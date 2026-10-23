from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from uuid import uuid4

import pytest
from allauth.account.models import EmailAddress
from django.contrib.auth import get_user_model
from django.db import close_old_connections, connection, connections
from django.test import Client
from django.utils import timezone

from . import email_delivery
from .collaboration import invite_token
from .models import CommandReceipt, Group, Invite, Participant
from .test_api import authenticated_client, expense, send, uid
from .test_api import client as client
from .test_email_codes import mailbox as mailbox

pytestmark = pytest.mark.django_db


@pytest.fixture
def direct(client):
    people = [uid(), uid()]
    body = {
        "command_id": uid(), "id": uid(), "name": "Synthetic friend", "is_direct": True,
        "self_participant_id": people[0],
        "participants": [{"id": people[0], "name": "You"}, {"id": people[1], "name": "Friend", "email": "friend@example.invalid"}],
    }
    response = send(client, "post", "/groups", body)
    assert response.status_code == 200
    return body["id"], people, body


def verified_person(email="friend@example.invalid", *, verified=True):
    user = get_user_model().objects.create_user(username=uid(), email=email)
    EmailAddress.objects.create(user=user, email=email, verified=verified, primary=True)
    return authenticated_client(user)


def send_invite(client, direct, command_id=None):
    group_id, people, _ = direct
    command = command_id or uid()
    response = send(client, "post", f"/groups/{group_id}/participants/{people[1]}/email-invite", {"command_id": command})
    return command, response


def test_optional_contact_is_not_identity_or_automatic_email(client, direct, mailbox):
    group_id, people, body = direct
    existing = verified_person()
    state = send(client, "get", f"/groups/{group_id}").json()
    person = next(p for p in state["participants"] if p["id"] == people[1])
    assert person["email"] == "friend@example.invalid" and person["user_id"] is None
    assert Group.objects.count() == 1 and Invite.objects.count() == 0 and mailbox == []
    assert send(existing, "get", f"/groups/{group_id}").status_code == 404
    assert send(client, "post", "/groups", body).status_code == 200
    assert Group.objects.count() == 1


def test_explicit_invite_is_idempotent_and_locked_until_verified_claim(client, direct, mailbox):
    group_id, people, _ = direct
    bill = expense(people, beneficiaries=[1])
    assert send(client, "post", f"/groups/{group_id}/expenses", bill).status_code == 200
    command, response = send_invite(client, direct)
    assert response.status_code == 200
    assert response.json()["invite"]["state"] == "sent" and len(mailbox) == 1
    assert mailbox[0]["id"] == f"invite/{command}"
    assert len(mailbox[0]["text"]) < 1000 and bill["description"] not in mailbox[0]["text"]
    _, duplicate = send_invite(client, direct, command)
    assert duplicate.status_code == 200 and len(mailbox) == 1 and Invite.objects.count() == 1
    token = invite_token(command)
    locked = send(Client(), "get", f"/invites/{token}")
    assert locked.status_code == 200 and locked.json() == {"requires_email_verification": True, "group_id": group_id}
    wrong, unverified = verified_person("wrong@example.invalid"), verified_person(verified=False)
    for person in [wrong, unverified]:
        assert send(person, "post", f"/invites/{token}/claim", {"command_id": uid()}).status_code == 403
        assert send(person, "get", f"/groups/{group_id}").status_code == 404
    EmailAddress.objects.filter(user=unverified.actor).update(verified=True)
    claim = {"command_id": uid()}
    accepted = send(unverified, "post", f"/invites/{token}/claim", claim)
    assert accepted.status_code == 200
    assert send(unverified, "post", f"/invites/{token}/claim", claim).json() == accepted.json()
    owner = send(client, "get", f"/groups/{group_id}").json()
    joined = send(unverified, "get", f"/groups/{group_id}").json()
    assert owner["balances"] == joined["balances"] and owner["expenses"] == joined["expenses"]
    assert len(joined["participants"]) == 2
    assert all("email" not in p for p in joined["participants"])
    assert Participant.objects.get(id=people[1]).user_id == unverified.actor.pk
    assert Invite.objects.get().approved


def test_contact_update_later_revokes_stale_intended_recipient(client, direct, mailbox):
    group_id, people, _ = direct
    command, _ = send_invite(client, direct)
    contact_path = f"/groups/{group_id}/participants/{people[1]}/contact"
    changed = {"command_id": uid(), "email": "later@example.invalid"}
    response = send(client, "post", contact_path, changed)
    assert response.status_code == 200
    assert send(client, "post", contact_path, changed).json() == response.json()
    assert Invite.objects.get(id=command).revoked
    assert send(Client(), "get", f"/invites/{invite_token(command)}").status_code == 404
    assert Participant.objects.get(id=people[1]).contact_email == changed["email"]
    assert send(client, "post", contact_path, {"command_id": uid(), "email": "bad"}).status_code == 422
    outsider = verified_person("outsider@example.invalid")
    assert send(outsider, "post", contact_path, {"command_id": uid(), "email": ""}).status_code == 404


def test_missing_email_archived_and_nondirect_ledgers_do_not_send(client, direct, mailbox):
    group_id, people, _ = direct
    Participant.objects.filter(id=people[1]).update(contact_email="")
    assert send_invite(client, direct)[1].status_code == 422
    Participant.objects.filter(id=people[1]).update(contact_email="friend@example.invalid")
    Group.objects.filter(id=group_id).update(archived=True)
    assert send_invite(client, direct)[1].status_code == 409
    Group.objects.filter(id=group_id).update(archived=False, is_direct=False)
    assert send_invite(client, direct)[1].status_code == 409
    assert mailbox == [] and Invite.objects.count() == 0


