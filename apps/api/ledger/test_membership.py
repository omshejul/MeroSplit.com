from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import timedelta
from threading import Event, Lock
from time import monotonic, sleep

import pytest
from allauth.account.models import EmailAddress
from django.contrib.auth import get_user_model
from django.db import close_old_connections, connection, connections, transaction
from django.utils import timezone

from . import email_delivery, push_provider
from .membership_notifications import send_membership_notifications
from .models import (
    Change,
    CommandReceipt,
    EmailLoginGrant,
    Group,
    Invite,
    MembershipDelivery,
    NotificationPreference,
    Participant,
)
from .services import create_group
from .test_api import authenticated_client, expense, send, uid
from .test_api import client as client
from .test_api import group as group
from .test_push import register

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture(autouse=True)
def configured(settings, monkeypatch):
    settings.PUSH_PROVIDER = 'expo'
    settings.PUBLIC_WEB_URL = 'https://merosplit.example'
    settings.EMAIL_PROVIDER = 'resend'
    deliveries = []
    guard = Lock()

    def email(recipient, subject, text, delivery_id, **kwargs):
        assert not connection.in_atomic_block
        with guard:
            deliveries.append((recipient, delivery_id, deepcopy(kwargs['payload'])))
        return 'synthetic-email-ticket'

    monkeypatch.setattr(email_delivery, 'send_email', email)
    monkeypatch.setattr(push_provider, 'send_bill_notification', lambda *args, **kwargs: 'synthetic-push-ticket')
    monkeypatch.setattr(push_provider, 'check_bill_notification_receipt', lambda ticket: True)
    return deliveries


def account(email='recipient@example.com', *, verified=True, active=True, email_on=True):
    user = get_user_model().objects.create_user(username=uid(), email=email, is_active=active, first_name='Canonical recipient')
    EmailAddress.objects.create(user=user, email=email, verified=verified, primary=True)
    NotificationPreference.objects.create(user=user, email_reminders=email_on,
        email_enabled_at=timezone.now() if email_on else None)
    return authenticated_client(user)


def body(recipient='recipient@example.com'):
    people = [uid(), uid()]
    return {'command_id': uid(), 'id': uid(), 'name': 'Synthetic private ledger', 'is_direct': True,
            'self_participant_id': people[0], 'participants': [
                {'id': people[0], 'name': 'Organizer'}, {'id': people[1], 'name': 'Recorded person', 'email': recipient}]}


def create(client, payload=None):
    payload = payload or body()
    response = send(client, 'post', '/groups', payload)
    assert response.status_code == 200, response.content
    return payload, response.json()


def test_create_links_existing_verified_account_and_dashboard_once(client, configured):
    recipient = account()
    register(recipient)
    payload, result = create(client)
    person_id = payload['participants'][1]['id']
    assert result['linked_participant_ids'] == [person_id]
    person = Participant.objects.get(pk=person_id)
    assert person.user_id == recipient.actor.pk and person.name == 'Recorded person'
    state = send(recipient, 'get', f'/groups/{payload["id"]}').json()
    linked = next(p for p in state['participants'] if p['id'] == person_id)
    assert linked['name'] == 'Canonical recipient' and linked['recorded_name'] == 'Recorded person'
    assert send(recipient, 'get', '/groups').json()['groups'][0]['id'] == payload['id']
    assert send(client, 'post', '/groups', payload).json() == result
    assert CommandReceipt.objects.count() == Change.objects.count() == 1
    assert MembershipDelivery.objects.count() == 2
    assert not Invite.objects.exists() and not EmailLoginGrant.objects.exists() and not configured


