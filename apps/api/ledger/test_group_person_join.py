from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from django.contrib.auth import get_user_model
from django.db import close_old_connections

from .models import Change, Expense, Group, OpeningBalance, Participant, PaymentAttempt, Settlement
from .test_api import authenticated_client, expense, send, uid
from .test_api import client as client
from .test_api import group as group
from .test_group_invites import account, link

pytestmark = pytest.mark.django_db


def preview(actor, token):
    response = send(actor, 'post', '/group-invite-links/preview', {'token': token})
    assert response.status_code == 200, response.content
    return response.json()


def claim(actor, token, person_id, version, name='John Doe', command=None):
    return send(actor, 'post', '/group-invite-links/join', {
        'token': token, 'command_id': command or uid(), 'participant_id': person_id,
        'preview_version': version, 'display_name': name,
    })


def test_preview_lists_only_eligible_names_and_no_email(client, group):
    gid, ids, _ = group
    Participant.objects.filter(pk=ids[1]).update(name='John')
    Participant.objects.filter(pk=ids[2]).update(contact_email='private@example.invalid')
    guest = account('Account name')
    data = preview(guest, link(client, gid))
    assert data['people'] == [{'id': ids[1], 'name': 'John'}]
    assert isinstance(data['version'], int)
    assert 'email' not in str(data) and 'private@example.invalid' not in str(data)
    assert Participant.objects.filter(group_id=gid, user=guest.actor).count() == 0


def test_selected_person_preserves_all_money_ids_and_account_name(client, group):
    gid, ids, _ = group
    Participant.objects.filter(pk=ids[1]).update(name='John')
    assert send(client, 'post', f'/groups/{gid}/expenses', expense(ids)).status_code == 200
    assert send(client, 'post', f'/groups/{gid}/settlements', {
        'command_id': uid(), 'id': uid(), 'sender': ids[1], 'recipient': ids[0], 'amount': '123',
    }).status_code == 200
    OpeningBalance.objects.create(group_id=gid, balances={ids[0]: '0', ids[1]: '-100', ids[2]: '100'},
                                  source='Local fixture', cutoff='2026-10-01', accepted=False)
    from datetime import timedelta

    from django.utils import timezone

    PaymentAttempt.objects.create(group_id=gid, sender_id=ids[1], recipient_id=ids[0], amount=222,
                                  payee="local-fixture@upi", payee_version=1, group_version=Group.objects.get(pk=gid).version,
                                  expires_at=timezone.now()+timedelta(minutes=10))
    original_attempts = list(PaymentAttempt.objects.values())
    before = list(Expense.objects.values()), list(Settlement.objects.values()), list(OpeningBalance.objects.values()), list(Change.objects.values())
    state = send(client, 'get', f'/groups/{gid}').json()
    guest = account('Global account name')
    token = link(client, gid)
    data = preview(guest, token)
    command = uid()
    response = claim(guest, token, ids[1], data['version'], command=command)
    assert response.status_code == 200, response.content
    assert claim(guest, token, ids[1], data['version'], command=command).json() == response.json()
    person = Participant.objects.get(pk=ids[1])
    assert person.user_id == guest.actor.pk and person.name == 'John'
    assert Participant.objects.filter(group_id=gid).count() == 3
    assert Group.objects.get(pk=gid).owner_id == client.actor.pk
    guest.actor.refresh_from_db()
    assert guest.actor.first_name == 'Global account name'
    for mode in ['', '/summary']:
        after = send(guest, 'get', f'/groups/{gid}{mode}').json()
        row = next(p for p in after['participants'] if p['id'] == ids[1])
        assert row['name'] == 'John Doe' and row['recorded_name'] == 'John'
        assert row['account_email'] == guest.actor.email
        assert after['balances'] == state['balances']
    assert (list(Expense.objects.values()), list(Settlement.objects.values()), list(OpeningBalance.objects.values())) == before[:3]
    assert list(PaymentAttempt.objects.values()) == original_attempts
    assert list(Change.objects.filter(pk__in=[row['id'] for row in before[3]]).values()) == before[3]
    assert claim(guest, token, ids[1], data['version'], name='Different', command=command).status_code == 409


