import json
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from uuid import UUID, uuid4

import pytest
from allauth.account.models import EmailAddress
from django.contrib.auth import get_user_model
from django.contrib.sessions.models import Session
from django.db import close_old_connections, connections
from django.test import Client, RequestFactory
from django.utils import timezone

from . import email_delivery, otp
from .models import EmailCodeChallenge, EmailRateBucket, NotificationPreference
from .test_api import authenticated_client, send

pytestmark = pytest.mark.django_db


@pytest.fixture
def mailbox(monkeypatch):
    messages = []

    def deliver(recipient, subject, text, delivery_id, **kwargs):
        messages.append({"recipient": recipient, "text": text, "id": delivery_id, **kwargs})
        return f"synthetic-{uuid4()}"

    monkeypatch.setattr(email_delivery, "send_email", deliver)
    return messages


def post(client, action, data, *, browser=False, csrf=None, ip="192.0.2.10", **headers):
    if csrf:
        headers["HTTP_X_CSRFTOKEN"] = csrf
    return client.post(
        f"/_allauth/{'browser' if browser else 'app'}/v1/auth/code/{action}",
        data=json.dumps(data), content_type="application/json", REMOTE_ADDR=ip, **headers,
    )


def requested(client, mailbox, email="new-person@example.invalid", **kwargs):
    response = post(client, "request", {"email": email}, **kwargs)
    assert response.status_code == 200
    challenge_id = response.json()["data"]["challenge_id"]
    message = next(message for message in reversed(mailbox) if message["id"] == f"otp/{challenge_id}")
    code = re.search(r"\b([0-9]{4})\b", message["text"]).group(1)
    return challenge_id, code


def test_new_account_native_otp_verifies_allauth_and_never_persists_raw_code(mailbox):
    native = Client()
    challenge_id, code = requested(native, mailbox)
    challenge = EmailCodeChallenge.objects.get(challenge_id=challenge_id)
    assert len(challenge.digest) == 64 and challenge.digest != code
    assert not hasattr(challenge, "code")
    response = post(native, "confirm", {"challenge_id": challenge_id, "code": code})
    assert response.status_code == 200
    token = response.json()["meta"]["session_token"]
    user = get_user_model().objects.get(pk=response.json()["data"]["user"]["id"])
    assert not user.has_usable_password()
    assert EmailAddress.objects.filter(user=user, verified=True).exists()
    native.defaults["HTTP_X_SESSION_TOKEN"] = token
    assert send(native, "get", "/me").json()["email_verified"] is True
    assert send(native, "get", "/groups").json() == {"groups": []}
    for session in Session.objects.all():
        decoded = session.get_decoded()
        def leaves(value):
            if isinstance(value, dict):
                return [leaf for item in value.values() for leaf in leaves(item)]
            if isinstance(value, list):
                return [leaf for item in value for leaf in leaves(item)]
            return [value]
        assert code not in leaves(decoded)
    assert post(Client(), "confirm", {"challenge_id": challenge_id, "code": code}).status_code == 400
    assert get_user_model().objects.count() == 1


@pytest.mark.parametrize("browser", [False, True])
@pytest.mark.parametrize("disclosed", [None, False, True])
def test_new_identity_email_default_requires_explicit_disclosure_flag(mailbox, browser, disclosed):
    client = Client(enforce_csrf_checks=browser)
    if browser:
        client.get("/_allauth/browser/v1/config")
    csrf = client.cookies["csrftoken"].value if browser else None
    challenge_id, code = requested(client, mailbox, browser=browser, csrf=csrf)
    body = {"challenge_id": challenge_id, "code": code}
    if disclosed is not None:
        body["email_reminders_disclosed"] = disclosed
    response = post(client, "confirm", body, browser=browser, csrf=csrf)
    assert response.status_code == 200
    user_id = response.json()["data"]["user"]["id"]
    pref = NotificationPreference.objects.filter(user_id=user_id).first()
    assert bool(pref and pref.email_reminders) == (disclosed is True)
    assert bool(pref and pref.email_enabled_at) == (disclosed is True)
    assert not pref or pref.expense_updates


