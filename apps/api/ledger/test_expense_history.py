from copy import deepcopy

import pytest
from django.contrib.auth import get_user_model
from django.db import transaction

from .models import Change, CommandReceipt, Expense, Group, Participant
from .services import expense_dict, save_expense
from .test_api import authenticated_client, expense, send, uid
from .test_api import client as client
from .test_api import group as group

pytestmark = pytest.mark.django_db


def create(client, group):
    gid, ids, _ = group
    body = expense(ids)
    assert send(client, 'post', f'/groups/{gid}/expenses', body).status_code == 200
    return body


def read(client, group, body, query=''):
    return send(client, 'get', f'/groups/{group[0]}/expenses/{body["id"]}/versions{query}')


def edit(client, group, body, **values):
    current = Expense.objects.get(pk=body['id'])
    updated = {**expense_dict(current), 'command_id': uid(), **values}
    updated.pop('deleted')
    updated.pop('shares')
    response = send(client, 'put', f'/groups/{group[0]}/expenses/{body["id"]}', updated)
    assert response.status_code == 200, response.content
    return updated


def test_actual_values_newest_first_and_labels_are_historical(client, group):
    body = create(client, group)
    edit(client, group, body, description='Dinner at Olive', total='276000', paid={group[1][1]: '276000'},
         split={'mode': 'exact', 'values': {group[1][0]: '106000', group[1][1]: '90000', group[1][2]: '80000'}})
    page = read(client, group, body).json()
    assert [x['kind'] for x in page['items']] == ['edited', 'created']
    changed = {x['field']: x for x in page['items'][0]['changes']}
    assert changed['description'] == {'field': 'description', 'before': 'Test expense', 'after': 'Dinner at Olive'}
    assert changed['total']['before'] == '10000' and changed['total']['after'] == '276000'
    assert changed['paid']['before'] == {group[1][0]: '10000'}
    assert changed['split']['after']['shares'] == {group[1][0]: '106000', group[1][1]: '90000', group[1][2]: '80000'}
    assert page['items'][0]['currency'] == 'INR' and page['items'][0]['actor_name'] == 'A'
    client.actor.first_name = 'Later profile'
    client.actor.save(update_fields=['first_name'])
    Participant.objects.filter(pk=group[1][1]).update(name='Later name')
    assert read(client, group, body).json() == page


def test_noop_keeps_old_write_contract_but_is_not_a_history_edit(client, group):
    body = create(client, group)
    before = Expense.objects.get(pk=body['id']).version
    edit(client, group, body)
    assert Expense.objects.get(pk=body['id']).version == before + 1
    page = read(client, group, body).json()
    assert len(page['items']) == 1 and page['items'][0]['kind'] == 'created' and not page['legacy_gap']


def test_replay_conflict_and_outer_rollback_have_no_false_rows(client, group):
    body = create(client, group)
    update = edit(client, group, body, description='Accepted')
    count = Change.objects.count()
    assert send(client, 'put', f'/groups/{group[0]}/expenses/{body["id"]}', update).status_code == 200
    stale = {**update, 'command_id': uid(), 'description': 'Rejected'}
    assert send(client, 'put', f'/groups/{group[0]}/expenses/{body["id"]}', stale).status_code == 409
    assert Change.objects.count() == count
    current = Expense.objects.get(pk=body['id'])
    rollback = {**expense_dict(current), 'command_id': uid(), 'description': 'Rolled back'}
    rollback.pop('deleted')
    rollback.pop('shares')
    with pytest.raises(RuntimeError), transaction.atomic():
        save_expense(client.actor, group[0], rollback, body['id'])
        raise RuntimeError('Synthetic outer rollback')
    assert Change.objects.count() == count and not CommandReceipt.objects.filter(command_id=rollback['command_id']).exists()
    assert Expense.objects.get(pk=body['id']).description == 'Accepted'
    assert len(read(client, group, body).json()['items']) == 2