def test_add_links_without_rewriting_old_bills_and_rejects_duplicate_identity(client, group):
    recipient = account()
    bill = expense(group[1])
    assert send(client, 'post', f'/groups/{group[0]}/expenses', bill).status_code == 200
    before = send(client, 'get', f'/groups/{group[0]}').json()
    payload = {'command_id': uid(), 'id': uid(), 'name': 'New person', 'email': ' RECIPIENT@example.com '}
    response = send(client, 'post', f'/groups/{group[0]}/participants', payload)
    assert response.status_code == 200, response.content
    assert response.json()['linked_participant_ids'] == [payload['id']]
    assert send(client, 'post', f'/groups/{group[0]}/participants', payload).json() == response.json()
    after = send(recipient, 'get', f'/groups/{group[0]}').json()
    assert before['expenses'] == after['expenses'] and after['balances'][payload['id']] == '0'
    assert all(after['balances'][key] == value for key, value in before['balances'].items())
    duplicate = {**payload, 'id': uid(), 'command_id': uid()}
    assert send(client, 'post', f'/groups/{group[0]}/participants', duplicate).status_code == 409
    assert send(recipient, 'post', f'/groups/{group[0]}/participants', duplicate).status_code == 403
    assert send(client, 'post', f'/groups/{group[0]}/participants/{payload["id"]}/remove', {'command_id': uid()}).status_code == 200
    assert send(client, 'post', f'/groups/{group[0]}/participants', duplicate).status_code == 409


@pytest.mark.parametrize('identity', ['missing', 'unverified', 'inactive', 'alias'])
def test_only_unique_verified_current_active_identity_links(client, identity):
    if identity != 'missing':
        recipient = account(verified=identity != 'unverified', active=identity != 'inactive')
        if identity == 'alias':
            get_user_model().objects.filter(pk=recipient.actor.pk).update(email='changed@example.com')
    payload, result = create(client)
    assert result['linked_participant_ids'] == []
    assert Participant.objects.get(pk=payload['participants'][1]['id']).user_id is None
    assert not MembershipDelivery.objects.exists() and not Invite.objects.exists()


def test_legacy_case_conflicting_identity_fails_closed(client):
    account()
    get_user_model().objects.create_user(username=uid(), email='RECIPIENT@example.com')
    response = send(client, 'post', '/groups', body())
    assert response.status_code == 409 and not Group.objects.exists()
    assert not MembershipDelivery.objects.exists() and not CommandReceipt.objects.exists()


def test_creation_receipt_never_links_retroactively_but_explicit_send_can(client, configured):
    payload, result = create(client)
    recipient = account()
    assert send(client, 'post', '/groups', payload).json() == result
    person_id = payload['participants'][1]['id']
    assert Participant.objects.get(pk=person_id).user_id is None
    command = {'command_id': uid()}
    path = f'/groups/{payload["id"]}/participants/{person_id}/email-invite'
    response = send(client, 'post', path, command)
    assert response.status_code == 200, response.content
    assert response.json()['linked_participant_ids'] == [person_id] and 'invite' not in response.json()
    assert send(client, 'post', path, command).json() == response.json()
    assert Participant.objects.get(pk=person_id).user_id == recipient.actor.pk
    assert not Invite.objects.exists() and not configured
    assert MembershipDelivery.objects.count() == 1


def test_contact_save_alone_does_not_link_and_unknown_send_keeps_explicit_invitation(client, group, configured):
    account()
    path = f'/groups/{group[0]}/participants/{group[1][1]}'
    assert send(client, 'post', f'{path}/contact', {'command_id': uid(), 'email': 'recipient@example.com'}).status_code == 200
    assert Participant.objects.get(pk=group[1][1]).user_id is None and not MembershipDelivery.objects.exists()
    assert not configured
    payload, _ = create(client, body('unknown@example.com'))
    path = f'/groups/{payload["id"]}/participants/{payload["participants"][1]["id"]}/email-invite'
    response = send(client, 'post', path, {'command_id': uid()})
    assert response.status_code == 200 and response.json()['invite']['state'] == 'sent'
    assert response.json()['linked_participant_ids'] == []
    assert len(configured) == 1 and Invite.objects.count() == 1