@pytest.mark.parametrize("invalid", [None, 0, 1, "true", "false", [], {}, "unknown"])
def test_email_disclosure_flag_is_strict_and_invalid_shape_does_not_consume_code(mailbox, invalid):
    challenge_id, code = requested(Client(), mailbox)
    response = post(Client(), "confirm", {"challenge_id": challenge_id, "code": code, "email_reminders_disclosed": invalid})
    assert response.status_code == 400 and not get_user_model().objects.exists()
    challenge = EmailCodeChallenge.objects.get(challenge_id=challenge_id)
    assert not challenge.consumed and challenge.attempts == 0
    assert post(Client(), "confirm", {"challenge_id": challenge_id, "code": code}).status_code == 200
    assert not NotificationPreference.objects.exists()


@pytest.mark.parametrize("current,disclosed", [(None, True), (False, True), (True, True), (True, False)])
def test_disclosure_flag_never_changes_an_existing_identity_preference(mailbox, current, disclosed):
    user = get_user_model().objects.create_user(username="existing-disclosure", email="existing-disclosure@example.invalid")
    if current is not None:
        NotificationPreference.objects.create(user=user, expense_updates=False, email_reminders=current, email_enabled_at=timezone.now() if current else None)
    before = list(NotificationPreference.objects.values())
    challenge_id, code = requested(Client(), mailbox, user.email)
    response = post(Client(), "confirm", {"challenge_id": challenge_id, "code": code, "email_reminders_disclosed": disclosed})
    assert response.status_code == 200 and response.json()["data"]["user"]["id"] == user.pk
    assert list(NotificationPreference.objects.values()) == before


def test_existing_identity_password_hash_and_valid_sessions_are_preserved(mailbox):
    user = get_user_model().objects.create_user(username="existing", email="Existing@Example.invalid", password="Synthetic-existing-password-only")
    EmailAddress.objects.create(user=user, email=user.email, verified=False, primary=True)
    old = authenticated_client(user)
    old_hash, old_email, user_id = user.password, user.email, user.pk
    native = Client()
    challenge_id, code = requested(native, mailbox, "existing@example.invalid")
    response = post(native, "confirm", {"challenge_id": challenge_id, "code": code})
    assert response.status_code == 200
    assert response.json()["data"]["user"]["id"] == user_id
    user.refresh_from_db()
    assert user.password == old_hash and user.email == old_email
    assert send(old, "get", "/me").status_code == 200
    assert EmailAddress.objects.filter(user=user).count() == 1


def test_browser_code_login_requires_csrf_and_uses_cookie_session(mailbox):
    browser = Client(enforce_csrf_checks=True)
    assert browser.get("/_allauth/browser/v1/config").status_code == 200
    csrf = browser.cookies["csrftoken"].value
    assert post(browser, "request", {"email": "browser@example.invalid"}, browser=True).status_code == 403
    challenge_id, code = requested(browser, mailbox, "browser@example.invalid", browser=True, csrf=csrf)
    assert post(browser, "confirm", {"challenge_id": challenge_id, "code": code}, browser=True).status_code == 403
    response = post(browser, "confirm", {"challenge_id": challenge_id, "code": code}, browser=True, csrf=csrf)
    assert response.status_code == 200
    assert "session_token" not in response.json().get("meta", {})
    assert browser.cookies.get("sessionid")
    assert send(browser, "get", "/me").status_code == 200


def test_exact_ascii_four_digits_preserve_leading_zero(mailbox, monkeypatch):
    monkeypatch.setattr(otp.secrets, "randbelow", lambda maximum: 7)
    native = Client()
    challenge_id, code = requested(native, mailbox)
    assert len(code) == 4 and code.startswith("0") and code.isascii() and code.isdecimal()
    assert post(native, "confirm", {"challenge_id": challenge_id, "code": code}).status_code == 200


@pytest.mark.parametrize("invalid", [" 0000", "0000 ", "００００", 0, "000", "00000", None])
def test_invalid_code_shapes_consume_attempt_budget(mailbox, invalid):
    challenge_id, _ = requested(Client(), mailbox)
    response = post(Client(), "confirm", {"challenge_id": challenge_id, "code": invalid})
    assert response.status_code == 400
    assert EmailCodeChallenge.objects.get().attempts == 1


