import json
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from datetime import date, timedelta
from threading import Event
from urllib.parse import urlencode
from uuid import UUID

import pytest
from django.core import signing
from django.db import close_old_connections, connection, connections, transaction
from django.test import Client
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from . import history_reads
from .history_reads import CURSOR_SALT
from .models import (
    Change,
    CommandReceipt,
    Expense,
    ExpenseNotice,
    Group,
    NotificationPreference,
    Participant,
    PaymentAttempt,
    PaymentProfile,
    Settlement,
)
from .test_api import client as client
from .test_api import expense, send, uid
from .test_api import group as group
from .test_collaboration import account, link, prepare

pytestmark = pytest.mark.django_db(transaction=True)


def page(client, group_id, **params):
    return send(client, "get", f"/groups/{group_id}/history/transactions?{urlencode(params)}")


def populate(group, count=25):
    group_id, ids, _ = group
    bills, payments = [], []
    for i in range(count):
        actual = date(2025, 1, 1) + timedelta(days=i % 5)
        bills.append(Expense(id=UUID(int=i + 1), group_id=group_id, description=f"Synthetic bill {i}", total=100,
            paid={ids[0]: "100"}, shares={ids[1]: "100"}, split={"mode": "exact", "values": {ids[1]: "100"}},
            date=actual, notes="Searchable needle" if i % 3 == 0 else "", deleted=i % 7 == 0))
        payments.append(Settlement(id=UUID(int=i + 1), group_id=group_id, sender_id=ids[1], recipient_id=ids[0],
            amount=10, date=actual if i % 4 else None, reversed=i % 6 == 0))
    Expense.objects.bulk_create(bills)
    Settlement.objects.bulk_create(payments)
    return bills, payments


def test_mixed_keysets_are_globally_ordered_with_cross_kind_uuid_ties_and_unknown_dates(client, group):
    bills, payments = populate(group)
    expected = sorted([(True, row.date, 0, row.id) for row in bills] + [(row.date is not None, row.date or date.min, 1, row.id) for row in payments], reverse=True)
    found, cursor = [], None
    while True:
        response = page(client, group[0], limit=3, **({"cursor": cursor} if cursor else {}))
        assert response.status_code == 200, response.content
        for item in response.json()["items"]:
            record = item[item["kind"]]
            found.append((item["date"] is not None, date.fromisoformat(item["date"]) if item["date"] else date.min, 0 if item["kind"] == "bill" else 1, UUID(record["id"])))
            assert "notes" not in record and "split" not in record
        cursor = response.json()["next_cursor"]
        if not cursor:
            break
    assert found == expected and len(found) == len(set(found)) == 50
    assert found[-1][0] is False
    summary = send(client, "get", f"/groups/{group[0]}/summary?limit=7").json()
    complete = send(client, "get", f"/groups/{group[0]}").json()
    assert summary["transactions"] == page(client, group[0], limit=7).json()["items"]
    for field in ("balances", "transfers", "totals"):
        assert summary[field] == complete[field]


def test_transaction_search_and_cursor_context_are_bounded_and_bill_only(client, group):
    bills, _ = populate(group)
    first = page(client, group[0], q="needle", limit=2).json()
    assert len(first["items"]) == 2 and all(row["kind"] == "bill" for row in first["items"])
    assert all(int(UUID(row["bill"]["id"])) in {int(bill.id) for bill in bills if "needle" in bill.notes} for row in first["items"])
    assert page(client, group[0], q="other", limit=2, cursor=first["next_cursor"]).status_code == 422
    assert page(client, group[0], q="x" * 201).status_code == 422
    assert page(client, group[0], limit=101).status_code == 422
    outsider = account()
    assert page(outsider, group[0]).status_code == 404
    member = account()
    Participant.objects.filter(pk=group[1][1]).update(user=member.actor)
    assert page(member, group[0], q="needle", limit=2, cursor=first["next_cursor"]).status_code == 422