@pytest.mark.parametrize("invalid", ["expired", "revoked", "removed"])
def test_expired_revoked_or_removed_email_invitation_cannot_claim(client, direct, mailbox, invalid):
    command, _ = send_invite(client, direct)
    target = verified_person()
    if invalid == "expired":
        Invite.objects.filter(id=command).update(expires_at=timezone.now() - timedelta(seconds=1))
    elif invalid == "revoked":
        Invite.objects.filter(id=command).update(revoked=True)
    else:
        Participant.objects.filter(id=direct[1][1]).update(removed=True)
    assert send(target, "post", f"/invites/{invite_token(command)}/claim", {"command_id": uid()}).status_code == 404
    assert Participant.objects.get(id=direct[1][1]).user_id is None


def test_provider_failure_keeps_one_ledger_and_retries_same_immutable_delivery(client, direct, mailbox, monkeypatch):
    deliveries = []
    def uncertain(recipient, subject, text, delivery_id, **kwargs):
        deliveries.append((recipient, subject, text, delivery_id, kwargs))
        raise email_delivery.EmailDeliveryUnavailable()
    monkeypatch.setattr(email_delivery, "send_email", uncertain)
    command, failed = send_invite(client, direct)
    assert failed.status_code == 200 and failed.json()["invite"]["state"] == "failed"
    assert send_invite(client, direct, command)[1].status_code == 429
    Invite.objects.filter(id=command).update(last_send_at=timezone.now() - timedelta(seconds=61))
    monkeypatch.setattr(email_delivery, "render_message", lambda *args, **kwargs: ("Changed text", "Changed HTML"))
    _, retried = send_invite(client, direct, command)
    assert retried.status_code == 200
    assert len(deliveries) == 2 and deliveries[0] == deliveries[1]
    assert Group.objects.count() == Invite.objects.count() == 1


@pytest.mark.parametrize("outcome", ["sent", "failed"])
def test_delivery_completion_invalidates_group_version_without_changing_finance(client, direct, mailbox, monkeypatch, outcome):
    group_id, people, _ = direct
    assert send(client, "post", f"/groups/{group_id}/expenses", expense(people, beneficiaries=[1])).status_code == 200
    before = send(client, "get", f"/groups/{group_id}").json()
    observed = []
    def deliver(*args, **kwargs):
        observed.append(send(client, "get", "/groups").json()["groups"][0]["version"])
        if outcome == "failed":
            raise email_delivery.EmailDeliveryUnavailable()
        return "synthetic-provider-id"
    monkeypatch.setattr(email_delivery, "send_email", deliver)
    command, response = send_invite(client, direct)
    assert response.status_code == 200 and response.json()["invite"]["state"] == outcome
    after = send(client, "get", f"/groups/{group_id}").json()
    version_index = send(client, "get", "/groups").json()["groups"][0]["version"]
    assert observed == [before["version"] + 1]
    assert after["version"] == version_index == observed[0] + 1
    assert after["balances"] == before["balances"] and after["expenses"] == before["expenses"]
    receipt = CommandReceipt.objects.get(command_id=command)
    assert receipt.result["version"] == response.json()["version"] == observed[0]
    assert Group.objects.get(id=group_id).changes.filter(kind="email_invite_delivery").count() == 1
    if outcome == "sent":
        _, replay = send_invite(client, direct, command)
        assert replay.json() == response.json()
        assert Group.objects.get(id=group_id).version == version_index


def test_resend_cooldown_and_destination_quota_are_database_backed(client, direct, mailbox):
    command, _ = send_invite(client, direct)
    assert send_invite(client, direct)[1].status_code == 429
    for _ in range(4):
        Invite.objects.update(last_send_at=timezone.now() - timedelta(seconds=61))
        assert send_invite(client, direct)[1].status_code == 200
    Invite.objects.update(last_send_at=timezone.now() - timedelta(seconds=61))
    assert send_invite(client, direct)[1].status_code == 429
    assert len(mailbox) == 5 and Invite.objects.count() == 5
    assert Invite.objects.filter(revoked=False).count() == 1
    assert Invite.objects.get(id=command).revoked


@pytest.mark.django_db(transaction=True)
def test_invite_is_committed_before_provider_and_two_workers_do_not_duplicate_email(client, direct, mailbox, monkeypatch):
    delivered = []
    def delivery(recipient, subject, text, delivery_id, **kwargs):
        assert not connection.in_atomic_block
        assert Invite.objects.get(id=delivery_id.split("/")[1]).send_state == "sending"
        delivered.append(delivery_id)
        return f"synthetic-{uuid4()}"
    monkeypatch.setattr(email_delivery, "send_email", delivery)
    command = uid()
    def execute(_):
        close_old_connections()
        try:
            native = authenticated_client(get_user_model().objects.get(pk=client.actor.pk))
            return send_invite(native, direct, command)[1].status_code
        finally:
            connections.close_all()
    with ThreadPoolExecutor(max_workers=2) as pool:
        statuses = list(pool.map(execute, range(2)))
    assert all(status in (200, 429) for status in statuses)
    assert len(delivered) == 1 and Invite.objects.count() == Group.objects.count() == 1
