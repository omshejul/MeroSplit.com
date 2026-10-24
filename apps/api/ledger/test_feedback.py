import json
from datetime import timedelta
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

import pytest
from django.db import connection
from django.test import Client
from django.utils import timezone

from . import feedback
from .models import Feedback
from .portability import account_export
from .test_api import client as client
from .test_api import send

pytestmark = pytest.mark.django_db(transaction=True)


def test_feedback_auth_validation_and_replay(client):
    identifier = str(uuid4())
    body = {'id': identifier, 'text': '  Make adding dinner faster  '}
    assert send(Client(), 'post', '/me/feedback', body).status_code == 401
    for text in ['', '  ', 'x' * 2001, 123]:
        assert send(client, 'post', '/me/feedback', {**body, 'text': text}).status_code == 422
    assert Feedback.objects.count() == 0
    for _ in range(2):
        response = send(client, 'post', '/me/feedback', body)
        assert response.status_code == 200 and response.json() == {'id': identifier, 'saved': True}
    assert Feedback.objects.count() == 1
    row = Feedback.objects.get()
    assert row.user == client.actor and row.text == body['text'].strip() and row.notify_state == 'pending'
    assert send(client, 'post', '/me/feedback', {**body, 'text': 'different'}).status_code == 409
    assert row.text == Feedback.objects.get().text
    assert str(account_export(client.actor)['feedback'][0]['id']) == identifier


def test_feedback_cross_account_id_and_rate_limit(client):
    from django.contrib.auth import get_user_model

    from .test_api import authenticated_client
    other = get_user_model().objects.create_user(username='feedback-other', email='other@example.invalid')
    body = {'id': str(uuid4()), 'text': 'First feedback'}
    assert send(client, 'post', '/me/feedback', body).status_code == 200
    assert send(authenticated_client(other), 'post', '/me/feedback', body).status_code == 409
    for _ in range(19):
        Feedback.objects.create(id=uuid4(), user=client.actor, text='Synthetic limit fixture')
    assert send(client, 'post', '/me/feedback', {'id': str(uuid4()), 'text': 'One more'}).status_code == 429
    assert send(client, 'post', '/me/feedback', body).status_code == 200
    client.actor.delete()
    assert not Feedback.objects.exists()


def test_notify_worker_is_opt_in_single_attempt_and_outside_transaction(client, settings, monkeypatch):
    row = Feedback.objects.create(id=uuid4(), user=client.actor, text='Worker fixture')
    calls = []
    def deliver(value):
        assert not connection.in_atomic_block
        calls.append(value.id)
    monkeypatch.setattr(feedback, 'notify', deliver)
    settings.FEEDBACK_NOTIFY_ENABLED = False
    assert feedback.send_feedback_notifications() == 0 and not calls
    settings.FEEDBACK_NOTIFY_ENABLED = True
    assert feedback.send_feedback_notifications() == 1
    row.refresh_from_db()
    assert row.notify_state == 'accepted' and calls == [row.id]
    assert feedback.send_feedback_notifications() == 0


def test_uncertain_and_abandoned_notify_are_held_without_resend(client, settings, monkeypatch):
    settings.FEEDBACK_NOTIFY_ENABLED = True
    row = Feedback.objects.create(id=uuid4(), user=client.actor, text='Uncertain')
    stale = Feedback.objects.create(id=uuid4(), user=client.actor, text='Interrupted', notify_state='sending', attempted_at=timezone.now() - timedelta(minutes=3))
    calls = []
    def deliver(value):
        calls.append(value.id)
        raise TimeoutError('Unknown acceptance')
    monkeypatch.setattr(feedback, 'notify', deliver)
    assert feedback.send_feedback_notifications() == 1
    assert feedback.send_feedback_notifications() == 0
    assert calls == [row.id]
    assert set(Feedback.objects.filter(id__in=[row.id, stale.id]).values_list('notify_state', flat=True)) == {'held'}


