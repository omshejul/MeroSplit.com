"""Real allauth/PG browser flow, with token/certificate HTTP mocked only."""
import json
import time
from copy import deepcopy
from urllib.parse import parse_qs, urlsplit

import pytest
import requests
from allauth.socialaccount.models import SocialAccount, SocialToken
from django.contrib.auth import get_user_model
from django.test import Client

from .test_google_signin import signer as signer
from .test_google_signin import token

pytestmark = pytest.mark.django_db


@pytest.fixture
def google_code(settings, monkeypatch, signer):
    settings.GOOGLE_SIGN_IN_ENABLED = True
    settings.GOOGLE_OAUTH_WEB_CLIENT_SECRET = "synthetic-code-secret"
    settings.PUBLIC_WEB_URL = "http://testserver"
    settings.HEADLESS_FRONTEND_URLS = {"socialaccount_login_error": "/app/?google_error=unavailable"}
    providers = deepcopy(settings.SOCIALACCOUNT_PROVIDERS)
    providers["google"]["APPS"][0]["secret"] = settings.GOOGLE_OAUTH_WEB_CLIENT_SECRET
    providers["google"]["OAUTH_PKCE_ENABLED"] = True
    settings.SOCIALACCOUNT_PROVIDERS = providers
    record = {"exchanges": 0, "nonce": "", "claims": {}}

    def http(_session, method, url, **kwargs):
        response = requests.Response()
        response.status_code = 200
        response.headers["Content-Type"] = "application/json"
        if method.upper() == "POST" and url == "https://oauth2.googleapis.com/token":
            record["exchanges"] += 1
            body = kwargs["data"]
            assert body["code_verifier"] and body["client_secret"] == "synthetic-code-secret"
            assert body["redirect_uri"] == "http://testserver/auth/google/callback"
            value = {"access_token": "synthetic-only", "token_type": "Bearer", "id_token": record.get("id_token_override") or token(signer, settings, record["nonce"], **record["claims"])}
        else:
            assert method.upper() == "GET" and url == "https://www.googleapis.com/oauth2/v1/certs"
            value = {"synthetic": signer[1]}
        response._content = json.dumps(value).encode()
        return response

    monkeypatch.setattr(requests.Session, "request", http)
    return record


def begin(client, record, process="login", account=None):
    client.get("/_allauth/browser/v1/config")
    response = client.post("/auth/google", {"process": process, **({"account": str(account)} if account else {})},
                           HTTP_X_CSRFTOKEN=client.cookies["csrftoken"].value)
    assert response.status_code == 302, response.content
    url = urlsplit(response["Location"])
    assert url.scheme == "https" and url.netloc == "accounts.google.com"
    params = {k: v[0] for k, v in parse_qs(url.query).items()}
    assert params["response_type"] == "code" and params["code_challenge_method"] == "S256"
    assert params["prompt"] == "select_account" and "openid" in params["scope"]
    assert params["redirect_uri"] == "http://testserver/auth/google/callback"
    assert params["nonce"] and params["state"]
    record["nonce"] = params["nonce"]
    return params


def callback(client, params, **extra):
    return client.get("/auth/google/callback", {"state": params["state"], "code": "synthetic-code", **extra})


def test_first_click_is_csrf_post_direct_to_google_and_standard_allauth_session(google_code, mailoutbox):
    client = Client(enforce_csrf_checks=True)
    params = begin(client, google_code)
    response = callback(client, params)
    assert response.status_code == 302 and response["Location"].startswith("/app/")
    assert "google_error" not in response["Location"]
    user = get_user_model().objects.get()
    assert SocialAccount.objects.get(user=user).uid == "google-sub-1"
    assert client.get("/api/v1/me").json()["id"] == user.pk
    assert not SocialToken.objects.exists() and not mailoutbox
    assert google_code["exchanges"] == 1
    assert callback(client, params).status_code == 302
    assert google_code["exchanges"] == 1


@pytest.mark.parametrize("change", [{"nonce": "wrong"}, {"aud": "wrong"}, {"iss": "https://evil.invalid"}, {"exp": 1}, {"sub": ""}])
def test_code_identity_is_signed_nonce_audience_issuer_expiry_and_sub_bound(google_code, change):
    client = Client()
    params = begin(client, google_code)
    google_code["claims"] = change
    response = callback(client, params)
    assert response.status_code == 302 and "google_error" in response["Location"]
    assert not SocialAccount.objects.exists()


def test_wrong_state_and_cancel_do_not_exchange_or_connect(google_code):
    client = Client()
    params = begin(client, google_code)
    response = callback(client, {**params, "state": "tampered"})
    assert response.status_code == 302 and "google_error" in response["Location"]
    response = callback(client, params, error="access_denied")
    assert response.status_code == 302 and "cancelled" in response["Location"]
    assert google_code["exchanges"] == 0 and not SocialAccount.objects.exists()