def test_auto_link_is_actual_succession_evidence(client):
    recipient = account()
    payload, _ = create(client)
    response = send(client, 'post', f'/groups/{payload["id"]}/leave', {'command_id': uid(), 'remove_membership': True})
    assert response.status_code == 200, response.content
    assert Group.objects.get(pk=payload['id']).owner_id == recipient.actor.pk


def test_all_membership_writes_and_delivery_work_rollback_together(client):
    account()
    payload = body()
    with pytest.raises(RuntimeError), transaction.atomic():
        create_group(client.actor, payload)
        assert MembershipDelivery.objects.count() == 1
        raise RuntimeError('synthetic rollback')
    assert not Group.objects.exists() and not Participant.objects.exists()
    assert not MembershipDelivery.objects.exists() and not CommandReceipt.objects.exists()
    create(client, payload)


@pytest.mark.parametrize('mode', ['self', 'repeated'])
def test_create_rejects_duplicate_account_in_people_list(client, mode):
    recipient = account(client.actor.email if mode == 'self' else 'recipient@example.com') if mode != 'self' else client
    if mode == 'self':
        EmailAddress.objects.create(user=recipient.actor, email=recipient.actor.email, verified=True)
    payload = body(recipient.actor.email)
    if mode == 'repeated':
        payload['is_direct'] = False
        payload['participants'].append({'id': uid(), 'name': 'Duplicate', 'email': recipient.actor.email})
    assert send(client, 'post', '/groups', payload).status_code == 409
    assert not Group.objects.exists()


def test_real_review_boundaries_and_no_demo_delivery(client, settings):
    recipient = account()
    settings.STORE_REVIEW_AUTH = [{'store': 'apple', 'user_id': recipient.actor.pk, 'email': recipient.actor.email, 'pin_hash': ''}]
    assert send(client, 'post', '/groups', body()).status_code == 409
    settings.STORE_REVIEW_AUTH = [{'store': 'apple', 'user_id': client.actor.pk, 'email': client.actor.email, 'pin_hash': ''}]
    assert send(client, 'post', '/groups', body()).status_code == 409
    assert not Group.objects.exists() and not MembershipDelivery.objects.exists()


def test_unverified_review_reservation_never_receives_an_invitation(client, settings):
    recipient = account(verified=False)
    payload, _ = create(client)
    settings.STORE_REVIEW_AUTH = [{'store': 'apple', 'user_id': recipient.actor.pk, 'email': recipient.actor.email, 'pin_hash': ''}]
    path = f'/groups/{payload["id"]}/participants/{payload["participants"][1]["id"]}/email-invite'
    assert send(client, 'post', path, {'command_id': uid()}).status_code == 409
    assert not Invite.objects.exists()


@pytest.mark.parametrize(('master', 'email_on', 'channels'), [(False, True, []), (True, False, ['push']), (True, True, ['email', 'push'])])
def test_existing_notification_switches_are_preserved(client, master, email_on, channels):
    recipient = account(email_on=email_on)
    NotificationPreference.objects.filter(user=recipient.actor).update(expense_updates=master)
    register(recipient)
    create(client)
    assert sorted(MembershipDelivery.objects.values_list('channel', flat=True)) == channels
    pref = NotificationPreference.objects.get(user=recipient.actor)
    assert (pref.expense_updates, pref.email_reminders) == (master, email_on)


def test_worker_email_push_receipt_and_generic_payload_once(client, configured, monkeypatch):
    recipient = account()
    register(recipient)
    payload, _ = create(client)
    pushes = []
    def push(device, data, **kwargs):
        assert not connection.in_atomic_block
        pushes.append((data, kwargs['body']))
        return 'accepted-ticket'
    monkeypatch.setattr(push_provider, 'send_bill_notification', push)
    assert send_membership_notifications() == 2
    assert len(configured) == len(pushes) == 1
    data, text = pushes[0]
    assert data['type'] == 'group_membership' and data['group_id'] == payload['id']
    assert set(data) == {'type', 'event_id', 'recipient_user_id', 'group_id'}
    assert 'Synthetic private ledger' not in text
    assert 'Canonical recipient' not in configured[0][2]['text'] and '#proof=' not in configured[0][2]['text']
    MembershipDelivery.objects.filter(channel='push').update(due_at=timezone.now())
    assert send_membership_notifications() == 1
    assert set(MembershipDelivery.objects.values_list('state', flat=True)) == {'sent'}
    assert len(configured) == len(pushes) == 1 and send_membership_notifications() == 0


