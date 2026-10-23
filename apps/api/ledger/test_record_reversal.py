"""Saved-record reversals: real PostgreSQL, existing API and MCP commands."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest
from django.contrib.auth import get_user_model
from django.db import close_old_connections, connections
from django.test import Client
from ninja.errors import HttpError

from . import mcp_tools, services
from .models import Change, CommandReceipt, Expense, Group, Participant, Settlement
from .test_api import authenticated_client, expense, send, uid
from .test_api import client as client
from .test_api import group as group

pytestmark = pytest.mark.django_db(transaction=True)


def add_bill(client, group, **updates):
    body = expense(group[1], total="10101")
    body.update(date="2025-12-31", description="Saved original bill", notes="Retained ledger note", **updates)
    response = send(client, "post", f"/groups/{group[0]}/expenses", body)
    assert response.status_code == 200
    return body


def add_payment(client, group, actual_date="2025-02-03"):
    body = {"id": uid(), "command_id": uid(), "sender": group[1][1], "recipient": group[1][0],
            "amount": "12345", "date": actual_date}
    assert send(client, "post", f"/groups/{group[0]}/settlements", body).status_code == 200
    return body


def state(client, group):
    response = send(client, "get", f"/groups/{group[0]}")
    assert response.status_code == 200
    return response.json()


def bill_reverse(transport, client, group, bill, payload):
    if transport == "api":
        response = send(client, "post", f"/groups/{group[0]}/expenses/{bill['id']}/reverse", payload)
        assert response.status_code == 200
        return response.json()
    function = mcp_tools.reverse_expense if transport == "mcp" else services.reverse_expense
    return function(client.actor, group[0], bill["id"], payload)


def payment_reverse(transport, client, group, payment, payload):
    if transport == "api":
        response = send(client, "post", f"/groups/{group[0]}/settlements/{payment['id']}/reverse", payload)
        assert response.status_code == 200
        return response.json()
    function = mcp_tools.reverse_external_payment if transport == "mcp" else services.reverse_settlement
    return function(client.actor, group[0], payment["id"], payload)


def assert_reversal(value, event, original_id, kind, original):
    assert value["id"] == str(event.pk) and value["sequence"] == event.sequence
    assert value["kind"] == kind and value["reversal_of"] == original_id
    assert value["created_at"] == event.created_at.isoformat()
    for key, expected in original.items():
        assert value["original"][key] == expected
    assert not {"invites", "payment_profile", "payee", "token", "object_key"} & value["original"].keys()


@pytest.mark.parametrize("transport", ["api", "mcp", "service"])
def test_bill_reversal_retains_original_and_adds_linked_visible_record_once(client, group, transport):
    bill = add_bill(client, group)
    before = Expense.objects.values().get(pk=bill["id"])
    version = Group.objects.get(pk=group[0]).version
    creation = Change.objects.get(group_id=group[0], kind="expense_saved", data__id=bill["id"])
    frozen_creation = creation.data
    assert send(client, "get", f"/groups/{group[0]}/expenses/{bill['id']}").json().get("reversal") is None
    assert mcp_tools.get_bill(client.actor, group[0], bill["id"]).get("reversal") is None
    command = {"command_id": uid(), "version": 1}
    receipt = bill_reverse(transport, client, group, bill, command)
    after = Expense.objects.values().get(pk=bill["id"])
    assert {key: value for key, value in after.items() if key not in {"deleted", "version"}} == {
        key: value for key, value in before.items() if key not in {"deleted", "version"}}
    assert after["deleted"] and after["version"] == 2
    assert Group.objects.get(pk=group[0]).version == version + 1
    assert all(value == "0" for value in state(client, group)["balances"].values())
    assert state(client, group)["totals"]["spending"] == "0"
    event = Change.objects.get(group_id=group[0], kind="expense_reversed")
    assert event.pk != creation.pk and event.data["id"] == event.data["reversal_of"] == bill["id"]
    assert event.data["version"] == 1 and event.data["deleted"] is False
    for key in ("total", "paid", "shares", "date", "description", "notes", "split"):
        assert event.data[key] == frozen_creation[key]
    creation.refresh_from_db()
    assert creation.data == frozen_creation
    assert bill_reverse(transport, client, group, bill, command) == receipt
    assert Change.objects.filter(group_id=group[0], kind="expense_reversed").count() == 1
    assert CommandReceipt.objects.filter(command_id=command["command_id"]).count() == 1
    financial = {"total": str(before["total"]), "paid": before["paid"], "shares": before["shares"], "date": "2025-12-31"}
    detail = send(client, "get", f"/groups/{group[0]}/expenses/{bill['id']}").json()
    assert_reversal(detail["reversal"], event, bill["id"], "bill_reversed", financial)
    assert_reversal(mcp_tools.get_bill(client.actor, group[0], bill["id"])["reversal"], event, bill["id"], "bill_reversed", financial)
    activity = send(client, "get", "/activity").json()["items"]
    reversal = next(item for item in activity if item["id"] == str(event.pk))
    assert reversal["kind"] == "bill_reversed" and reversal["bill"]["id"] == bill["id"]


@pytest.mark.parametrize("transport", ["api", "mcp", "service"])
@pytest.mark.parametrize("actual_date", ["2025-02-03", None])
def test_payment_reversal_keeps_known_or_unknown_original_date_and_financial_fields(client, group, transport, actual_date):
    payment = add_payment(client, group, actual_date)
    before = Settlement.objects.values().get(pk=payment["id"])
    version = Group.objects.get(pk=group[0]).version
    command = {"command_id": uid()}
    receipt = payment_reverse(transport, client, group, payment, command)
    after = Settlement.objects.values().get(pk=payment["id"])
    assert {key: value for key, value in after.items() if key != "reversed"} == {
        key: value for key, value in before.items() if key != "reversed"}
    assert after["reversed"] and Group.objects.get(pk=group[0]).version == version + 1
    assert all(value == "0" for value in state(client, group)["balances"].values())
    event = Change.objects.get(group_id=group[0], kind="settlement_reversed")
    assert event.data["id"] == payment["id"]
    financial = {key: payment[key] for key in ("sender", "recipient", "amount", "date")}
    detail = send(client, "get", f"/groups/{group[0]}/settlements/{payment['id']}").json()
    assert_reversal(detail["reversal"], event, payment["id"], "payment_reversed", financial)
    assert_reversal(mcp_tools.get_payment(client.actor, group[0], payment["id"])["reversal"], event, payment["id"], "payment_reversed", financial)
    assert payment_reverse(transport, client, group, payment, command) == receipt
    assert Change.objects.filter(group_id=group[0], kind="settlement_reversed").count() == 1
    rows = send(client, "get", "/activity").json()["items"]
    assert next(row for row in rows if row["id"] == str(event.pk))["kind"] == "payment_reversed"


@pytest.mark.parametrize("first", ["api", "mcp"])
def test_bill_same_command_replays_across_api_and_mcp_but_changed_input_conflicts(client, group, first):
    bill = add_bill(client, group)
    command = {"command_id": uid(), "version": 1}
    receipt = bill_reverse(first, client, group, bill, command)
    assert bill_reverse("mcp" if first == "api" else "api", client, group, bill, command) == receipt
    response = send(client, "post", f"/groups/{group[0]}/expenses/{bill['id']}/reverse", {**command, "version": 2})
    assert response.status_code == 409
    with pytest.raises(HttpError) as error:
        mcp_tools.reverse_expense(client.actor, group[0], bill["id"], {"command_id": uid(), "version": 2})
    assert error.value.status_code == 409
    assert Change.objects.filter(group_id=group[0], kind="expense_reversed").count() == 1


def test_no_saved_bill_delete_or_restore_api_or_mcp_surface(client, group):
    from .mcp_server import create_server

    bill = add_bill(client, group)
    before = state(client, group)
    for actor in (client, Client()):
        for method, suffix in (("delete", ""), ("post", "/restore")):
            response = send(actor, method, f"/groups/{group[0]}/expenses/{bill['id']}{suffix}", {"command_id": uid(), "version": 1})
            assert response.status_code in (404, 405)
    names = {tool.name for tool in asyncio.run(create_server().list_tools())}
    assert "reverse_expense" in names and "set_expense_deleted" not in names
    assert state(client, group) == before


@pytest.mark.parametrize("guard,status", [("archived", 409), ("outsider", 404), ("removed_actor", 404), ("wrong_group", 404)])
def test_bill_reversal_preserves_existing_access_and_archive_guards(client, group, guard, status):
    bill = add_bill(client, group)
    actor = client.actor
    group_id = group[0]
    if guard == "archived":
        Group.objects.filter(pk=group_id).update(archived=True)
    elif guard == "outsider":
        actor = get_user_model().objects.create_user(username=uid(), email=f"{uid()}@example.invalid")
    elif guard == "removed_actor":
        Participant.objects.filter(pk=group[1][0]).update(removed=True)
    else:
        group_id = uid()
    before = Expense.objects.values().get(pk=bill["id"])
    command = {"command_id": uid(), "version": 1}
    for function in (services.reverse_expense, mcp_tools.reverse_expense):
        with pytest.raises(HttpError) as error:
            function(actor, group_id, bill["id"], command)
        assert error.value.status_code == status
    assert Expense.objects.values().get(pk=bill["id"]) == before
    assert not Change.objects.filter(kind="expense_reversed").exists()
    assert not CommandReceipt.objects.filter(command_id=command["command_id"]).exists()


def test_active_member_bill_reversal_keeps_existing_permission_without_creator_role(client, group):
    bill = add_bill(client, group)
    member = get_user_model().objects.create_user(username=uid(), email=f"{uid()}@example.invalid")
    Participant.objects.filter(pk=group[1][1]).update(user=member)
    response = send(authenticated_client(member), "post", f"/groups/{group[0]}/expenses/{bill['id']}/reverse", {"command_id": uid(), "version": 1})
    assert response.status_code == 200


def test_payment_reversal_rejects_uninvolved_member_without_touching_original(client, group):
    payment = add_payment(client, group)
    member = get_user_model().objects.create_user(username=uid(), email=f"{uid()}@example.invalid")
    Participant.objects.filter(pk=group[1][2]).update(user=member)
    response = send(authenticated_client(member), "post", f"/groups/{group[0]}/settlements/{payment['id']}/reverse", {"command_id": uid()})
    assert response.status_code == 403
    assert not Settlement.objects.get(pk=payment["id"]).reversed
    assert not Change.objects.filter(kind="settlement_reversed").exists()


@pytest.mark.parametrize("kind", ["bill", "payment"])
def test_reversal_cannot_reopen_removed_person_balance_and_rolls_back_audit(client, group, kind):
    bill = add_bill(client, group, total="10000", paid={group[1][0]: "10000"},
                    split={"mode": "equal", "values": {group[1][1]: "1"}})
    payment = {"id": uid(), "command_id": uid(), "sender": group[1][1], "recipient": group[1][0], "amount": "10000", "date": None}
    assert send(client, "post", f"/groups/{group[0]}/settlements", payment).status_code == 200
    assert send(client, "post", f"/groups/{group[0]}/participants/{group[1][1]}/remove", {"command_id": uid()}).status_code == 200
    before = state(client, group)
    command = {"command_id": uid(), **({"version": 1} if kind == "bill" else {})}
    path = f"/groups/{group[0]}/{'expenses' if kind == 'bill' else 'settlements'}/{bill['id'] if kind == 'bill' else payment['id']}/reverse"
    response = send(client, "post", path, command)
    assert response.status_code == 409
    assert state(client, group) == before
    assert not CommandReceipt.objects.filter(command_id=command["command_id"]).exists()
    assert not Change.objects.filter(kind__in=["expense_reversed", "settlement_reversed"]).exists()


@pytest.mark.parametrize("kind", ["bill", "payment"])
@pytest.mark.parametrize("same_command", [True, False])
def test_concurrent_api_domain_and_mcp_reversals_apply_inverse_exactly_once(client, group, kind, same_command):
    original = add_bill(client, group) if kind == "bill" else add_payment(client, group)
    version = Group.objects.get(pk=group[0]).version
    shared = uid()
    commands = [{"command_id": shared if same_command else uid(), **({"version": 1} if kind == "bill" else {})} for _ in range(2)]
    barrier = Barrier(2)

    def run(index):
        close_old_connections()
        try:
            actor = get_user_model().objects.get(pk=client.actor.pk)
            function = (services.reverse_expense if index == 0 else mcp_tools.reverse_expense) if kind == "bill" else (
                services.reverse_settlement if index == 0 else mcp_tools.reverse_external_payment)
            barrier.wait(timeout=10)
            try:
                return function(actor, group[0], original["id"], commands[index])
            except HttpError as error:
                return error.status_code
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(run, range(2)))
    if same_command:
        assert isinstance(results[0], dict) and results[0] == results[1]
    else:
        assert sum(isinstance(result, dict) for result in results) == 1 and results.count(409) == 1
    event_kind = "expense_reversed" if kind == "bill" else "settlement_reversed"
    assert Change.objects.filter(group_id=group[0], kind=event_kind).count() == 1
    assert CommandReceipt.objects.filter(command_id__in=[command["command_id"] for command in commands]).count() == 1
    assert Group.objects.get(pk=group[0]).version == version + 1
    assert all(value == "0" for value in state(client, group)["balances"].values())


def test_legacy_payment_reversal_event_uses_immutable_original_financial_fallback(client, group):
    payment = add_payment(client, group, None)
    Settlement.objects.filter(pk=payment["id"]).update(reversed=True)
    Group.objects.filter(pk=group[0]).update(version=Group.objects.get(pk=group[0]).version + 1)
    event = Change.objects.create(group_id=group[0], sequence=Group.objects.get(pk=group[0]).version,
        actor=client.actor, kind="settlement_reversed", data={"id": payment["id"]})
    financial = {key: payment[key] for key in ("sender", "recipient", "amount", "date")}
    assert_reversal(send(client, "get", f"/groups/{group[0]}/settlements/{payment['id']}").json()["reversal"], event, payment["id"], "payment_reversed", financial)
    assert_reversal(mcp_tools.get_payment(client.actor, group[0], payment["id"])["reversal"], event, payment["id"], "payment_reversed", financial)