def test_expiry_single_use_resend_invalidation_and_cooldown(mailbox):
    first_id, first_code = requested(Client(), mailbox)
    limited = post(Client(), "request", {"email": "new-person@example.invalid"})
    assert limited.status_code == 429 and len(mailbox) == 1
    EmailCodeChallenge.objects.update(requested_at=timezone.now() - timedelta(seconds=61))
    second_id, second_code = requested(Client(), mailbox)
    assert second_id != first_id
    assert post(Client(), "confirm", {"challenge_id": first_id, "code": first_code}).status_code == 400
    EmailCodeChallenge.objects.update(expires_at=timezone.now() - timedelta(seconds=1))
    assert post(Client(), "confirm", {"challenge_id": second_id, "code": second_code}).status_code == 400
    assert get_user_model().objects.count() == 0


def test_resend_does_not_reset_mailbox_guess_budget(mailbox):
    first_id, code = requested(Client(), mailbox)
    wrong = "0000" if code != "0000" else "9999"
    for _ in range(3):
        assert post(Client(), "confirm", {"challenge_id": first_id, "code": wrong}).status_code == 400
    EmailCodeChallenge.objects.update(requested_at=timezone.now() - timedelta(seconds=61))
    second_id, second_code = requested(Client(), mailbox)
    assert post(Client(), "confirm", {"challenge_id": second_id, "code": second_code}, ip="198.51.100.10").status_code == 429
    assert get_user_model().objects.count() == 0


def test_request_response_and_invalid_response_do_not_enumerate_accounts(mailbox):
    user = get_user_model().objects.create_user(username="known", email="known@example.invalid")
    first = post(Client(), "request", {"email": user.email})
    second = post(Client(), "request", {"email": "unknown@example.invalid"})
    assert first.status_code == second.status_code == 200
    for response in [first, second]:
        body = response.json()
        assert set(body["data"]) == {"challenge_id", "expires_in", "retry_after"}
        assert "email" not in body["data"] and "user" not in body["data"] and "code" not in body["data"]
    fake = post(Client(), "confirm", {"challenge_id": str(uuid4()), "code": "0000"})
    actual = post(Client(), "confirm", {"challenge_id": first.json()["data"]["challenge_id"], "code": "x"})
    assert fake.status_code == actual.status_code == 400 and fake.json() == actual.json()


def test_provider_failure_is_generic_and_never_accepts_undelivered_code(mailbox, monkeypatch):
    def fail(*args, **kwargs):
        raise email_delivery.EmailDeliveryUnavailable()
    monkeypatch.setattr(email_delivery, "send_email", fail)
    response = post(Client(), "request", {"email": "failure@example.invalid"})
    assert response.status_code == 503
    challenge = EmailCodeChallenge.objects.get()
    assert not challenge.delivered
    assert post(Client(), "confirm", {"challenge_id": str(challenge.challenge_id), "code": "0000"}).status_code == 400


def test_per_email_request_limit_survives_new_sessions_and_networks(mailbox):
    for index in range(5):
        EmailCodeChallenge.objects.update(requested_at=timezone.now() - timedelta(seconds=61))
        assert post(Client(), "request", {"email": "limited@example.invalid"}, ip=f"198.51.{index}.1").status_code == 200
    EmailCodeChallenge.objects.update(requested_at=timezone.now() - timedelta(seconds=61))
    assert post(Client(), "request", {"email": "limited@example.invalid"}, ip="203.0.113.1").status_code == 429
    assert len(mailbox) == 5


def test_network_request_limit_ignores_spoofed_forwarded_headers(mailbox):
    for index in range(30):
        assert post(Client(), "request", {"email": f"synthetic-{index}@example.invalid"}, ip=f"192.0.2.{index + 1}", HTTP_X_FORWARDED_FOR=f"198.51.{index}.1").status_code == 200
    assert post(Client(), "request", {"email": "last@example.invalid"}, HTTP_X_FORWARDED_FOR="203.0.113.99").status_code == 429
    assert len(mailbox) == 30
    assert otp.client_network(RequestFactory().get("/", REMOTE_ADDR="2001:db8::1")) == "2001:db8::/64"


