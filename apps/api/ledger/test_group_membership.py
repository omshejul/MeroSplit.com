from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest
from django.db import close_old_connections, connections
from django.utils import timezone
from ninja.errors import HttpError

from .group_membership import leave_group, restore_group
from .models import (
    Change,
    CommandReceipt,
    ExpenseNotice,
    Group,
    Invite,
    OpeningBalance,
    Participant,
    PaymentAttempt,
)
from .services import snapshot, visible_group
from .test_api import client as client
from .test_api import expense, send, uid
from .test_api import group as group
from .test_collaboration import account, link, state

pytestmark = pytest.mark.django_db


def leave(client, group_id, command=None):
    return leave_group(client.actor, group_id, {"command_id": command or uid()})


def restore(client, group_id, command=None):
    return restore_group(client.actor, group_id, {"command_id": command or uid()})


def fails(status, action):
    with pytest.raises(HttpError) as exc:
        action()
    assert exc.value.status_code == status
    return str(exc.value)


def test_departure_revokes_access_but_exact_receipt_replays(client, group):
    gid, ids, _ = group
    member, stranger = account(), account()
    link(client, member, gid, ids[1])
    command = uid()
    result = leave(member, gid, command)
    assert result["disposition"] == "left"
    assert leave(member, gid, command) == result
    assert Participant.objects.get(pk=ids[1]).user_id == member.actor.pk
    assert Participant.objects.get(pk=ids[1]).removed
    assert Group.objects.get(pk=gid).owner_id == client.actor.pk
    assert Invite.objects.filter(participant_id=ids[1], revoked=False).count() == 0
    fails(404, lambda: visible_group(member.actor, gid))
    fails(404, lambda: leave(member, gid))
    fails(404, lambda: restore(member, gid))
    fails(404, lambda: leave(stranger, gid, command))
    fails(409, lambda: leave_group(member.actor, gid, {"command_id": command, "changed": True}))
    fails(409, lambda: restore(member, gid, command))
    assert CommandReceipt.objects.filter(actor=member.actor, command_id=command).count() == 1


def test_owner_succession_uses_actual_claim_order_not_uuid(client, group):
    gid, ids, _ = group
    early, late = account(), account()
    # Deliberately give the lexically larger participant the earlier join.
    first, second = sorted(ids[1:], reverse=True)
    link(client, early, gid, first)
    link(client, late, gid, second)
    Group.objects.filter(pk=gid).update(import_source_hash="a" * 64, archived=True)
    before = snapshot(Group.objects.get(pk=gid))
    result = leave(client, gid)
    row = Group.objects.get(pk=gid)
    assert result["disposition"] == "left"
    assert row.owner_id == early.actor.pk and row.import_source_hash == "" and row.archived
    after = snapshot(row)
    for key in ["expenses", "settlements", "balances", "transfers", "totals"]:
        assert after[key] == before[key]
    assert leave(early, gid)["disposition"] == "left"
    assert Group.objects.get(pk=gid).owner_id == late.actor.pk


def test_missing_candidate_chronology_fails_closed_atomically(client, group):
    gid, ids, _ = group
    unknown = account()
    Participant.objects.filter(pk=ids[1]).update(user=unknown.actor)
    before = state(client, gid)
    command = uid()
    assert "joining history" in fails(409, lambda: leave(client, gid, command))
    assert state(client, gid) == before
    assert not CommandReceipt.objects.filter(command_id=command).exists()
    assert not Participant.objects.get(pk=ids[0]).hidden


def test_only_owner_hides_and_restores_privately_without_shared_revision(client, group):
    gid, ids, _ = group
    Group.objects.filter(pk=gid).update(archived=True, import_source_hash="b" * 64)
    before = snapshot(Group.objects.get(pk=gid))
    command = uid()
    result = leave(client, gid, command)
    assert result == {"id": gid, "version": before["version"], "disposition": "hidden"}
    assert leave(client, gid, command) == result
    assert Participant.objects.get(pk=ids[0]).hidden
    assert snapshot(Group.objects.get(pk=gid)) == before  # Private flag is absent from shared participant/history DTO.
    restore_command = uid()
    restored = restore(client, gid, restore_command)
    assert restored["disposition"] == "restored" and restored["version"] == before["version"]
    assert restore(client, gid, restore_command) == restored
    assert not Participant.objects.get(pk=ids[0]).hidden
    row = Group.objects.get(pk=gid)
    assert row.owner_id == client.actor.pk and row.archived and row.import_source_hash == "b" * 64


@pytest.mark.parametrize("linked", [False, True])
def test_debt_blocks_hide_or_departure_without_receipt(client, group, linked):
    gid, ids, _ = group
    if linked:
        link(client, account(), gid, ids[1])
    assert send(client, "post", f"/groups/{gid}/expenses", expense(ids, payer=1, beneficiaries=[0], total="12345")).status_code == 200
    command = uid()
    assert "Settle ₹123.45 first" in fails(409, lambda: leave(client, gid, command))
    assert not Participant.objects.get(pk=ids[0]).hidden
    assert not CommandReceipt.objects.filter(command_id=command).exists()


