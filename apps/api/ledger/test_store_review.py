import json
import runpy
import secrets
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from uuid import UUID, uuid4

import pytest
from allauth.account.models import EmailAddress
from django.contrib.auth import get_user_model
from django.contrib.auth.hashers import make_password
from django.contrib.sessions.models import Session
from django.db import close_old_connections, connections
from django.test import Client
from django.utils import timezone

from . import otp
from .collaboration import invite_token
from .models import EmailCodeChallenge, Expense, ExpensePushDelivery, Invite, Participant, UploadedFile
from .push import send_pending_bill_notifications
from .test_api import authenticated_client, expense, send, uid
from .test_email_codes import mailbox as mailbox
from .test_email_codes import post, requested
from .test_push import register

pytestmark = pytest.mark.django_db


@pytest.fixture(scope="module")
def synthetic_credentials():
    pins = [f"{secrets.randbelow(10000):04d}"]
    while len(pins) < 2:
        pin = f"{secrets.randbelow(10000):04d}"
        if pin not in pins:
            pins.append(pin)
    return [(pin, make_password(pin)) for pin in pins]


@pytest.fixture
def reviewers(settings, synthetic_credentials):
    users = [get_user_model().objects.create_user(username=uid(), email=f"{store}-review@example.invalid") for store in ("apple", "google")]
    for user in users:
        EmailAddress.objects.create(user=user, email=user.email, primary=True, verified=False)
    settings.STORE_REVIEW_AUTH = [
        {"store": store, "user_id": user.pk, "email": user.email, "pin_hash": credential[1]}
        for store, user, credential in zip(("apple", "google"), users, synthetic_credentials)
    ]
    return users, [value[0] for value in synthetic_credentials]


def challenge(email):
    response = post(Client(), "request", {"email": email})
    assert response.status_code == 200
    return response.json()["data"]["challenge_id"]


def group_for(actor):
    client = authenticated_client(actor)
    ids, group_id = [uid(), uid()], uid()
    body = {"command_id": uid(), "id": group_id, "name": "Synthetic review ledger", "is_direct": True,
            "self_participant_id": ids[0], "participants": [{"id": ids[0], "name": "You"}, {"id": ids[1], "name": "Friend"}]}
    assert send(client, "post", "/groups", body).status_code == 200
    return client, group_id, ids


def test_demo_credential_uses_normal_challenge_session_without_email_or_verification(reviewers, mailbox):
    users, pins = reviewers
    native = Client()
    identifier = challenge(users[0].email)
    row = EmailCodeChallenge.objects.get()
    assert not row.delivered and row.digest != pins[0] and len(row.digest) == 64
    response = post(native, "confirm", {"challenge_id": identifier, "code": pins[0]})
    assert response.status_code == 200 and response.json()["data"]["user"]["id"] == users[0].pk
    native.defaults["HTTP_X_SESSION_TOKEN"] = response.json()["meta"]["session_token"]
    assert send(native, "get", "/me").json()["email_verified"] is False
    assert not EmailAddress.objects.filter(user=users[0], verified=True).exists()
    assert mailbox == [] and get_user_model().objects.count() == 2
    assert post(Client(), "confirm", {"challenge_id": identifier, "code": pins[0]}).status_code == 400
    for session in Session.objects.all():
        assert pins[0] not in json.dumps(session.get_decoded())


def test_browser_demo_sign_in_uses_csrf_and_cookie_without_verifying_email(reviewers, mailbox):
    users, pins = reviewers
    browser = Client(enforce_csrf_checks=True)
    browser.get("/_allauth/browser/v1/config")
    csrf = browser.cookies["csrftoken"].value
    requested = post(browser, "request", {"email": users[1].email}, browser=True, csrf=csrf)
    assert requested.status_code == 200
    body = {"challenge_id": requested.json()["data"]["challenge_id"], "code": pins[1]}
    assert post(browser, "confirm", body, browser=True).status_code == 403
    response = post(browser, "confirm", body, browser=True, csrf=csrf)
    assert response.status_code == 200 and browser.cookies.get("sessionid")
    assert "session_token" not in response.json().get("meta", {}) and mailbox == []
    assert send(browser, "get", "/me").json()["email_verified"] is False


def test_fresh_challenge_reuses_only_its_own_store_credential(reviewers, mailbox):
    users, pins = reviewers
    first = challenge(users[0].email)
    assert post(Client(), "confirm", {"challenge_id": first, "code": pins[0]}).status_code == 200
    EmailCodeChallenge.objects.update(requested_at=timezone.now() - timedelta(seconds=61))
    second = challenge(users[0].email)
    assert second != first
    assert post(Client(), "confirm", {"challenge_id": second, "code": pins[0]}).status_code == 200
    other = challenge(users[1].email)
    assert post(Client(), "confirm", {"challenge_id": other, "code": pins[0]}).status_code == 400
    assert post(Client(), "confirm", {"challenge_id": other, "code": pins[1]}).status_code == 200
    assert mailbox == []


