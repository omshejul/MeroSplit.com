from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Event
from time import monotonic, sleep

import pytest
from django.contrib.auth import get_user_model
from django.db import close_old_connections, connection, connections, transaction
from ninja.errors import HttpError

from .accounting import AccountingError
from .collaboration import remove_participant
from .models import CommandReceipt, Expense, ExpensePushDelivery, Group, Participant
from .services import save_expense
from .test_api import client as client
from .test_api import expense, send, uid
from .test_api import group as group
from .test_collaboration import account, link, prepare, state

pytestmark = pytest.mark.django_db


def remove(owner, group_id, person, command=None):
    return send(
        owner, "post", f"/groups/{group_id}/participants/{person}/remove",
        {"command_id": command or uid()},
    )


def settle(owner, group_id, sender, recipient, amount):
    payload = {"command_id": uid(), "id": uid(), "sender": sender, "recipient": recipient, "amount": amount}
    response = send(owner, "post", f"/groups/{group_id}/settlements", payload)
    assert response.status_code == 200, response.content
    return payload


def test_removal_permissions_balance_and_command_replay(client, group):
    group_id, ids, _ = group
    member, outsider = account(), account()
    link(client, member, group_id, ids[1])
    assert remove(outsider, group_id, ids[1]).status_code == 404
    assert remove(member, group_id, ids[2]).status_code == 403
    assert remove(client, group_id, ids[0]).status_code == 409
    bill = expense(ids, payer=0, beneficiaries=[1], total="12345")
    assert send(client, "post", f"/groups/{group_id}/expenses", bill).status_code == 200
    before = state(client, group_id)
    command = uid()
    blocked = remove(client, group_id, ids[1], command)
    assert blocked.status_code == 409
    assert blocked.json()["detail"] == "Settle ₹123.45 first"
    assert state(client, group_id) == before
    assert not CommandReceipt.objects.filter(command_id=command).exists()
    settle(client, group_id, ids[1], ids[0], "12345")
    assert remove(client, group_id, ids[1], command).status_code == 200
    assert remove(client, group_id, ids[1], command).status_code == 200
    assert remove(client, group_id, ids[1]).status_code == 409
    assert Group.objects.get(pk=group_id).changes.filter(kind="participant_removed").count() == 1


def test_removal_preserves_history_revokes_access_invites_and_queued_push(client, group, settings, monkeypatch):
    from .push import send_pending_bill_notifications
    from .test_push import register

    settings.PUSH_PROVIDER = "expo"
    group_id, ids, _ = group
    member = account()
    invitation, token = link(client, member, group_id, ids[1])
    register(member)
    bill = expense(ids, payer=0, beneficiaries=[1])
    assert send(client, "post", f"/groups/{group_id}/expenses", bill).status_code == 200
    settle(client, group_id, ids[1], ids[0], "10000")
    before = state(client, group_id)
    assert ExpensePushDelivery.objects.filter(state="pending").count() == 1
    # Revocation is also available when the owner has already archived the group.
    assert send(client, "post", f"/groups/{group_id}/archive", {
        "command_id": uid(), "archived": True,
    }).status_code == 200
    assert ExpensePushDelivery.objects.get().last_error == "group_archived"
    assert remove(client, group_id, ids[1]).status_code == 200
    after = state(client, group_id)
    for key in ["expenses", "settlements", "balances", "totals"]:
        assert after[key] == before[key]
    person = next(p for p in after["participants"] if p["id"] == ids[1])
    assert person["name"] == "B" and person["user_id"] == member.actor.pk and person["removed"]
    assert Participant.objects.get(pk=ids[1]).user_id == member.actor.pk
    assert send(member, "get", "/groups").json()["groups"] == []
    assert send(member, "get", "/account/export").json()["groups"] == []
    assert send(member, "get", f"/groups/{group_id}").status_code == 404
    assert send(member, "get", f"/groups/{group_id}/export").status_code == 404
    assert send(member, "post", f"/groups/{group_id}/expenses", bill).status_code == 404
    assert send(member, "get", f"/invites/{token}").status_code == 404
    assert send(client, "post", f"/groups/{group_id}/invites/{invitation}/approve", {
        "command_id": uid(),
    }).status_code == 409
    delivery = ExpensePushDelivery.objects.get()
    assert delivery.state == "skipped" and delivery.lease_id is None
    assert delivery.last_error == "member_removed"

    def forbidden(*args):
        pytest.fail("Removed member must not receive a notification")

    monkeypatch.setattr("ledger.push_provider.send_bill_notification", forbidden)
    assert send_pending_bill_notifications() == 0
    assert send(client, "post", f"/groups/{group_id}/archive", {
        "command_id": uid(), "archived": False,
    }).status_code == 200
    active_bill = expense(ids, payer=0, beneficiaries=[0])
    assert send(client, "post", f"/groups/{group_id}/expenses", active_bill).status_code == 200
    assert ExpensePushDelivery.objects.count() == 1


