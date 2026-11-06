"""Real allauth/DB sessions and signed synthetic tokens; Google HTTP is mocked."""
import json
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import jwt
import pytest
import requests
from allauth.account.models import EmailAddress
from allauth.socialaccount.models import SocialAccount, SocialToken
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from django.contrib.auth import get_user_model
from django.contrib.sessions.models import Session
from django.db import close_old_connections, connections
from django.test import Client

from .google_signin import CHALLENGE
from .test_api import authenticated_client, send

pytestmark = pytest.mark.django_db


@pytest.fixture(scope="module")
def signer():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "synthetic-google-test-only")])
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(1).not_valid_before(datetime.now(timezone.utc) - timedelta(days=1))
            .not_valid_after(datetime.now(timezone.utc) + timedelta(days=1)).sign(key, hashes.SHA256()))
    return key, cert.public_bytes(serialization.Encoding.PEM).decode()


@pytest.fixture(autouse=True)
def google(settings, monkeypatch, signer):
    settings.GOOGLE_SIGN_IN_ENABLED = True
    calls = []

    def request(_session, method, url, **kwargs):
        assert method.upper() == "GET" and url == "https://www.googleapis.com/oauth2/v1/certs"
        calls.append(url)
        response = requests.Response()
        response.status_code = 200
        response._content = json.dumps({"synthetic": signer[1]}).encode()
        return response

    monkeypatch.setattr(requests.Session, "request", request)
    return calls


def post(client, action, data, browser=False, **headers):
    return client.post(f"/_allauth/{'browser' if browser else 'app'}/v1/auth/google/{action}",
                       data=json.dumps(data), content_type="application/json", REMOTE_ADDR="192.0.2.42", **headers)


def challenge(client, process="login", browser=False, **headers):
    response = post(client, "challenge", {"process": process}, browser, **headers)
    assert response.status_code == 200, response.content
    if not browser:
        client.defaults["HTTP_X_SESSION_TOKEN"] = response.json().get("meta", {}).get("session_token", client.defaults.get("HTTP_X_SESSION_TOKEN"))
        client.cookies.clear()
    return response.json()["data"]["nonce"]


def token(signer, settings, expected_nonce, **claims):
    data = {"sub": "google-sub-1", "aud": settings.GOOGLE_OAUTH_WEB_CLIENT_ID,
            "iss": "https://accounts.google.com", "exp": int(time.time()) + 120,
            "email": "google-new@example.invalid", "email_verified": True, "hd": "example.invalid",
            "given_name": "Google", "family_name": "Test", "nonce": expected_nonce, **claims}
    return jwt.encode(data, signer[0], algorithm="RS256", headers={"kid": "synthetic"})


def submit(client, credential, process="login", browser=False, **headers):
    return post(client, "token", {"process": process, "id_token": credential}, browser, **headers)


@pytest.mark.parametrize("browser", [False, True])
def test_new_google_identity_uses_allauth_session_without_credentials_or_mail(browser, signer, settings, mailoutbox):
    client = Client(enforce_csrf_checks=browser)
    headers = {}
    if browser:
        client.get("/_allauth/browser/v1/config")
        headers["HTTP_X_CSRFTOKEN"] = client.cookies["csrftoken"].value
    nonce = challenge(client, browser=browser, **headers)
    response = submit(client, token(signer, settings, nonce), browser=browser, **headers)
    assert response.status_code == 200, response.content
    assert response.json()["meta"]["is_authenticated"] is True
    user = get_user_model().objects.get(pk=response.json()["data"]["user"]["id"])
    assert not user.has_usable_password()
    assert EmailAddress.objects.filter(user=user, email=user.email, verified=True).exists()
    account = SocialAccount.objects.get(user=user)
    assert account.provider == "google" and account.uid == "google-sub-1"
    assert set(account.extra_data) == {"sub", "email", "email_verified", "given_name", "family_name"}
    assert not SocialToken.objects.exists() and not mailoutbox
    if browser:
        assert "session_token" not in response.json()["meta"]
    else:
        client.defaults["HTTP_X_SESSION_TOKEN"] = response.json()["meta"]["session_token"]
    assert send(client, "get", "/me").json()["id"] == user.pk
    assert send(client, "get", "/groups").json() == {"groups": []}
    assert all(CHALLENGE not in row.get_decoded() for row in Session.objects.all())


