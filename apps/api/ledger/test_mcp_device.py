"""Remote approval never navigates the phone to the app or a loopback callback."""
from urllib.parse import parse_qs, urlsplit

import pytest
from django.test import Client

from . import mcp_oauth as oauth
from .test_mcp_oauth import (
    CHALLENGE,
    NETWORK,
    REDIRECT,
    RESOURCE,
    browser,
    code_data,
    post,
    registered,
)

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def canonical(settings):
    settings.MCP_SERVER_URL = RESOURCE


def start():
    client_id = registered()["client_id"]
    response = post(Client(), "/oauth/device", {"client_id": client_id, "redirect_uri": REDIRECT,
        "response_type": "code", "code_challenge": CHALLENGE, "code_challenge_method": "S256",
        "state": "remote-state", "resource": RESOURCE})
    assert response.status_code == 200
    return client_id, response.json()


def test_remote_device_approval_stays_in_browser_and_completes_original_pkce_flow():
    client_id, device = start()
    phone = browser()
    page = phone.get("/mcp/device")
    assert page.status_code == 200 and b'name="user_code"' in page.content
    accepted = post(phone, "/mcp/device", {"user_code": device["user_code"]})
    assert accepted.status_code == 302 and accepted["Location"] == "/mcp/device"
    accepted = phone.get(accepted["Location"])
    assert accepted["Location"].startswith("/oauth/authorize?request=")
    request_id = phone.session[oauth.MCP_PENDING_SESSION_KEY]
    row = oauth.get_pending(request_id)
    page = phone.get(accepted["Location"])
    assert page.status_code == 200 and device["user_code"].encode() in page.content
    approved = post(phone, "/oauth/authorize", {"request": request_id, "decision": "allow",
        "expected_user_id": phone.session["_auth_user_id"]})
    assert approved.status_code == 302 and approved["Location"] == "/mcp/device?done=1"
    done = phone.get(approved["Location"])
    assert done.status_code == 200 and b"Return to your server" in done.content
    callback = post(Client(), "/oauth/device/poll", {"client_id": client_id, "device_code": device["device_code"]})
    assert callback.status_code == 200
    redirect = callback.json()["redirect_url"]
    assert redirect.startswith(REDIRECT) and parse_qs(urlsplit(redirect).query)["state"] == ["remote-state"]
    code = parse_qs(urlsplit(redirect).query)["code"][0]
    tokens = oauth.exchange_code(code_data(row, code), NETWORK)
    assert oauth.authenticate_access_token(tokens["access_token"])


def poll(client_id, device):
    return post(Client(), "/oauth/device/poll", {"client_id": client_id, "device_code": device["device_code"]})


def enter(phone, device):
    response = post(phone, "/mcp/device", {"user_code": device["user_code"].lower().replace("-", " ")})
    assert response.status_code == 302
    return oauth.get_pending(phone.session[oauth.MCP_PENDING_SESSION_KEY])


def test_device_entry_works_logged_out_without_loading_the_app():
    _, device = start()
    phone = Client()
    enter(phone, device)
    page = phone.get('/mcp/device')
    assert page.status_code == 200 and b'id="email-form"' in page.content
    assert b'/mcp/device.js' in page.content
    assert b'id="email-form" method="post" action="/mcp/device"' in page.content
    assert b'id="code-form" method="post" action="/mcp/device"' in page.content
    assert b'/app/' not in page.content and b'localhost' not in page.content
    assert b'name="csrfmiddlewaretoken"' in page.content


def test_device_code_and_secret_are_only_digests_and_polls_cannot_approve():
    from .mcp_models import McpOAuthPendingAuthorization
    client_id, device = start()
    row = McpOAuthPendingAuthorization.objects.get()
    assert device['device_code'] not in str(row.__dict__) and device['user_code'] not in str(row.__dict__)
    assert poll(client_id, device).json()['error'] == 'authorization_pending'
    assert poll(client_id, device).json()['error'] == 'slow_down'
    row.refresh_from_db()
    assert row.device_poll_interval == 10 and not row.approved_at and not row.code_digest
    assert post(Client(), '/oauth/device/poll', {'client_id': registered()['client_id'], 'device_code': device['device_code']}).json()['error'] == 'invalid_grant'
    assert poll(client_id, {**device, 'device_code': 'bad-secret'}).json()['error'] == 'invalid_grant'