def test_blank_credential_keeps_confirmed_session_authenticated_and_isolated(reviewers, settings, mailbox):
    users, pins = reviewers
    _, demo_id, _ = group_for(users[0])
    real_user = get_user_model().objects.create_user(username=uid(), email="session-boundary@example.invalid")
    real, real_id, ids = group_for(real_user)
    bill = expense(ids, beneficiaries=[0, 1])
    assert send(real, "post", f"/groups/{real_id}/expenses", bill).status_code == 200
    Participant.objects.filter(id=ids[1]).update(user=users[0])

    native = Client()
    identifier = challenge(users[0].email)
    confirmed = post(native, "confirm", {"challenge_id": identifier, "code": pins[0]})
    assert confirmed.status_code == 200
    native.defaults["HTTP_X_SESSION_TOKEN"] = confirmed.json()["meta"]["session_token"]
    native.cookies.clear()
    assert send(native, "get", "/me").json()["id"] == users[0].pk

    reservation = dict(settings.STORE_REVIEW_AUTH[0])
    settings.STORE_REVIEW_AUTH[0]["pin_hash"] = ""
    assert settings.STORE_REVIEW_AUTH[0] == {**reservation, "pin_hash": ""}
    assert send(native, "get", "/me").status_code == 200
    assert send(native, "get", f"/groups/{demo_id}").status_code == 200
    assert [str(row["id"]) for row in send(native, "get", "/groups").json()["groups"]] == [demo_id]
    assert [row["group"]["id"] for row in send(native, "get", "/account/export").json()["groups"]] == [demo_id]
    for path in [f"/groups/{real_id}", f"/groups/{real_id}/summary", f"/groups/{real_id}/history/bills", f"/groups/{real_id}/export"]:
        assert send(native, "get", path).status_code == 404
    assert send(native, "post", f"/groups/{real_id}/expenses", expense(ids, beneficiaries=[0, 1])).status_code == 404

    EmailCodeChallenge.objects.update(requested_at=timezone.now() - timedelta(seconds=61))
    fresh = challenge(users[0].email)
    assert fresh != identifier
    assert post(Client(), "confirm", {"challenge_id": fresh, "code": pins[0]}).status_code == 400
    assert not EmailCodeChallenge.objects.get().delivered
    assert send(native, "get", "/me").status_code == 200
    assert send(native, "get", f"/groups/{real_id}").status_code == 404
    assert not EmailAddress.objects.filter(user=users[0], verified=True).exists() and mailbox == []


@pytest.mark.parametrize("change", ["wrong_id", "wrong_email", "inactive", "staff", "superuser", "blank_hash", "rotated_hash", "duplicate_user", "duplicate_address"])
def test_wrong_identity_or_disabled_rotated_credential_fails_closed(reviewers, settings, change, mailbox):
    users, pins = reviewers
    identifier = challenge(users[0].email)
    if change == "wrong_id":
        settings.STORE_REVIEW_AUTH[0]["user_id"] = users[1].pk
    elif change == "wrong_email":
        get_user_model().objects.filter(pk=users[0].pk).update(email="changed@example.invalid")
    elif change == "blank_hash":
        settings.STORE_REVIEW_AUTH[0]["pin_hash"] = ""
    elif change == "rotated_hash":
        settings.STORE_REVIEW_AUTH[0]["pin_hash"] = settings.STORE_REVIEW_AUTH[1]["pin_hash"]
    elif change == "duplicate_user":
        get_user_model().objects.create_user(username=uid(), email=users[0].email.upper())
    elif change == "duplicate_address":
        EmailAddress.objects.create(user=users[1], email=users[0].email, verified=False)
    else:
        get_user_model().objects.filter(pk=users[0].pk).update(**{"is_active" if change == "inactive" else f"is_{change}": change != "inactive"})
    assert post(Client(), "confirm", {"challenge_id": identifier, "code": pins[0]}).status_code == 400
    assert not EmailAddress.objects.filter(user=users[0], verified=True).exists() and mailbox == []


def test_config_absent_keeps_real_email_otp_and_never_accepts_demo_credential(reviewers, settings, mailbox, monkeypatch):
    users, pins = reviewers
    settings.STORE_REVIEW_AUTH = []
    # An ordinary fresh code differs from the synthetic reusable credential.
    monkeypatch.setattr(otp.secrets, "randbelow", lambda maximum: (int(pins[0]) + 1) % maximum)
    identifier, real_code = requested(Client(), mailbox, users[0].email)
    assert post(Client(), "confirm", {"challenge_id": identifier, "code": pins[0]}).status_code == 400
    assert post(Client(), "confirm", {"challenge_id": identifier, "code": real_code}).status_code == 200
    assert EmailAddress.objects.filter(user=users[0], verified=True).exists() and len(mailbox) == 1


