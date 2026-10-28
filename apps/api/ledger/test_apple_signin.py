"""Signed synthetic Apple proofs and real allauth sessions, with all HTTP mocked."""
import json
import time

import jwt
import pytest
import requests
from allauth.account.models import EmailAddress
from allauth.socialaccount.models import SocialAccount, SocialToken
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from django.contrib.auth import get_user_model
from django.contrib.sessions.models import Session
from django.test import Client

from .test_api import authenticated_client, send

pytestmark = pytest.mark.django_db


@pytest.fixture(scope="module")
def keys():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048), ec.generate_private_key(ec.SECP256R1())


@pytest.fixture(autouse=True)
def apple(settings, monkeypatch, keys):
    settings.APPLE_SIGN_IN_ENABLED = True
    settings.APPLE_SIGN_IN_KEY_ID = "SYNTHETIC"
    settings.APPLE_SIGN_IN_PRIVATE_KEY = keys[1].private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
    settings.APPLE_SIGN_IN_TOKEN_ENCRYPTION_KEY = Fernet.generate_key().decode()
    wire = {"calls": [], "exchange": None, "revoke_status": 200, "offline": False}

    def request(_session, method, url, **kwargs):
        wire["calls"].append((method.upper(), url))
        response = requests.Response()
        response.status_code = 200
        response._content_consumed = True
        if method.upper() == "GET":
            assert url == "https://appleid.apple.com/auth/keys"
            jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(keys[0].public_key()))
            response._content = json.dumps({"keys": [{**jwk, "kid": "synthetic", "alg": "RS256"}]}).encode()
        else:
            assert url in {"https://appleid.apple.com/auth/token", "https://appleid.apple.com/auth/revoke"}
            assert kwargs["allow_redirects"] is False and kwargs["timeout"] == (3, 5)
            form = kwargs["data"]
            secret = jwt.decode(form["client_secret"], keys[1].public_key(), algorithms=["ES256"], audience="https://appleid.apple.com")
            assert secret["sub"] == settings.APPLE_SIGN_IN_CLIENT_ID and secret["iss"] == settings.APPLE_SIGN_IN_TEAM_ID
            assert secret["exp"] - secret["iat"] == 300
            if wire["offline"]:
                raise requests.ConnectionError("synthetic private failure")
            if url.endswith("/token"):
                assert form["grant_type"] == "authorization_code" and form["code"] == "synthetic-one-use-code"
                response._content = json.dumps({"id_token": wire["exchange"], "refresh_token": "synthetic-refresh-only"}).encode()
            else:
                assert form["token"] == "synthetic-refresh-only" and form["token_type_hint"] == "refresh_token"
                response.status_code = wire["revoke_status"]
                response._content = b""
        return response

    monkeypatch.setattr(requests.Session, "request", request)
    return wire


def post(client, action, data):
    return client.post(f"/_allauth/app/v1/auth/apple/{action}", data=json.dumps(data), content_type="application/json", REMOTE_ADDR="192.0.2.43")


def challenge(client, process="login"):
    response = post(client, "challenge", {"process": process})
    assert response.status_code == 200, response.content
    client.defaults["HTTP_X_SESSION_TOKEN"] = response.json().get("meta", {}).get("session_token", client.defaults.get("HTTP_X_SESSION_TOKEN"))
    client.cookies.clear()
    return response.json()["data"]


def credential(keys, settings, expected_nonce, **claims):
    return jwt.encode({"sub": "apple-sub", "aud": settings.APPLE_SIGN_IN_CLIENT_ID, "iss": "https://appleid.apple.com",
        "exp": int(time.time()) + 120, "nonce": expected_nonce, "email": "relay@privaterelay.appleid.com", "email_verified": "true", **claims},
        keys[0], algorithm="RS256", headers={"kid": "synthetic"})


def submit(client, keys, settings, apple, proof, process="login", **claims):
    token = credential(keys, settings, proof["nonce"], **claims)
    apple["exchange"] = token
    return post(client, "token", {"process": process, "id_token": token, "authorization_code": "synthetic-one-use-code", "state": proof["state"], "given_name": "Initial", "family_name": "Name"})


def test_apple_private_relay_uses_allauth_and_encrypts_only_refresh_credential(keys, settings, apple, mailoutbox):
    client = Client()
    response = submit(client, keys, settings, apple, challenge(client))
    assert response.status_code == 200, response.content
    user = get_user_model().objects.get(pk=response.json()["data"]["user"]["id"])
    assert user.email == "relay@privaterelay.appleid.com" and user.first_name == "Initial"
    assert not user.has_usable_password() and not mailoutbox
    assert EmailAddress.objects.filter(user=user, verified=True).exists()
    account = SocialAccount.objects.get(user=user, provider="apple", uid="apple-sub")
    assert set(account.extra_data) == {"sub", "email", "email_verified"}
    saved = SocialToken.objects.get(account=account)
    assert saved.token == "" and saved.token_secret != "synthetic-refresh-only"
    assert Fernet(settings.APPLE_SIGN_IN_TOKEN_ENCRYPTION_KEY.encode()).decrypt(saved.token_secret.encode()) == b"synthetic-refresh-only"
    assert "synthetic-refresh" not in response.content.decode() and "id_token" not in response.content.decode()
    client.defaults["HTTP_X_SESSION_TOKEN"] = response.json()["meta"]["session_token"]
    assert send(client, "get", "/me").json()["id"] == user.pk


