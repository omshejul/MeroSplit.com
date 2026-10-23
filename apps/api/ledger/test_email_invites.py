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
from .test_api import group as group
from .test_collaboration import invite as manual_invite
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


def test_group_member_with_email_is_immediately_usable_without_sending_or_linking(client, group, mailbox):
    group_id, people, _ = group
    old_bill = expense(people)
    assert send(client, "post", f"/groups/{group_id}/expenses", old_bill).status_code == 200
    existing = verified_person()
    added = {"command_id": uid(), "id": uid(), "name": " Added person ", "email": " FRIEND@example.invalid "}
    path = f"/groups/{group_id}/participants"
    response = send(client, "post", path, added)
    assert response.status_code == 200, response.content
    assert send(client, "post", path, added).json() == response.json()
    person = Participant.objects.get(pk=added["id"])
    assert person.name == "Added person" and person.contact_email == "friend@example.invalid" and person.user_id is None
    state = send(client, "get", f"/groups/{group_id}").json()
    assert added["id"] not in state["expenses"][0]["shares"] and state["balances"][added["id"]] == "0"
    new_bill = expense(people + [added["id"]], beneficiaries=[3])
    assert send(client, "post", f"/groups/{group_id}/expenses", new_bill).status_code == 200
    assert send(existing, "get", f"/groups/{group_id}").status_code == 404
    assert Participant.objects.count() == 4 and Invite.objects.count() == 0 and mailbox == []


def test_group_email_claim_uses_existing_person_and_preserves_money_and_privacy(client, group, mailbox):
    group_id, people, _ = group
    assert send(client, "post", f"/groups/{group_id}/participants/{people[1]}/contact", {
        "command_id": uid(), "email": "friend@example.invalid",
    }).status_code == 200
    assert send(client, "post", f"/groups/{group_id}/expenses", expense(people)).status_code == 200
    before = send(client, "get", f"/groups/{group_id}").json()
    command, sent = send_invite(client, group)
    assert sent.status_code == 200 and sent.json()["invite"]["state"] == "sent"
    assert send_invite(client, group, command)[1].json() == sent.json() and len(mailbox) == 1
    recipient = verified_person(verified=False)
    token = invite_token(command)
    for actor in (verified_person("other@example.invalid"), recipient):
        assert send(actor, "post", f"/invites/{token}/claim", {"command_id": uid()}).status_code == 403
        assert send(actor, "get", f"/groups/{group_id}").status_code == 404
    EmailAddress.objects.filter(user=recipient.actor).update(verified=True)
    claimed = send(recipient, "post", f"/invites/{token}/claim", {"command_id": uid()})
    assert claimed.status_code == 200, claimed.content
    after = send(recipient, "get", f"/groups/{group_id}").json()
    assert len(after["participants"]) == 3 and Participant.objects.get(pk=people[1]).user_id == recipient.actor.pk
    for key in ("balances", "totals", "expenses", "settlements"):
        assert after[key] == before[key]
    assert all("email" not in person for person in after["participants"]) and after["invites"] == []


def test_saving_group_contact_revokes_manual_pending_claim_and_requires_explicit_email(client, group, mailbox):
    group_id, people, _ = group
    command, token = manual_invite(client, group_id, people[1])
    target = verified_person()
    assert send(target, "post", f"/invites/{token}/claim", {"command_id": uid()}).status_code == 200
    assert send(client, "post", f"/groups/{group_id}/participants/{people[1]}/contact", {
        "command_id": uid(), "email": target.actor.email,
    }).status_code == 200
    assert Invite.objects.get(pk=command).revoked and mailbox == []
    assert send(target, "post", f"/invites/{token}/claim", {"command_id": uid()}).status_code == 404
    assert send(client, "post", f"/groups/{group_id}/invites/{command}/approve", {"command_id": uid()}).status_code == 409
    assert send(client, "post", f"/groups/{group_id}/invites", {"command_id": uid(), "participant_id": people[1]}).status_code == 409
    email_command, response = send_invite(client, group)
    assert response.status_code == 200 and len(mailbox) == 1
    assert send(target, "post", f"/invites/{invite_token(email_command)}/claim", {"command_id": uid()}).status_code == 200
    assert Participant.objects.get(pk=people[1]).user_id == target.actor.pk