@pytest.mark.parametrize("claims", [
    {"aud": "wrong-client"}, {"iss": "https://attacker.invalid"}, {"exp": 1},
    {"nonce": "wrong"}, {"email_verified": False}, {"email_verified": "true"},
    {"sub": ""}, {"email": "invalid"}, {"exp": True},
])
def test_rejects_invalid_identity_without_allauth_writes(claims, signer, settings):
    client = Client()
    nonce = challenge(client)
    response = submit(client, token(signer, settings, nonce, **claims))
    assert response.status_code == 400
    assert not get_user_model().objects.exists() and not SocialAccount.objects.exists()


def test_signature_cannot_be_forged(signer, settings):
    client = Client()
    nonce = challenge(client)
    forged = (rsa.generate_private_key(public_exponent=65537, key_size=2048), signer[1])
    assert submit(client, token(forged, settings, nonce)).status_code == 400
    assert not get_user_model().objects.exists()


def test_google_supported_issuer_and_nonce_rotation(signer, settings):
    client = Client()
    old = challenge(client)
    new = challenge(client)
    assert submit(client, token(signer, settings, old)).status_code == 400
    response = submit(client, token(signer, settings, new, iss="accounts.google.com"))
    assert response.status_code == 200, response.content
    # The original pre-auth token was replaced by allauth. It cannot replay login.
    assert submit(client, token(signer, settings, new)).status_code == 410


def test_stale_session_save_cannot_resurrect_a_consumed_connect_proof(signer, settings):
    user = get_user_model().objects.create_user(username="connect", email="google-new@example.invalid")
    client = authenticated_client(user)
    credential = token(signer, settings, challenge(client, "connect"))
    row = Session.objects.get(session_key=client.defaults["HTTP_X_SESSION_TOKEN"])
    old_data = row.session_data
    assert submit(client, credential, "connect").status_code == 200
    # Model an unrelated in-flight request saving its pre-consumption session.
    row.session_data = old_data
    row.save(update_fields=["session_data"])
    assert submit(client, credential, "connect").status_code == 400
    assert SocialAccount.objects.count() == 1


def test_non_google_hosted_email_needs_existing_email_session_then_explicit_connect(signer, settings):
    anonymous = Client()
    response = submit(anonymous, token(signer, settings, challenge(anonymous), hd=None))
    assert response.status_code == 409 and not get_user_model().objects.exists()
    user = get_user_model().objects.create_user(username="email-owner", email="verified-owner@example.invalid")
    EmailAddress.objects.create(user=user, email=user.email, verified=True, primary=True)
    client = authenticated_client(user)
    response = submit(client, token(signer, settings, challenge(client, "connect"), hd=None), "connect")
    assert response.status_code == 200
    assert list(EmailAddress.objects.filter(user=user).values_list('email', flat=True)) == [user.email]
    fresh = Client()
    response = submit(fresh, token(signer, settings, challenge(fresh), hd=None))
    assert response.status_code == 200 and response.json()['data']['user']['id'] == user.pk


def test_existing_verified_secondary_email_automatically_links_google_account(signer, settings):
    user = get_user_model().objects.create_user(username="email-owner", email="primary@example.invalid")
    EmailAddress.objects.create(user=user, email="google-new@example.invalid", verified=True)
    client = Client()
    response = submit(client, token(signer, settings, challenge(client)))
    assert response.status_code == 200, response.content
    assert response.json()["data"]["user"]["id"] == user.pk
    assert get_user_model().objects.count() == 1
    assert SocialAccount.objects.get().user_id == user.pk


@pytest.mark.parametrize("process", [None, [], {}, 1, True, "redirect", ""])
def test_malformed_process_is_rejected_before_provider_request(process, google):
    client = Client()
    assert post(client, "challenge", {"process": process}).status_code == 409
    assert post(client, "token", {"process": process, "id_token": "bad"}).status_code == 409
    assert not google