@pytest.fixture
def railway_public(settings):
    settings.EMAIL_CLIENT_IP_SOURCE = "railway_public"
    settings.EMAIL_RAILWAY_PUBLIC_HOSTS = {"api.example.invalid"}
    settings.ALLOWED_HOSTS = [*settings.ALLOWED_HOSTS, "api.example.invalid", "api.railway.internal", "other.example.invalid"]
    return {"HTTP_HOST": "api.example.invalid", "secure": True}


def test_proxy_ip_headers_are_ignored_without_explicit_deployment_opt_in(settings):
    settings.EMAIL_CLIENT_IP_SOURCE = "remote_addr"
    settings.EMAIL_RAILWAY_PUBLIC_HOSTS = {"testserver"}
    request = RequestFactory().get(
        "/", secure=True, REMOTE_ADDR="192.0.2.10", HTTP_X_REAL_IP="198.51.100.10",
        HTTP_X_FORWARDED_FOR="203.0.113.10",
    )
    assert otp.client_network(request) == "192.0.2.0/24"


@pytest.mark.parametrize("source,network", [("198.51.100.10", "198.51.100.0/24"), ("2001:db8:1::12", "2001:db8:1::/64")])
def test_declared_railway_public_context_uses_validated_real_ip(railway_public, source, network):
    request = RequestFactory().get(
        "/", REMOTE_ADDR="10.0.0.10", HTTP_X_REAL_IP=source, HTTP_X_FORWARDED_FOR="203.0.113.10", **railway_public,
    )
    assert otp.client_network(request) == network


@pytest.mark.parametrize("source", ["", "not-an-address", "198.51.100.1, 203.0.113.2", "198.51.100.1/24", " 198.51.100.1", "fe80::1%eth0"])
def test_invalid_public_edge_real_ip_shares_fail_closed_bucket(railway_public, source):
    request = RequestFactory().get("/", REMOTE_ADDR="10.0.0.10", HTTP_X_REAL_IP=source, **railway_public)
    assert otp.client_network(request) == "unknown-network"


@pytest.mark.parametrize("host,secure", [("api.railway.internal", True), ("other.example.invalid", True), ("api.example.invalid", False)])
def test_private_other_host_or_plain_http_cannot_select_proxy_ip(railway_public, host, secure):
    request = RequestFactory().get(
        "/", REMOTE_ADDR="10.0.0.10", HTTP_X_REAL_IP="198.51.100.10", HTTP_HOST=host, secure=secure,
    )
    assert otp.client_network(request) == "10.0.0.0/24"


@pytest.mark.parametrize("host", ["api.railway.internal", "127.0.0.1", "10.0.0.10", "localhost"])
def test_private_hostname_or_ip_cannot_qualify_even_if_misconfigured(settings, railway_public, host):
    settings.ALLOWED_HOSTS.append(host)
    settings.EMAIL_RAILWAY_PUBLIC_HOSTS = {host}
    request = RequestFactory().get(
        "/", secure=True, HTTP_HOST=host, REMOTE_ADDR="10.0.0.10", HTTP_X_REAL_IP="198.51.100.10",
    )
    assert otp.client_network(request) == "10.0.0.0/24"


def test_public_edge_network_quota_uses_real_ip_and_never_forwarded_for(mailbox, railway_public):
    for index in range(30):
        assert post(Client(), "request", {"email": f"edge-{index}@example.invalid"}, ip="10.0.0.10",
                    HTTP_X_REAL_IP=f"192.0.2.{index + 1}", HTTP_X_FORWARDED_FOR=f"198.51.{index}.1", **railway_public).status_code == 200
    assert post(Client(), "request", {"email": "edge-limited@example.invalid"}, ip="10.0.0.10",
                HTTP_X_REAL_IP="192.0.2.100", HTTP_X_FORWARDED_FOR="203.0.113.1", **railway_public).status_code == 429
    assert post(Client(), "request", {"email": "edge-other-network@example.invalid"}, ip="10.0.0.10",
                HTTP_X_REAL_IP="198.51.100.10", **railway_public).status_code == 200


