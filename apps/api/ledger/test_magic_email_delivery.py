"""Frozen email recipes resolve recipient-bound proof only at delivery time."""

import hashlib
import json
from datetime import timedelta
from urllib.error import URLError
from uuid import uuid4

import pytest
from django.db import connection
from django.utils import timezone

from . import email_delivery
from . import expense_notifications as notifications
from .email_links import (
    CODE_PLACEHOLDER,
    EXPIRY_PLACEHOLDER,
    LINK_PLACEHOLDER,
    activate_email_link,
    delivery_url,
    fallback_code,
    issue_email_link,
)
from .models import EmailLoginGrant, ExpenseDigest, ExpenseNotice, Invite
from .test_api import client as client
from .test_api import group as group
from .test_email_invites import direct as direct
from .test_email_invites import send_invite
from .test_expense_notifications import add_bill, enable
from .test_expense_notifications import clock as clock
from .test_expense_notifications import recipient as recipient

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture
def provider(settings, monkeypatch):
    settings.RESEND_API_KEY = "synthetic-provider-key"
    settings.PUBLIC_WEB_URL = "https://original-synthetic.example.invalid"
    calls = []

    def timeout(request, timeout):
        assert not connection.in_atomic_block and timeout == 10
        calls.append({"data": request.data, "key": request.get_header("Idempotency-key")})
        raise URLError("Synthetic uncertain delivery")

    monkeypatch.setattr(email_delivery, "urlopen", timeout)
    return calls


def recipe(grant):
    text, html = email_delivery.render_message("sign_in", {
        "login_url": LINK_PLACEHOLDER, "expires_at": EXPIRY_PLACEHOLDER,
        "code": CODE_PLACEHOLDER, "expires_minutes": 3,
    })
    payload = email_delivery.message_payload(grant.email, "Sign in", text, html)
    return {**payload, "_email_link_id": str(grant.id)}


def digest_of(payload):
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


def test_frozen_login_recipe_keeps_bearer_and_code_out_of_database(settings, clock):
    settings.PUBLIC_WEB_URL = "https://synthetic.example.invalid"
    grant = issue_email_link("synthetic@example.invalid", purpose="login", target={"kind": "home"},
                             source_key=f"otp/{uuid4()}", expires_at=clock[0] + timedelta(seconds=180))
    grant.payload = recipe(grant)
    grant.save(update_fields=["payload"])
    grant.refresh_from_db()
    stored = json.dumps(grant.payload)
    assert LINK_PLACEHOLDER in stored and CODE_PLACEHOLDER in stored and "#proof=" not in stored
    url = delivery_url(grant.id)
    resolved = email_delivery.materialize_payload(grant.payload, recipient=grant.email)
    assert "_email_link_id" not in resolved and url in resolved["text"] and url in resolved["html"]
    assert f"\n{fallback_code(grant.id)}\n" in resolved["text"]
    assert grant.expires_at.strftime("%d %b %Y, %H:%M:%S UTC") in resolved["text"]
    original = digest_of(resolved)
    clock[0] += timedelta(hours=1)
    settings.PUBLIC_WEB_URL = "https://changed-synthetic.example.invalid"
    assert digest_of(email_delivery.materialize_payload(grant.payload)) == original
    grant.refresh_from_db()
    assert json.dumps(grant.payload) == stored


def test_materialization_rejects_missing_unactivated_or_mixed_recipient_grant(settings):
    settings.PUBLIC_WEB_URL = "https://synthetic.example.invalid"
    grant = issue_email_link("recipient@example.invalid", purpose="digest", target={"kind": "home"}, source_key=f"digest/{uuid4()}")
    payload = recipe(grant)
    with pytest.raises(email_delivery.EmailDeliveryUnavailable):
        email_delivery.materialize_payload(payload)
    activate_email_link(grant.id, timezone.now() + timedelta(hours=24))
    for changed, expected_recipient in (({**payload, "to": ["wrong@example.invalid"]}, None), (payload, "wrong@example.invalid"),
                               ({**payload, "_email_link_id": str(uuid4())}, None)):
        with pytest.raises(email_delivery.EmailDeliveryUnavailable):
            email_delivery.materialize_payload(changed, recipient=expected_recipient)


def test_legacy_frozen_payload_is_not_reinterpreted():
    payload = {"to": ["synthetic@example.invalid"], "text": "Earlier frozen invitation", "html": "<p>Earlier frozen invitation</p>"}
    assert email_delivery.materialize_payload(payload) is payload


