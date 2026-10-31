import json
from pathlib import Path

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from .accounting import direct_transfers
from .models import Group, Participant, PaymentAttempt, PaymentProfile
from .services import snapshot
from .test_api import authenticated_client, expense, send, uid
from .test_api import client as client
from .test_api import group as group

CASES = json.loads((Path(__file__).resolve().parents[3] / "fixtures/direct-debts.json").read_text())


@pytest.mark.parametrize("case", CASES, ids=lambda row: row["id"])
def test_direct_accounting(case):
    bills = [(sum(map(int, paid.values())), paid, shares) for paid, shares in case["bills"]]
    assert direct_transfers(bills, case["payments"], checkpoint=case.get("checkpoint", [])) == case["expected"]


pytestmark = pytest.mark.django_db


def switch(client, group_id, enabled, *, version=None, command_id=None):
    if version is None:
        version = Group.objects.get(pk=group_id).version
    return send(client, "post", f"/groups/{group_id}/simplify", {"command_id": command_id or uid(), "version": version, "simplify_debts": enabled})


def bill(client, group_id, ids, payer, beneficiary, amount="50000"):
    payload = expense(ids, payer=payer, beneficiaries=[beneficiary], total=amount)
    assert send(client, "post", f"/groups/{group_id}/expenses", payload).status_code == 200
    return payload


def test_group_setting_defaults_and_new_group_off(client, group):
    group_id, ids, creation = group
    assert snapshot(Group.objects.get(pk=group_id))["simplify_debts"] is True
    fresh = {**creation, "id": uid(), "command_id": uid(), "participants": [{"id": uid(), "name": str(i)} for i in range(3)], "simplify_debts": False}
    fresh["self_participant_id"] = fresh["participants"][0]["id"]
    assert send(client, "post", "/groups", fresh).status_code == 200
    assert Group.objects.get(pk=fresh["id"]).simplify_debts is False
    # Default metadata must not break old command receipts.
    assert send(client, "post", "/groups", {**creation, "simplify_debts": True}).status_code == 200


def test_direct_chain_summary_partial_payment_and_upi(client, group):
    group_id, ids, _ = group
    assert switch(client, group_id, False).status_code == 200
    bill(client, group_id, ids, 1, 0)
    bill(client, group_id, ids, 2, 1)
    state = snapshot(Group.objects.get(pk=group_id))
    assert {tuple(row.values()) for row in state["transfers"]} == {(ids[0], ids[1], "50000"), (ids[1], ids[2], "50000")}
    summary = send(client, "get", f"/groups/{group_id}/summary?limit=1").json()
    assert summary["transfers"] == state["transfers"]
    assert summary["simplify_debts"] is False and summary["can_change_simplify"] is False
    assert switch(client, group_id, True).status_code == 409
    payment = {"command_id": uid(), "id": uid(), "sender": ids[0], "recipient": ids[1], "amount": "20000"}
    assert send(client, "post", f"/groups/{group_id}/settlements", payment).status_code == 200
    state = snapshot(Group.objects.get(pk=group_id))
    assert next(row for row in state["transfers"] if row["sender"] == ids[0])["amount"] == "30000"
    # The existing UPI validation must use the direct plan, not group nets.
    recipient = get_user_model().objects.create_user(username=uid(), email=f"{uid()}@example.invalid")
    Participant.objects.filter(pk=ids[1]).update(user=recipient)
    PaymentProfile.objects.create(user=recipient, vpa="test@upi")
    profile = PaymentProfile.objects.get(user=recipient)
    quote = {"command_id": uid(), "id": uid(), "sender": ids[0], "recipient": ids[1], "amount": "30000", "group_version": state["version"], "payee_version": profile.version}
    assert send(client, "post", f"/groups/{group_id}/payment-attempts", quote).status_code == 200


def test_settled_checkpoint_does_not_revive_debts_and_edit_is_only_difference(client, group):
    group_id, ids, _ = group
    original = bill(client, group_id, ids, 1, 0)
    bill(client, group_id, ids, 2, 1)
    payment = {"command_id": uid(), "id": uid(), "sender": ids[0], "recipient": ids[2], "amount": "50000"}
    assert send(client, "post", f"/groups/{group_id}/settlements", payment).status_code == 200
    current = Group.objects.get(pk=group_id)
    version, command_id = current.version, uid()
    assert switch(client, group_id, False, version=version, command_id=command_id).status_code == 200
    assert switch(client, group_id, False, version=version, command_id=command_id).status_code == 200
    current.refresh_from_db()
    assert current.debt_checkpoint and snapshot(current)["transfers"] == []
    edited = {**original, "command_id": uid(), "version": 1, "total": "60000", "paid": {ids[1]: "60000"}}
    assert send(client, "put", f"/groups/{group_id}/expenses/{original['id']}", edited).status_code == 200
    assert snapshot(Group.objects.get(pk=group_id))["transfers"] == [{"sender": ids[0], "recipient": ids[1], "amount": "10000"}]


def test_setting_authorization_versions_pending_and_archived(client, group):
    group_id, ids, _ = group
    other = get_user_model().objects.create_user(username=uid(), email=f"{uid()}@example.invalid")
    outsider = authenticated_client(other)
    assert switch(outsider, group_id, False).status_code == 404
    Participant.objects.filter(pk=ids[1]).update(user=other)
    assert switch(outsider, group_id, False).status_code == 403
    assert switch(client, group_id, False, version=0).status_code == 409
    attempt = PaymentAttempt.objects.create(group_id=group_id, sender_id=ids[0], recipient_id=ids[1], amount=1, payee="test@upi", payee_version=1, group_version=1, expires_at=timezone.now()+timezone.timedelta(minutes=5))
    assert switch(client, group_id, False).status_code == 409
    attempt.state="cancelled"
    attempt.save()
    Group.objects.filter(pk=group_id).update(archived=True)
    assert switch(client, group_id, False).status_code == 409


def test_zero_net_direct_cycle_cannot_switch_remove_or_leave(client, group):
    group_id, ids, _ = group
    assert switch(client, group_id, False).status_code == 200
    for payer, beneficiary in [(1, 0), (2, 1), (0, 2)]:
        bill(client, group_id, ids, payer, beneficiary)
    state=snapshot(Group.objects.get(pk=group_id))
    assert set(state["balances"].values()) == {"0"} and len(state["transfers"]) == 3
    assert switch(client, group_id, True).status_code == 409
    assert send(client, "post", f"/groups/{group_id}/participants/{ids[1]}/remove", {"command_id":uid()}).status_code == 409
    assert send(client, "post", f"/groups/{group_id}/leave", {"command_id":uid()}).status_code == 409
