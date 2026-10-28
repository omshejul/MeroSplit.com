from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from io import StringIO
from uuid import uuid4

import pytest
from allauth.account.models import EmailAddress
from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.db import close_old_connections, connection, connections, transaction
from django.utils import timezone

from . import bill_chat as chat
from . import chat_notifications as notices
from .models import (
    BillChatAcceptance,
    BillChatBlock,
    BillChatDelivery,
    BillChatMessage,
    BillChatNotice,
    BillChatReport,
    CommandReceipt,
    Expense,
    ExpenseNotice,
    Group,
    NotificationPreference,
    Participant,
)
from .otp import EmailCodeLimited
from .portability import account_export, delete_account
from .test_api import authenticated_client, expense, send, uid
from .test_api import client as client
from .test_api import group as group
from .test_push import register
from .test_web_app import exported_app as exported_app

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture
def clock(monkeypatch):
    value = [timezone.now()]
    monkeypatch.setattr(timezone, 'now', lambda: value[0])
    return value


@pytest.fixture
def setup(client, group, settings, clock):
    settings.PUBLIC_WEB_URL = 'https://example.test'
    settings.PUSH_PROVIDER = 'expo'
    user = get_user_model().objects.create_user(username=uid(), email='synthetic@example.test')
    EmailAddress.objects.create(user=user, email=user.email, verified=True, primary=True)
    recipient = authenticated_client(user)
    Participant.objects.filter(pk=group[1][1]).update(user=user)
    for actor in [client.actor, user]:
        chat.accept_policy(actor, 1)
    NotificationPreference.objects.create(user=user, email_reminders=True, email_enabled_at=clock[0] - timedelta(seconds=1))
    body = expense(group[1])
    assert send(client, 'post', f'/groups/{group[0]}/expenses', body).status_code == 200
    path = f'/groups/{group[0]}/expenses/{body["id"]}/chat'
    return client, recipient, group[0], body['id'], path


@pytest.fixture
def providers(monkeypatch):
    calls = {'email': [], 'push': [], 'receipt': []}
    def email(recipient, subject, text, key, **kwargs):
        assert not connection.in_atomic_block
        calls['email'].append({'recipient': recipient, 'subject': subject, 'text': text, 'key': key, **kwargs})
        return f'fake-mail-{len(calls["email"])}'
    def push(device, data, **kwargs):
        assert not connection.in_atomic_block
        calls['push'].append({'device': device.pk, 'data': data, **kwargs})
        return f'fake-push-{len(calls["push"])}'
    def receipt(identifier):
        assert not connection.in_atomic_block
        calls['receipt'].append(identifier)
        return True
    monkeypatch.setattr(notices.email_delivery, 'send_email', email)
    monkeypatch.setattr(notices.push_provider, 'send_bill_notification', push)
    monkeypatch.setattr(notices.push_provider, 'check_bill_notification_receipt', receipt)
    return calls


def post(setup, text='A plain synthetic message', identifier=None):
    owner, _, _, _, path = setup
    response = send(owner, 'post', path, {'client_id': identifier or uid(), 'text': text})
    assert response.status_code == 200, response.content
    return response.json()


def page(setup, actor=None, query=''):
    response = send(actor or setup[1], 'get', setup[4] + query)
    assert response.status_code == 200, response.content
    return response.json()


def test_message_replay_conflict_rollback_and_finances_unchanged(setup):
    owner, recipient, gid, bill, path = setup
    before = (Group.objects.get(pk=gid).version, Expense.objects.get(pk=bill).version,
              CommandReceipt.objects.count(), ExpenseNotice.objects.count())
    key = uid()
    first = post(setup, identifier=key)
    assert post(setup, identifier=key) == first
    assert send(owner, 'post', path, {'client_id': key, 'text': 'Changed'}).status_code == 409
    assert BillChatMessage.objects.count() == BillChatNotice.objects.count() == 1
    with pytest.raises(RuntimeError), transaction.atomic():
        chat.send_message(owner.actor, gid, bill, uuid4(), 'Rolled back')
        raise RuntimeError('rollback')
    assert BillChatMessage.objects.count() == BillChatNotice.objects.count() == 1
    assert before == (Group.objects.get(pk=gid).version, Expense.objects.get(pk=bill).version,
                      CommandReceipt.objects.count(), ExpenseNotice.objects.count())
    assert page(setup)['unread'] == 1
    assert page(setup, owner)['unread'] == 0