@pytest.mark.parametrize("claims", [{"aud": "wrong"}, {"iss": "wrong"}, {"exp": 1}, {"exp": True}, {"sub": ""}, {"nonce": "wrong"}, {"email_verified": False}, {"email_verified": 1}, {"email": "bad"}])
def test_invalid_apple_proof_never_exchanges_or_creates_identity(claims, keys, settings, apple):
    client = Client()
    response = submit(client, keys, settings, apple, challenge(client), **claims)
    assert response.status_code == 400
    assert not SocialAccount.objects.exists() and not get_user_model().objects.exists()
    assert all(method == "GET" for method, _ in apple["calls"])


@pytest.mark.parametrize("field,value", [("state", "wrong"), ("authorization_code", []), ("given_name", {}), ("process", []), ("process", {})])
def test_malformed_and_state_mismatch_fail_closed(field, value, keys, settings, apple):
    client = Client()
    proof = challenge(client)
    data = {"process": "login", "id_token": credential(keys, settings, proof["nonce"]), "authorization_code": "synthetic-one-use-code", "state": proof["state"], field: value}
    assert post(client, "token", data).status_code in (400, 409)
    assert all(method == "GET" for method, _ in apple["calls"])
    assert not SocialAccount.objects.exists()


def test_signature_and_exchanged_subject_are_both_verified(keys, settings, apple):
    client = Client()
    proof = challenge(client)
    wrong_key = (rsa.generate_private_key(public_exponent=65537, key_size=2048), keys[1])
    assert submit(client, wrong_key, settings, apple, proof).status_code == 400
    proof = challenge(client)
    apple["exchange"] = credential(keys, settings, proof["nonce"], sub="another-sub")
    response = post(client, "token", {"process": "login", "id_token": credential(keys, settings, proof["nonce"]), "authorization_code": "synthetic-one-use-code", "state": proof["state"]})
    assert response.status_code == 400 and not SocialAccount.objects.exists()


def test_existing_verified_email_auto_links_and_returning_sub_needs_no_name_or_email(keys, settings, apple):
    user = get_user_model().objects.create_user(username="owner", email="relay@privaterelay.appleid.com", first_name="Keep")
    EmailAddress.objects.create(user=user, email=user.email, primary=True, verified=True)
    anonymous = Client()
    response = submit(anonymous, keys, settings, apple, challenge(anonymous))
    assert response.status_code == 200, response.content
    assert SocialAccount.objects.get().user_id == user.pk
    client = authenticated_client(user)
    proof = challenge(client, "connect")
    stale = Session.objects.get(session_key=client.defaults["HTTP_X_SESSION_TOKEN"]).session_data
    response = submit(client, keys, settings, apple, proof, "connect")
    assert response.status_code == 200, response.content
    user.refresh_from_db()
    assert user.first_name == "Keep"
    row = Session.objects.get(session_key=client.defaults["HTTP_X_SESSION_TOKEN"])
    row.session_data = stale
    row.save(update_fields=["session_data"])
    assert submit(client, keys, settings, apple, proof, "connect").status_code == 400
    fresh = Client()
    response = submit(fresh, keys, settings, apple, challenge(fresh), email=None, email_verified=None)
    assert response.status_code == 200 and response.json()["data"]["user"]["id"] == user.pk
    assert get_user_model().objects.count() == 1 and SocialToken.objects.count() == 1


def test_connect_cannot_take_other_apple_identity_and_stale_actor_is_rejected(keys, settings, apple):
    owner = get_user_model().objects.create_user(username="owner", email="owner@example.invalid")
    other = get_user_model().objects.create_user(username="other", email="other@example.invalid")
    SocialAccount.objects.create(user=owner, provider="apple", uid="apple-sub")
    client = authenticated_client(other)
    assert submit(client, keys, settings, apple, challenge(client, "connect"), "connect").status_code == 409
    proof = challenge(client, "connect")
    assert submit(client, keys, settings, apple, proof, "login").status_code == 409
    assert SocialAccount.objects.get().user_id == owner.pk


