import json
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier, Event
from time import monotonic, sleep
from urllib.parse import urlsplit
from uuid import uuid4

import pytest
from allauth.account.models import EmailAddress
from django.contrib.auth import get_user_model
from django.contrib.sessions.models import Session
from django.db import close_old_connections, connection, connections, transaction
from django.test import Client
from django.utils import timezone

from . import email_delivery, email_links, otp
from .models import (
    CommandReceipt,
    EmailCodeChallenge,
    EmailLoginGrant,
    Group,
    Invite,
    NotificationPreference,
    Participant,
    PushDevice,
)
from .test_api import send

pytestmark = pytest.mark.django_db


@pytest.fixture
def mailbox(monkeypatch):
    messages = []

    def deliver(recipient, subject, text, delivery_id, **kwargs):
        payload = email_delivery.materialize_payload(kwargs.get("payload") or email_delivery.message_payload(recipient, subject, text, kwargs.get("html")))
        messages.append((delivery_id, payload))
        return "synthetic-accepted"

    monkeypatch.setattr(email_delivery, "send_email", deliver)
    return messages


def user(email="recipient@example.invalid", name=""):
    return get_user_model().objects.create_user(username=uuid4().hex, email=email, first_name=name)


def grant(email="recipient@example.invalid", *, purpose="login", target=None, **kwargs):
    return email_links.issue_email_link(email, purpose=purpose, target=target or {"kind": "home"},
                                         source_key=f"synthetic/{uuid4()}", expires_at=timezone.now() + timedelta(seconds=180), **kwargs)


def proof(row):
    return urlsplit(email_links.delivery_url(row.id)).fragment.removeprefix("proof=")


def post(client, action, data, *, browser=False, csrf=None, **extra):
    if csrf:
        extra["HTTP_X_CSRFTOKEN"] = csrf
    return client.post(f"/_allauth/{'browser' if browser else 'app'}/v1/auth/link/{action}",
                       data=json.dumps(data), content_type="application/json", REMOTE_ADDR="192.0.2.12", **extra)


def exchange(client, row, *, browser=False, csrf=None):
    return post(client, "exchange", {"grant_id": str(row.id), "proof": proof(row)}, browser=browser, csrf=csrf)


def email_invite(email="recipient@example.invalid", name="Invited name", recipient=None):
    owner = user("organizer@example.invalid", "Organizer")
    group = Group.objects.create(owner=owner, name="Synthetic ledger", version=1)
    Participant.objects.create(group=group, name="Organizer record", user=owner)
    person = Participant.objects.create(group=group, name=name, contact_email=email, user=recipient)
    invite = Invite.objects.create(participant=person, token_hash=uuid4().hex, intended_email=email,
                                    expires_at=timezone.now() + timedelta(days=7))
    return group, person, invite


def test_request_click_cross_browser_creates_same_allauth_identity_and_no_raw_db_proof(mailbox):
    response = post(Client(), "request", {"email": " RECIPIENT@example.invalid ", "email_reminders_disclosed": True})
    assert response.status_code == 200 and response.json()["data"] == {"retry_after": 60, "accepted": True}
    row = EmailLoginGrant.objects.get()
    token = proof(row)
    assert token in mailbox[0][1]["text"] and len(token) == 43
    assert token not in json.dumps(row.payload) and "#proof=" not in json.dumps(row.payload)
    assert email_links.CODE_PLACEHOLDER in row.payload["text"]
    clicked = Client()
    response = exchange(clicked, row)
    assert response.status_code == 200, response.content
    body = response.json()
    assert body["data"]["target"] == {"kind": "home"} and body["data"]["needs_name"]
    identity = get_user_model().objects.get(pk=body["data"]["user"]["id"])
    assert identity.email == row.email and not identity.has_usable_password()
    assert EmailAddress.objects.filter(user=identity, verified=True).exists()
    assert NotificationPreference.objects.get(user=identity).email_reminders
    for session in Session.objects.all():
        assert token not in json.dumps(session.get_decoded())
    assert exchange(Client(), row).status_code == 400
    clicked.defaults["HTTP_X_SESSION_TOKEN"] = body["meta"]["session_token"]
    resumed = post(clicked, "resume", {"grant_id": str(row.id)})
    assert resumed.status_code == 200 and resumed.json()["data"]["user"]["id"] == identity.pk
    assert get_user_model().objects.count() == 1
    assert post(Client(), "resume", {"grant_id": str(row.id)}).status_code == 401