def test_concurrent_lost_response_replay_has_one_message_and_intent(setup):
    owner, _, gid, bill, _ = setup
    key = uuid4()
    def write():
        close_old_connections()
        try:
            return chat.send_message(get_user_model().objects.get(pk=owner.actor.pk), gid, bill, key, 'Same immutable input')['id']
        finally:
            connections.close_all()
    with ThreadPoolExecutor(max_workers=2) as pool:
        result = list(pool.map(lambda _: write(), range(2)))
    assert result[0] == result[1]
    assert BillChatMessage.objects.count() == BillChatNotice.objects.count() == 1


def test_equal_timestamps_keysets_concurrent_insert_and_scoped_ack(setup):
    owner, recipient, gid, bill, path = setup
    now = timezone.now() - timedelta(minutes=2)
    BillChatMessage.objects.bulk_create([BillChatMessage(expense_id=bill, sender=owner.actor, client_id=uuid4(), text=str(i), created_at=now) for i in range(75)])
    latest = page(setup)
    assert len(latest['messages']) == 50
    new = post(setup)
    older = page(setup, query='?before=' + latest['older_cursor'])
    assert len(older['messages']) == 25
    ids = [int(r['id']) for r in older['messages'] + latest['messages']]
    assert ids == sorted(set(ids)) and len(ids) == 75
    incremental = page(setup, query='?after=' + latest['after_cursor'])
    assert [r['id'] for r in incremental['messages']] == [new['id']]
    assert page(setup)['unread'] == 1
    # Merely fetching old or new pages is never a read acknowledgement.
    assert not BillChatNotice.objects.get().seen_at
    stale = older['messages'][0]['seen_token']
    assert send(recipient, 'post', path + '/seen', {'tokens': [stale]}).json() == {'seen': 0}
    assert send(owner, 'post', path + '/seen', {'tokens': [incremental['messages'][0]['seen_token']]}).status_code == 422
    assert send(recipient, 'post', path + '/seen', {'tokens': [incremental['messages'][0]['seen_token']]}).json() == {'seen': 1}
    assert page(setup)['unread'] == 0
    assert send(recipient, 'get', path + '?limit=51').status_code == 422
    assert send(recipient, 'get', path + '?after=forged').status_code == 422


def test_notification_audience_is_financial_involvement_not_authors(setup, group):
    owner, recipient, gid, bill, path = setup
    bystander = get_user_model().objects.create_user(username=uid(), email='bystander@example.test')
    Participant.objects.filter(pk=group[1][2]).update(user=bystander)
    Expense.objects.filter(pk=bill).update(paid={group[1][0]: '10000'}, shares={group[1][1]: '10000'})
    chat.accept_policy(bystander, 1)
    chat.send_message(bystander, gid, bill, uuid4(), 'I can join a visible conversation')
    post(setup)
    assert not BillChatNotice.objects.filter(recipient=bystander).exists()
    assert chat.chat_inbox(bystander)['conversations'] == []
    assert set(BillChatNotice.objects.values_list('recipient_id', flat=True)) == {owner.actor.pk, recipient.actor.pk}


@pytest.mark.parametrize('change', ['remove', 'archive', 'reverse', 'involvement'])
def test_current_access_and_readonly_history_cancel_delivery(setup, clock, providers, change):
    owner, recipient, gid, bill, path = setup
    post(setup)
    if change == 'remove':
        Participant.objects.filter(group_id=gid, user=recipient.actor).update(removed=True)
        assert send(recipient, 'get', path).status_code == 404
        assert send(recipient, 'post', path, {'client_id': uid(), 'text': 'Denied'}).status_code == 404
    elif change == 'archive':
        Group.objects.filter(pk=gid).update(archived=True)
    elif change == 'reverse':
        Expense.objects.filter(pk=bill).update(deleted=True)
    else:
        Expense.objects.filter(pk=bill).update(shares={}, paid={})
        assert page(setup)['unread'] == 0
    if change in {'archive', 'reverse'}:
        assert len(page(setup)['messages']) == 1 and not page(setup)['can_send']
        assert send(recipient, 'post', path, {'client_id': uid(), 'text': 'Denied'}).status_code == 409
    clock[0] += timedelta(minutes=11)
    notices.send_chat_notifications()
    assert not providers['email'] and not providers['push']