def test_legacy_gaps_imports_and_first_real_edit_do_not_invent_creation(client, group):
    body = create(client, group)
    Change.objects.filter(group_id=group[0], data__id=body['id']).delete()
    page = read(client, group, body).json()
    assert page['items'] == [] and page['legacy_gap']
    edit(client, group, body, description='First evidenced edit')
    page = read(client, group, body).json()
    assert len(page['items']) == 1 and page['items'][0]['kind'] == 'edited'
    assert next(x for x in page['items'][0]['changes'] if x['field'] == 'description')['before'] == 'Test expense'


def test_old_complete_snapshots_are_used_but_missing_versions_are_not_guessed(client, group):
    body = create(client, group)
    edit(client, group, body, description='Old edit')
    for change in Change.objects.filter(group_id=group[0], kind='expense_saved'):
        change.data.pop('_history')
        change.save(update_fields=['data'])
    page = read(client, group, body).json()
    assert len(page['items']) == 2 and page['legacy_gap'] and page['items'][0]['actor_name'] == 'A'
    newest = Change.objects.filter(group_id=group[0], kind='expense_saved').latest('sequence')
    newest.data['version'] = 4
    newest.save(update_fields=['data'])
    assert [x['kind'] for x in read(client, group, body).json()['items']] == ['created']
    oldest = Change.objects.filter(group_id=group[0], kind='expense_saved').earliest('sequence')
    oldest.data['source'] = 'splitwise_csv'
    oldest.save(update_fields=['data'])
    assert read(client, group, body).json()['items'] == []


def test_entity_permissions_hidden_removed_unrelated_and_anonymous(client, group):
    body = create(client, group)
    other = authenticated_client(get_user_model().objects.create_user(username=uid()))
    assert read(other, group, body).status_code == 404
    assert send(client, 'get', f'/groups/{uid()}/expenses/{body["id"]}/versions').status_code == 404
    assert send(client, 'get', f'/groups/{group[0]}/expenses/{uid()}/versions').status_code == 404
    Participant.objects.filter(user=client.actor).update(hidden=True)
    assert read(client, group, body).status_code == 200
    Participant.objects.filter(user=client.actor).update(removed=True)
    assert read(client, group, body).status_code == 404
    client.logout()
    client.defaults.pop('HTTP_X_SESSION_TOKEN')
    assert read(client, group, body).status_code == 401


def test_bounded_stable_pagination_and_reversal_preserve_original_once(client, group):
    body = create(client, group)
    for i in range(4):
        edit(client, group, body, description=f'Edit {i}')
    page = read(client, group, body, '?limit=2').json()
    older = read(client, group, body, f'?limit=2&before={page["next_before"]}').json()
    assert len(page['items']) == len(older['items']) == 2
    assert page['items'][-1]['sequence'] > older['items'][0]['sequence']
    assert read(client, group, body, '?limit=101').status_code == 422
    original = deepcopy(expense_dict(Expense.objects.get(pk=body['id'])))
    payload = {'command_id': uid(), 'version': original['version']}
    path = f'/groups/{group[0]}/expenses/{body["id"]}/reverse'
    assert send(client, 'post', path, payload).status_code == 200
    assert send(client, 'post', path, payload).status_code == 200
    history = read(client, group, body).json()['items']
    assert history[0]['changes'] == [{'field': 'deleted', 'before': False, 'after': True}]
    assert sum(x['changes'] == history[0]['changes'] for x in history) == 1
    current = expense_dict(Expense.objects.get(pk=body['id']))
    assert {k:v for k,v in current.items() if k not in ['deleted', 'version']} == {k:v for k,v in original.items() if k not in ['deleted','version']}
    assert Group.objects.get(pk=group[0]).expenses.count() == 1


def test_empty_bounded_noop_page_can_reach_an_actual_earlier_edit(client, group):
    body = create(client, group)
    edit(client, group, body, description='Actual edit')
    edit(client, group, body)
    empty = read(client, group, body, '?limit=1').json()
    assert empty['items'] == [] and empty['next_before'] is not None
    earlier = read(client, group, body, f"?limit=1&before={empty['next_before']}").json()
    assert earlier['items'][0]['changes'][0]['after'] == 'Actual edit'
    full = send(client, 'get', f'/groups/{group[0]}')
    assert full.status_code == 200 and '_history' not in full.content.decode()