@pytest.mark.parametrize("disclosed", [False, True])
def test_link_disclosure_is_request_bound_and_existing_preferences_unchanged(mailbox, disclosed):
    row = grant(email_reminders_disclosed=disclosed)
    response = post(Client(), "exchange", {"grant_id": str(row.id), "proof": proof(row), "email_reminders_disclosed": True})
    assert response.status_code == 200
    identity = get_user_model().objects.get(pk=response.json()["data"]["user"]["id"])
    assert bool(NotificationPreference.objects.filter(user=identity, email_reminders=True).exists()) == disclosed
    newer = grant(email_reminders_disclosed=True)
    NotificationPreference.objects.update_or_create(user=identity, defaults={"email_reminders": False, "email_enabled_at": None})
    assert exchange(Client(), newer).status_code == 200
    assert not NotificationPreference.objects.get(user=identity).email_reminders


def test_browser_csrf_switch_rotates_session_and_deletes_old_device_only(mailbox):
    old = user("old@example.invalid", "Old name")
    intended = user(name="Chosen name")
    row = grant()
    browser = Client(enforce_csrf_checks=True)
    browser.force_login(old, backend="allauth.account.auth_backends.AuthenticationBackend")
    old_session = browser.session.session_key
    PushDevice.objects.create(id=uuid4(), user=old, session_id=old_session, provider="expo", token="synthetic", token_hash=uuid4().hex, platform="ios")
    browser.get("/_allauth/browser/v1/config")
    csrf = browser.cookies["csrftoken"].value
    assert exchange(browser, row, browser=True).status_code == 403
    assert exchange(browser, row, browser=True, csrf=csrf, ).status_code == 200
    assert browser.session.session_key != old_session
    assert not Session.objects.filter(session_key=old_session).exists()
    assert not PushDevice.objects.filter(user=old).exists()
    assert send(browser, "get", "/me").json()["id"] == intended.pk
    assert post(browser, "resume", {"grant_id": str(row.id)}, browser=True, csrf=csrf).status_code == 403
    csrf = browser.cookies["csrftoken"].value
    response = post(browser, "resume", {"grant_id": str(row.id)}, browser=True, csrf=csrf)
    assert response.status_code == 200 and not response.json()["data"]["needs_name"]
    assert "session_token" not in response.json()["meta"]


def test_get_head_and_cross_origin_are_inert_and_no_credential_in_url(mailbox):
    row = grant()
    client = Client(enforce_csrf_checks=True)
    for method in ["get", "head"]:
        assert getattr(client, method)(f"/app/sign-in/{row.id}").status_code in {200, 503}
        assert getattr(client, method)("/_allauth/browser/v1/auth/link/exchange").status_code == 405
    client.get("/_allauth/browser/v1/config")
    assert exchange(client, row, browser=True, csrf=client.cookies["csrftoken"].value,
                    ).status_code == 200
    other = grant(email="other@example.invalid")
    assert post(client, "exchange", {"grant_id": str(other.id), "proof": proof(other)}, browser=True,
                csrf=client.cookies["csrftoken"].value, HTTP_ORIGIN="https://hostile.example.invalid").status_code == 403
    assert get_user_model().objects.count() == 1
    other.refresh_from_db()
    assert other.consumed_at is None


@pytest.mark.parametrize("field,value", [("email", "other@example.invalid"), ("purpose", "digest"),
    ("target", {"kind": "home", "redirect": "https://evil.invalid"}), ("delivery_origin", "https://evil.invalid"),
    ("email_reminders_disclosed", True), ("expires_at", "future")])
def test_metadata_tampering_denies_without_creating_identity(field, value):
    row = grant()
    token = proof(row)
    if value == "future":
        value = timezone.now() + timedelta(days=1)
    EmailLoginGrant.objects.filter(pk=row.pk).update(**{field: value})
    result = post(Client(), "exchange", {"grant_id": str(row.id), "proof": token})
    assert result.status_code == 400 and not get_user_model().objects.exists()


