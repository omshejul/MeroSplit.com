"""Independent audit repros, synthetic PostgreSQL and real session-token HTTP auth."""
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest
from allauth.account.models import EmailAddress
from django.contrib.auth import get_user_model
from django.db import close_old_connections, connections

from .models import CommandReceipt, Expense, Group, OpeningBalance
from .test_api import authenticated_client, expense, send, uid

pytestmark = pytest.mark.django_db(transaction=True)


def account():
    email = f"{uid()}@audit.invalid"
    actor = get_user_model().objects.create_user(username=email, email=email)
    EmailAddress.objects.create(user=actor, email=email, verified=True, primary=True)
    return authenticated_client(actor)


def ledger(owner, member=None):
    ids = [uid(), uid()]
    body = {"command_id": uid(), "id": uid(), "name": "Synthetic audit",
            "self_participant_id": ids[0], "participants": [
                {"id": ids[0], "name": "Owner"},
                {"id": ids[1], "name": "Other", "email": member.actor.email if member else ""}]}
    result = send(owner, "post", "/groups", body)
    assert result.status_code == 200, result.content
    return body["id"], ids


def bill(ids, **changes):
    return expense(ids, beneficiaries=[0, 1]) | changes


def parallel_http(token, jobs):
    barrier = Barrier(len(jobs))

    def run(job):
        from django.test import Client
        close_old_connections()
        client = Client(HTTP_X_SESSION_TOKEN=token)
        try:
            barrier.wait(timeout=5)
            response = send(client, *job)
            return response.status_code, response.json()
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=len(jobs)) as pool:
        return list(pool.map(run, jobs))


def test_audit_lost_ack_concurrent_replay_and_changed_payload():
    owner = account()
    group_id, ids = ledger(owner)
    body = bill(ids)
    jobs = [("post", f"/groups/{group_id}/expenses", body)] * 2
    results = parallel_http(owner.defaults["HTTP_X_SESSION_TOKEN"], jobs)
    assert results[0] == results[1] and results[0][0] == 200
    assert Expense.objects.filter(group_id=group_id).count() == 1
    assert Group.objects.get(pk=group_id).version == 2
    assert send(owner, "post", jobs[0][1], body | {"description": "Changed"}).status_code == 409
    assert Expense.objects.get(pk=body["id"]).description == body["description"]


def test_audit_cross_group_command_collision_rolls_back_loser():
    owner = account()
    first, a = ledger(owner)
    second, b = ledger(owner)
    command_id = uid()
    jobs = [("post", f"/groups/{group_id}/expenses", bill(ids, command_id=command_id))
            for group_id, ids in [(first, a), (second, b)]]
    results = parallel_http(owner.defaults["HTTP_X_SESSION_TOKEN"], jobs)
    assert sorted(row[0] for row in results) == [200, 409]
    assert Expense.objects.count() == 1
    assert sorted(Group.objects.values_list("version", flat=True)) == [1, 2]
    assert CommandReceipt.objects.filter(command_id=command_id).count() == 1


def test_audit_concurrent_edits_do_not_lose_updates():
    owner = account()
    group_id, ids = ledger(owner)
    original = bill(ids)
    path = f"/groups/{group_id}/expenses"
    assert send(owner, "post", path, original).status_code == 200
    jobs = [("put", f"{path}/{original['id']}", original | {
        "command_id": uid(), "version": 1, "description": text}) for text in ["First", "Second"]]
    results = parallel_http(owner.defaults["HTTP_X_SESSION_TOKEN"], jobs)
    assert sorted(row[0] for row in results) == [200, 409]
    assert Expense.objects.get(pk=original["id"]).version == 2
    assert Group.objects.get(pk=group_id).version == 3


def test_audit_same_expense_id_different_accounts_cannot_cross_groups():
    left, right = account(), account()
    first, a = ledger(left)
    second, b = ledger(right)
    first_bill = bill(a)
    assert send(left, "post", f"/groups/{first}/expenses", first_bill).status_code == 200
    duplicate = bill(b, id=first_bill["id"])
    assert send(right, "post", f"/groups/{second}/expenses", duplicate).status_code == 409
    assert Group.objects.get(pk=second).version == 1
    assert not CommandReceipt.objects.filter(actor=right.actor, command_id=duplicate["command_id"]).exists()
    assert send(right, "put", f"/groups/{second}/expenses/{first_bill['id']}", duplicate | {"version": 1}).status_code == 404
    assert send(right, "get", f"/groups/{first}").status_code == 404


@pytest.mark.parametrize("mode,values", [
    ("equal", {"a": "0"}), ("exact", {"a": "9999"}),
    ("percent", {"a": "99.99"}), ("shares", {"a": "0"}),
    ("adjustment", {"a": "20000"}),
])
def test_audit_invalid_splits_leave_no_receipt_or_partial_bill(mode, values):
    owner = account()
    group_id, ids = ledger(owner)
    body = bill(ids, split={"mode": mode, "values": {ids[0]: values["a"]}})
    assert send(owner, "post", f"/groups/{group_id}/expenses", body).status_code == 422
    assert not Expense.objects.filter(id=body["id"]).exists()
    assert not CommandReceipt.objects.filter(command_id=body["command_id"]).exists()
    assert Group.objects.get(pk=group_id).version == 1