def test_offline_exchange_consumes_proof_without_local_adoption_or_automatic_retry(keys, settings, apple):
    client = Client()
    proof = challenge(client)
    apple["offline"] = True
    assert submit(client, keys, settings, apple, proof).status_code == 503
    assert submit(client, keys, settings, apple, proof).status_code == 400
    assert sum(method == "POST" for method, _ in apple["calls"]) == 1
    assert not SocialAccount.objects.exists()


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("revoke_status,expected", [(200, "revoked"), (400, "manual_required"), (500, "manual_required")])
def test_actual_deletion_response_reports_confirmed_or_unconfirmed_revoke(revoke_status, expected, keys, settings, apple):
    user = get_user_model().objects.create_user(username="delete", email="delete@example.invalid")
    account = SocialAccount.objects.create(user=user, provider="apple", uid="apple-delete")
    SocialToken.objects.create(account=account, token="", token_secret=Fernet(settings.APPLE_SIGN_IN_TOKEN_ENCRYPTION_KEY.encode()).encrypt(b"synthetic-refresh-only").decode())
    client = authenticated_client(user)
    apple["revoke_status"] = revoke_status
    response = send(client, "delete", "/account")
    assert response.status_code == 200, response.content
    assert response.json() == {"deleted": True, "apple_revocation": expected}
    assert not get_user_model().objects.filter(pk=user.pk).exists() and not SocialToken.objects.exists()
    assert sum(url.endswith("/revoke") for _, url in apple["calls"]) == 1


@pytest.mark.django_db(transaction=True)
def test_missing_legacy_refresh_still_deletes_and_tells_actual_client_manual_required(apple):
    user = get_user_model().objects.create_user(username="legacy", email="legacy@example.invalid")
    SocialAccount.objects.create(user=user, provider="apple", uid="legacy-sub")
    response = send(authenticated_client(user), "delete", "/account")
    assert response.status_code == 200 and response.json() == {"deleted": True, "apple_revocation": "manual_required"}
    assert not apple["calls"]


def test_disabled_or_incomplete_config_is_unavailable_without_provider_call(settings, apple):
    settings.APPLE_SIGN_IN_KEY_ID = ""
    assert post(Client(), "challenge", {"process": "login"}).status_code == 503
    assert not apple["calls"]


@pytest.mark.django_db(transaction=True)
def test_deletion_transport_uncertainty_is_manual_required_not_revoked(settings, apple):
    user = get_user_model().objects.create_user(username="uncertain", email="uncertain@example.invalid")
    account = SocialAccount.objects.create(user=user, provider="apple", uid="uncertain-sub")
    SocialToken.objects.create(account=account, token="", token_secret=Fernet(settings.APPLE_SIGN_IN_TOKEN_ENCRYPTION_KEY.encode()).encrypt(b"synthetic-refresh-only").decode())
    apple["offline"] = True
    response = send(authenticated_client(user), "delete", "/account")
    assert response.status_code == 200 and response.json()["apple_revocation"] == "manual_required"
    assert not get_user_model().objects.filter(pk=user.pk).exists()
    assert sum(method == "POST" for method, _ in apple["calls"]) == 1


def test_expired_challenge_cannot_adopt_apple_identity(keys, settings, apple):
    client = Client()
    proof = challenge(client)
    row = Session.objects.get(session_key=client.defaults["HTTP_X_SESSION_TOKEN"])
    stored = row.get_decoded()
    stored["merosplit_apple_signin"]["expires_at"] = 1
    row.session_data = client.session.encode(stored)
    row.save(update_fields=["session_data"])
    assert submit(client, keys, settings, apple, proof).status_code == 400
    assert not SocialAccount.objects.exists()


def test_reviewer_reserved_email_and_inactive_link_cannot_enter_apple_flow(keys, settings, apple):
    settings.STORE_REVIEW_AUTH = [{"email": "relay@privaterelay.appleid.com", "user_id": 99, "store": "apple", "pin_hash": ""}]
    client = Client()
    assert submit(client, keys, settings, apple, challenge(client)).status_code == 400
    assert not SocialAccount.objects.exists()
    settings.STORE_REVIEW_AUTH = []
    user = get_user_model().objects.create_user(username="inactive", email="inactive@example.invalid", is_active=False)
    SocialAccount.objects.create(user=user, provider="apple", uid="apple-sub")
    assert submit(client, keys, settings, apple, challenge(client)).status_code == 400
    assert all(method == "GET" for method, _ in apple["calls"])


def test_cross_session_and_rate_limit_do_not_exchange_apple_proofs(keys, settings, apple):
    a, b = Client(), Client()
    proof = challenge(a)
    assert submit(b, keys, settings, apple, proof).status_code == 400
    for _ in range(9):
        assert post(a, "challenge", {"process": "login"}).status_code == 200
    assert post(a, "challenge", {"process": "login"}).status_code == 429
    assert all(method == "GET" for method, _ in apple["calls"])


def test_auto_link_off_requires_explicit_apple_connect(keys, settings, apple):
    from .models import SignInPreference
    user = get_user_model().objects.create_user(username='apple-owner', email='relay@privaterelay.appleid.com')
    EmailAddress.objects.create(user=user, email=user.email, verified=True, primary=True)
    SignInPreference.objects.create(user=user, auto_link=False)
    fresh = Client()
    response = submit(fresh, keys, settings, apple, challenge(fresh))
    assert response.status_code == 409 and not SocialAccount.objects.exists()
    owner = authenticated_client(user)
    response = submit(owner, keys, settings, apple, challenge(owner, 'connect'), 'connect')
    assert response.status_code == 200 and SocialAccount.objects.get().user_id == user.pk