def test_demo_expiry_resend_and_shared_attempt_budget_are_unchanged(reviewers, mailbox):
    users, pins = reviewers
    identifier = challenge(users[0].email)
    assert post(Client(), "request", {"email": users[0].email}).status_code == 429
    wrong = f"{(int(pins[0]) + 1) % 10000:04d}"
    for network in range(3):
        assert post(Client(), "confirm", {"challenge_id": identifier, "code": wrong}, ip=f"198.51.{network}.10").status_code == 400
    EmailCodeChallenge.objects.update(requested_at=timezone.now() - timedelta(seconds=61))
    fresh = challenge(users[0].email)
    assert post(Client(), "confirm", {"challenge_id": fresh, "code": pins[0]}).status_code == 429
    other = challenge(users[1].email)
    EmailCodeChallenge.objects.filter(challenge_id=other).update(expires_at=timezone.now() - timedelta(seconds=1))
    assert post(Client(), "confirm", {"challenge_id": other, "code": pins[1]}).status_code == 400
    assert mailbox == []


def test_demo_pin_does_not_authenticate_a_real_account_with_review_config_enabled(reviewers, mailbox, monkeypatch):
    _, pins = reviewers
    monkeypatch.setattr(otp.secrets, "randbelow", lambda maximum: (int(pins[0]) + 1) % maximum)
    identifier, delivered_code = requested(Client(), mailbox, "ordinary@example.invalid")
    assert post(Client(), "confirm", {"challenge_id": identifier, "code": pins[0]}).status_code == 400
    response = post(Client(), "confirm", {"challenge_id": identifier, "code": delivered_code})
    assert response.status_code == 200
    assert EmailAddress.objects.filter(email="ordinary@example.invalid", verified=True).exists()


@pytest.mark.django_db(transaction=True)
def test_concurrent_demo_consumption_is_single_use(reviewers, mailbox):
    users, pins = reviewers
    identifier = challenge(users[0].email)
    def consume(_):
        close_old_connections()
        try:
            try:
                otp.confirm_email_code(UUID(identifier), pins[0], "192.0.2.0/24")
                return True
            except otp.EmailCodeInvalid:
                return False
        finally:
            connections.close_all()
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert list(pool.map(consume, range(2))).count(True) == 1
    assert EmailCodeChallenge.objects.get().consumed and mailbox == []


def test_demo_and_real_group_index_export_detail_media_and_writes_stay_isolated(reviewers, mailbox, monkeypatch):
    users, _ = reviewers
    demo, demo_id, _ = group_for(users[0])
    real_user = get_user_model().objects.create_user(username=uid(), email="real-person@example.invalid")
    real, real_id, ids = group_for(real_user)
    bill = expense(ids, beneficiaries=[0, 1])
    assert send(real, "post", f"/groups/{real_id}/expenses", bill).status_code == 200
    file = UploadedFile.objects.create(expense_id=bill["id"], uploaded_by=real_user, object_key=f"bills/{uid()}.jpg",
                                       source_hash="synthetic", name="synthetic.jpg", content_type="image/jpeg", size=100, state="active")
    Participant.objects.filter(id=ids[1]).update(user=users[0])  # Defend even an accidental legacy mixed membership.
    for path in [f"/groups/{real_id}", f"/groups/{real_id}/summary", f"/groups/{real_id}/history/bills",
                 f"/groups/{real_id}/expenses/{bill['id']}", f"/groups/{real_id}/export",
                 f"/groups/{real_id}/expenses/{bill['id']}/attachments", f"/media/{file.id}/url"]:
        assert send(demo, "get", path).status_code == 404
    assert send(demo, "post", f"/groups/{real_id}/expenses", expense(ids, beneficiaries=[0, 1])).status_code == 404
    assert [str(row["id"]) for row in send(demo, "get", "/groups").json()["groups"]] == [demo_id]
    assert [row["group"]["id"] for row in send(demo, "get", "/account/export").json()["groups"]] == [demo_id]
    assert send(real, "get", f"/groups/{demo_id}").status_code == 404
    # Mixed groups are hidden from real members too, rather than half-authorized.
    assert send(real, "get", "/groups").json()["groups"] == []
    assert send(demo, "put", "/me/payment-profile", {"vpa": "synthetic@upi"}).status_code == 404
    assert send(demo, "delete", "/account").status_code == 404
    assert get_user_model().objects.filter(pk=users[0].pk).exists() and mailbox == []