def test_verified_email_auto_links_and_preserves_existing_account(signer, settings):
    user = get_user_model().objects.create_user(username="existing", email="google-new@example.invalid")
    EmailAddress.objects.create(user=user, email=user.email, primary=True, verified=True)
    old = authenticated_client(user)
    anonymous = Client()
    nonce = challenge(anonymous)
    response = submit(anonymous, token(signer, settings, nonce))
    assert response.status_code == 200, response.content
    assert response.json()["data"]["user"]["id"] == user.pk
    assert SocialAccount.objects.get().user_id == user.pk
    assert get_user_model().objects.count() == 1
    session_key = old.defaults["HTTP_X_SESSION_TOKEN"]
    nonce = challenge(old, "connect")
    response = submit(old, token(signer, settings, nonce), "connect")
    assert response.status_code == 200, response.content
    assert response.json()["data"]["user"]["id"] == user.pk
    assert SocialAccount.objects.get().user_id == user.pk
    assert old.defaults["HTTP_X_SESSION_TOKEN"] == session_key
    assert send(old, "get", "/me").status_code == 200
    fresh = Client()
    response = submit(fresh, token(signer, settings, challenge(fresh), email="changed@example.invalid"))
    assert response.status_code == 200 and response.json()["data"]["user"]["id"] == user.pk
    user.refresh_from_db()
    assert user.email == "google-new@example.invalid" and get_user_model().objects.count() == 1


def test_connect_cannot_take_another_users_google_subject(signer, settings):
    owner = get_user_model().objects.create_user(username="owner", email="owner@example.invalid")
    other = get_user_model().objects.create_user(username="other", email="other@example.invalid")
    SocialAccount.objects.create(user=owner, provider="google", uid="google-sub-1")
    client = authenticated_client(other)
    response = submit(client, token(signer, settings, challenge(client, "connect")), "connect")
    assert response.status_code == 400
    assert SocialAccount.objects.get().user_id == owner.pk
    assert send(client, "get", "/me").json()["id"] == other.pk


def test_nonce_session_expiry_process_and_review_fences(signer, settings, google):
    a, b = Client(), Client()
    credential = token(signer, settings, challenge(a))
    assert submit(b, credential).status_code == 400
    assert post(a, "challenge", {"process": "connect"}).status_code == 409
    row = Session.objects.get(session_key=a.defaults["HTTP_X_SESSION_TOKEN"])
    data = row.get_decoded()
    data[CHALLENGE]["expires_at"] = 1
    from config.sessions import SessionStore
    row.session_data = SessionStore().encode(data)
    row.save()
    count = len(google)
    assert submit(a, credential).status_code == 400 and len(google) == count
    settings.STORE_REVIEW_AUTH = [{"email": "google-new@example.invalid", "user_id": 99, "store": "apple", "pin_hash": ""}]
    assert submit(b, token(signer, settings, challenge(b))).status_code == 400
    assert not get_user_model().objects.exists()


def test_browser_requires_csrf_and_exact_signed_in_account(signer, settings):
    client = Client(enforce_csrf_checks=True)
    client.get("/_allauth/browser/v1/config")
    assert post(client, "challenge", {"process": "login"}, True).status_code == 403
    csrf = client.cookies["csrftoken"].value
    nonce = challenge(client, browser=True, HTTP_X_CSRFTOKEN=csrf)
    assert submit(client, token(signer, settings, nonce), browser=True).status_code == 403
    user = get_user_model().objects.create_user(username="browser", email="browser@example.invalid")
    client.force_login(user)
    response = post(client, "challenge", {"process": "connect"}, True, HTTP_X_CSRFTOKEN=client.cookies["csrftoken"].value,
                    HTTP_X_MEROSPLIT_ACCOUNT=str(user.pk + 1))
    assert response.status_code == 401 and not SocialAccount.objects.exists()


def test_get_no_longer_renders_an_intermediate_google_button():
    client = Client()
    response = client.get('/auth/google?process=login')
    assert response.status_code == 405
    assert b'accounts.google.com/gsi/client' not in response.content


def test_google_redirect_csrf_bridge_does_not_need_lax_session_or_authenticate_before_same_origin_nonce(signer, settings):
    browser = Client(enforce_csrf_checks=True)
    browser.get('/_allauth/browser/v1/config')
    csrf = browser.cookies['csrftoken'].value
    credential = token(signer, settings, challenge(browser, browser=True, HTTP_X_CSRFTOKEN=csrf))
    # The cross-site redirect POST omits the Lax session cookie. The Google
    # double-submit cookie is required, but no allauth state changes here.
    bridge = Client(enforce_csrf_checks=True)
    bridge.cookies['g_csrf_token'] = 'synthetic-google-csrf'
    body = {'credential': credential, 'state': 'login', 'g_csrf_token': 'synthetic-google-csrf'}
    response = bridge.post('/auth/google/callback', body)
    assert response.status_code == 200 and not get_user_model().objects.exists()
    assert response['Cache-Control'] == 'no-store' and response['Referrer-Policy'] == 'no-referrer'
    assert b'localStorage' not in response.content and b'window.location.replace(\'/app/\')' in response.content
    assert bridge.post('/auth/google/callback', json.dumps(body), content_type='application/json').status_code == 200
    response = submit(browser, credential, browser=True, HTTP_X_CSRFTOKEN=csrf)
    assert response.status_code == 200 and response.json()['meta']['is_authenticated']
    for change in [{'g_csrf_token': ''}, {'g_csrf_token': 'wrong'}, {'g_csrf_token': 'é'}, {'state': 'redirect'}, {'credential': ''}]:
        response = bridge.post('/auth/google/callback', {**body, **change})
        assert response.status_code == 400 and credential.encode() not in response.content
    for malformed in [[], {'state': []}, {'g_csrf_token': {}}, None]:
        assert bridge.post('/auth/google/callback', json.dumps(malformed), content_type='application/json').status_code == 400