def test_policy_validation_and_filter_preserve_no_stray_rows(setup):
    owner, _, _, _, path = setup
    BillChatAcceptance.objects.filter(user=owner.actor).delete()
    assert send(owner, 'post', path, {'client_id': uid(), 'text': 'Hello'}).status_code == 409
    assert send(owner, 'put', '/me/chat-policy', {'version': 99}).status_code == 409
    assert send(owner, 'put', '/me/chat-policy', {'version': 1}).status_code == 200
    for text in ['', ' ', 'x' * 2001, 'i will kill you', '\x01hidden']:
        assert send(owner, 'post', path, {'client_id': uid(), 'text': text}).status_code == 422
    assert not BillChatMessage.objects.exists()
    post(setup, '<script>alert(1)</script>\nPlain text only')
    assert page(setup)['messages'][0]['text'].startswith('<script>')


def test_blocks_reports_operator_hide_and_prospective_unblock(setup, clock, providers):
    owner, recipient, gid, bill, path = setup
    first = post(setup)
    before = (Group.objects.get(pk=gid).version, Expense.objects.get(pk=bill).version)
    body = {'message_id': first['id'], 'kind': 'message', 'reason': 'Synthetic report reason'}
    result = send(recipient, 'post', path + '/report', body)
    assert result.status_code == 200
    assert send(recipient, 'post', path + '/report', body).json() == result.json()
    assert send(owner, 'post', path + '/report', body).status_code == 404
    assert send(recipient, 'put', path + '/block', {'user_id': owner.actor.pk, 'blocked': True}).status_code == 200
    assert page(setup)['messages'] == [] and page(setup)['unread'] == 0
    clock[0] += timedelta(seconds=1)
    post(setup, 'Blocked sender')
    assert page(setup)['unread'] == 0
    assert send(recipient, 'put', path + '/block', {'user_id': owner.actor.pk, 'blocked': False}).status_code == 200
    assert len(page(setup)['messages']) == 2 and page(setup)['unread'] == 0
    clock[0] += timedelta(seconds=1)
    post(setup, 'New after unblock')
    assert page(setup)['unread'] == 1
    chat.hide_reported_message(result.json()['id'])
    assert first['id'] in page(setup, query='?known=' + first['id'])['removed_ids']
    output = StringIO()
    call_command('review_bill_chat', stdout=output)
    assert 'Synthetic report reason' not in output.getvalue()
    assert before == (Group.objects.get(pk=gid).version, Expense.objects.get(pk=bill).version)
    assert BillChatReport.objects.get().resolution == 'hidden'


def test_email_ten_minutes_exact_visibility_cancel_and_busy_coalescing(setup, clock, providers):
    first = post(setup)
    clock[0] += timedelta(minutes=9)
    assert notices.send_chat_notifications() == 0
    post(setup, 'Newer unread text')
    clock[0] += timedelta(minutes=1, seconds=1)
    notices.send_chat_notifications()
    assert len(providers['email']) == 1 and BillChatDelivery.objects.filter(channel='email').count() == 1
    assert BillChatNotice.objects.filter(email_delivery__isnull=False).count() == 2
    mail = providers['email'][0]
    assert '/chat' in mail['text'] and first['text'] not in mail['text'] and 'Newer unread text' not in str(mail['payload'])
    post(setup, 'Actually viewed')
    last = page(setup)['messages'][-1]
    assert send(setup[1], 'post', setup[4] + '/seen', {'tokens': [last['seen_token']]}).json() == {'seen': 1}
    clock[0] += timedelta(minutes=11)
    notices.send_chat_notifications()
    assert len(providers['email']) == 1


def test_six_account_reminders_same_day_have_no_copied_daily_cap(setup, clock, providers):
    for i in range(6):
        post(setup, f'Message {i}')
        clock[0] += timedelta(minutes=11)
        notices.send_chat_notifications()
    assert len(providers['email']) == 6
    assert BillChatDelivery.objects.filter(state='sent', channel='email').count() == 6


def test_held_conversation_does_not_head_block_another(setup, clock, providers, group):
    post(setup)
    clock[0] += timedelta(minutes=11)
    held = notices.create_chat_email()
    BillChatDelivery.objects.filter(pk=held).update(state='held')
    post(setup, 'Oldest unassigned notice in held A')
    second = expense(group[1])
    assert send(setup[0], 'post', f'/groups/{group[0]}/expenses', second).status_code == 200
    clock[0] += timedelta(seconds=1)
    chat.send_message(setup[0].actor, group[0], second['id'], uuid4(), 'Ready conversation B')
    clock[0] += timedelta(minutes=11)
    notices.send_chat_notifications()
    assert len(providers['email']) == 1
    job = BillChatDelivery.objects.get(state='sent')
    assert str(job.expense_id) == second['id']
    assert BillChatDelivery.objects.get(pk=held).state == 'held'