@pytest.mark.parametrize('changed', ['email', 'linked', 'removed', 'pending', 'other_group'])
def test_target_revalidated_without_silent_new_person(client, group, changed):
    from datetime import timedelta

    from django.utils import timezone

    from .models import Invite
    gid, ids, _ = group
    guest = account()
    token = link(client, gid)
    data = preview(guest, token)
    target = ids[1]
    if changed == 'email':
        Participant.objects.filter(pk=target).update(contact_email='saved@example.invalid')
    elif changed == 'linked':
        Participant.objects.filter(pk=target).update(user=account().actor)
    elif changed == 'removed':
        Participant.objects.filter(pk=target).update(removed=True)
    elif changed == 'pending':
        Invite.objects.create(participant_id=target, token_hash=uuid4().hex, claimant=account().actor,
                              expires_at=timezone.now()+timedelta(days=1))
    else:
        foreign = Group.objects.create(owner=client.actor, name='Other local fixture')
        target = str(Participant.objects.create(group=foreign, name='Not this group').pk)
    before = Participant.objects.filter(group_id=gid).count()
    assert claim(guest, token, target, data['version']).status_code == 409
    assert Participant.objects.filter(group_id=gid).count() == before
    assert not Participant.objects.filter(group_id=gid, user=guest.actor).exists()
    if changed == 'pending':
        assert all(p['id'] != target for p in preview(guest, token)['people'])


@pytest.mark.django_db(transaction=True)
def test_two_accounts_claim_one_stable_person_once(client, group):
    gid, ids, _ = group
    token = link(client, gid)
    actors = [account(), account()]
    version = preview(actors[0], token)['version']
    def attempt(user_id):
        close_old_connections()
        try:
            actor = authenticated_client(get_user_model().objects.get(pk=user_id))
            return claim(actor, token, ids[1], version).status_code
        finally:
            close_old_connections()
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(attempt, [a.actor.pk for a in actors])) == [200, 409]
    assert Participant.objects.filter(group_id=gid).count() == 3
    assert Change.objects.filter(group_id=gid, kind='participant_claim_approved').count() == 1


def test_legacy_omitted_fields_replay_and_new_person_never_matches_a_name(client, group):
    from .group_invites import join_link
    gid, ids, _ = group
    guest = account('B')
    token, command = link(client, gid), uid()
    legacy = {'token': token, 'command_id': command}
    result = join_link(guest.actor, legacy)
    response = send(guest, 'post', '/group-invite-links/join', legacy)
    assert response.status_code == 200 and response.json() == result
    assert Participant.objects.get(pk=ids[1]).user_id is None
    own = Participant.objects.get(group_id=gid, user=guest.actor)
    assert str(own.pk) not in ids
    assert preview(guest, token)['people'] == []
    assert claim(guest, token, ids[1], Group.objects.get(pk=gid).version).status_code == 409


@pytest.mark.parametrize('body', [
    {'display_name': '   '}, {'display_name': []}, {'display_name': 'x'*121},
    {'preview_version': '1'}, {'participant_id': []}, {'unexpected': True},
])
def test_malformed_claim_input_is_rejected_without_membership(client, group, body):
    gid, *_ = group
    guest = account()
    response = send(guest, 'post', '/group-invite-links/join', {'token': link(client, gid), 'command_id': uid(), **body})
    assert response.status_code == 422
    assert not Participant.objects.filter(group_id=gid, user=guest.actor).exists()


def test_stale_version_no_group_title_or_global_name_change(client, group):
    gid, ids, _ = group
    guest = account('Global name')
    token = link(client, gid)
    data = preview(guest, token)
    assert send(client, 'post', f'/groups/{gid}/expenses', expense(ids)).status_code == 200
    assert claim(guest, token, ids[1], data['version']).status_code == 409
    assert Group.objects.get(pk=gid).name == 'Functional test'
    assert not Participant.objects.filter(group_id=gid, user=guest.actor).exists()