def test_connect_cannot_follow_an_account_switch(google_code):
    User = get_user_model()
    a = User.objects.create(username="a", email="a@example.invalid")
    b = User.objects.create(username="b", email="b@example.invalid")
    client = Client()
    client.force_login(a, backend="django.contrib.auth.backends.ModelBackend")
    params = begin(client, google_code, "connect", a.pk)
    client.force_login(b, backend="django.contrib.auth.backends.ModelBackend")
    response = callback(client, params)
    assert response.status_code == 302 and "google_error" in response["Location"]
    assert google_code["exchanges"] == 0 and not SocialAccount.objects.exists()


def test_connected_providers_are_current_user_social_memberships_only(google_code):
    User = get_user_model()
    a = User.objects.create(username="a", email="same@example.invalid")
    b = User.objects.create(username="b", email="other@example.invalid")
    SocialAccount.objects.create(user=a, provider="google", uid="a-sub")
    SocialAccount.objects.create(user=b, provider="apple", uid="b-sub")
    client = Client()
    client.force_login(a, backend="django.contrib.auth.backends.ModelBackend")
    response = client.get("/_allauth/browser/v1/account/providers", HTTP_X_MEROSPLIT_ACCOUNT=str(a.pk))
    assert response.status_code == 200
    assert [a["provider"]["id"] for a in response.json()["data"]] == ["google"]
    assert client.get("/_allauth/browser/v1/account/providers", HTTP_X_MEROSPLIT_ACCOUNT=str(b.pk)).status_code == 401
    client.logout()
    assert client.get("/_allauth/browser/v1/account/providers").status_code == 401


def test_get_and_missing_or_cross_origin_csrf_do_not_start_auth(google_code):
    client = Client(enforce_csrf_checks=True)
    assert client.get("/auth/google?process=login").status_code == 405
    assert client.post("/auth/google", {"process": "login"}).status_code == 403
    client.get("/_allauth/browser/v1/config")
    assert client.post("/auth/google", {"process": "login"}, HTTP_X_CSRFTOKEN=client.cookies["csrftoken"].value, HTTP_ORIGIN="https://evil.invalid").status_code == 403
    assert google_code["exchanges"] == 0


def test_expired_browser_challenge_never_exchanges_code(google_code):
    client = Client()
    params = begin(client, google_code)
    session = client.session
    session["merosplit_google_signin"] = {**session["merosplit_google_signin"], "expires_at": int(time.time()) - 1}
    session.save()
    response = callback(client, params)
    assert "google_error" in response["Location"] and google_code["exchanges"] == 0


def test_connect_is_authoritative_and_same_email_never_auto_merges(google_code):
    User = get_user_model()
    user = User.objects.create(username="existing", email="google-new@example.invalid")
    anonymous = Client()
    params = begin(anonymous, google_code)
    response = callback(anonymous, params)
    assert "conflict" in response["Location"] and User.objects.count() == 1 and not SocialAccount.objects.exists()
    client = Client()
    client.force_login(user, backend="django.contrib.auth.backends.ModelBackend")
    params = begin(client, google_code, "connect", user.pk)
    response = callback(client, params)
    assert response.status_code == 302 and response["Location"] == "/app/?google_return=connect"
    assert SocialAccount.objects.get().user_id == user.pk
    assert client.get("/_allauth/browser/v1/account/providers").json()["data"][0]["provider"]["id"] == "google"
    exchanges = google_code["exchanges"]
    callback(client, params)
    assert google_code["exchanges"] == exchanges


def test_browser_configuration_and_redirect_allowlist_fail_closed(google_code, settings):
    client = Client()
    config = client.get("/_allauth/browser/v1/config")
    assert config.status_code == 200
    assert settings.GOOGLE_OAUTH_WEB_CLIENT_SECRET not in config.content.decode()
    assert "google_error" in client.post("/auth/google", {"process": "login", "next": "https://evil.invalid"})["Location"]
    settings.GOOGLE_OAUTH_WEB_CLIENT_SECRET = ""
    assert "google_error" in client.post("/auth/google", {"process": "login"})["Location"]
    assert google_code["exchanges"] == 0


def test_code_query_credentials_are_redacted_from_request_and_error_logs():
    import logging

    from config.logging import RedactInvitePath
    record = logging.LogRecord("test", logging.ERROR, __file__, 0, 'GET /auth/google/callback?code=synthetic-secret&state=synthetic-state HTTP/1.1', (), None)
    RedactInvitePath().filter(record)
    assert "synthetic-secret" not in record.getMessage() and "synthetic-state" not in record.getMessage()


def test_server_code_response_wrong_signing_key_is_rejected(google_code, signer, settings):
    from cryptography.hazmat.primitives.asymmetric import rsa
    client = Client()
    params = begin(client, google_code)
    wrong_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    google_code["id_token_override"] = token((wrong_key, signer[1]), settings, google_code["nonce"])
    response = callback(client, params)
    assert response.status_code == 302 and "google_error" in response["Location"]
    assert google_code["exchanges"] == 1 and not SocialAccount.objects.exists()