@pytest.mark.parametrize("owner_demo", [True, False])
def test_cross_boundary_claim_and_forged_pending_approval_are_rejected(reviewers, mailbox, owner_demo):
    users, _ = reviewers
    real_user = get_user_model().objects.create_user(username=uid(), email="normal@example.invalid")
    owner_user, claimant = (users[0], real_user) if owner_demo else (real_user, users[0])
    owner, group_id, ids = group_for(owner_user)
    invitation = uid()
    assert send(owner, "post", f"/groups/{group_id}/invites", {"command_id": invitation, "participant_id": ids[1]}).status_code == 200
    assert send(authenticated_client(claimant), "post", f"/invites/{invite_token(invitation)}/claim", {"command_id": uid()}).status_code == 404
    Invite.objects.filter(id=invitation).update(claimant=claimant)
    assert send(owner, "post", f"/groups/{group_id}/invites/{invitation}/approve", {"command_id": uid()}).status_code == 404
    assert Participant.objects.get(id=ids[1]).user_id is None and mailbox == []


def test_demo_manual_invites_work_only_for_configured_secondary_identity_and_no_emails(reviewers, mailbox, settings):
    users, _ = reviewers
    owner, group_id, ids = group_for(users[0])
    invitation = uid()
    assert send(owner, "post", f"/groups/{group_id}/invites", {"command_id": invitation, "participant_id": ids[1]}).status_code == 200
    assert send(authenticated_client(users[1]), "post", f"/invites/{invite_token(invitation)}/claim", {"command_id": uid()}).status_code == 200
    assert send(owner, "post", f"/groups/{group_id}/invites/{invitation}/approve", {"command_id": uid()}).status_code == 200
    assert Participant.objects.get(id=ids[1]).user_id == users[1].pk
    assert len(send(authenticated_client(users[1]), "get", "/groups").json()["groups"]) == 1
    # A fresh unclaimed person can hold contact metadata but never trigger email.
    other, other_id, other_ids = group_for(users[0])
    assert send(other, "post", f"/groups/{other_id}/participants/{other_ids[1]}/contact",
                {"command_id": uid(), "email": "non-demo@example.invalid"}).status_code == 200
    assert send(other, "post", f"/groups/{other_id}/participants/{other_ids[1]}/email-invite", {"command_id": uid()}).status_code == 403
    settings.STORE_REVIEW_AUTH[0]["pin_hash"] = ""
    assert send(other, "get", f"/groups/{other_id}").status_code == 200
    assert mailbox == []


def test_preexisting_demo_to_real_push_is_skipped_before_external_provider(reviewers, settings, monkeypatch):
    settings.PUSH_PROVIDER = "expo"
    users, _ = reviewers
    owner, group_id, ids = group_for(users[0])
    bill = expense(ids, beneficiaries=[0, 1])
    assert send(owner, "post", f"/groups/{group_id}/expenses", bill).status_code == 200
    real_user = get_user_model().objects.create_user(username=uid(), email="push-recipient@example.invalid")
    device = register(authenticated_client(real_user))
    Participant.objects.filter(id=ids[1]).update(user=real_user)
    delivery = ExpensePushDelivery.objects.create(expense=Expense.objects.get(pk=bill["id"]), recipient=real_user,
        device=device, device_revision=device.revision, event_id=uuid4(), due_at=timezone.now())
    monkeypatch.setattr("ledger.push_provider.send_bill_notification", lambda *args: pytest.fail("No cross-boundary push"))
    assert send_pending_bill_notifications() == 1
    delivery.refresh_from_db()
    assert delivery.state == "skipped"


@pytest.mark.parametrize("invalid", ["duplicate", "plaintext", "weak_hash", "wrong_shape"])
def test_invalid_server_review_configuration_fails_without_exposing_credential(reviewers, settings, monkeypatch, invalid):
    entries = [dict(settings.STORE_REVIEW_AUTH[0])]
    if invalid == "duplicate":
        entries.append(dict(entries[0]))
    elif invalid == "plaintext":
        entries[0]["pin_hash"] = reviewers[1][0]
    elif invalid == "weak_hash":
        entries[0]["pin_hash"] = entries[0]["pin_hash"].replace("$1000000$", "$1000$")
    else:
        entries[0]["user_id"] = "not-an-id"
    monkeypatch.setenv("STORE_REVIEW_AUTH_JSON", json.dumps(entries))
    with pytest.raises(RuntimeError, match="STORE_REVIEW_AUTH_JSON"):
        runpy.run_path(str(settings.BASE_DIR / "config" / "settings.py"))