def test_local_rate_waits_do_not_spend_provider_attempts(setup, clock, providers, monkeypatch):
    post(setup)
    clock[0] += timedelta(minutes=11)
    original = notices.consume_limits
    def limited(_limits):
        raise EmailCodeLimited()
    monkeypatch.setattr(notices, 'consume_limits', limited)
    for _ in range(12):
        notices.send_chat_notifications(limit=1)
        clock[0] += timedelta(minutes=1, seconds=1)
        row = BillChatDelivery.objects.get()
        assert row.attempts == 0 and row.first_attempt_at is None and row.state == 'pending'
    assert providers['email'] == []
    monkeypatch.setattr(notices, 'consume_limits', original)
    notices.send_chat_notifications(limit=1)
    assert len(providers['email']) == 1 and BillChatDelivery.objects.get().attempts == 1


def test_mail_lost_response_retries_one_frozen_idempotency_key(setup, clock, providers, monkeypatch):
    post(setup)
    clock[0] += timedelta(minutes=11)
    original = notices.email_delivery.send_email
    def uncertain(*args, **kwargs):
        original(*args, **kwargs)
        raise notices.email_delivery.EmailDeliveryUnavailable()
    monkeypatch.setattr(notices.email_delivery, 'send_email', uncertain)
    notices.send_chat_notifications(limit=1)
    clock[0] += timedelta(minutes=2)
    monkeypatch.setattr(notices.email_delivery, 'send_email', original)
    notices.send_chat_notifications(limit=1)
    assert len(providers['email']) == 2 and providers['email'][0] == providers['email'][1]
    assert BillChatDelivery.objects.get().state == 'sent'


@pytest.mark.parametrize('change', ['master', 'email', 'block', 'opt_out'])
def test_prospective_off_on_does_not_replay_old_unread(setup, clock, providers, change):
    owner, recipient, _, _, path = setup
    post(setup)
    clock[0] += timedelta(minutes=11)
    if change == 'opt_out':
        job = BillChatDelivery.objects.get(pk=notices.create_chat_email())
        from .bill_email import opt_out
        assert opt_out(job.id, notices._proof(job)) == {'stopped': True}
    elif change == 'block':
        chat.block_user(recipient.actor, setup[2], setup[3], owner.actor.pk, True)
        clock[0] += timedelta(seconds=1)
        chat.block_user(recipient.actor, setup[2], setup[3], owner.actor.pk, False)
    else:
        body = {'expense_updates': change != 'master', 'email_reminders': change != 'email'}
        assert send(recipient, 'put', '/me/notifications/preferences', body).status_code == 200
        clock[0] += timedelta(seconds=1)
        assert send(recipient, 'put', '/me/notifications/preferences', {'expense_updates': True, 'email_reminders': True}).status_code == 200
    notices.send_chat_notifications()
    assert not providers['email']


def test_immediate_unclaimed_notice_grants_no_access_or_login(setup, clock, providers, group):
    from .models import EmailLoginGrant, Invite
    Participant.objects.filter(pk=group[1][2]).update(contact_email='unclaimed@example.test')
    before = (EmailLoginGrant.objects.count(), Invite.objects.count(), get_user_model().objects.count())
    post(setup)
    notices.send_chat_notifications()
    assert len(providers['email']) == 1 and providers['email'][0]['recipient'] == 'unclaimed@example.test'
    assert before == (EmailLoginGrant.objects.count(), Invite.objects.count(), get_user_model().objects.count())
    assert Participant.objects.get(pk=group[1][2]).user_id is None
    assert '/chat' in providers['email'][0]['text'] and 'proof=' not in providers['email'][0]['text'].split('Stop')[0]


def test_push_preview_is_not_read_or_delivered_and_data_has_no_text(setup, clock, providers):
    device = register(setup[1])
    response = send(setup[1], 'put', f'/me/push-devices/{device.id}', {'provider': device.provider, 'token': device.token, 'platform': device.platform, 'bill_chat': True})
    assert response.status_code == 200
    first = post(setup, 'Private synthetic text')
    notices.send_chat_notifications()
    assert len(providers['push']) == 1
    assert providers['push'][0]['body'] == first['text']
    assert first['text'] not in str(providers['push'][0]['data'])
    assert providers['push'][0]['title'] == 'A · Test expense'
    job = BillChatDelivery.objects.get(channel='push')
    assert job.state == 'queued' and job.provider_id and not job.notice.seen_at
    clock[0] += timedelta(minutes=15)
    notices.send_chat_notifications()
    assert len(providers['push']) == len(providers['receipt']) == 1
    assert BillChatDelivery.objects.get(channel='push').state == 'sent'
    assert page(setup)['unread'] == 1