@pytest.mark.parametrize('provider', ['email', 'google'])
def test_linked_canonical_email_visible_to_members_only(client, group, provider):
    from allauth.socialaccount.models import SocialAccount
    gid, ids, _ = group
    member = account('Actual account')
    if provider == 'google':
        SocialAccount.objects.create(user=member.actor, provider='google', uid=uuid4().hex,
                                     extra_data={'email': 'untrusted-provider-extra@example.invalid'})
    token = link(client, gid)
    data = preview(member, token)
    assert claim(member, token, ids[1], data['version']).status_code == 200
    outsider = account()
    for path in [f'/groups/{gid}', f'/groups/{gid}/summary']:
        assert send(outsider, 'get', path).status_code == 404
        assert send(client.__class__(), 'get', path).status_code == 401
        for viewer in [client, member]:
            row = next(p for p in send(viewer, 'get', path).json()['participants'] if p['id'] == ids[1])
            assert row['account_email'] == member.actor.email
    assert member.actor.email not in str(preview(outsider, token))
    assert member.actor.email not in client.get('/j/'+token).content.decode()


def test_group_label_override_preserves_other_groups_profile_fallback_and_succession(client, group):
    from .group_membership import _next_organizer
    from .profiles import update_display_name
    gid, ids, _ = group
    guest = account('Global name')
    other = Group.objects.create(name='Other local group', owner=guest.actor)
    Participant.objects.create(group=other, user=guest.actor, name='Recorded other')
    token = link(client, gid)
    assert claim(guest, token, ids[1], preview(guest, token)['version']).status_code == 200
    update_display_name(guest.actor, 'Updated global name')
    for group_id, expected in [(gid, 'John Doe'), (str(other.pk), 'Updated global name')]:
        row = next(p for p in send(guest, 'get', f'/groups/{group_id}').json()['participants'] if p['user_id'] == guest.actor.pk)
        assert row['name'] == expected
    assert _next_organizer(Group.objects.get(pk=gid), Participant.objects.get(pk=ids[0])).pk == Participant.objects.get(pk=ids[1]).pk


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize('change', ['contact', 'manual_claim', 'removed'])
def test_waiting_claim_rechecks_locked_contact_claim_and_removal(client, group, change):
    from threading import Event
    from time import monotonic, sleep

    from django.db import connection, connections, transaction
    from ninja.errors import HttpError

    from .collaboration import claim_invite, create_invite, invite_token
    from .email_invites import update_contact
    from .group_invites import join_link
    gid, ids, _ = group
    actors = [account(), account()]
    token = link(client, gid)
    version = preview(actors[0], token)['version']
    invitation = uid()
    if change == 'manual_claim':
        create_invite(client.actor, gid, {'command_id': invitation, 'participant_id': ids[1]})
        version = preview(actors[0], token)['version']
    started, backend = Event(), []
    def waiting_join():
        close_old_connections()
        try:
            actor = get_user_model().objects.get(pk=actors[0].actor.pk)
            backend.append(connections['default'].connection.info.backend_pid)
            started.set()
            try:
                join_link(actor, {'token': token, 'command_id': uid(), 'participant_id': ids[1], 'preview_version': version, 'display_name': 'John'})
            except HttpError as exc:
                return exc.status_code
        finally:
            connections.close_all()
    with ThreadPoolExecutor(max_workers=1) as pool:
        with transaction.atomic():
            Group.objects.select_for_update().get(pk=gid)
            future = pool.submit(waiting_join)
            assert started.wait(5)
            deadline = monotonic()+5
            while True:
                with connection.cursor() as cursor:
                    cursor.execute('SELECT wait_event_type FROM pg_stat_activity WHERE pid=%s', backend)
                    row = cursor.fetchone()
                if row and row[0] == 'Lock':
                    break
                assert monotonic() < deadline, 'Join did not wait for group lock'
                sleep(0.01)
            if change == 'contact':
                update_contact(client.actor, gid, ids[1], {'command_id': uid(), 'email': 'saved@example.invalid'})
            elif change == 'manual_claim':
                claim_invite(actors[1].actor, invite_token(invitation), {'command_id': uid()})
            else:
                Participant.objects.filter(pk=ids[1]).update(removed=True)
        assert future.result(timeout=5) == 409
    assert not Participant.objects.filter(group_id=gid, user=actors[0].actor).exists()
    assert Participant.objects.filter(group_id=gid).count() == 3