def test_removed_history_allows_notes_but_cannot_reopen_debt(client, group):
    group_id, ids, _ = group
    bill = expense(ids, payer=0, beneficiaries=[1])
    assert send(client, "post", f"/groups/{group_id}/expenses", bill).status_code == 200
    payment = settle(client, group_id, ids[1], ids[0], "10000")
    deleted_bill = expense(ids, payer=0, beneficiaries=[1], total="7000")
    assert send(client, "post", f"/groups/{group_id}/expenses", deleted_bill).status_code == 200
    assert send(client, "delete", f"/groups/{group_id}/expenses/{deleted_bill['id']}", {
        "command_id": uid(), "version": 1,
    }).status_code == 200
    assert remove(client, group_id, ids[1]).status_code == 200
    edited = {**bill, "command_id": uid(), "version": 1, "notes": "Keep the old split"}
    assert send(client, "put", f"/groups/{group_id}/expenses/{bill['id']}", edited).status_code == 200
    before = state(client, group_id)
    changed = {**edited, "command_id": uid(), "version": 2, "total": "20000", "paid": {ids[0]: "20000"}}
    assert send(client, "put", f"/groups/{group_id}/expenses/{bill['id']}", changed).status_code == 409
    assert send(client, "delete", f"/groups/{group_id}/expenses/{bill['id']}", {
        "command_id": uid(), "version": 2,
    }).status_code == 409
    assert send(client, "post", f"/groups/{group_id}/expenses/{deleted_bill['id']}/restore", {
        "command_id": uid(), "version": 2,
    }).status_code == 409
    assert send(client, "post", f"/groups/{group_id}/settlements/{payment['id']}/reverse", {
        "command_id": uid(),
    }).status_code == 409
    assert send(client, "post", f"/groups/{group_id}/expenses", expense(ids)).status_code == 422
    assert send(client, "post", f"/groups/{group_id}/settlements", {
        **payment, "id": uid(), "command_id": uid(),
    }).status_code == 422
    assert send(client, "post", f"/groups/{group_id}/invites", {
        "command_id": uid(), "participant_id": ids[1],
    }).status_code == 409
    assert state(client, group_id) == before


def test_zero_direct_member_removal_archives_and_preserves_owner_history(client):
    ids = [uid(), uid()]
    payload = {
        "command_id": uid(), "id": uid(), "name": "Direct", "self_participant_id": ids[0],
        "is_direct": True, "participants": [{"id": person, "name": str(i)} for i, person in enumerate(ids)],
    }
    assert send(client, "post", "/groups", payload).status_code == 200
    member = account()
    link(client, member, payload["id"], ids[1])
    assert remove(client, payload["id"], ids[1]).status_code == 200
    after = state(client, payload["id"])
    assert after["archived"] and len(after["participants"]) == 2
    assert send(member, "get", f"/groups/{payload['id']}").status_code == 404