def test_export_and_account_deletion_remove_own_text_reports_blocks_only(setup):
    owner, recipient, gid, bill, path = setup
    first = post(setup)
    chat.send_message(recipient.actor, gid, bill, uuid4(), 'Other author text')
    chat.report_message(recipient.actor, gid, bill, first['id'], 'user', 'Private reason')
    chat.block_user(recipient.actor, gid, bill, owner.actor.pk, True)
    exported = account_export(recipient.actor)
    assert len(exported['chat']['reports']) == len(exported['chat']['blocks']) == len(exported['chat']['policy_acceptances']) == 1
    assert exported['chat']['authored_messages'][0]['text'] == 'Other author text'
    assert first['text'] not in str(exported['groups'])
    delete_account(recipient.actor)
    assert not BillChatMessage.objects.filter(text='Other author text').exists()
    assert not BillChatReport.objects.exists() and not BillChatBlock.objects.exists()
    assert BillChatMessage.objects.get().text == first['text']
    assert Expense.objects.filter(pk=bill).exists()


def test_old_device_keeps_financial_push_but_chat_uses_unread_email_fallback(setup, clock, providers):
    from .push import fanout_due_notices, send_pending_bill_notifications
    owner, recipient, gid, bill, path = setup
    device = register(recipient)
    assert not device.bill_chat
    post(setup)
    assert BillChatNotice.objects.filter(recipient=recipient.actor, seen_at__isnull=True).count() == 1
    assert not BillChatDelivery.objects.filter(channel='push').exists()
    ExpenseNotice.objects.filter(expense_id=bill).update(push_due_at=clock[0])
    fanout_due_notices()
    send_pending_bill_notifications()
    assert len(providers['push']) == 1 and providers['push'][0]['data']['type'] == 'new_bill'
    clock[0] += timedelta(minutes=11)
    notices.send_chat_notifications()
    assert len(providers['email']) == 1 and len(providers['push']) == 1


def test_explicit_device_capability_is_rechecked_without_changing_financial_binding(setup, providers):
    owner, recipient, gid, bill, path = setup
    device = register(recipient)
    payload = {'provider': device.provider, 'token': device.token, 'platform': device.platform, 'bill_chat': True}
    assert send(recipient, 'put', f'/me/push-devices/{device.id}', payload).status_code == 200
    device.refresh_from_db()
    assert device.bill_chat and device.revision == 1
    post(setup)
    assert BillChatDelivery.objects.filter(channel='push').count() == 1
    # An old client re-registering the same binding omits the capability.
    del payload['bill_chat']
    assert send(recipient, 'put', f'/me/push-devices/{device.id}', payload).status_code == 200
    device.refresh_from_db()
    assert not device.bill_chat and device.revision == 1
    notices.send_chat_notifications()
    assert not providers['push'] and BillChatDelivery.objects.get(channel='push').state == 'cancelled'
    assert page(setup)['unread'] == 1


def test_cross_account_group_report_block_and_future_ack_are_denied(setup):
    from ninja.errors import HttpError

    from .test_collaboration import account
    owner, recipient, gid, bill, path = setup
    first = post(setup)
    outsider = account()
    for suffix in ['', '/status']:
        assert send(outsider, 'get', path + suffix).status_code == 404
    assert send(outsider, 'post', path + '/report', {'message_id': first['id'], 'kind': 'user', 'reason': 'No access'}).status_code == 404
    assert send(recipient, 'put', path + '/block', {'user_id': outsider.actor.pk, 'blocked': True}).status_code == 404
    future = chat._token(recipient.actor, Expense.objects.get(pk=bill), 'seen', int(first['id']) + 100)
    assert send(recipient, 'post', path + '/seen', {'tokens': [future]}).status_code == 422
    assert not BillChatNotice.objects.get().seen_at
    with pytest.raises(HttpError):
        chat.chat_page(recipient.actor, gid, bill, after=chat._token(owner.actor, Expense.objects.get(pk=bill), 'after', first['id']))
    assert send(recipient, 'get', path + '/status')['Cache-Control'] == 'private, no-store'