def test_insert_and_reversal_invalidate_transaction_cursor_and_reload_exact_current_state(client, group):
    _, payments = populate(group)
    cursor = page(client, group[0], limit=3).json()["next_cursor"]
    old_version = Group.objects.get(pk=group[0]).version
    assert send(client, "post", f"/groups/{group[0]}/expenses", expense(group[1])).status_code == 200
    assert page(client, group[0], limit=3, cursor=cursor).status_code == 409
    payment = next(row for row in payments if not row.reversed)
    cursor = page(client, group[0], limit=3).json()["next_cursor"]
    assert send(client, "post", f"/groups/{group[0]}/settlements/{payment.id}/reverse", {"command_id": uid()}).status_code == 200
    assert page(client, group[0], limit=3, cursor=cursor).status_code == 409
    assert send(client, "get", f"/groups/{group[0]}/settlements/{payment.id}?version={old_version}").status_code == 409
    detail = send(client, "get", f"/groups/{group[0]}/settlements/{payment.id}")
    assert detail.status_code == 200 and detail.json()["reversed"] is True
    assert send(account(), "get", f"/groups/{group[0]}/settlements/{payment.id}").status_code == 404


def test_exact_attempt_lookup_finds_confirmed_old_record_without_full_history(client, group):
    receiver = account()
    attempt = prepare(client, receiver, group[0], group[1])
    path = f"/groups/{group[0]}/payment-attempts/{attempt['id']}"
    assert send(client, "post", f"{path}/report", {"command_id": uid()}).status_code == 200
    assert send(receiver, "post", f"{path}/confirm", {"command_id": uid()}).status_code == 200
    PaymentAttempt.objects.filter(pk=attempt["id"]).update(created_at=timezone.now() - timedelta(days=10))
    PaymentAttempt.objects.bulk_create([PaymentAttempt(group_id=group[0], sender_id=group[1][0], recipient_id=group[1][1], amount=1,
        state="cancelled", payee="synthetic@bank", payee_version=1, group_version=1, expires_at=timezone.now()) for _ in range(100)])
    with CaptureQueriesContext(connection) as queries:
        result = send(client, "get", path)
    assert result.status_code == 200 and result.json()["state"] == "confirmed"
    assert result.json()["settlement"]["id"] == result.json()["settlement_id"]
    assert "payee" not in result.json() and "payee_version" not in result.json()
    assert len(result.content) < 2000 and len(queries) <= 8
    assert send(client, "get", f"{path}?version=1").status_code == 409
    assert send(account(), "get", path).status_code == 404
    assert send(Client(), "get", path).status_code == 401


def test_activity_is_human_cross_group_ordered_current_and_never_acknowledges(client, group):
    member = account()
    link(client, member, group[0], group[1][1])
    stamp = timezone.now()
    bill = expense(group[1])
    bill["description"] = "Canonical title"
    assert send(member, "post", f"/groups/{group[0]}/expenses", bill).status_code == 200
    bill.update(command_id=uid(), version=1, description="Current canonical title")
    assert send(client, "put", f"/groups/{group[0]}/expenses/{bill['id']}", bill).status_code == 200
    payment = {"command_id": uid(), "id": uid(), "sender": group[1][1], "recipient": group[1][0], "amount": "100"}
    assert send(client, "post", f"/groups/{group[0]}/settlements", payment).status_code == 200
    assert send(client, "post", f"/groups/{group[0]}/settlements/{payment['id']}/reverse", {"command_id": uid()}).status_code == 200
    other = Group.objects.create(owner=client.actor, name="Second synthetic group", version=1)
    Participant.objects.create(group=other, user=client.actor, name="Owner")
    Change.objects.create(group=other, sequence=1, actor=client.actor, kind="group_created", data={"name": other.name})
    Change.objects.filter(group_id__in=[group[0], other.pk]).update(created_at=stamp)
    before = list(ExpenseNotice.objects.values("id", "seen_at"))
    assert before and ExpenseNotice.objects.filter(recipient=client.actor, seen_at__isnull=True).exists()
    found, cursor = [], None
    while True:
        response = send(client, "get", f"/activity?{urlencode({'limit': 2, **({'cursor': cursor} if cursor else {})})}")
        assert response.status_code == 200, response.content
        data = response.json()
        found += data["items"]
        cursor = data["next_cursor"]
        if not cursor:
            break
    assert len(found) == len({row["id"] for row in found})
    assert [int(row["id"]) for row in found] == sorted([int(row["id"]) for row in found], reverse=True)
    assert {row["group"]["id"] for row in found} == {group[0], str(other.id)}
    assert {row["kind"] for row in found} >= {"bill_added", "bill_edited", "payment_recorded", "payment_reversed", "member_joined", "group_created"}
    assert all(row["bill"]["description"] == "Current canonical title" for row in found if "bill" in row)
    assert all("data" not in row and "actor_id" not in row for row in found)
    for path in ("/summary", "/history/transactions", f"/expenses/{bill['id']}", f"/settlements/{payment['id']}"):
        assert send(client, "get", f"/groups/{group[0]}{path}").status_code == 200
    assert list(ExpenseNotice.objects.values("id", "seen_at")) == before and not NotificationPreference.objects.exists()