def attempt(gid, sender, recipient, state="prepared"):
    return PaymentAttempt.objects.create(group_id=gid, sender_id=sender, recipient_id=recipient, amount=100,
                                        payee="synthetic@upi", payee_version=1, group_version=1,
                                        expires_at=timezone.now(), state=state)


def test_reported_and_opening_guards_include_owner_hide(client, group):
    gid, ids, _ = group
    row = attempt(gid, ids[0], ids[1], "reported")
    assert "reported" in fails(409, lambda: leave(client, gid))
    row.state = "cancelled"
    row.save()
    opening = OpeningBalance.objects.create(group_id=gid, source="Synthetic", cutoff="2026-01-01",
                                           balances={ids[0]: "100", ids[1]: "-100", ids[2]: "0"}, acknowledgments={})
    assert "opening" in fails(409, lambda: leave(client, gid))
    opening.balances = {ids[0]: "0", ids[1]: "100", ids[2]: "-100"}
    opening.save()
    assert leave(client, gid)["disposition"] == "hidden"


def test_departure_cancels_only_own_quotes_and_notices(client, group):
    gid, ids, _ = group
    member, other = account(), account()
    link(client, member, gid, ids[1])
    link(client, other, gid, ids[2])
    # Each person pays and shares equally: notices exist without outstanding debt.
    bill = expense(ids, total="300")
    bill["paid"] = {pid: "100" for pid in ids}
    assert send(client, "post", f"/groups/{gid}/expenses", bill).status_code == 200
    own = attempt(gid, ids[1], ids[0])
    unrelated = attempt(gid, ids[0], ids[2])
    leave(member, gid)
    own.refresh_from_db()
    unrelated.refresh_from_db()
    assert own.state == "cancelled" and unrelated.state == "prepared"
    assert ExpenseNotice.objects.get(expense_id=bill["id"], recipient=member.actor).cancelled_at
    assert ExpenseNotice.objects.get(expense_id=bill["id"], recipient=other.actor).cancelled_at is None
    assert state(client, gid)["totals"]["spending"] == "300"


def test_failed_receipt_rolls_back_transfer_and_departure(client, group, monkeypatch):
    gid, ids, _ = group
    member = account()
    link(client, member, gid, ids[1])
    Group.objects.filter(pk=gid).update(import_source_hash="c" * 64)
    def fail(*args, **kwargs):
        raise RuntimeError("receipt storage unavailable")
    monkeypatch.setattr(CommandReceipt.objects, "create", fail)
    with pytest.raises(RuntimeError):
        leave(client, gid)
    row = Group.objects.get(pk=gid)
    assert row.owner_id == client.actor.pk and row.import_source_hash == "c" * 64
    assert not Participant.objects.get(pk=ids[0]).removed


@pytest.mark.django_db(transaction=True)
def test_concurrent_same_command_has_one_receipt_and_one_departure(client, group):
    gid, ids, _ = group
    member = account()
    link(client, member, gid, ids[1])
    gate, command = Barrier(2), uid()
    def run():
        close_old_connections()
        try:
            gate.wait(timeout=10)
            return leave(member, gid, command)
        finally:
            connections.close_all()
    with ThreadPoolExecutor(max_workers=2) as pool:
        values = list(pool.map(lambda _: run(), range(2)))
    assert values[0] == values[1]
    assert CommandReceipt.objects.filter(actor=member.actor, command_id=command).count() == 1
    assert Change.objects.filter(group_id=gid, kind="participant_removed").count() == 1


def test_import_creator_and_email_claim_produce_succession_evidence(client, monkeypatch):
    from . import email_delivery
    from .collaboration import invite_token
    from .splitwise_import import import_splitwise
    from .test_email_invites import verified_person
    from .test_splitwise_import import payload
    monkeypatch.setattr(email_delivery, "send_email", lambda *args, **kwargs: "synthetic-delivery")
    # Imported Alpha has zero balance; Beta/Gamma retain their original obligations.
    data = payload(self_index=0)
    imported = import_splitwise(client.actor, data)
    gid = imported["id"]
    person = Participant.objects.get(group_id=gid, name="Beta")
    recipient = verified_person("successor@example.invalid")
    assert send(client, "post", f"/groups/{gid}/participants/{person.id}/contact", {
        "command_id": uid(), "email": recipient.actor.email,
    }).status_code == 200
    command = uid()
    assert send(client, "post", f"/groups/{gid}/participants/{person.id}/email-invite", {"command_id": command}).status_code == 200
    assert send(recipient, "post", f"/invites/{invite_token(command)}/claim", {"command_id": uid()}).status_code == 200
    evidence = Change.objects.get(group_id=gid, kind="participant_claim_approved")
    assert evidence.data["participant_id"] == str(person.id)
    before = snapshot(Group.objects.get(pk=gid))
    assert leave(client, gid)["disposition"] == "left"
    row = Group.objects.get(pk=gid)
    assert row.owner_id == recipient.actor.pk and row.import_source_hash == ""
    after = snapshot(row)
    assert after["balances"] == before["balances"] and after["expenses"] == before["expenses"]