@pytest.mark.parametrize("state", ["expired", "revoked", "consumed", "wrong_proof", "missing"])
def test_unavailable_links_have_generic_response(state):
    row = grant()
    token = proof(row)
    if state == "expired":
        # Preserve a cryptographically valid but actually expired issue time.
        row = email_links.issue_email_link("recipient@example.invalid", purpose="login", target={"kind": "home"},
                                          source_key=uuid4().hex, expires_at=timezone.now() - timedelta(seconds=1))
        token = proof(row)
    elif state == "revoked":
        EmailLoginGrant.objects.filter(pk=row.pk).update(revoked_at=timezone.now())
    elif state == "consumed":
        EmailLoginGrant.objects.filter(pk=row.pk).update(consumed_at=timezone.now())
    elif state == "wrong_proof":
        token = "A" * 43
    elif state == "missing":
        row.id = uuid4()
    response = post(Client(), "exchange", {"grant_id": str(row.id), "proof": token})
    assert response.status_code == 400 and response.json()["errors"][0]["code"] == "email_link_unavailable"
    assert not get_user_model().objects.exists()


@pytest.mark.parametrize("name", ["", "Chosen canonical"])
def test_invitation_claims_only_exact_person_preserves_name_and_finance(name):
    identity = user(name=name) if name else None
    group, person, invite = email_invite()
    other = Participant.objects.create(group=group, name="Other", contact_email="recipient@example.invalid")
    row = grant(purpose="invite", target={"kind": "invite", "invite_id": str(invite.id)})
    response = exchange(Client(), row)
    assert response.status_code == 200, response.content
    body = response.json()
    identity = get_user_model().objects.get(pk=body["data"]["user"]["id"])
    assert identity.first_name == (name or "Invited name") and not body["data"]["needs_name"]
    assert body["data"]["target"] == {"kind": "group", "group_id": str(group.id)}
    person.refresh_from_db()
    invite.refresh_from_db()
    other.refresh_from_db()
    assert person.user_id == identity.pk and invite.approved and invite.claimant_id == identity.pk
    assert other.user_id is None and CommandReceipt.objects.filter(actor=identity).count() == 1
    assert not group.expenses.exists() and not group.settlements.exists()


@pytest.mark.parametrize("state", ["revoked", "expired", "removed", "archived", "edited_email", "linked_other"])
def test_stale_invitation_cannot_create_account_or_claim(state):
    group, person, invite = email_invite()
    row = grant(purpose="invite", target={"kind": "invite", "invite_id": str(invite.id)})
    if state == "revoked":
        Invite.objects.filter(pk=invite.pk).update(revoked=True)
    elif state == "expired":
        Invite.objects.filter(pk=invite.pk).update(expires_at=timezone.now() - timedelta(seconds=1))
    elif state == "removed":
        Participant.objects.filter(pk=person.pk).update(removed=True)
    elif state == "archived":
        Group.objects.filter(pk=group.pk).update(archived=True)
    elif state == "edited_email":
        Invite.objects.filter(pk=invite.pk).update(intended_email="new@example.invalid")
    else:
        Participant.objects.filter(pk=person.pk).update(user=user("other@example.invalid"))
    assert exchange(Client(), row).status_code == 400
    assert not get_user_model().objects.filter(email="recipient@example.invalid").exists()
    row.refresh_from_db()
    assert row.consumed_at is None


@pytest.mark.parametrize("state", ["disabled", "conflict", "edited", "deleted", "review"])
def test_identity_conflict_disabled_deleted_edited_review_fail_closed(state, settings):
    identity = user()
    row = grant()
    token = proof(row)
    if state == "disabled":
        identity.is_active = False
        identity.save(update_fields=["is_active"])
    elif state == "conflict":
        user()
    elif state == "edited":
        EmailAddress.objects.create(user=identity, email=identity.email, verified=True)
        identity.email = "changed@example.invalid"
        identity.save(update_fields=["email"])
    elif state == "deleted":
        identity.delete()
    else:
        settings.STORE_REVIEW_AUTH = [{"user_id": identity.pk, "email": identity.email, "pin_hash": ""}]
    assert post(Client(), "exchange", {"grant_id": str(row.id), "proof": token}).status_code == 400
    assert not EmailLoginGrant.objects.filter(pk=row.pk, consumed_at__isnull=False).exists()


def test_renew_known_recipient_no_email_no_otp_and_missing_is_not_sent(mailbox):
    row = grant()
    response = post(Client(), "renew", {"grant_id": str(row.id)})
    assert response.status_code == 200 and response.json()["data"]["accepted"]
    replacement = row.renewals.get()
    assert replacement.email == row.email and replacement.expires_at <= timezone.now() + timedelta(seconds=180)
    assert exchange(Client(), replacement).status_code == 200
    response = post(Client(), "renew", {"grant_id": str(uuid4())})
    assert response.status_code == 200 and response.json()["data"]["accepted"] is False


