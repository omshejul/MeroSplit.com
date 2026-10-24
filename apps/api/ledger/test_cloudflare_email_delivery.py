"""Real PostgreSQL send fences; the only replaced boundary is provider HTTP."""
import copy
import io
import json
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from urllib.error import HTTPError, URLError
from uuid import uuid4

import pytest
from django.db import close_old_connections, connection, connections, transaction

from . import email_delivery
from .models import CloudflareEmailDispatch, EmailLoginGrant

pytestmark = pytest.mark.django_db(transaction=True)
RECIPIENT = 'synthetic@example.invalid'
ACCOUNT = 'a' * 32
MESSAGE_ID = '<synthetic-message@mx.cloudflare.net>'


@pytest.fixture(autouse=True)
def cloudflare(settings):
    settings.EMAIL_PROVIDER = 'cloudflare'
    settings.CLOUDFLARE_EMAIL_ACCOUNT_ID = ACCOUNT
    settings.CLOUDFLARE_EMAIL_API_TOKEN = 'synthetic-scoped-token'
    settings.RESEND_API_KEY = 'synthetic-legacy-token'
    settings.DEFAULT_FROM_EMAIL = 'MeroSplit <mail@merosplit.com>'
    settings.EMAIL_REPLY_TO = 'mail@merosplit.com'
    settings.PUBLIC_WEB_URL = 'https://merosplit.com'


class Response:
    status = 200
    def __init__(self, data=None, status=200):
        self.status = status
        self.data = data if data is not None else result()
    def __enter__(self):
        return self
    def __exit__(self, *args):
        return False
    def read(self, limit):
        assert limit == 65536
        return json.dumps(self.data).encode()


def result(**updates):
    return {'success': True, 'errors': [], 'result': {'message_id': MESSAGE_ID, 'delivered': [RECIPIENT],
            'queued': [], 'permanent_bounces': [], 'suppressed_recipients': [], **updates}}


def payload():
    return email_delivery.message_payload(RECIPIENT, 'Synthetic subject', 'Private synthetic body', '<img src="cid:merosplit-logo">')


def send(frozen, key):
    return email_delivery.send_email(RECIPIENT, frozen['subject'], frozen['text'], key, payload=frozen)


def test_cloudflare_exact_request_committed_fence_receipt_replay_and_frozen_provider(settings, monkeypatch):
    frozen = payload()
    original = copy.deepcopy(frozen)
    key = f'otp/{uuid4()}'
    calls = []
    def http(request, timeout):
        assert timeout == 10 and not connection.in_atomic_block
        row = CloudflareEmailDispatch.objects.get(pk=key)
        assert row.state == 'sending' and row.account_id == ACCOUNT
        calls.append(request)
        return Response()
    monkeypatch.setattr(email_delivery, 'urlopen', http)
    assert send(frozen, key) == MESSAGE_ID
    request, = calls
    assert request.full_url == f'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/email/sending/send'
    assert request.get_method() == 'POST'
    headers = {name.lower(): value for name, value in request.header_items()}
    assert headers['authorization'] == 'Bearer synthetic-scoped-token'
    assert 'idempotency-key' not in headers  # Not a documented Cloudflare guarantee.
    body = json.loads(request.data)
    assert body['from'] == {'address': 'mail@merosplit.com', 'name': 'MeroSplit'}
    assert body['to'] == [RECIPIENT] and body['reply_to'] == 'mail@merosplit.com'
    assert body['headers'] == {'X-MeroSplit-Delivery-ID': key}
    assert body['text'] == frozen['text'] and body['html'] == frozen['html']
    assert body['attachments'] == [{'filename': 'merosplit-logo.png', 'content': frozen['attachments'][0]['content'],
                                    'type': 'image/png', 'disposition': 'inline', 'content_id': 'merosplit-logo'}]
    assert '_email_provider' not in body
    assert frozen == original
    row = CloudflareEmailDispatch.objects.get(pk=key)
    assert row.state == 'accepted' and row.provider_id == MESSAGE_ID and row.http_status == 200
    assert len(row.payload_hash) == 64 and RECIPIENT not in str(row.__dict__) and 'Private synthetic body' not in str(row.__dict__)
    settings.EMAIL_PROVIDER = 'resend'
    settings.DEFAULT_FROM_EMAIL = 'Changed <other@example.invalid>'
    assert send(frozen, key) == MESSAGE_ID and len(calls) == 1