def test_repeated_unblock_is_idempotent_and_does_not_erase_new_unread(setup, clock):
    owner, recipient, gid, bill, path = setup
    chat.block_user(recipient.actor, gid, bill, owner.actor.pk, True)
    clock[0] += timedelta(seconds=1)
    chat.block_user(recipient.actor, gid, bill, owner.actor.pk, False)
    clock[0] += timedelta(seconds=1)
    post(setup)
    assert page(setup)['unread'] == 1
    clock[0] += timedelta(seconds=1)
    chat.block_user(recipient.actor, gid, bill, owner.actor.pk, False)
    assert page(setup)['unread'] == 1


def test_post_rate_is_bounded_but_accepted_replay_does_not_consume_quota(setup):
    owner, recipient, gid, bill, path = setup
    first = None
    for i in range(20):
        key = uid()
        post(setup, f'Synthetic bounded message {i}', key)
        if i == 0:
            first = key
    assert send(owner, 'post', path, {'client_id': uid(), 'text': 'Over limit'}).status_code == 429
    post(setup, 'Synthetic bounded message 0', first)
    assert BillChatMessage.objects.count() == 20


def test_chat_policy_and_reports_do_not_grant_operator_access(setup):
    from django.core.management.base import CommandError
    owner = setup[0]
    response = owner.get('/chat-policy')
    assert response.status_code == 200 and b'mail@merosplit.com' in response.content
    assert b'not end-to-end encrypted' in response.content
    with pytest.raises(CommandError, match='interactive'):
        call_command('review_bill_chat', show=uid(), stdout=StringIO())


def test_seen_oldest_message_restarts_delay_for_only_younger_unread(setup, clock, providers):
    oldest = post(setup)
    clock[0] += timedelta(minutes=9)
    post(setup, 'Younger unread')
    clock[0] += timedelta(minutes=1, seconds=1)
    job = notices.create_chat_email()
    row = next(row for row in page(setup)['messages'] if row['id'] == oldest['id'])
    assert send(setup[1], 'post', setup[4] + '/seen', {'tokens': [row['seen_token']]}).json() == {'seen': 1}
    notices.send_chat_notifications(limit=1)
    assert providers['email'] == [] and BillChatDelivery.objects.get(pk=job).attempts == 0
    clock[0] += timedelta(minutes=9)
    notices.send_chat_notifications(limit=1)
    assert len(providers['email']) == 1


def test_reading_all_messages_releases_held_email_without_backlog_replay(setup, clock, providers):
    post(setup)
    clock[0] += timedelta(minutes=11)
    job = notices.create_chat_email()
    BillChatDelivery.objects.filter(pk=job).update(state='held')
    tokens = [row['seen_token'] for row in page(setup)['messages']]
    assert send(setup[1], 'post', setup[4] + '/seen', {'tokens': tokens}).json() == {'seen': 1}
    assert BillChatDelivery.objects.get(pk=job).state == 'cancelled'
    post(setup, 'Future conversation notice')
    clock[0] += timedelta(minutes=11)
    notices.send_chat_notifications()
    assert len(providers['email']) == 1


def test_chat_email_uses_browser_route_outside_native_associations_with_ordinary_auth(setup, clock, settings, exported_app):
    import fnmatch
    import json
    import re
    from pathlib import Path
    from urllib.parse import urlsplit

    from config.associations import APPLE_ASSOCIATION
    from config.web import web_app
    from django.test import Client
    from django.urls import resolve

    from .models import EmailLoginGrant, Invite
    from .test_web_app import body

    first = post(setup, 'Private message that must never appear in email')
    before = (EmailLoginGrant.objects.count(), Invite.objects.count())
    clock[0] += timedelta(minutes=11)
    job = BillChatDelivery.objects.get(pk=notices.create_chat_email())
    links = re.findall(r'https://[^\s<]+', job.payload['text'])
    url = next(link for link in links if '/app/chat/' in link)
    path = urlsplit(url).path
    assert path == f'/app/chat/{setup[2]}/{setup[3]}'
    assert first['text'] not in str(job.payload) and 'proof=' not in url
    apple = APPLE_ASSOCIATION['applinks']['details'][0]['components']
    assert not any(fnmatch.fnmatchcase(path, row['/']) for row in apple)
    app = json.loads((Path(settings.BASE_DIR).parent / 'mobile' / 'app.json').read_text())
    prefixes = [row['pathPrefix'] for item in app['expo']['android']['intentFilters'] for row in item['data']]
    assert not any(path.startswith(prefix) for prefix in prefixes)
    assert resolve(path).func is web_app
    shell = Client().get(path)
    assert shell.status_code == 200 and first['text'].encode() not in body(shell)
    assert send(Client(), 'get', setup[4]).status_code == 401
    assert page(setup)['messages'][0]['id'] == first['id']
    assert before == (EmailLoginGrant.objects.count(), Invite.objects.count())
    print('chat email web contract: ' + json.dumps({'url': url, 'groupId': setup[2], 'expenseId': setup[3]}))