def test_invitation_timeout_retry_freezes_body_proof_origin_and_key(client, direct, clock, provider, settings, monkeypatch):
    command, response = send_invite(client, direct)
    assert response.status_code == 200 and response.json()["invite"]["state"] == "failed"
    invite = Invite.objects.get(pk=command)
    grant = EmailLoginGrant.objects.get(source_key=f"invite/{command}")
    assert grant.purpose == "invite" and grant.target == {"kind": "invite", "invite_id": command}
    assert grant.expires_at == invite.expires_at and grant.expires_at <= clock[0] + timedelta(days=7)
    assert "#proof=" not in json.dumps(invite.email_payload) and LINK_PLACEHOLDER in invite.email_payload["text"]
    assert len(provider) == 1
    assert provider[0]["key"] == f"invite/{command}"
    assert json.loads(provider[0]["data"])["attachments"][0]["content_id"] == "merosplit-logo"
    clock[0] += timedelta(seconds=61)
    settings.PUBLIC_WEB_URL = "https://changed-synthetic.example.invalid"
    settings.DEFAULT_FROM_EMAIL = "Changed sender <changed@example.invalid>"
    monkeypatch.setattr(email_delivery, "render_message", lambda *args, **kwargs: pytest.fail("Retry must use the frozen body"))
    _, response = send_invite(client, direct, command)
    assert response.status_code == 200 and response.json()["invite"]["state"] == "failed"
    assert len(provider) == 2 and provider[0]["key"] == provider[1]["key"]
    assert hashlib.sha256(provider[0]["data"]).digest() == hashlib.sha256(provider[1]["data"]).digest()
    assert EmailLoginGrant.objects.count() == 1


@pytest.mark.parametrize("origin", ["https://synthetic.example.invalid/app", "https://synthetic.example.invalid/?query=1", "https://synthetic.example.invalid/#fragment"])
def test_invitation_rejects_noncanonical_origin_without_issuing_proof(client, direct, settings, origin):
    settings.PUBLIC_WEB_URL = origin
    _, response = send_invite(client, direct)
    assert response.status_code == 503 and not Invite.objects.exists() and not EmailLoginGrant.objects.exists()


def test_digest_first_attempt_activates_expiry_and_retry_keeps_frozen_recipe(client, group, recipient, clock, provider, settings, monkeypatch):
    enable(recipient)
    add_bill(client, group)
    clock[0] += timedelta(hours=24)
    identifier = notifications.create_due_digest()
    digest = ExpenseDigest.objects.get(pk=identifier)
    grant = EmailLoginGrant.objects.get(source_key=f"expense-digest/{identifier}")
    assert grant.purpose == "digest" and grant.target == {"kind": "home"} and grant.expires_at is None
    assert "#proof=" not in json.dumps(digest.payload) and LINK_PLACEHOLDER in digest.payload["text"]
    clock[0] += timedelta(hours=6)
    monkeypatch.setattr(email_delivery, "render_message", lambda *args, **kwargs: pytest.fail("Queued work must use the frozen body"))
    assert notifications.send_pending_digests(limit=1) == 1
    grant.refresh_from_db()
    digest.refresh_from_db()
    assert grant.expires_at == digest.first_attempt_at + notifications.LINK_LIFETIME
    assert digest.first_attempt_at == clock[0] and len(provider) == 1
    original_expiry = grant.expires_at
    clock[0] += timedelta(minutes=2)
    settings.PUBLIC_WEB_URL = "https://changed-synthetic.example.invalid"
    settings.DEFAULT_FROM_EMAIL = "Changed sender <changed@example.invalid>"
    assert notifications.send_pending_digests(limit=1) == 1
    assert len(provider) == 2 and provider[0]["key"] == provider[1]["key"] == f"expense-digest/{identifier}"
    assert hashlib.sha256(provider[0]["data"]).digest() == hashlib.sha256(provider[1]["data"]).digest()
    grant.refresh_from_db()
    assert grant.expires_at == original_expiry and EmailLoginGrant.objects.count() == 1
    assert not ExpenseNotice.objects.filter(seen_at__isnull=False).exists()


def test_digest_foreground_does_not_defer_first_attempt_or_restart_link_lifetime(client, group, recipient, clock, provider):
    enable(recipient)
    add_bill(client, group)
    clock[0] += timedelta(minutes=10)
    identifier = notifications.create_due_digest()
    grant = EmailLoginGrant.objects.get(source_key=f"expense-digest/{identifier}")
    assert grant.expires_at is None and not grant.proof_digest
    notifications.foreground(recipient.actor)
    assert notifications.send_pending_digests(limit=1) == 1 and len(provider) == 1
    grant.refresh_from_db()
    expiry = grant.expires_at
    assert expiry == clock[0] + notifications.LINK_LIFETIME
    clock[0] += timedelta(minutes=2)
    notifications.foreground(recipient.actor)
    assert notifications.send_pending_digests(limit=1) == 1 and len(provider) == 2
    grant.refresh_from_db()
    assert grant.expires_at == expiry


def test_digest_invalid_config_keeps_unread_without_creating_unusable_proof(client, group, recipient, clock, settings):
    enable(recipient)
    add_bill(client, group)
    clock[0] += timedelta(hours=24)
    settings.PUBLIC_WEB_URL = "https://synthetic.example.invalid/app"
    assert notifications.create_due_digest() is None
    assert not ExpenseDigest.objects.exists() and not EmailLoginGrant.objects.exists()
    assert ExpenseNotice.objects.filter(seen_at__isnull=True, email_eligible=True).count() == 1