def test_activity_skips_handoff_noise_and_duplicate_receipt_acknowledgements(client, group):
    receiver = account()
    attempt = prepare(client, receiver, group[0], group[1])
    path = f"/groups/{group[0]}/payment-attempts/{attempt['id']}"
    assert send(client, "post", f"{path}/report", {"command_id": uid()}).status_code == 200
    assert not [row for row in send(client, "get", "/activity").json()["items"] if row["kind"].startswith("payment_")]
    for _ in range(2):
        assert send(receiver, "post", f"{path}/confirm", {"command_id": uid()}).status_code == 200
    records = [row for row in send(client, "get", "/activity").json()["items"] if row["kind"] == "payment_recorded"]
    assert len(records) == 1 and records[0]["payment"]["amount"] == attempt["amount"]


def test_activity_hides_existing_icon_only_edits_before_paging_but_keeps_real_edits_and_history(client, group):
    body = expense(group[1]) | {"category": "general", "category_auto": True}
    path = f"/groups/{group[0]}/expenses"
    assert send(client, "post", path, body).status_code == 200
    for version, category in enumerate(["general", "cycling", "cleaning", "cycling"], start=1):
        body.update(command_id=uid(), version=version, category=category, category_auto=False)
        assert send(client, "put", f"{path}/{body['id']}", body).status_code == 200
    icon_rows = set(Change.objects.filter(group_id=group[0], kind="expense_saved", data__version__gt=1).values_list("id", flat=True))
    body.update(command_id=uid(), version=5, category="food", notes="Real bill edit")
    assert send(client, "put", f"{path}/{body['id']}", body).status_code == 200
    seen, cursor = [], None
    while True:
        response = send(client, "get", f"/activity?{urlencode({'limit': 1, **({'cursor': cursor} if cursor else {})})}")
        assert response.status_code == 200, response.content
        result = response.json()
        assert result["items"], "icon edits must be filtered before the page limit"
        seen.extend(row for row in result["items"] if "bill" in row)
        cursor = result["next_cursor"]
        if not cursor:
            break
    assert [row["kind"] for row in seen] == ["bill_edited", "bill_added"]
    assert not icon_rows.intersection(int(row["id"]) for row in seen)
    assert Change.objects.filter(id__in=icon_rows).count() == 4
    history = send(client, "get", f"{path}/{body['id']}/versions").json()
    assert any(change["field"] == "category" for item in history["items"] for change in item["changes"])