@pytest.mark.parametrize('change', ['off_on', 'email_off_on', 'archive_unarchive', 'removed', 'inactive', 'email_changed', 'unverified'])
def test_pending_delivery_rechecks_and_does_not_replay_after_opt_out(client, configured, change):
    recipient = account()
    payload, _ = create(client)
    if change in {'off_on', 'email_off_on'}:
        from .expense_notifications import update_preferences
        update_preferences(recipient.actor, change == 'email_off_on', False)
        update_preferences(recipient.actor, True, True)
    elif change == 'archive_unarchive':
        for archived in (True, False):
            assert send(client, 'post', f'/groups/{payload["id"]}/archive', {'command_id': uid(), 'archived': archived}).status_code == 200
    elif change == 'removed':
        assert send(client, 'post', f'/groups/{payload["id"]}/participants/{payload["participants"][1]["id"]}/remove', {'command_id': uid()}).status_code == 200
    elif change == 'inactive':
        get_user_model().objects.filter(pk=recipient.actor.pk).update(is_active=False)
    elif change == 'email_changed':
        get_user_model().objects.filter(pk=recipient.actor.pk).update(email='different@example.com')
    else:
        EmailAddress.objects.filter(user=recipient.actor).update(verified=False)
    send_membership_notifications()
    assert not configured and MembershipDelivery.objects.get().state == 'cancelled'


@pytest.mark.parametrize('change', ['logout', 'rebound', 'expired', 'disabled_provider'])
def test_push_binding_and_session_guard(client, configured, change, settings):
    recipient = account(email_on=False)
    device = register(recipient)
    create(client)
    if change == 'logout':
        from config.sessions import SessionStore
        SessionStore(session_key=device.session_id).delete()
    elif change == 'rebound':
        other = account('other@example.com')
        register(other, installation=device.id, token=device.token)
    elif change == 'expired':
        from django.contrib.sessions.models import Session
        Session.objects.filter(pk=device.session_id).update(expire_date=timezone.now() - timedelta(seconds=1))
    else:
        settings.PUSH_PROVIDER = ''
    send_membership_notifications()
    assert not configured
    assert not MembershipDelivery.objects.exclude(state='cancelled').exists()


def test_email_retry_keeps_frozen_body_key_and_holds_after_window(client, settings, monkeypatch):
    account()
    create(client)
    sent = []
    def uncertain(*args, **kwargs):
        sent.append((args, deepcopy(kwargs)))
        raise email_delivery.EmailDeliveryUnavailable()
    monkeypatch.setattr(email_delivery, 'send_email', uncertain)
    send_membership_notifications()
    row = MembershipDelivery.objects.get()
    assert row.state == 'pending'
    settings.PUBLIC_WEB_URL, settings.DEFAULT_FROM_EMAIL = 'https://changed.example', 'Changed <changed@example.com>'
    MembershipDelivery.objects.update(due_at=timezone.now())
    send_membership_notifications()
    assert sent[0] == sent[1]
    MembershipDelivery.objects.update(due_at=timezone.now(), first_attempt_at=timezone.now() - timedelta(hours=23))
    send_membership_notifications()
    assert len(sent) == 2 and MembershipDelivery.objects.get().state == 'held'


def test_uncertain_push_is_held_instead_of_blind_resend(client, monkeypatch):
    recipient = account(email_on=False)
    register(recipient)
    create(client)
    calls = []
    def uncertain(*args, **kwargs):
        calls.append(True)
        raise push_provider.PushFailure('network_error')
    monkeypatch.setattr(push_provider, 'send_bill_notification', uncertain)
    send_membership_notifications()
    assert MembershipDelivery.objects.get().state == 'held'
    send_membership_notifications()
    assert len(calls) == 1