def test_new_explicit_confirmation_cannot_silently_reclaim_same_account_person(client, group):
    gid, ids, _ = group
    actor = account()
    token = link(client, gid)
    version = preview(actor, token)['version']
    assert claim(actor, token, ids[1], version, name='First confirmed label').status_code == 200
    assert claim(actor, token, ids[1], version, name='Second confirmed label').status_code == 409
    assert Participant.objects.get(pk=ids[1]).display_name_override == 'First confirmed label'
    assert Change.objects.filter(group_id=gid, kind='participant_claim_approved').count() == 1
    # Existing clients can still explicitly open a group without a claim target.
    assert send(actor, 'post', '/group-invite-links/join', {'token': token, 'command_id': uid()}).status_code == 200


def test_large_preview_keeps_all_choices_and_normal_join_as_new(client, group):
    gid, *_ = group
    Participant.objects.bulk_create([Participant(group_id=gid, name=f'Local person {n}') for n in range(100)])
    actor = account()
    before = Participant.objects.count()
    response = send(actor, 'post', '/group-invite-links/preview', {'token': link(client, gid)})
    assert response.status_code == 200 and len(response.json()['people']) == 102
    assert Participant.objects.count() == before
    assert send(actor, 'post', '/group-invite-links/join', {'token': link(client, gid), 'command_id': uid()}).status_code == 200
    assert Participant.objects.count() == before + 1


def test_account_deletion_clears_group_display_override_without_money_rewrite(client, group):
    from .portability import delete_account
    gid, ids, _ = group
    actor = account()
    token = link(client, gid)
    assert claim(actor, token, ids[1], preview(actor, token)['version']).status_code == 200
    assert send(client, 'post', f'/groups/{gid}/expenses', expense(ids)).status_code == 200
    original = list(Expense.objects.values())
    delete_account(actor.actor)
    person = Participant.objects.get(pk=ids[1])
    assert person.user_id is None and person.display_name_override == '' and person.contact_email == ''
    assert list(Expense.objects.values()) == original


def test_group_override_remains_the_person_label_after_membership_removal(client, group):
    from .profiles import participant_display_name
    gid, ids, _ = group
    actor = account()
    token = link(client, gid)
    assert claim(actor, token, ids[1], preview(actor, token)['version']).status_code == 200
    person = Participant.objects.get(pk=ids[1])
    person.removed = True
    person.save(update_fields=['removed'])
    assert participant_display_name(person) == 'John Doe' and person.name == 'B'


def test_additive_group_override_default_allows_old_writer_and_matches_migration(client, group):
    from django.core.management import call_command
    from django.db import connection
    gid, *_ = group
    person_id = uid()
    with connection.cursor() as cursor:
        cursor.execute('INSERT INTO ledger_participant (id,group_id,name,user_id,removed,hidden,contact_email) VALUES (%s,%s,%s,NULL,false,false,%s)',
                       [person_id, gid, 'Old local writer', ''])
    assert Participant.objects.get(pk=person_id).display_name_override == ''
    call_command('makemigrations', 'ledger', check=True, dry_run=True, verbosity=0)


def test_real_browser_claim_requires_csrf_before_linking_same_person(client, group):
    import json

    from django.test import Client
    gid, ids, _ = group
    member = account()
    token = link(client, gid)
    data = preview(member, token)
    body = {'token': token, 'command_id': uid(), 'participant_id': ids[1], 'preview_version': data['version'], 'display_name': 'John Doe'}
    browser = Client(enforce_csrf_checks=True)
    browser.get('/_allauth/browser/v1/config')
    browser.force_login(member.actor, backend='allauth.account.auth_backends.AuthenticationBackend')
    assert send(browser, 'post', '/group-invite-links/join', body).status_code == 403
    assert Participant.objects.get(pk=ids[1]).user_id is None
    response = browser.post('/api/v1/group-invite-links/join', data=json.dumps(body), content_type='application/json',
                            HTTP_X_CSRFTOKEN=browser.cookies['csrftoken'].value)
    assert response.status_code == 200 and Participant.objects.get(pk=ids[1]).user_id == member.actor.pk