@pytest.mark.parametrize('updates', [
    {'message_id': ''}, {'message_id': 'bad\nheader'}, {'message_id': 'x' * 201},
    {'delivered': [], 'queued': []}, {'delivered': ['wrong@example.invalid']}, {'delivered': None},
    {'delivered': [RECIPIENT, 'unexpected@example.invalid']}, {'delivered': [{'address': RECIPIENT}]},
    {'permanent_bounces': [RECIPIENT]}, {'suppressed_recipients': [RECIPIENT]},
])
def test_invalid_or_rejected_recipient_result_holds_without_resending(monkeypatch, updates):
    calls = []
    monkeypatch.setattr(email_delivery, 'urlopen', lambda *args, **kwargs: calls.append(1) or Response(result(**updates)))
    key, frozen = f'bill-chat/{uuid4()}', payload()
    for _ in range(2):
        with pytest.raises(email_delivery.EmailDeliveryHeld) as exc:
            send(frozen, key)
        assert str(exc.value) == ''
    assert len(calls) == 1
    assert CloudflareEmailDispatch.objects.get(pk=key).state == 'held'


@pytest.mark.parametrize('failure', [URLError('private provider body'), TimeoutError('private token'), None, [], {'success': False}, {'success': True, 'result': None}])
def test_unknown_outcomes_are_durable_holds_not_provider_failover(monkeypatch, failure):
    calls = []
    def http(*args, **kwargs):
        calls.append(1)
        if isinstance(failure, Exception):
            raise failure
        response = Response()
        response.data = failure
        return response
    monkeypatch.setattr(email_delivery, 'urlopen', http)
    key, frozen = f'invite/{uuid4()}', payload()
    with pytest.raises(email_delivery.EmailDeliveryHeld):
        send(frozen, key)
    with pytest.raises(email_delivery.EmailDeliveryHeld):
        send(frozen, key)
    assert len(calls) == 1 and CloudflareEmailDispatch.objects.get(pk=key).state == 'held'


@pytest.mark.parametrize('status', [400, 401, 403, 404, 429])
def test_explicit_preaccept_rejection_retries_same_frozen_body_key_and_provider(monkeypatch, status):
    calls = []
    def http(request, timeout):
        calls.append(request.data)
        if len(calls) == 1:
            code = {400: 10001, 401: 10101, 403: 10102, 404: 10000, 429: 10004}[status]
            rejected = {'success': False, 'errors': [{'code': code, 'message': 'private details'}], 'result': None}
            raise HTTPError(request.full_url, status, 'Not accepted', {}, io.BytesIO(json.dumps(rejected).encode()))
        return Response()
    monkeypatch.setattr(email_delivery, 'urlopen', http)
    key, frozen = f'expense-digest/{uuid4()}', payload()
    with pytest.raises(email_delivery.EmailDeliveryUnavailable) as exc:
        send(frozen, key)
    assert not isinstance(exc.value, email_delivery.EmailDeliveryHeld) and str(exc.value) == ''
    assert CloudflareEmailDispatch.objects.get(pk=key).state == 'retryable'
    assert send(frozen, key) == MESSAGE_ID
    assert calls[0] == calls[1] and CloudflareEmailDispatch.objects.count() == 1