@pytest.mark.parametrize('changed', ['email', 'device'])
def test_last_check_reloads_changed_recipient_or_binding_after_job_fetch(client, configured, monkeypatch, changed):
    from . import membership_notifications
    recipient = account(email_on=changed == 'email')
    device = register(recipient) if changed == 'device' else None
    create(client)
    original = membership_notifications._eligible
    def race(job):
        if changed == 'email':
            get_user_model().objects.filter(pk=recipient.actor.pk).update(email='new@example.com')
        else:
            from django.db.models import F

            from .models import PushDevice
            PushDevice.objects.filter(pk=device.pk).update(revision=F('revision') + 1)
        return original(job)
    monkeypatch.setattr(membership_notifications, '_eligible', race)
    assert send_membership_notifications() == 1
    assert MembershipDelivery.objects.get().state == 'cancelled' and not configured


def test_crashed_push_attempt_is_held_on_lease_recovery(client, monkeypatch):
    recipient = account(email_on=False)
    register(recipient)
    create(client)
    calls = []
    def lost(*args, **kwargs):
        calls.append(True)
        raise KeyboardInterrupt()
    monkeypatch.setattr(push_provider, 'send_bill_notification', lost)
    with pytest.raises(KeyboardInterrupt):
        send_membership_notifications()
    job = MembershipDelivery.objects.get()
    assert job.state == 'sending' and job.first_attempt_at
    MembershipDelivery.objects.update(lease_until=timezone.now() - timedelta(seconds=1))
    send_membership_notifications()
    assert MembershipDelivery.objects.get().state == 'held' and len(calls) == 1


def threaded(function):
    close_old_connections()
    try:
        return function()
    finally:
        connections.close_all()


def test_concurrent_same_command_and_recipient_additions_are_once(client, group):
    recipient = account()
    payload = {'command_id': uid(), 'id': uid(), 'name': 'Recipient', 'email': recipient.actor.email}
    from .collaboration import add_participant
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: threaded(lambda: add_participant(client.actor, group[0], payload)), range(2)))
    assert results[0] == results[1]
    assert Participant.objects.filter(group_id=group[0], user=recipient.actor).count() == 1
    assert MembershipDelivery.objects.count() == 1


def test_reciprocal_creation_locks_users_in_one_order(client):
    EmailAddress.objects.create(user=client.actor, email=client.actor.email, verified=True)
    recipient = account()
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(threaded, lambda: create_group(client.actor, body(recipient.actor.email))),
                   pool.submit(threaded, lambda: create_group(recipient.actor, body(client.actor.email)))]
        results = [future.result(timeout=10) for future in futures]
    assert all(len(result['linked_participant_ids']) == 1 for result in results)
    assert Group.objects.count() == 2


def test_two_workers_never_submit_same_membership_email(client, configured):
    account()
    create(client)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: threaded(lambda: send_membership_notifications(limit=1)), range(2)))
    assert sum(results) == 1 and len(configured) == 1
    assert MembershipDelivery.objects.get().state == 'sent'


def test_linked_recipient_deletion_cascades_membership_work_without_shared_ledger_loss(client, configured):
    from .portability import delete_account
    recipient = account()
    register(recipient)
    payload, _ = create(client)
    assert MembershipDelivery.objects.count() == 2
    delete_account(recipient.actor)
    assert not MembershipDelivery.objects.exists()
    assert Group.objects.filter(pk=payload['id']).exists()
    assert Participant.objects.get(pk=payload['participants'][1]['id']).user_id is None
    send_membership_notifications()
    assert not configured