def test_audit_archive_replays_ack_but_rejects_new_bill():
    owner = account()
    group_id, ids = ledger(owner)
    body = bill(ids)
    path = f"/groups/{group_id}"
    original = send(owner, "post", f"{path}/expenses", body)
    assert original.status_code == 200
    assert send(owner, "post", f"{path}/archive", {"command_id": uid(), "archived": True}).status_code == 200
    replay = send(owner, "post", f"{path}/expenses", body)
    assert replay.status_code == 200 and replay.json() == original.json()
    assert send(owner, "post", f"{path}/expenses", bill(ids)).status_code == 409
    assert Expense.objects.filter(group_id=group_id).count() == 1


def test_audit_deleted_bill_rejects_edit_but_original_ack_still_replays():
    owner = account()
    group_id, ids = ledger(owner)
    body = bill(ids)
    path = f"/groups/{group_id}/expenses"
    original = send(owner, "post", path, body)
    assert original.status_code == 200
    assert send(owner, "post", f"{path}/{body['id']}/reverse", {"command_id": uid(), "version": 1}).status_code == 200
    assert send(owner, "put", f"{path}/{body['id']}", body | {"command_id": uid(), "version": 2}).status_code == 409
    assert send(owner, "post", path, body).json() == original.json()
    assert Expense.objects.get(pk=body["id"]).deleted


def test_audit_receipt_distinguishes_omitted_category_from_explicit_category():
    owner = account()
    group_id, ids = ledger(owner)
    body = bill(ids, category="food")
    path = f"/groups/{group_id}/expenses"
    assert send(owner, "post", path, body).status_code == 200
    edit = body | {"command_id": uid(), "version": 1, "description": "Edited"}
    edit.pop("category")
    assert send(owner, "put", f"{path}/{body['id']}", edit).status_code == 200
    assert Expense.objects.get(pk=body["id"]).category == "food"
    # Omission preserves food, explicit other requests a different mutation.
    response = send(owner, "put", f"{path}/{body['id']}", edit | {"category": "other"})
    assert response.status_code == 409, (response.status_code, response.json())


def test_audit_legacy_category_receipt_still_replays():
    import hashlib
    import json

    from .schemas import ExpenseIn

    owner = account()
    group_id, ids = ledger(owner)
    body = bill(ids)
    body.pop("category")
    path = f"/groups/{group_id}/expenses"
    accepted = send(owner, "post", path, body)
    assert accepted.status_code == 200
    normalized = ExpenseIn.model_validate(body).model_dump(mode="json", exclude={"time"})
    normalized.pop("category_auto", None)
    legacy = hashlib.sha256(json.dumps([f"expense:{group_id}:new", normalized], sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    CommandReceipt.objects.filter(command_id=body["command_id"]).update(fingerprint=legacy)
    replay = send(owner, "post", path, body)
    assert replay.status_code == 200 and replay.json() == accepted.json()
    assert Expense.objects.count() == 1 and Group.objects.get(pk=group_id).version == 2


@pytest.mark.parametrize("amount", ["1000000001", "-1000000001"])
def test_audit_opening_amount_limit_applies_to_both_signs(amount):
    owner = account()
    group_id, ids = ledger(owner)
    body = {"command_id": uid(), "id": uid(),
            "balances": {ids[0]: amount, ids[1]: str(-int(amount))},
            "source": "Synthetic boundary", "cutoff": "2026-01-01"}
    assert send(owner, "post", f"/groups/{group_id}/opening-balances", body).status_code == 422
    assert not OpeningBalance.objects.filter(group_id=group_id).exists()
    assert not CommandReceipt.objects.filter(command_id=body["command_id"]).exists()


def test_audit_existing_large_opening_stays_readable_after_a_bill():
    owner = account()
    group_id, ids = ledger(owner)
    amount = 10**39 - 1
    # Represents historical accepted input from before opening limits existed.
    OpeningBalance.objects.create(group_id=group_id, balances={ids[0]: str(amount), ids[1]: str(-amount)},
                                  source="Historical boundary", cutoff="2026-01-01", accepted=True)
    body = bill(ids, total="1", paid={ids[0]: "1"}, split={"mode": "exact", "values": {ids[1]: "1"}})
    assert send(owner, "post", f"/groups/{group_id}/expenses", body).status_code == 200
    response = send(owner, "get", f"/groups/{group_id}")
    assert response.status_code == 200, response.content
    assert response.json()["balances"] == {ids[0]: str(amount + 1), ids[1]: str(-amount - 1)}


def test_audit_accepted_opening_and_bill_remain_readable():
    owner, member = account(), account()
    group_id, ids = ledger(owner, member)
    amount = str(10**39 - 1)
    opening = {"command_id": uid(), "id": uid(), "balances": {ids[0]: amount, ids[1]: f"-{amount}"},
               "source": "Synthetic boundary", "cutoff": "2026-01-01"}
    base = f"/groups/{group_id}"
    proposed = send(owner, "post", f"{base}/opening-balances", opening)
    # Oversized input may be rejected; accepting it must not poison subsequent reads.
    if proposed.status_code == 422:
        return
    assert proposed.status_code == 200, proposed.content
    assert send(member, "post", f"{base}/opening-balances/{opening['id']}/acknowledge", {"command_id": uid()}).status_code == 200
    body = bill(ids, total="1", paid={ids[0]: "1"}, split={"mode": "exact", "values": {ids[1]: "1"}})
    assert send(owner, "post", f"{base}/expenses", body).status_code == 200
    response = send(owner, "get", base)
    assert response.status_code == 200, (response.status_code, response.json())