def test_invite_renewal_never_extends_original_expiry(mailbox):
    group, person, invite = email_invite()
    invite.expires_at = timezone.now() + timedelta(seconds=20)
    invite.save(update_fields=["expires_at"])
    row = grant(purpose="invite", target={"kind": "invite", "invite_id": str(invite.id)})
    assert row.expires_at == invite.expires_at
    assert post(Client(), "renew", {"grant_id": str(row.id)}).json()["data"]["accepted"]
    assert row.renewals.get().expires_at == invite.expires_at


def test_login_renewal_keeps_recorded_disclosure_for_new_identity(mailbox):
    row = grant(email_reminders_disclosed=True)
    assert post(Client(), "renew", {"grant_id": str(row.id)}).json()["data"]["accepted"]
    replacement = row.renewals.get()
    assert replacement.email_reminders_disclosed
    response = exchange(Client(), replacement)
    assert response.status_code == 200
    assert NotificationPreference.objects.get(user_id=response.json()["data"]["user"]["id"]).email_reminders


def test_renew_uncertain_retry_reuses_same_payload_proof_key_and_expiry(mailbox, monkeypatch):
    row = grant()
    bodies = []
    def uncertain(recipient, subject, text, delivery_id, **kwargs):
        bodies.append((delivery_id, email_delivery.materialize_payload(kwargs["payload"])))
        raise email_delivery.EmailDeliveryUnavailable()
    monkeypatch.setattr(email_delivery, "send_email", uncertain)
    assert post(Client(), "renew", {"grant_id": str(row.id)}).status_code == 503
    replacement = row.renewals.get()
    expires = replacement.expires_at
    EmailCodeChallenge.objects.filter(email=row.email).update(requested_at=timezone.now() - timedelta(seconds=61))
    monkeypatch.setattr(email_delivery, "render_message", lambda *args, **kwargs: ("changed", "changed"))
    assert post(Client(), "renew", {"grant_id": str(row.id)}).status_code == 503
    replacement.refresh_from_db()
    assert bodies[0] == bodies[1] and row.renewals.count() == 1 and replacement.expires_at == expires
    assert "#proof=" not in json.dumps(replacement.payload)


def test_shared_otp_and_link_attempt_budget_cannot_be_bypassed(mailbox):
    otp.request_email_code("recipient@example.invalid", "192.0.2.0/24")
    row = EmailLoginGrant.objects.get()
    for _ in range(3):
        assert post(Client(), "exchange", {"grant_id": str(row.id), "proof": "A" * 43}).status_code == 400
    challenge = EmailCodeChallenge.objects.get()
    with pytest.raises(otp.EmailCodeLimited):
        otp.confirm_email_code(challenge.challenge_id, email_links.fallback_code(row.id), "198.51.100.0/24")
    assert not get_user_model().objects.exists()


@pytest.mark.parametrize("invalid", [None, 0, "true", [], {}, 1])
def test_malformed_disclosure_never_consumes_link(invalid):
    row = grant()
    response = post(Client(), "exchange", {"grant_id": str(row.id), "proof": proof(row), "email_reminders_disclosed": invalid})
    assert response.status_code == 400 and not get_user_model().objects.exists()
    row.refresh_from_db()
    assert row.consumed_at is None
    assert exchange(Client(), row).status_code == 200


@pytest.mark.parametrize("action,body", [("request", ["email"]), ("renew", ["id"]), ("exchange", ["proof"]),
                                         ("resume", ["id"]), ("request", {"email": "recipient@example.invalid", "target": "https://evil.invalid"})])
def test_malformed_shapes_and_redirect_input_fail_closed(action, body):
    assert post(Client(), action, body).status_code == 400
    assert not EmailLoginGrant.objects.exists()


@pytest.mark.parametrize("invalid", [None, 1, "", "A" * 44, "é" * 43, [], {}])
def test_malformed_proof_is_generic_invalid_without_exception(invalid):
    row = grant()
    assert post(Client(), "exchange", {"grant_id": str(row.id), "proof": invalid}).status_code == 400
    assert not get_user_model().objects.exists()


@pytest.mark.parametrize("first", ["code", "link"])
def test_alternative_code_and_link_are_one_login_credential(mailbox, first):
    result = otp.request_email_code("recipient@example.invalid", "192.0.2.0/24")
    row = EmailLoginGrant.objects.get()
    challenge_id = EmailCodeChallenge.objects.get().challenge_id
    assert str(challenge_id) == result["challenge_id"]
    if first == "code":
        otp.confirm_email_code(challenge_id, email_links.fallback_code(row.id), "192.0.2.0/24")
        assert exchange(Client(), row).status_code == 400
    else:
        assert exchange(Client(), row).status_code == 200
        with pytest.raises(otp.EmailCodeInvalid):
            otp.confirm_email_code(challenge_id, email_links.fallback_code(row.id), "192.0.2.0/24")
    assert get_user_model().objects.count() == 1