def test_payment_confirmation_activity_uses_bounded_duplicate_lookup(client, group, capsys):
    attempts = [PaymentAttempt(group_id=group[0], sender_id=group[1][0], recipient_id=group[1][1], amount=1,
        state="confirmed", payee="synthetic@bank", payee_version=1, group_version=1, expires_at=timezone.now()) for _ in range(2000)]
    PaymentAttempt.objects.bulk_create(attempts, batch_size=500)
    payments = [Settlement(group_id=group[0], sender_id=group[1][0], recipient_id=group[1][1], amount=1,
        date=date(2026, 10, 17), attempt=attempt, method="recipient_confirmed") for attempt in attempts]
    Settlement.objects.bulk_create(payments, batch_size=500)
    Change.objects.bulk_create([Change(group_id=group[0], sequence=i + 2, kind="payment_confirm",
        data={"id": str(payment.attempt_id), "settlement_id": str(payment.id)}) for i, payment in enumerate(payments)], batch_size=500)
    Group.objects.filter(pk=group[0]).update(version=2001)
    with CaptureQueriesContext(connection) as queries:
        result = send(client, "get", "/activity")
    assert result.status_code == 200 and len(result.json()["items"]) == 50
    assert all(item["kind"] == "payment_recorded" for item in result.json()["items"])
    sql = next(query["sql"] for query in queries if '"ledger_change"' in query["sql"] and "LIMIT 51" in query["sql"])
    with connection.cursor() as cursor:
        cursor.execute("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + sql)
        plan = cursor.fetchone()[0][0]
    def discarded(node):
        return node.get("Rows Removed by Filter", 0) + sum(discarded(child) for child in node.get("Plans", []))
    assert "payment_activity_identity" in json.dumps(plan), plan
    assert discarded(plan["Plan"]) <= 100, plan
    with capsys.disabled():
        print(f"confirmation Activity plan: ms={plan['Execution Time']} discarded={discarded(plan['Plan'])}")


def test_activity_cursor_scope_mutation_revocation_and_redaction(client, group):
    receiver = account()
    link(client, receiver, group[0], group[1][1])
    body = expense(group[1])
    body["description"] = "Synthetic private authored title"
    assert send(client, "post", f"/groups/{group[0]}/expenses", body).status_code == 200
    cursor = send(receiver, "get", "/activity?limit=1").json()["next_cursor"]
    assert send(client, "get", f"/activity?{urlencode({'limit': 1, 'cursor': cursor})}").status_code == 422
    assert send(client, "delete", "/account").status_code == 200
    assert send(receiver, "get", f"/activity?{urlencode({'limit': 1, 'cursor': cursor})}").status_code == 409
    current = send(receiver, "get", "/activity")
    assert current.status_code == 200 and body["description"] not in current.content.decode()
    Participant.objects.filter(user=receiver.actor).update(removed=True)
    assert send(receiver, "get", "/activity").json()["items"] == []


def test_activity_removed_actor_keeps_recorded_name_and_has_no_live_profile_leak(client, group):
    former = account()
    Participant.objects.filter(pk=group[1][1]).update(user=former.actor, name="Recorded former member")
    former.actor.first_name = "Old live name"
    former.actor.save(update_fields=["first_name"])
    assert send(former, "post", f"/groups/{group[0]}/expenses", expense(group[1])).status_code == 200
    Participant.objects.filter(pk=group[1][1]).update(removed=True)
    former.actor.first_name = "New private profile name"
    former.actor.save(update_fields=["first_name"])
    current = send(client, "get", "/activity")
    assert current.status_code == 200 and former.actor.first_name not in current.content.decode()
    item = next(row for row in current.json()["items"] if row["kind"] == "bill_added")
    assert item["actor"] == {"name": "Recorded former member", "is_self": False}


def test_activity_detects_an_insert_committed_while_the_page_is_being_read(client, group, monkeypatch):
    original = history_reads._activity_revision
    calls = 0
    def revision(actor):
        nonlocal calls
        calls += 1
        if calls == 2:
            def insert():
                close_old_connections()
                try:
                    return send(Client(**client.defaults), "post", f"/groups/{group[0]}/expenses", expense(group[1])).status_code
                finally:
                    connections.close_all()
            with ThreadPoolExecutor(max_workers=1) as pool:
                assert pool.submit(insert).result(timeout=5) == 200
        return original(actor)
    monkeypatch.setattr(history_reads, "_activity_revision", revision)
    assert send(client, "get", "/activity").status_code == 409
    assert send(client, "get", "/activity").status_code == 200


@pytest.mark.parametrize("position,value", [(0, True), (0, 2), (1, None), (1, "invalid"), (2, True), (2, 2), (3, None), (3, "invalid")])
def test_transaction_signed_invalid_positions_are_rejected(client, group, position, value):
    populate(group, 3)
    token = page(client, group[0], limit=2).json()["next_cursor"]
    payload = signing.loads(token, salt=CURSOR_SALT)
    payload["after"][position] = value
    assert page(client, group[0], limit=2, cursor=signing.dumps(payload, salt=CURSOR_SALT)).status_code == 422


@pytest.mark.parametrize("after", [[0, "2026-01-01", 1, str(UUID(int=1))], [0, None, 0, str(UUID(int=1))]])
def test_unknown_date_cursor_cannot_invent_bill_or_payment_dates(client, group, after):
    populate(group, 3)
    payload = signing.loads(page(client, group[0], limit=2).json()["next_cursor"], salt=CURSOR_SALT)
    payload["after"] = after
    assert page(client, group[0], limit=2, cursor=signing.dumps(payload, salt=CURSOR_SALT)).status_code == 422


def test_new_reads_enforce_store_review_isolation_and_removed_membership(client, group, settings):
    reviewer = account()
    settings.STORE_REVIEW_AUTH = [{"store": "apple", "user_id": reviewer.actor.pk, "email": reviewer.actor.email, "pin_hash": ""}]
    _, payments = populate(group, 3)
    attempt = PaymentAttempt.objects.create(group_id=group[0], sender_id=group[1][0], recipient_id=group[1][1], amount=1,
        state="cancelled", payee="synthetic@bank", payee_version=1, group_version=1, expires_at=timezone.now())
    Participant.objects.filter(pk=group[1][1]).update(user=reviewer.actor)
    paths = ["/history/transactions", f"/settlements/{payments[0].id}", f"/payment-attempts/{attempt.id}"]
    for viewer in (client, reviewer):
        assert send(viewer, "get", "/activity").json()["items"] == []
        for path in paths:
            assert send(viewer, "get", f"/groups/{group[0]}{path}").status_code == 404
    settings.STORE_REVIEW_AUTH = []
    Participant.objects.filter(user=reviewer.actor).update(removed=True)
    for path in paths:
        assert send(reviewer, "get", f"/groups/{group[0]}{path}").status_code == 404


def test_deleted_account_retains_settleable_debt_under_existing_member_permissions(client, group):
    former = account()
    link(client, former, group[0], group[1][1])
    assert send(client, "post", f"/groups/{group[0]}/expenses", expense(group[1], beneficiaries=[1], total="12345")).status_code == 200
    assert send(former, "delete", "/account").status_code == 200
    person = Participant.objects.get(pk=group[1][1])
    assert person.user_id is None and not person.removed
    summary = send(client, "get", f"/groups/{group[0]}/summary").json()
    assert summary["balances"][str(person.id)] == "-12345"
    payment = {"command_id": uid(), "id": uid(), "sender": str(person.id), "recipient": group[1][0], "amount": "12345"}
    assert send(client, "post", f"/groups/{group[0]}/settlements", payment).status_code == 200
    assert send(client, "get", f"/groups/{group[0]}/summary").json()["balances"][str(person.id)] == "0"


def prepared_guarded(client, group):
    receiver = account()
    attempt = prepare(client, receiver, group[0], group[1])
    quote = send(client, "get", f"/groups/{group[0]}/payment-attempts/{attempt['id']}/launch").json()
    body = {"command_id": uid(), "id": uid(), "sender": group[1][0], "recipient": group[1][1], "amount": quote["amount"],
            "attempt_id": quote["id"], "expected_group_version": quote["group_version"], "date": "2026-10-17"}
    return receiver, attempt, body


@pytest.mark.parametrize("changed", ["group", "cancelled", "amount", "payee", "payee_version", "actor"])
def test_guarded_return_rejects_changed_version_state_amount_or_payee_without_writes(client, group, changed):
    receiver, attempt, body = prepared_guarded(client, group)
    actor = client
    if changed == "group":
        assert send(client, "post", f"/groups/{group[0]}/expenses", expense(group[1])).status_code == 200
    elif changed == "cancelled":
        PaymentAttempt.objects.filter(pk=attempt["id"]).update(state="cancelled")
    elif changed == "amount":
        body["amount"] = "20000"
    elif changed == "payee":
        PaymentProfile.objects.filter(user=receiver.actor).update(vpa="changed@bank")
    elif changed == "payee_version":
        PaymentProfile.objects.filter(user=receiver.actor).update(version=99)
    else:
        actor = receiver
    before = Group.objects.get(pk=group[0]).version
    response = send(actor, "post", f"/groups/{group[0]}/settlements", body)
    assert response.status_code == 409, response.content
    assert not Settlement.objects.exists() and not CommandReceipt.objects.filter(command_id=body["command_id"]).exists()
    assert Group.objects.get(pk=group[0]).version == before


def test_guarded_return_allows_expiry_alone_and_replays_original_after_version_changes(client, group):
    receiver, attempt, body = prepared_guarded(client, group)
    PaymentAttempt.objects.filter(pk=attempt["id"]).update(expires_at=timezone.now() - timedelta(days=1))
    path = f"/groups/{group[0]}/settlements"
    first = send(client, "post", path, body)
    assert first.status_code == 200, first.content
    recorded = [item for item in send(client, "get", "/activity").json()["items"] if item["kind"] == "payment_recorded"]
    assert len(recorded) == 1
    assert send(receiver, "post", f"/groups/{group[0]}/payment-attempts/{attempt['id']}/confirm", {"command_id": uid()}).status_code == 200
    assert [item for item in send(client, "get", "/activity").json()["items"] if item["kind"] == "payment_recorded"] == recorded
    assert send(receiver, "put", "/me/payment-profile", {"vpa": "another@bank"}).status_code == 200
    assert send(client, "post", f"/groups/{group[0]}/expenses", expense(group[1])).status_code == 200
    assert send(client, "post", path, body).json() == first.json() and Settlement.objects.count() == 1
    assert send(client, "post", path, {**body, "amount": "1"}).status_code == 409


def test_cancelled_handoff_creates_no_payment_or_payment_activity(client, group):
    _, attempt, _ = prepared_guarded(client, group)
    assert send(client, "post", f"/groups/{group[0]}/payment-attempts/{attempt['id']}/cancel", {"command_id": uid()}).status_code == 200
    assert not Settlement.objects.exists()
    assert not [item for item in send(client, "get", "/activity").json()["items"] if item["kind"].startswith("payment_")]


@pytest.mark.parametrize("field,value,status", [("expected_group_version", None, 409), ("expected_group_version", "1", 422), ("attempt_id", None, 422)])
def test_guarded_return_requires_exact_attempt_and_strict_version(client, group, field, value, status):
    _, _, body = prepared_guarded(client, group)
    body[field] = value
    assert send(client, "post", f"/groups/{group[0]}/settlements", body).status_code == status
    assert not Settlement.objects.exists() and not CommandReceipt.objects.filter(command_id=body["command_id"]).exists()


def test_guarded_return_waits_for_group_change_and_rejects_after_lock(client, group):
    _, _, body = prepared_guarded(client, group)
    waiting = Event()
    def record():
        close_old_connections()
        def observe(execute, sql, params, many, context):
            if '"ledger_group"' in sql and "FOR UPDATE" in sql:
                waiting.set()
            return execute(sql, params, many, context)
        try:
            with connection.execute_wrapper(observe):
                return send(Client(**client.defaults), "post", f"/groups/{group[0]}/settlements", body).status_code
        finally:
            connections.close_all()
    with ThreadPoolExecutor(max_workers=1) as pool:
        with transaction.atomic():
            Group.objects.select_for_update().get(pk=group[0])
            future = pool.submit(record)
            assert waiting.wait(5)
            with pytest.raises(TimeoutError):
                future.result(timeout=0.2)
            assert send(client, "post", f"/groups/{group[0]}/expenses", expense(group[1])).status_code == 200
        assert future.result(timeout=5) == 409
    assert not Settlement.objects.exists() and not CommandReceipt.objects.filter(command_id=body["command_id"]).exists()


def test_same_date_bills_use_addition_order_and_edits_do_not_reorder_them(client, group):
    food = expense(group[1])
    food.update(id='ffffffff-ffff-4fff-8fff-ffffffffffff', description='Food', date='2026-10-28')
    shared = expense(group[1])
    shared.update(id='00000000-0000-4000-8000-000000000001', description='Shared expense', date='2026-10-28')
    assert send(client, 'post', f'/groups/{group[0]}/expenses', food).status_code == 200
    assert send(client, 'post', f'/groups/{group[0]}/expenses', shared).status_code == 200
    first = page(client, group[0], limit=1).json()
    assert first['items'][0]['bill']['description'] == 'Shared expense'
    second = page(client, group[0], limit=1, cursor=first['next_cursor']).json()
    assert second['items'][0]['bill']['description'] == 'Food'
    edited = {**food, 'command_id': uid(), 'version': 1, 'description': 'Edited food'}
    assert send(client, 'put', f'/groups/{group[0]}/expenses/{food["id"]}', edited).status_code == 200
    assert page(client, group[0], limit=1).json()['items'][0]['bill']['description'] == 'Shared expense'
    complete = send(client, 'get', f'/groups/{group[0]}').json()
    assert [bill['description'] for bill in reversed(complete['expenses'])] == ['Shared expense', 'Edited food']


def test_same_day_bill_and_payment_order_uses_addition_time_before_kind_or_uuid(client, group):
    bills, payments = populate(group, count=2)
    stamp = timezone.now()
    for row, minutes in [(bills[1], 0), (payments[1], 1), (bills[0], 2), (payments[0], 3)]:
        type(row).objects.filter(pk=row.pk).update(date=date(2026, 10, 28), created_at=stamp + timedelta(minutes=minutes))
    found, cursor = [], None
    while True:
        result = page(client, group[0], limit=1, **({"cursor": cursor} if cursor else {})).json()
        found.extend((item['kind'], item[item['kind']]['id']) for item in result['items'])
        cursor = result['next_cursor']
        if not cursor:
            break
    assert found == [('payment', str(payments[0].id)), ('bill', str(bills[0].id)), ('payment', str(payments[1].id)), ('bill', str(bills[1].id))]


def test_addition_backfill_uses_first_audit_and_invalidates_old_caches(client, group):
    import importlib

    from django.apps import apps

    first = expense(group[1])
    assert send(client, 'post', f'/groups/{group[0]}/expenses', first).status_code == 200
    saved = Change.objects.get(group_id=group[0], kind='expense_saved', data__id=first['id'])
    original = timezone.now() - timedelta(days=2)
    Change.objects.filter(pk=saved.pk).update(created_at=original)
    current = Group.objects.get(pk=group[0])
    Change.objects.create(group=current, sequence=current.version + 1, kind='expense_saved', data={'id': first['id']})
    current.version += 1
    current.save(update_fields=['version'])
    imported = Expense.objects.create(group=current, description='Legacy bill', total=100, paid={}, shares={}, split={}, date=date(2026, 1, 2))
    migration = importlib.import_module('ledger.migrations.0033_bill_addition_order')
    with connection.schema_editor() as editor:
        migration.restore_addition_order(apps, editor)
    assert Expense.objects.get(pk=first['id']).created_at == original
    assert Expense.objects.get(pk=imported.pk).created_at.isoformat() == '2026-01-02T00:00:00+00:00'
    current.refresh_from_db()
    assert current.version == saved.sequence + 2
    assert Change.objects.filter(group=current, sequence=current.version, kind='history_order_updated').exists()


def test_creation_timestamp_is_read_only_even_when_echoed_on_create_and_edit(client, group):
    body = expense(group[1]) | {'created_at': '2099-01-01T00:00:00+00:00'}
    assert send(client, 'post', f'/groups/{group[0]}/expenses', body).status_code == 200
    record = Expense.objects.get(pk=body['id'])
    assert record.created_at.year != 2099
    body.update(command_id=uid(), version=1, created_at='2000-01-01T00:00:00+00:00')
    assert send(client, 'put', f'/groups/{group[0]}/expenses/{body["id"]}', body).status_code == 200
    assert Expense.objects.get(pk=body['id']).created_at == record.created_at