def test_store_review_and_public_links_cannot_expose_entity_history(client, group, settings):
    from .collaboration import create_invite, guest_view
    body = create(client, group)
    from .collaboration import invite_token
    command = uid()
    create_invite(client.actor, group[0], {'participant_id': group[1][1], 'command_id': command})
    assert '_history' not in str(guest_view(invite_token(command)))
    reviewer = get_user_model().objects.create_user(username=uid(), email='review@example.invalid')
    Participant.objects.filter(pk=group[1][1]).update(user=reviewer)
    settings.STORE_REVIEW_AUTH = [{'store': 'apple', 'user_id': reviewer.pk, 'email': reviewer.email, 'pin_hash': ''}]
    for viewer in [client, authenticated_client(reviewer)]:
        assert read(viewer, group, body).status_code == 404


def test_new_uninvolved_person_does_not_create_a_false_paid_or_split_change(client, group):
    body = create(client, group)
    Participant.objects.create(group_id=group[0], name='Uninvolved')
    edit(client, group, body)
    assert len(read(client, group, body).json()['items']) == 1


def test_forged_rest_source_is_not_mcp_and_legacy_entries_stay_unmarked(client, group):
    client.defaults['HTTP_USER_AGENT'] = 'MCP'
    client.defaults['HTTP_X_MEROSPLIT_SOURCE'] = 'mcp'
    body = create(client, group)
    assert not read(client, group, body).json()['items'][0]['via_mcp']
    forged = {**expense(group[1]), 'source': 'mcp', '_history': {'origin': 'mcp'}}
    assert send(client, 'post', f'/groups/{group[0]}/expenses', forged).status_code == 422
    assert not Expense.objects.filter(pk=forged['id']).exists()
    change = Change.objects.get(group_id=group[0], data__id=body['id'])
    change.data.pop('_history')
    change.save(update_fields=['data'])
    assert not read(client, group, body).json()['items'][0]['via_mcp']


def test_legacy_actor_fallback_uses_only_group_visible_label(client, group):
    body = create(client, group)
    row = Change.objects.get(group_id=group[0], kind='expense_saved', data__id=body['id'])
    row.data.pop('_history')
    row.save(update_fields=['data'])
    client.actor.first_name = 'Current profile'
    client.actor.save(update_fields=['first_name'])
    assert read(client, group, body).json()['items'][0]['actor_name'] == 'Current profile'
    assert not read(client, group, body).json()['items'][0]['labels_recorded']
    Participant.objects.filter(user=client.actor).update(removed=True)
    member = get_user_model().objects.create_user(username=uid())
    Participant.objects.filter(pk=group[1][1]).update(user=member)
    peer = authenticated_client(member)
    assert read(peer, group, body).json()['items'][0]['actor_name'] == 'A'
    Participant.objects.filter(user=client.actor).update(user=None)
    assert read(peer, group, body).json()['items'][0]['actor_name'] is None
    Group.objects.filter(pk=group[0]).update(owner=member)
    client.actor.delete()
    assert read(peer, group, body).json()['items'][0]['actor_name'] is None


def test_deletion_scrubs_frozen_labels_and_cross_author_before_text(client, group):
    import json

    from .portability import delete_account

    body = create(client, group)
    edit(client, group, body, description='Private authored title', notes='Private authored note')
    peer = get_user_model().objects.create_user(username=uid(), first_name='Visible peer')
    Participant.objects.filter(pk=group[1][1]).update(user=peer)
    other = authenticated_client(peer)
    edit(other, group, body, description='Retained peer title')
    delete_account(client.actor)
    history = read(other, group, body)
    assert history.status_code == 200
    raw = json.dumps(list(Change.objects.filter(group_id=group[0]).values('data')))
    assert 'Private authored' not in raw
    assert 'Retained peer title' in raw
    for row in history.json()['items']:
        assert row['actor_name'] != 'A'
        assert row['names'].get(group[1][0]) != 'A'