def test_correct_session_resume_rechecks_removed_membership_without_new_claim():
    group, person, invite = email_invite()
    row = grant(purpose="invite", target={"kind": "invite", "invite_id": str(invite.id)})
    client = Client()
    response = exchange(client, row)
    assert response.status_code == 200
    client.defaults["HTTP_X_SESSION_TOKEN"] = response.json()["meta"]["session_token"]
    assert post(client, "resume", {"grant_id": str(row.id)}).status_code == 200
    Participant.objects.filter(pk=person.pk).update(removed=True)
    assert post(client, "resume", {"grant_id": str(row.id)}).status_code == 400
    assert send(client, "get", f"/groups/{group.id}").status_code == 404
    assert CommandReceipt.objects.count() == 1


def test_renew_revoked_invitation_can_recover_account_but_never_membership(mailbox):
    group, person, invite = email_invite()
    row = grant(purpose="invite", target={"kind": "invite", "invite_id": str(invite.id)})
    Invite.objects.filter(pk=invite.pk).update(revoked=True)
    assert post(Client(), "renew", {"grant_id": str(row.id)}).json()["data"]["accepted"] is True
    replacement = row.renewals.get()
    response = exchange(Client(), replacement)
    assert response.status_code == 200 and response.json()["data"]["target"] == {"kind": "home"}
    person.refresh_from_db()
    assert person.user_id is None and not CommandReceipt.objects.exists()


def test_login_provider_retry_keeps_resolved_body_after_template_and_origin_change(mailbox, settings, monkeypatch):
    otp.request_email_code("recipient@example.invalid", "192.0.2.0/24")
    row = EmailLoginGrant.objects.get()
    settings.PUBLIC_WEB_URL = "https://new-canonical.example.invalid"
    monkeypatch.setattr(email_delivery, "render_message", lambda *args: ("new template", "new template"))
    otp.deliver_login_link(row.id)
    assert mailbox[0] == mailbox[1]
    assert row.delivery_origin in mailbox[1][1]["text"]
    assert settings.PUBLIC_WEB_URL not in mailbox[1][1]["text"]


def test_final_consume_rechecks_actual_expiry_after_waiting_for_target(monkeypatch):
    row = grant()
    destination = email_links._destination
    def after_wait(*args, **kwargs):
        result = destination(*args, **kwargs)
        monkeypatch.setattr(email_links.timezone, "now", lambda: row.expires_at + timedelta(seconds=1))
        return result
    monkeypatch.setattr(email_links, "_destination", after_wait)
    assert exchange(Client(), row).status_code == 400
    assert not get_user_model().objects.exists()
    row.refresh_from_db()
    assert row.consumed_at is None


def test_deleting_exact_invitation_target_erases_unbound_grant_and_recovery_payload(mailbox):
    group, person, invite = email_invite()
    row = grant(purpose="invite", target={"kind": "invite", "invite_id": str(invite.id)})
    token = proof(row)
    assert row.recipient_id is None
    group.delete()
    assert not EmailLoginGrant.objects.filter(pk=row.pk).exists()
    assert post(Client(), "exchange", {"grant_id": str(row.id), "proof": token}).status_code == 400
    assert post(Client(), "renew", {"grant_id": str(row.id)}).json()["data"]["accepted"] is False
    assert not mailbox


def test_account_deletion_erases_earlier_unbound_sibling_proof_and_cannot_recreate_identity():
    old = grant()
    token = proof(old)
    newer = grant()
    client = Client()
    response = exchange(client, newer)
    assert response.status_code == 200
    client.defaults["HTTP_X_SESSION_TOKEN"] = response.json()["meta"]["session_token"]
    assert send(client, "delete", "/account").status_code == 200
    assert not EmailLoginGrant.objects.exists() and not get_user_model().objects.exists()
    assert post(Client(), "exchange", {"grant_id": str(old.id), "proof": token}).status_code == 400
    assert not get_user_model().objects.exists()