@pytest.mark.parametrize("reported", [False, True])
def test_prepared_quotes_cancel_but_reported_payments_block_removal(client, group, reported):
    group_id, ids, _ = group
    member = account()
    attempt = prepare(client, member, group_id, ids)
    bill = Expense.objects.get(group_id=group_id)
    if reported:
        assert send(client, "post", f"/groups/{group_id}/payment-attempts/{attempt['id']}/report", {
            "command_id": uid(),
        }).status_code == 200
    assert send(client, "delete", f"/groups/{group_id}/expenses/{bill.id}", {
        "command_id": uid(), "version": 1,
    }).status_code == 200
    response = remove(client, group_id, ids[1])
    assert response.status_code == (409 if reported else 200)
    model = Group.objects.get(pk=group_id).attempts.get(pk=attempt["id"])
    assert model.state == ("reported" if reported else "cancelled")
    if not reported:
        assert send(client, "post", f"/groups/{group_id}/payment-attempts/{attempt['id']}/report", {
            "command_id": uid(),
        }).status_code == 409
        assert send(client, "get", f"/groups/{group_id}/payment-attempts/{attempt['id']}/launch").status_code == 409


def test_pending_opening_cannot_become_removed_debt(client, group):
    group_id, ids, _ = group
    body = {"command_id": uid(), "id": uid(), "balances": {
        ids[0]: "10000", ids[1]: "-10000", ids[2]: "0",
    }, "source": "Old ledger", "cutoff": "2026-01-01"}
    assert send(client, "post", f"/groups/{group_id}/opening-balances", body).status_code == 200
    response = remove(client, group_id, ids[1])
    assert response.status_code == 409
    assert response.json()["detail"] == "Resolve the opening balance proposal first"


@pytest.mark.django_db(transaction=True)
def test_remove_and_new_debt_are_serialized(client, group):
    group_id, ids, _ = group
    barrier = Barrier(2)
    bill = expense(ids, payer=0, beneficiaries=[1])

    def run(action):
        close_old_connections()
        try:
            actor = get_user_model().objects.get(pk=client.actor.pk)
            barrier.wait(timeout=5)
            try:
                if action == "remove":
                    remove_participant(actor, group_id, ids[1], {"command_id": uid()})
                else:
                    save_expense(actor, group_id, bill)
                return "ok"
            except (HttpError, AccountingError):
                return "blocked"
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(run, ["remove", "expense"]))
    assert sorted(results) == ["blocked", "ok"]
    removed = Participant.objects.get(pk=ids[1]).removed
    assert removed == (results[0] == "ok")
    assert Expense.objects.filter(pk=bill["id"]).exists() != removed


@pytest.mark.django_db(transaction=True)
def test_waiting_member_write_rechecks_access_after_removal(client, group):
    group_id, ids, _ = group
    member = account()
    link(client, member, group_id, ids[1])
    started = Event()
    worker_pids = []

    def waiting_write():
        close_old_connections()
        try:
            actor = get_user_model().objects.get(pk=member.actor.pk)
            worker_pids.append(connections["default"].connection.info.backend_pid)
            started.set()
            try:
                save_expense(actor, group_id, expense(ids, payer=0, beneficiaries=[2]))
                return "ok"
            except HttpError as error:
                return error.status_code
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=1) as pool:
        with transaction.atomic():
            Group.objects.select_for_update().get(pk=group_id)
            future = pool.submit(waiting_write)
            assert started.wait(timeout=5)
            deadline = monotonic() + 5
            while True:
                with connection.cursor() as cursor:
                    cursor.execute("SELECT wait_event_type FROM pg_stat_activity WHERE pid = %s", worker_pids)
                    waiting = cursor.fetchone()
                if waiting and waiting[0] == "Lock":
                    break
                assert monotonic() < deadline, "Member write did not wait for the group lock"
                sleep(0.01)
            assert remove(client, group_id, ids[1]).status_code == 200
        assert future.result(timeout=5) == 404
    assert not Expense.objects.filter(group_id=group_id).exists()