def test_explicit_send_replay_after_recipient_registration_keeps_original_invitation(client, configured):
    payload, _ = create(client)
    path = f'/groups/{payload["id"]}/participants/{payload["participants"][1]["id"]}/email-invite'
    command = {'command_id': uid()}
    first = send(client, 'post', path, command)
    assert first.status_code == 200 and first.json()['linked_participant_ids'] == []
    account()
    assert send(client, 'post', path, command).json() == first.json()
    assert Participant.objects.get(pk=payload['participants'][1]['id']).user_id is None
    assert not MembershipDelivery.objects.exists() and len(configured) == 1


def test_concurrent_explicit_send_links_once_without_email_invite(client):
    from .email_invites import send_person_invite
    payload, _ = create(client)
    account()
    command = {'command_id': uid()}
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: threaded(lambda: send_person_invite(client.actor, payload['id'],
            payload['participants'][1]['id'], command, 'https://merosplit.example', 'synthetic-network')), range(2)))
    assert results[0] == results[1] and results[0]['linked_participant_ids'] == [payload['participants'][1]['id']]
    assert MembershipDelivery.objects.count() == 1 and not Invite.objects.exists()


def test_waiting_add_cannot_relink_deleted_recipient(client, group, monkeypatch):
    from . import membership
    from .collaboration import add_participant
    from .portability import delete_account
    recipient = account()
    recipient_id = recipient.actor.pk
    payload = {'command_id': uid(), 'id': uid(), 'name': 'Recipient', 'email': recipient.actor.email}
    entered = Event()
    original = membership.lock_link_users
    def locking(*args, **kwargs):
        entered.set()
        return original(*args, **kwargs)
    monkeypatch.setattr(membership, 'lock_link_users', locking)
    with ThreadPoolExecutor(max_workers=1) as pool:
        with transaction.atomic():
            get_user_model().objects.select_for_update(no_key=True).get(pk=recipient_id)
            future = pool.submit(threaded, lambda: add_participant(client.actor, group[0], payload))
            assert entered.wait(3)
            deadline = monotonic() + 3
            while monotonic() < deadline:
                with connection.cursor() as cursor:
                    cursor.execute("SELECT COUNT(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND pid<>pg_backend_pid()")
                    if cursor.fetchone()[0]:
                        break
                sleep(.01)
            else:
                pytest.fail('add did not wait on the recipient lock')
            delete_account(recipient.actor)
        result = future.result(timeout=10)
    assert result['linked_participant_ids'] == []
    assert Participant.objects.get(pk=payload['id']).user_id is None
    assert not MembershipDelivery.objects.exists() and not get_user_model().objects.filter(pk=recipient_id).exists()


def test_recipient_rate_budget_is_durable_and_receipt_replay_is_free(client):
    account(email_on=False)
    first = body()
    create(client, first)
    for _ in range(29):
        create(client)
    assert send(client, 'post', '/groups', body()).status_code == 429
    assert send(client, 'post', '/groups', first).status_code == 200
    assert Group.objects.count() == 30


def test_bulk_creation_charges_each_link_and_rejected_batch_rolls_back_budget(client):
    recipients = [account(f'bulk-{index}@example.com', email_on=False).actor.email for index in range(42)]

    def bulk(emails):
        payload = body()
        payload['is_direct'] = False
        payload['participants'] = [payload['participants'][0], *[
            {'id': uid(), 'name': f'Person {index}', 'email': email} for index, email in enumerate(emails)]]
        return payload

    first = bulk(recipients[:39])
    _, result = create(client, first)
    assert len(result['linked_participant_ids']) == 39
    assert send(client, 'post', '/groups', bulk(recipients[39:41])).status_code == 429
    assert Group.objects.count() == 1
    assert Participant.objects.exclude(user=client.actor).count() == 39
    # The rejected two-person batch must not spend its first person's quota.
    _, final = create(client, bulk(recipients[39:40]))
    assert len(final['linked_participant_ids']) == 1
    assert send(client, 'post', '/groups', bulk(recipients[40:])).status_code == 429
    assert send(client, 'post', '/groups', first).json() == result
    assert Group.objects.count() == 2
    assert Participant.objects.exclude(user=client.actor).count() == 40