def test_chat_inbox_discovers_exact_conversation_without_opening_bill_or_marking_seen(setup):
    owner, recipient, gid, bill, path = setup
    post(setup)
    versions = (Group.objects.get(pk=gid).version, Expense.objects.get(pk=bill).version, CommandReceipt.objects.count())
    response = send(recipient, 'get', '/me/chat-conversations')
    assert response.status_code == 200
    row = response.json()['conversations'][0]
    assert row == {'group_id': gid, 'expense_id': bill, 'group': 'Functional test', 'bill': 'Test expense', 'unread': 1}
    assert 'text' not in row
    assert send(owner, 'get', '/me/chat-conversations').json()['conversations'] == []
    assert not BillChatNotice.objects.get().seen_at
    assert versions == (Group.objects.get(pk=gid).version, Expense.objects.get(pk=bill).version, CommandReceipt.objects.count())
    assert response['Cache-Control'] == 'private, no-store'


@pytest.mark.parametrize('change', ['blocked', 'removed', 'no_involvement', 'not_linked'])
def test_chat_inbox_rechecks_current_recipient_access_and_blocks(setup, change):
    owner, recipient, gid, bill, path = setup
    post(setup)
    if change == 'blocked':
        chat.block_user(recipient.actor, gid, bill, owner.actor.pk, True)
    elif change == 'removed':
        Participant.objects.filter(group_id=gid, user=recipient.actor).update(removed=True)
    elif change == 'no_involvement':
        Expense.objects.filter(pk=bill).update(paid={}, shares={})
    else:
        Participant.objects.filter(group_id=gid, user=recipient.actor).update(user=None)
    response = send(recipient, 'get', '/me/chat-conversations')
    assert response.status_code == 200 and response.json()['conversations'] == []
    assert not BillChatNotice.objects.get().seen_at


def test_chat_inbox_pages_are_bounded_signed_account_scoped_and_do_not_ack(setup):
    from django.test.utils import CaptureQueriesContext

    owner, recipient, gid, bill, path = setup
    person = Participant.objects.get(group_id=gid, user=recipient.actor)
    original = Expense.objects.get(pk=bill)
    for _ in range(23):
        original.id = uuid4()
        original.save(force_insert=True)
        message = BillChatMessage.objects.create(expense=original, sender=owner.actor, client_id=uuid4(), text='Unread private body', created_at=timezone.now())
        BillChatNotice.objects.create(message=message, participant=person, recipient=recipient.actor, created_at=timezone.now())
    with CaptureQueriesContext(connection) as queries:
        first = chat.chat_inbox(recipient.actor)
    assert len(queries) <= 3 and len(first['conversations']) == 20
    second = chat.chat_inbox(recipient.actor, before=first['next_cursor'])
    assert len(second['conversations']) == 3 and second['next_cursor'] is None
    ids = [row['expense_id'] for row in first['conversations'] + second['conversations']]
    assert len(set(ids)) == 23
    assert send(owner, 'get', '/me/chat-conversations?before=' + first['next_cursor']).status_code == 422
    assert send(recipient, 'get', '/me/chat-conversations?limit=21').status_code == 422
    assert not BillChatNotice.objects.filter(seen_at__isnull=False).exists()


def test_cloudflare_uncertain_chat_delivery_holds_immediately_without_another_send(setup, clock, providers, monkeypatch, settings):
    settings.EMAIL_PROVIDER = 'cloudflare'
    post(setup)
    clock[0] += timedelta(minutes=11)
    calls = []
    def held(*args, **kwargs):
        calls.append(1)
        raise notices.email_delivery.EmailDeliveryHeld()
    monkeypatch.setattr(notices.email_delivery, 'send_email', held)
    notices.send_chat_notifications(limit=1)
    row = BillChatDelivery.objects.get(channel='email')
    assert row.state == 'held' and row.payload['_email_provider'] == 'cloudflare'
    frozen = row.payload
    clock[0] += timedelta(minutes=5)
    notices.send_chat_notifications(limit=1)
    row.refresh_from_db()
    assert calls == [1] and row.payload == frozen and row.attempts == 1