def test_legacy_manual_token_with_saved_email_cannot_claim_or_approve(client, group, mailbox):
    group_id, people, _ = group
    command, token = manual_invite(client, group_id, people[1])
    target = verified_person()
    assert send(target, "post", f"/invites/{token}/claim", {"command_id": uid()}).status_code == 200
    # Simulate pre-upgrade data: the old contact code did not revoke manual tokens.
    Participant.objects.filter(pk=people[1]).update(contact_email=target.actor.email)
    assert send(target, "post", f"/invites/{token}/claim", {"command_id": uid()}).status_code == 409
    assert send(client, "post", f"/groups/{group_id}/invites/{command}/approve", {"command_id": uid()}).status_code == 409
    assert Participant.objects.get(pk=people[1]).user_id is None and mailbox == []


def test_email_pending_approval_requires_exact_verified_claimant(client, group, mailbox):
    group_id, people, _ = group
    assert send(client, "post", f"/groups/{group_id}/participants/{people[1]}/contact", {
        "command_id": uid(), "email": "friend@example.invalid",
    }).status_code == 200
    command, response = send_invite(client, group)
    assert response.status_code == 200
    wrong = verified_person("wrong@example.invalid")
    Invite.objects.filter(pk=command).update(claimant=wrong.actor)
    assert send(client, "post", f"/groups/{group_id}/invites/{command}/approve", {"command_id": uid()}).status_code == 403
    assert Participant.objects.get(pk=people[1]).user_id is None


@pytest.mark.parametrize("invalid", ["outsider", "member", "archived", "removed"])
def test_group_contact_and_email_invite_preserve_permissions(client, group, mailbox, invalid):
    group_id, people, _ = group
    actor = client
    if invalid in ("outsider", "member"):
        actor = verified_person()
        if invalid == "member":
            Participant.objects.filter(pk=people[2]).update(user=actor.actor)
        expected = 404 if invalid == "outsider" else 403
    elif invalid == "archived":
        Group.objects.filter(pk=group_id).update(archived=True)
        expected = 409
    else:
        Participant.objects.filter(pk=people[1]).update(removed=True)
        expected = 409
    for suffix in ("contact", "email-invite"):
        payload = {"command_id": uid(), **({"email": "friend@example.invalid"} if suffix == "contact" else {})}
        assert send(actor, "post", f"/groups/{group_id}/participants/{people[1]}/{suffix}", payload).status_code == expected
    assert Invite.objects.count() == 0 and mailbox == []


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


def test_missing_email_and_archived_ledgers_do_not_send(client, direct, mailbox):
    group_id, people, _ = direct
    Participant.objects.filter(id=people[1]).update(contact_email="")
    assert send_invite(client, direct)[1].status_code == 422
    Participant.objects.filter(id=people[1]).update(contact_email="friend@example.invalid")
    Group.objects.filter(id=group_id).update(archived=True)
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


@pytest.mark.parametrize("ledger_fixture", ["direct", "group"])
def test_provider_failure_keeps_one_ledger_and_retries_same_immutable_delivery(client, request, mailbox, monkeypatch, ledger_fixture):
    ledger = request.getfixturevalue(ledger_fixture)
    if ledger_fixture == "group":
        Participant.objects.filter(pk=ledger[1][1]).update(contact_email="friend@example.invalid")
    deliveries = []
    def uncertain(recipient, subject, text, delivery_id, **kwargs):
        deliveries.append((recipient, subject, text, delivery_id, kwargs))
        raise email_delivery.EmailDeliveryUnavailable()
    monkeypatch.setattr(email_delivery, "send_email", uncertain)
    command, failed = send_invite(client, ledger)
    assert failed.status_code == 200 and failed.json()["invite"]["state"] == "failed"
    assert send_invite(client, ledger, command)[1].status_code == 429
    Invite.objects.filter(id=command).update(last_send_at=timezone.now() - timedelta(seconds=61))
    monkeypatch.setattr(email_delivery, "render_message", lambda *args, **kwargs: ("Changed text", "Changed HTML"))
    _, retried = send_invite(client, ledger, command)
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