@pytest.mark.parametrize('status', [408, 409, 500, 503])
def test_ambiguous_http_errors_hold_even_with_error_envelope(monkeypatch, status):
    calls = []
    def http(request, timeout):
        calls.append(1)
        raise HTTPError(request.full_url, status, 'Unknown', {}, io.BytesIO(b'{"success":false,"errors":[{"code":10002}],"result":null}'))
    monkeypatch.setattr(email_delivery, 'urlopen', http)
    key, frozen = f'bill-notice/{uuid4()}', payload()
    with pytest.raises(email_delivery.EmailDeliveryHeld):
        send(frozen, key)
    with pytest.raises(email_delivery.EmailDeliveryHeld):
        send(frozen, key)
    assert len(calls) == 1


def test_concurrent_same_uuid_posts_once_and_committed_unfinished_fence_never_replays(monkeypatch):
    entered, release = Event(), Event()
    calls = []
    def http(request, timeout):
        calls.append(1)
        entered.set()
        assert release.wait(5)
        return Response()
    monkeypatch.setattr(email_delivery, 'urlopen', http)
    key, frozen = f'bill-chat/{uuid4()}', payload()
    def attempt():
        close_old_connections()
        try:
            return send(frozen, key)
        finally:
            connections['default'].close()
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(attempt)
        try:
            assert entered.wait(5)
            second = pool.submit(attempt)
            with pytest.raises(email_delivery.EmailDeliveryHeld):
                second.result(5)
        finally:
            release.set()
        assert first.result(5) == MESSAGE_ID
    assert len(calls) == 1 and CloudflareEmailDispatch.objects.get(pk=key).state == 'accepted'
    CloudflareEmailDispatch.objects.filter(pk=key).update(state='sending', provider_id='')  # Crash before HTTP/receipt.
    with pytest.raises(email_delivery.EmailDeliveryHeld):
        send(frozen, key)
    assert len(calls) == 1


def test_unmarked_legacy_payload_keeps_exact_resend_sender_body_key_after_cutover(monkeypatch, settings):
    settings.EMAIL_PROVIDER = 'resend'
    settings.DEFAULT_FROM_EMAIL = 'MeroSplit <legacy@old.example.invalid>'
    settings.EMAIL_REPLY_TO = 'legacy-reply@old.example.invalid'
    frozen = payload()
    original = copy.deepcopy(frozen)
    settings.EMAIL_PROVIDER = 'cloudflare'
    settings.DEFAULT_FROM_EMAIL = 'MeroSplit <mail@merosplit.com>'
    calls = []
    monkeypatch.setattr(email_delivery, 'urlopen', lambda request, timeout: calls.append(request) or Response({'id': 'legacy-provider-id'}))
    key = f'invite/{uuid4()}'
    assert send(frozen, key) == 'legacy-provider-id'
    request, = calls
    assert request.full_url == 'https://api.resend.com/emails'
    assert json.loads(request.data) == frozen == original
    assert {name.lower(): value for name, value in request.header_items()}['idempotency-key'] == key
    assert CloudflareEmailDispatch.objects.count() == 0


def test_mismatch_or_missing_configuration_cannot_send_and_outer_transactions_fail_closed(settings, monkeypatch):
    calls = []
    monkeypatch.setattr(email_delivery, 'urlopen', lambda *args, **kwargs: calls.append(1) or Response())
    frozen, key = payload(), f'otp/{uuid4()}'
    for altered in [{**frozen, 'from': 'attacker@other.invalid'}, {**frozen, 'to': ['other@example.invalid']},
                    {**frozen, 'cc': ['other@example.invalid']}, {**frozen, 'bcc': ['other@example.invalid']}]:
        with pytest.raises(email_delivery.EmailDeliveryUnavailable):
            send(altered, key)
    settings.CLOUDFLARE_EMAIL_API_TOKEN = ''
    with pytest.raises(email_delivery.EmailDeliveryUnavailable):
        send(frozen, key)
    settings.CLOUDFLARE_EMAIL_API_TOKEN = 'synthetic-scoped-token'
    with transaction.atomic(), pytest.raises(email_delivery.EmailDeliveryUnavailable):
        send(frozen, key)
    assert calls == [] and CloudflareEmailDispatch.objects.count() == 0
    assert send(frozen, key) == MESSAGE_ID
    with pytest.raises(email_delivery.EmailDeliveryHeld):
        send({**frozen, 'text': 'Changed body'}, key)
    settings.CLOUDFLARE_EMAIL_ACCOUNT_ID = 'b' * 32
    with pytest.raises(email_delivery.EmailDeliveryHeld):
        send(frozen, key)
    assert len(calls) == 1