def test_chat_push_summary_omits_hidden_and_blocked_messages(setup, providers):
    device = register(setup[1])
    send(setup[1], 'put', f'/me/push-devices/{device.id}', {
        'provider': device.provider, 'token': device.token, 'platform': device.platform, 'bill_chat': True})
    post(setup, 'First message')
    newest = post(setup, 'Second message')
    hidden = post(setup, 'Hidden message')
    BillChatMessage.objects.filter(pk=hidden['id']).update(hidden_at=timezone.now())
    notices.send_chat_notifications()
    assert len(providers['push']) == 2
    for payload in providers['push']:
        assert payload['title'] == 'Test expense · 2 new messages'
        assert 'First message' in payload['body'] and 'Second message' in payload['body']
        assert 'Hidden message' not in payload['body']
        assert payload['conversation_id'] == f'chat/{setup[1].actor.pk}/{setup[3]}'
        assert payload['data']['message_id'] == newest['id']
        assert payload['data']['event_id'] == str(BillChatNotice.objects.get(message_id=newest['id']).pk)
    assert len({payload['conversation_id'] for payload in providers['push']}) == 1


@pytest.mark.parametrize('change', ['block', 'remove', 'hide', 'archive', 'delete', 'logout', 'disable'])
def test_chat_preview_never_bypasses_delivery_checks(setup, providers, change):
    device = register(setup[1])
    send(setup[1], 'put', f'/me/push-devices/{device.id}', {
        'provider': device.provider, 'token': device.token, 'platform': device.platform, 'bill_chat': True})
    message = post(setup, 'Should not leave the server')
    if change == 'block':
        BillChatBlock.objects.create(owner=setup[1].actor, blocked=setup[0].actor, active=True, changed_at=timezone.now())
    elif change == 'remove':
        Participant.objects.filter(group_id=setup[2], user=setup[1].actor).update(removed=True)
    elif change == 'hide':
        BillChatMessage.objects.filter(pk=message['id']).update(hidden_at=timezone.now())
    elif change == 'archive':
        Group.objects.filter(pk=setup[2]).update(archived=True)
    elif change == 'delete':
        Expense.objects.filter(pk=setup[3]).update(deleted=True)
    elif change == 'logout':
        device.session.delete()
    else:
        NotificationPreference.objects.filter(user=setup[1].actor).update(expense_updates=False)
    notices.send_chat_notifications()
    assert not providers['push']


@pytest.mark.parametrize('raw,expected', [
    ('  Reuben\n Shejul  ', 'Reuben Shejul'),
    ('\u202eevil\u202c\x00', 'evil'),
    ('👨\u200d👩\u200d👧', '👨\u200d👩\u200d👧'),
    ('   ', 'Fallback'),
    ('x' * 100, 'x' * 19 + '…'),
])
def test_notification_preview_sanitizes_and_bounds_text(raw, expected):
    assert notices._preview(raw, 20, 'Fallback') == expected


def test_chat_preview_has_safe_missing_names_and_bounded_unicode(setup, providers):
    device = register(setup[1])
    send(setup[1], 'put', f'/me/push-devices/{device.id}', {
        'provider': device.provider, 'token': device.token, 'platform': device.platform, 'bill_chat': True})
    post(setup, '😀' * 1000)
    Participant.objects.filter(group_id=setup[2], user=setup[0].actor).update(name=' ', display_name_override='')
    Expense.objects.filter(pk=setup[3]).update(description=' ')
    notices.send_chat_notifications()
    payload = providers['push'][0]
    assert payload['title'] == 'Someone · Bill conversation'
    assert len(payload['body']) == 180 and payload['body'].endswith('…')


def test_chat_preview_cancels_if_read_during_dispatch(setup, providers, monkeypatch):
    device = register(setup[1])
    send(setup[1], 'put', f'/me/push-devices/{device.id}', {
        'provider': device.provider, 'token': device.token, 'platform': device.platform, 'bill_chat': True})
    post(setup)
    original = notices.chat_push_content
    def read_before_preview(job):
        BillChatNotice.objects.filter(pk=job.notice_id).update(seen_at=timezone.now())
        return original(job)
    monkeypatch.setattr(notices, 'chat_push_content', read_before_preview)
    notices.send_chat_notifications()
    assert not providers['push']
    assert BillChatDelivery.objects.get(channel='push').state == 'cancelled'