def test_different_public_edge_ips_do_not_reset_shared_mailbox_guess_budget(mailbox, railway_public):
    challenge_id, code = requested(Client(), mailbox, HTTP_X_REAL_IP="192.0.2.10", **railway_public)
    wrong = "0000" if code != "0000" else "9999"
    for network in range(3):
        assert post(Client(), "confirm", {"challenge_id": challenge_id, "code": wrong},
                    HTTP_X_REAL_IP=f"198.51.{network}.10", **railway_public).status_code == 400
    assert post(Client(), "confirm", {"challenge_id": challenge_id, "code": code},
                HTTP_X_REAL_IP="203.0.113.10", **railway_public).status_code == 429
    assert EmailCodeChallenge.objects.get().attempts == 3
    assert not get_user_model().objects.exists()


def test_different_public_edge_ips_do_not_reset_mailbox_request_budget(mailbox, railway_public):
    for network in range(5):
        EmailCodeChallenge.objects.update(requested_at=timezone.now() - timedelta(seconds=61))
        assert post(Client(), "request", {"email": "edge-mailbox@example.invalid"},
                    HTTP_X_REAL_IP=f"198.51.{network}.10", **railway_public).status_code == 200
    EmailCodeChallenge.objects.update(requested_at=timezone.now() - timedelta(seconds=61))
    assert post(Client(), "request", {"email": "edge-mailbox@example.invalid"},
                HTTP_X_REAL_IP="203.0.113.10", **railway_public).status_code == 429
    assert len(mailbox) == 5


@pytest.mark.django_db(transaction=True)
def test_two_workers_can_consume_one_code_only_once(mailbox):
    challenge_id, code = requested(Client(), mailbox)

    def confirm(_):
        close_old_connections()
        try:
            try:
                otp.confirm_email_code(UUID(challenge_id), code, "192.0.2.0/24")
                return True
            except otp.EmailCodeInvalid:
                return False
        finally:
            connections.close_all()
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(confirm, range(2)))
    assert results.count(True) == 1 and get_user_model().objects.count() == 1
    assert EmailCodeChallenge.objects.get().consumed


@pytest.mark.django_db(transaction=True)
def test_concurrent_wrong_attempts_cannot_exceed_three(mailbox):
    challenge_id, code = requested(Client(), mailbox)
    wrong = "0000" if code != "0000" else "9999"

    def guess(_):
        close_old_connections()
        try:
            try:
                otp.confirm_email_code(UUID(challenge_id), wrong, "192.0.2.0/24")
            except (otp.EmailCodeInvalid, otp.EmailCodeLimited):
                return False
        finally:
            connections.close_all()
    with ThreadPoolExecutor(max_workers=5) as pool:
        assert not any(pool.map(guess, range(5)))
    assert EmailCodeChallenge.objects.get().attempts == 3
    assert not get_user_model().objects.exists()


def test_inactive_or_conflicting_legacy_identities_never_merge(mailbox):
    User = get_user_model()
    User.objects.create_user(username="inactive", email="inactive@example.invalid", is_active=False)
    User.objects.create_user(username="first", email="duplicate@example.invalid")
    User.objects.create_user(username="second", email="DUPLICATE@example.invalid")
    for email in ["inactive@example.invalid", "duplicate@example.invalid"]:
        challenge_id, code = requested(Client(), mailbox, email)
        assert post(Client(), "confirm", {"challenge_id": challenge_id, "code": code}).status_code == 400
    assert User.objects.count() == 3


def test_password_and_legacy_verification_routes_are_blocked(mailbox):
    for client_type in ["app", "browser"]:
        for path in ["auth/login", "auth/signup", "auth/password/reset", "auth/password/request", "account/password/change", "account/email", "auth/email/verify", "auth/code/resend"]:
            assert Client().post(f"/_allauth/{client_type}/v1/{path}", data="{}", content_type="application/json").status_code == 403
    assert EmailRateBucket.objects.count() == 0 and mailbox == []