def test_real_login_freezes_cloudflare_recipe_and_reconciles_accepted_delivery_without_another_post(monkeypatch, settings):
    from .otp import deliver_login_link, request_email_code
    calls = []
    monkeypatch.setattr(email_delivery, 'urlopen', lambda request, timeout: calls.append(request) or Response())
    request_email_code(RECIPIENT, '192.0.2.0/24')
    grant = EmailLoginGrant.objects.get(email=RECIPIENT)
    original = copy.deepcopy(grant.payload)
    assert grant.delivered_at and grant.payload['_email_provider'] == 'cloudflare'
    settings.EMAIL_PROVIDER = 'resend'
    deliver_login_link(grant.id)
    assert len(calls) == 1
    grant.refresh_from_db()
    assert grant.payload == original
    assert '_email_link_id' not in json.loads(calls[0].data)


def test_native_code_request_view_uses_cloudflare_after_its_database_transaction(monkeypatch):
    from django.test import Client
    calls = []
    monkeypatch.setattr(email_delivery, 'urlopen', lambda request, timeout: calls.append(request) or Response())
    response = Client().post('/_allauth/app/v1/auth/code/request', data=json.dumps({'email': RECIPIENT}),
                             content_type='application/json', REMOTE_ADDR='192.0.2.10')
    assert response.status_code == 200
    assert len(calls) == 1 and CloudflareEmailDispatch.objects.get().state == 'accepted'


def test_receipt_database_failure_keeps_committed_fence_and_never_posts_again(monkeypatch):
    calls = []
    monkeypatch.setattr(email_delivery, 'urlopen', lambda request, timeout: calls.append(request) or Response())
    with connection.cursor() as cursor:
        cursor.execute("CREATE FUNCTION pg_temp.fail_cf_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='accepted' THEN RAISE EXCEPTION 'synthetic receipt failure'; END IF; RETURN NEW; END $$")
        cursor.execute("CREATE TRIGGER fail_cf_receipt BEFORE UPDATE ON ledger_cloudflareemaildispatch FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_cf_receipt()")
    try:
        frozen, key = payload(), f'bill-chat/{uuid4()}'
        with pytest.raises(email_delivery.EmailDeliveryHeld):
            send(frozen, key)
        assert CloudflareEmailDispatch.objects.get(pk=key).state == 'sending'
        with pytest.raises(email_delivery.EmailDeliveryHeld):
            send(frozen, key)
        assert len(calls) == 1
    finally:
        with connection.cursor() as cursor:
            cursor.execute('DROP TRIGGER fail_cf_receipt ON ledger_cloudflareemaildispatch')
            cursor.execute('DROP FUNCTION pg_temp.fail_cf_receipt()')


@pytest.mark.parametrize('errors', ['not an array', [{}], [{'code': 99999, 'message': 'unknown'}], [{'code': 10004, 'message': 'wrong status'}]])
def test_malformed_or_unknown_rejection_is_not_assumed_safe_to_retry(monkeypatch, errors):
    calls = []
    def http(request, timeout):
        calls.append(1)
        response = {'success': False, 'result': None, 'errors': errors}
        raise HTTPError(request.full_url, 400, 'Unknown', {}, io.BytesIO(json.dumps(response).encode()))
    monkeypatch.setattr(email_delivery, 'urlopen', http)
    frozen, key = payload(), f'otp/{uuid4()}'
    with pytest.raises(email_delivery.EmailDeliveryHeld):
        send(frozen, key)
    with pytest.raises(email_delivery.EmailDeliveryHeld):
        send(frozen, key)
    assert calls == [1]