def test_unavailable_and_rate_limited_paths_never_leak_credentials(signer, settings, monkeypatch, google):
    client = Client()
    settings.GOOGLE_SIGN_IN_ENABLED = False
    assert post(client, "challenge", {"process": "login"}).status_code == 503
    settings.GOOGLE_SIGN_IN_ENABLED = True
    nonce = challenge(client)
    from allauth.socialaccount.adapter import DefaultSocialAccountAdapter
    def offline(*args, **kwargs):
        raise requests.ConnectionError("synthetic-private-error-never-return-this")
    monkeypatch.setattr(DefaultSocialAccountAdapter, "get_requests_session", offline)
    response = submit(client, token(signer, settings, nonce))
    assert response.status_code == 400  # allauth maps provider transport failure to OAuth2Error
    assert b"synthetic-private" not in response.content
    assert not get_user_model().objects.exists()
    for _ in range(4):
        submit(client, token(signer, settings, nonce))
    assert submit(client, token(signer, settings, nonce)).status_code == 429


@pytest.mark.django_db(transaction=True)
def test_nonce_is_atomically_single_use_across_workers(signer, settings):
    client = Client()
    credential = token(signer, settings, challenge(client))
    key = client.defaults["HTTP_X_SESSION_TOKEN"]
    def worker(_):
        close_old_connections()
        try:
            return submit(Client(HTTP_X_SESSION_TOKEN=key), credential).status_code
        finally:
            connections.close_all()
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(worker, range(2))) == [200, 400]
    assert get_user_model().objects.count() == 1 and SocialAccount.objects.count() == 1


@pytest.mark.parametrize("verified,active", [(False, True), (True, False)])
def test_google_matching_email_requires_verified_active_local_account(signer, settings, verified, active):
    user = get_user_model().objects.create_user(username="blocked-owner", email="google-new@example.invalid", is_active=active)
    EmailAddress.objects.create(user=user, email=user.email, verified=verified)
    client = Client()
    assert submit(client, token(signer, settings, challenge(client))).status_code == 409
    assert not SocialAccount.objects.exists()


def test_google_photo_claim_is_saved_and_exposed_as_profile_fallback(signer, settings):
    client = Client()
    picture = "https://lh3.googleusercontent.com/synthetic-photo-v1"
    response = submit(client, token(signer, settings, challenge(client), picture=picture))
    assert response.status_code == 200, response.content
    assert SocialAccount.objects.get().extra_data["picture"] == picture
    client.defaults["HTTP_X_SESSION_TOKEN"] = response.json()["meta"]["session_token"]
    assert send(client, "get", "/me").json()["profile_photo"] == {"url": picture}


def test_auto_link_off_requires_explicit_connect_but_keeps_existing_google_login(signer, settings):
    from .models import SignInPreference
    user = get_user_model().objects.create_user(username='google-new@example.invalid', email='google-new@example.invalid')
    EmailAddress.objects.create(user=user, email=user.email, verified=True, primary=True)
    SignInPreference.objects.create(user=user, auto_link=False)
    fresh = Client()
    response = submit(fresh, token(signer, settings, challenge(fresh)))
    assert response.status_code == 409 and not SocialAccount.objects.exists()
    owner = authenticated_client(user)
    assert submit(owner, token(signer, settings, challenge(owner, 'connect')), 'connect').status_code == 200
    again = Client()
    response = submit(again, token(signer, settings, challenge(again)))
    assert response.status_code == 200 and response.json()['data']['user']['id'] == user.pk