def test_inactive_and_removed_candidates_do_not_prevent_private_hide(client, group):
    gid, ids, _ = group
    inactive, removed = account(), account()
    Participant.objects.filter(pk=ids[1]).update(user=inactive.actor)
    inactive.actor.is_active = False
    inactive.actor.save(update_fields=["is_active"])
    Participant.objects.filter(pk=ids[2]).update(user=removed.actor, removed=True)
    assert leave(client, gid)["disposition"] == "hidden"
    assert Group.objects.get(pk=gid).owner_id == client.actor.pk


def test_inactive_actor_cannot_replay_or_restore(client, group):
    gid, _, _ = group
    command = uid()
    leave(client, gid, command)
    client.actor.is_active = False
    client.actor.save(update_fields=["is_active"])
    fails(401, lambda: leave(client, gid, command))
    fails(401, lambda: restore(client, gid))


@pytest.mark.django_db(transaction=True)
def test_departure_and_new_debt_serialize_without_reopening_removed_balance(client, group):
    from .accounting import AccountingError
    from .services import save_expense
    gid, ids, _ = group
    member = account()
    link(client, member, gid, ids[1])
    gate = Barrier(2)
    bill = expense(ids, payer=0, beneficiaries=[1], total="100")
    def run(action):
        close_old_connections()
        try:
            gate.wait(timeout=10)
            try:
                action()
                return "accepted"
            except (HttpError, AccountingError):
                return "blocked"
        finally:
            connections.close_all()
    with ThreadPoolExecutor(max_workers=2) as pool:
        departing = pool.submit(run, lambda: leave(member, gid))
        writing = pool.submit(run, lambda: save_expense(client.actor, gid, bill))
        outcomes = [departing.result(timeout=15), writing.result(timeout=15)]
    assert sorted(outcomes) == ["accepted", "blocked"]
    person = Participant.objects.get(pk=ids[1])
    balance = int(snapshot(Group.objects.get(pk=gid))["balances"][ids[1]])
    assert balance == (0 if person.removed else -100)


def test_reclaimed_deleted_identity_uses_new_join_order(client, group):
    from .portability import delete_account
    gid, ids, _ = group
    former, earlier_current, replacement = account(), account(), account()
    link(client, former, gid, ids[1])
    link(client, earlier_current, gid, ids[2])
    delete_account(former.actor)
    link(client, replacement, gid, ids[1])
    assert leave(client, gid)["disposition"] == "left"
    assert Group.objects.get(pk=gid).owner_id == earlier_current.actor.pk


def test_http_hidden_index_is_complete_and_private_then_actual_leave_receipt_remains_replayable(client, group):
    from django.test import Client
    gid, ids, _ = group
    command = uid()
    assert send(Client(), "post", f"/groups/{gid}/leave", {"command_id": uid()}).status_code == 401
    hidden = send(client, "post", f"/groups/{gid}/leave", {"command_id": command})
    assert hidden.status_code == 200 and hidden.json()["disposition"] == "hidden"
    index = send(client, "get", "/groups").json()["groups"]
    assert len(index) == 1 and index[0]["id"] == gid and index[0]["hidden"] is True
    assert send(client, "get", f"/groups/{gid}").json()["hidden"] is True
    assert send(client, "get", f"/groups/{gid}/summary").json()["hidden"] is True
    member = account()
    link(client, member, gid, ids[1])
    member_index = send(member, "get", "/groups").json()["groups"]
    assert member_index[0]["hidden"] is False
    full = send(member, "get", f"/groups/{gid}").json()
    assert full["hidden"] is False and all("hidden" not in person for person in full["participants"])
    restore_body = {"command_id": uid()}
    restored = send(client, "post", f"/groups/{gid}/restore", restore_body)
    assert restored.status_code == 200 and restored.json()["disposition"] == "restored"
    assert send(client, "post", f"/groups/{gid}/restore", restore_body).json() == restored.json()
    leave_body = {"command_id": uid()}
    departed = send(client, "post", f"/groups/{gid}/leave", leave_body)
    assert departed.status_code == 200 and departed.json()["disposition"] == "left"
    assert send(client, "get", f"/groups/{gid}").status_code == 404
    assert send(client, "get", "/groups").json()["groups"] == []
    assert send(client, "post", f"/groups/{gid}/leave", leave_body).json() == departed.json()
    assert send(client, "post", f"/groups/{gid}/leave", {"command_id": uid()}).status_code == 404
