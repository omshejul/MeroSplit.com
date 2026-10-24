"""The production native code-request email has one consent choice for both CTAs."""

import json
import re
import secrets
from urllib.parse import urlsplit
from uuid import uuid4

import pytest
from allauth.account.models import EmailAddress
from django.contrib.auth import get_user_model
from django.contrib.auth.hashers import make_password
from django.test import Client

from . import email_delivery
from .models import EmailCodeChallenge, EmailLoginGrant, EmailRateBucket, NotificationPreference

pytestmark = pytest.mark.django_db


@pytest.fixture
def mail(monkeypatch):
    messages = []
    def deliver(recipient, subject, text, delivery_id, **kwargs):
        messages.append(email_delivery.materialize_payload(kwargs["payload"], recipient=recipient))
        return "synthetic-accepted"
    monkeypatch.setattr(email_delivery, "send_email", deliver)
    return messages


def post(action, body):
    return Client().post(f"/_allauth/app/v1/auth/{action}", data=json.dumps(body),
                         content_type="application/json", REMOTE_ADDR="192.0.2.18")


def finish(mode, request_data, message, disclosure):
    if mode == "code":
        code = re.search(r"(?m)^([0-9]{4})$", message["text"]).group(1)
        return post("code/confirm", {"challenge_id": request_data["challenge_id"], "code": code,
                                     **({"email_reminders_disclosed": disclosure} if disclosure != "omitted" else {})})
    link = re.search(r"https://[^\s<>]+/app/sign-in/[0-9a-f-]+#proof=[A-Za-z0-9_-]{43}", message["text"]).group(0)
    url = urlsplit(link)
    # A confirm-time true flag must not elevate an undisclosed stored grant.
    return post("link/exchange", {"grant_id": url.path.rsplit("/", 1)[1], "proof": url.fragment.removeprefix("proof="),
                                  "email_reminders_disclosed": True})


@pytest.mark.parametrize("disclosure", [True, False, "omitted"])
@pytest.mark.parametrize("mode", ["code", "link"])
def test_production_code_request_new_account_defaults_agree_for_delivered_code_and_link(mail, mode, disclosure):
    body = {"email": "fresh@example.invalid", **({"email_reminders_disclosed": disclosure} if disclosure != "omitted" else {})}
    requested = post("code/request", body)
    assert requested.status_code == 200 and len(mail) == 1
    grant = EmailLoginGrant.objects.get()
    assert grant.email_reminders_disclosed is (disclosure is True)
    assert not get_user_model().objects.exists() and not NotificationPreference.objects.exists()
    confirmed = finish(mode, requested.json()["data"], mail[0], disclosure)
    assert confirmed.status_code == 200
    identity = get_user_model().objects.get(pk=confirmed.json()["data"]["user"]["id"])
    pref = NotificationPreference.objects.filter(user=identity).first()
    assert bool(pref and pref.email_reminders) is False
    assert bool(pref and pref.email_enabled_at) is False
    assert EmailAddress.objects.filter(user=identity, verified=True).exists()
    assert get_user_model().objects.count() == 1 and len(mail) == 1


@pytest.mark.parametrize("existing_challenge", [False, True])
@pytest.mark.parametrize("invalid", [None, "true", "false", 0, 1, [], {}, 1.5])
def test_bad_disclosure_rejected_before_provider_challenge_and_rate_mutation(mail, existing_challenge, invalid):
    if existing_challenge:
        assert post("code/request", {"email": "unchanged@example.invalid"}).status_code == 200
    before_challenges = list(EmailCodeChallenge.objects.values())
    before_grants = list(EmailLoginGrant.objects.values("id", "proof_digest", "email_reminders_disclosed"))
    before_rates = list(EmailRateBucket.objects.order_by("key").values())
    sends = len(mail)
    response = post("code/request", {"email": "unchanged@example.invalid", "email_reminders_disclosed": invalid})
    assert response.status_code == 400 and response.json()["errors"][0]["code"] == "email_code_unavailable"
    assert list(EmailCodeChallenge.objects.values()) == before_challenges
    assert list(EmailLoginGrant.objects.values("id", "proof_digest", "email_reminders_disclosed")) == before_grants
    assert list(EmailRateBucket.objects.order_by("key").values()) == before_rates
    assert len(mail) == sends and not get_user_model().objects.exists()


@pytest.mark.parametrize("body", [["email"], 42, True, "email", {"email": "recipient@example.invalid", "email_reminders_disclosed": True, "target": "home"}])
def test_non_dictionary_or_unknown_fields_do_not_issue_challenge_or_email(mail, body):
    assert post("code/request", body).status_code == 400
    assert not EmailCodeChallenge.objects.exists() and not EmailLoginGrant.objects.exists()
    assert not EmailRateBucket.objects.exists() and not mail


@pytest.mark.parametrize("mode", ["code", "link"])
def test_disclosed_request_never_turns_existing_account_preference_on(mail, mode):
    identity = get_user_model().objects.create_user(username=uuid4().hex, email="existing@example.invalid", first_name="Chosen")
    pref = NotificationPreference.objects.create(user=identity, email_reminders=False)
    EmailAddress.objects.create(user=identity, email=identity.email, verified=True, primary=True)
    requested = post("code/request", {"email": identity.email, "email_reminders_disclosed": True})
    assert requested.status_code == 200
    response = finish(mode, requested.json()["data"], mail[0], True)
    assert response.status_code == 200 and response.json()["data"]["user"]["id"] == identity.pk
    pref.refresh_from_db()
    assert not pref.email_reminders and pref.email_enabled_at is None
    identity.refresh_from_db()
    assert identity.first_name == "Chosen" and get_user_model().objects.count() == 1


@pytest.fixture(scope="module")
def demo_credential():
    pin = f"{secrets.randbelow(10000):04d}"
    return pin, make_password(pin)


@pytest.mark.parametrize("has_preference", [False, True])
def test_isolated_reviewer_disclosed_request_and_confirm_do_not_send_or_change_defaults(mail, settings, demo_credential, has_preference):
    identity = get_user_model().objects.create_user(username=uuid4().hex, email="synthetic-review@example.invalid")
    EmailAddress.objects.create(user=identity, email=identity.email, verified=False, primary=True)
    if has_preference:
        NotificationPreference.objects.create(user=identity, email_reminders=False)
    pin, digest = demo_credential
    settings.STORE_REVIEW_AUTH = [{"store": "apple", "user_id": identity.pk, "email": identity.email, "pin_hash": digest}]
    requested = post("code/request", {"email": identity.email, "email_reminders_disclosed": True})
    assert requested.status_code == 200 and not mail and not EmailLoginGrant.objects.exists()
    response = post("code/confirm", {"challenge_id": requested.json()["data"]["challenge_id"], "code": pin,
                                     "email_reminders_disclosed": True})
    assert response.status_code == 200 and response.json()["data"]["user"]["id"] == identity.pk
    assert not mail and not EmailLoginGrant.objects.exists()
    assert not EmailAddress.objects.filter(user=identity, verified=True).exists()
    assert NotificationPreference.objects.filter(user=identity).exists() == has_preference
    assert not NotificationPreference.objects.filter(user=identity, email_reminders=True).exists()