def test_reserved_demo_feedback_is_saved_without_real_notification(client, settings, monkeypatch):
    settings.FEEDBACK_NOTIFY_ENABLED = True
    monkeypatch.setattr(feedback, 'review_ids', lambda: {client.actor.pk})
    monkeypatch.setattr(feedback, 'notify', lambda row: pytest.fail('No live store-demo notification'))
    assert send(client, 'post', '/me/feedback', {'id': str(uuid4()), 'text': 'Store demo'}).status_code == 200
    assert Feedback.objects.get().notify_state == 'held'
    assert feedback.send_feedback_notifications() == 0


def test_browser_feedback_requires_csrf(client):
    browser = Client(enforce_csrf_checks=True)
    browser.force_login(client.actor, backend='allauth.account.auth_backends.AuthenticationBackend')
    assert send(browser, 'post', '/me/feedback', {'id': str(uuid4()), 'text': 'CSRF fixture'}).status_code == 403
    assert not Feedback.objects.exists()


def test_deactivated_actor_cannot_create_or_replay_feedback(client):
    from ninja.errors import HttpError
    identifier = uuid4()
    feedback.submit(client.actor, identifier, 'Before deactivation')
    type(client.actor).objects.filter(pk=client.actor.pk).update(is_active=False)
    for value in [identifier, uuid4()]:
        with pytest.raises(HttpError) as error:
            feedback.submit(client.actor, value, 'Before deactivation')
        assert error.value.status_code == 401
    assert Feedback.objects.count() == 1


@pytest.mark.parametrize('limit, expected', [(100, 5), (3, 3)])
def test_feedback_batch_does_not_starve_the_existing_worker(settings, monkeypatch, limit, expected):
    from io import StringIO

    from django.core.management import call_command

    from .management.commands import send_bill_notifications as command
    settings.PUSH_PROVIDER = 'expo'
    calls = {}
    for name in ['send_pending_bill_notifications', 'check_pending_bill_receipts', 'send_pending_digests',
                 'send_pending_bill_emails', 'send_chat_notifications', 'send_balance_statements',
                 'send_membership_notifications', 'send_feedback_notifications']:
        def fake(*, limit, label=name):
            calls[label] = limit
            return 0
        monkeypatch.setattr(command, name, fake)
    call_command('send_bill_notifications', limit=limit, stdout=StringIO())
    assert calls.pop('send_feedback_notifications') == expected
    assert set(calls.values()) == {limit}


def test_overlapping_workers_cannot_send_feedback_twice(client, settings, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event

    from django.db import close_old_connections, connections

    settings.FEEDBACK_NOTIFY_ENABLED = True
    row = Feedback.objects.create(id=uuid4(), user=client.actor, text='Concurrent fixture')
    started, release = Event(), Event()
    calls = []
    def deliver(value):
        calls.append(value.id)
        started.set()
        assert release.wait(5)
    def worker():
        close_old_connections()
        try:
            return feedback.send_feedback_notifications()
        finally:
            connections.close_all()
    monkeypatch.setattr(feedback, 'notify', deliver)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(worker)
        assert started.wait(5)
        try:
            assert pool.submit(worker).result(timeout=5) == 0
        finally:
            release.set()
        assert first.result(timeout=5) == 1
    assert calls == [row.id]


@pytest.mark.parametrize('response, accepted', [(b'{"ok":true}', True), (b'message sent', True), (b'{"message":"message sent"}', True), (b'{"ok":false,"error":"denied"}', False), (b'{}', False)])
def test_notify_matches_skill_route_and_escapes_untrusted_feedback(client, monkeypatch, response, accepted):
    row = Feedback(id=uuid4(), user=client.actor, text='<!channel> <https://evil.invalid|click>')
    class Reply:
        status = 200
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def read(self, size): return response
    def open_fake(request, timeout):
        url = urlsplit(request.full_url)
        assert (url.scheme, url.netloc, url.path) == ('https', 'nodered.omshejul.com', '/api/om')
        assert timeout == 10
        payload = json.loads(parse_qs(url.query)['msg'][0])
        assert payload['blocks'][1]['text'] == {'type': 'plain_text', 'text': row.text, 'emoji': False}
        assert 'merosplit.com' in payload['blocks'][2]['text']['text']
        return Reply()
    monkeypatch.setattr(feedback, 'urlopen', open_fake)
    if accepted:
        feedback.notify(row)
    else:
        with pytest.raises(ValueError):
            feedback.notify(row)