def test_name_only_guard_preserves_existing_name_and_no_extra_revision():
    identity = user(name="Chosen in another tab")
    group = Group.objects.create(owner=identity, name="Name concurrency", version=3)
    Participant.objects.create(group=group, user=identity, name="Recorded name")
    from .test_api import authenticated_client
    client = authenticated_client(identity)
    response = send(client, "put", "/me/profile", {"display_name": "Stale onboarding", "only_if_unnamed": True})
    assert response.status_code == 200 and response.json() == {"display_name": "Chosen in another tab"}
    group.refresh_from_db()
    assert group.version == 3 and not group.changes.exists()
    assert send(client, "put", "/me/profile", {"display_name": "Explicit edit"}).json() == {"display_name": "Explicit edit"}
    assert send(client, "put", "/me/profile", {"display_name": "Invalid", "only_if_unnamed": "true"}).status_code == 422


@pytest.mark.django_db(transaction=True)
def test_parallel_bad_link_attempts_share_three_attempt_budget():
    row = grant()
    barrier = Barrier(4)
    def consume():
        close_old_connections()
        try:
            barrier.wait(timeout=5)
            email_links.exchange_email_link(row.id, "A" * 43, "192.0.2.0/24")
        except otp.EmailCodeInvalid:
            return "invalid"
        except otp.EmailCodeLimited:
            return "limited"
        finally:
            connections.close_all()
    with ThreadPoolExecutor(max_workers=4) as pool:
        result = list(pool.map(lambda _: consume(), range(4)))
    assert result.count("invalid") == 3 and result.count("limited") == 1
    assert not get_user_model().objects.exists()


@pytest.mark.django_db(transaction=True)
def test_parallel_code_and_link_do_not_create_two_users_or_sessions(mailbox):
    otp.request_email_code("recipient@example.invalid", "192.0.2.0/24")
    row = EmailLoginGrant.objects.get()
    challenge_id = EmailCodeChallenge.objects.get().challenge_id
    token, code = proof(row), email_links.fallback_code(row.id)
    barrier = Barrier(2)
    def consume(kind):
        close_old_connections()
        try:
            barrier.wait(timeout=5)
            if kind == "code":
                otp.confirm_email_code(challenge_id, code, "192.0.2.0/24")
            else:
                email_links.exchange_email_link(row.id, token, "192.0.2.0/24")
            return "accepted"
        except otp.EmailCodeInvalid:
            return "invalid"
        finally:
            connections.close_all()
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(consume, ["code", "link"])) == ["accepted", "invalid"]
    assert get_user_model().objects.count() == 1


@pytest.mark.django_db(transaction=True)
def test_concurrent_workers_consume_one_link_once():
    row = grant()
    token = proof(row)
    barrier = Barrier(2)
    def consume():
        close_old_connections()
        try:
            barrier.wait(timeout=5)
            email_links.exchange_email_link(row.id, token, "192.0.2.0/24")
            return "accepted"
        except otp.EmailCodeInvalid:
            return "invalid"
        finally:
            connections.close_all()
    with ThreadPoolExecutor(max_workers=2) as pool:
        result = list(pool.map(lambda _: consume(), range(2)))
    assert sorted(result) == ["accepted", "invalid"]
    assert get_user_model().objects.filter(email=row.email).count() == 1


@pytest.mark.django_db(transaction=True)
def test_waiting_consume_cannot_recreate_deleted_issued_identity():
    identity = user()
    row = grant()
    token, started, pids = proof(row), Event(), []
    def consume():
        close_old_connections()
        try:
            connection.ensure_connection()
            pids.append(connection.connection.info.backend_pid)
            started.set()
            try:
                email_links.exchange_email_link(row.id, token, "192.0.2.0/24")
            except otp.EmailCodeInvalid:
                return "invalid"
            return "accepted"
        finally:
            connections.close_all()
    with ThreadPoolExecutor(max_workers=1) as pool:
        with transaction.atomic():
            get_user_model().objects.select_for_update(no_key=True).get(pk=identity.pk)
            future = pool.submit(consume)
            assert started.wait(5)
            deadline = monotonic() + 5
            while True:
                with connection.cursor() as cursor:
                    cursor.execute("SELECT wait_event_type FROM pg_stat_activity WHERE pid=%s", pids)
                    waiting = cursor.fetchone()
                if waiting and waiting[0] == "Lock":
                    break
                assert monotonic() < deadline, "Exchange did not wait for identity lock"
                sleep(0.01)
            identity.delete()
        assert future.result(timeout=5) == "invalid"
    assert not get_user_model().objects.exists()
    assert EmailLoginGrant.objects.get(pk=row.pk).consumed_at is None