def test_device_cancel_expiry_replay_and_pkce_are_enforced():
    from datetime import timedelta

    from django.utils import timezone

    client_id, device = start()
    phone = browser()
    row = enter(phone, device)
    decision = {'request': str(row.id), 'expected_user_id': phone.session['_auth_user_id'], 'decision': 'cancel'}
    assert post(phone, '/oauth/authorize', decision)['Location'] == '/mcp/device?cancelled=1'
    assert poll(client_id, device).json()['error'] == 'access_denied'
    client_id, device = start()
    row = enter(phone, device)
    row.expires_at = timezone.now() - timedelta(seconds=1)
    row.save(update_fields=['expires_at'])
    assert poll(client_id, device).json()['error'] == 'expired_token'
    assert post(Client(), '/mcp/device', {'user_code': device['user_code']}).status_code == 400
    client_id, device = start()
    row = enter(phone, device)
    decision.update(request=str(row.id), decision='allow')
    assert post(phone, '/oauth/authorize', decision)['Location'] == '/mcp/device?done=1'
    callback = poll(client_id, device).json()['redirect_url']
    assert poll(client_id, device).json()['error'] == 'invalid_grant'
    code = parse_qs(urlsplit(callback).query)['code'][0]
    with pytest.raises(oauth.OAuthError):
        oauth.exchange_code(code_data(row, code, code_verifier='wrong-' + 'x' * 45), NETWORK)
    tokens = oauth.exchange_code(code_data(row, code), NETWORK)
    assert oauth.authenticate_access_token(tokens['access_token'])
    with pytest.raises(oauth.OAuthError):
        oauth.exchange_code(code_data(row, code), NETWORK)


def test_device_entry_has_csrf_and_guessing_limits():
    _, device = start()
    phone = Client(enforce_csrf_checks=True)
    assert post(phone, '/mcp/device', {'user_code': device['user_code']}).status_code == 403
    phone.get('/mcp/device')
    assert post(phone, '/mcp/device', {'user_code': device['user_code']}, HTTP_X_CSRFTOKEN=phone.cookies['csrftoken'].value).status_code == 302
    for _ in range(19):
        assert post(Client(), '/mcp/device', {'user_code': 'XXXX-XXXX'}).status_code == 400
    assert post(Client(), '/mcp/device', {'user_code': 'XXXX-XXXX'}).status_code == 429


@pytest.mark.django_db(transaction=True)
def test_concurrent_device_polls_deliver_only_one_callback():
    from .test_mcp_oauth import _parallel
    client_id, device = start()
    phone = browser()
    row = enter(phone, device)
    post(phone, '/oauth/authorize', {'request': str(row.id), 'expected_user_id': phone.session['_auth_user_id'], 'decision': 'allow'})
    results = _parallel(lambda: oauth.poll_device_authorization({'client_id': client_id, 'device_code': device['device_code']}, NETWORK))
    assert sum(isinstance(value, dict) for value in results) == 1
    assert results.count('invalid_grant') == 1


def test_device_email_signin_retains_selector_and_goes_straight_to_consent(monkeypatch):
    import re

    from . import email_delivery
    from .test_mcp_oauth import user

    delivered = []
    monkeypatch.setattr(email_delivery, 'send_email', lambda recipient, subject, text, key, **kwargs: delivered.append(text) or 'synthetic-accepted')
    actor = user(name='')
    client_id, device = start()
    phone = Client(enforce_csrf_checks=True)
    phone.get('/mcp/device')
    response = post(phone, '/mcp/device', {'user_code': device['user_code']}, HTTP_X_CSRFTOKEN=phone.cookies['csrftoken'].value)
    assert response.status_code == 302
    request_id = phone.session[oauth.MCP_PENDING_SESSION_KEY]
    phone.get('/mcp/device')
    def auth(path, data):
        return post(phone, '/_allauth/browser/v1/auth/code/' + path, data, json_body=True,
                    HTTP_X_CSRFTOKEN=phone.cookies['csrftoken'].value)
    requested = auth('request', {'email': actor.email})
    assert requested.status_code == 200
    code = re.search(r'(?m)^([0-9]{4})$', delivered[0]).group(1)
    assert auth('confirm', {'challenge_id': requested.json()['data']['challenge_id'], 'code': code}).status_code == 200
    assert phone.session[oauth.MCP_PENDING_SESSION_KEY] == request_id
    assert phone.get('/mcp/device')['Location'] == '/oauth/authorize?request=' + request_id
    consent = phone.get('/oauth/authorize?request=' + request_id)
    assert consent.status_code == 200 and actor.email.encode() in consent.content
    assert poll(client_id, device).json()['error'] == 'authorization_pending'


def test_device_assets_are_public_but_never_contain_credentials():
    for path in ['/mcp/login.py', '/mcp/device.js']:
        response = Client().get(path)
        assert response.status_code == 200
        assert response['X-Content-Type-Options'] == 'nosniff'
        content = b''.join(response.streaming_content)
        assert b'mero_at_' not in content and b'mero_rt_' not in content
    setup = Client().get('/mcp/setup').content.decode()
    assert 'sign in with a device code' in setup
    assert 'python3 ~/.local/bin/merosplit-login.py' in setup
    assert 'Copy the entire final callback URL' not in setup


def test_device_consent_requires_the_entered_code_in_that_browser_session():
    _, device = start()
    phone = browser()
    row = enter(phone, device)
    session = phone.session
    session['mcp_device_user_code'] = 'WRNG-CODE'
    session.save()
    assert phone.get('/oauth/authorize?request=' + str(row.id)).status_code == 400
    assert post(phone, '/oauth/authorize', {'request': str(row.id), 'decision': 'allow',
                'expected_user_id': session['_auth_user_id']}).status_code == 400
    row.refresh_from_db()
    assert not row.approved_at and not row.code_digest
