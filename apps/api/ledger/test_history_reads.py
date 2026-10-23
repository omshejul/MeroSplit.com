import json
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from threading import Event
from time import monotonic, sleep
from urllib.parse import urlencode
from uuid import UUID, uuid4

import pytest
from django.contrib.auth import get_user_model
from django.core import signing
from django.core.serializers.json import DjangoJSONEncoder
from django.db import close_old_connections, connection, connections, transaction
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from ninja.errors import HttpError

from .collaboration import remove_participant
from .history_reads import CURSOR_SALT, account_activity, group_summary, history_page
from .models import (
    Change,
    Expense,
    Group,
    Invite,
    OpeningBalance,
    Participant,
    PaymentAttempt,
    PaymentProfile,
    Settlement,
)
from .services import snapshot
from .test_api import authenticated_client, expense, send, uid
from .test_api import client as client
from .test_api import group as group

pytestmark = pytest.mark.django_db


def populate(group_id, ids, *, count=125, payments=125, attempts=125):
    group = Group.objects.get(pk=group_id)
    long_note = "Synthetic note only " + "x" * 1800
    bills = [Expense(id=UUID(int=i + 1), group=group, description=f"Bill {i:05}", total=10000,
                     paid={ids[0]: "10000"}, shares={ids[0]: "3334", ids[1]: "3333", ids[2]: "3333"},
                     split={"mode": "equal", "values": {person: "1" for person in ids}},
                     date=date(2020, 1, 1) + timedelta(days=i % 730), notes=long_note, deleted=i % 7 == 0)
             for i in range(count)]
    Expense.objects.bulk_create(bills, batch_size=500)
    Change.objects.bulk_create([Change(group=group, sequence=i + 2, kind="expense_saved", data={
        "id": str(bill.id), "description": bill.description, "notes": long_note, "paid": bill.paid,
        "shares": bill.shares, "split": bill.split,
    }) for i, bill in enumerate(bills)], batch_size=500)
    Settlement.objects.bulk_create([Settlement(group=group, sender_id=ids[1], recipient_id=ids[0], amount=25,
                                               reversed=i % 9 == 0, date=None if i % 3 == 0 else date(2021, 1, 1))
                                    for i in range(payments)], batch_size=500)
    PaymentAttempt.objects.bulk_create([PaymentAttempt(group=group, sender_id=ids[0], recipient_id=ids[1],
        amount=500, payee="synthetic@bank", payee_version=1, group_version=1,
        expires_at=timezone.now() - timedelta(days=1), state="recorded") for _ in range(attempts)], batch_size=500)
    group.version = count + 1
    group.save(update_fields=["version"])
    return group, bills


def get_page(client, group_id, resource, **query):
    return send(client, "get", f"/groups/{group_id}/history/{resource}?{urlencode(query)}")


def test_summary_finance_is_complete_while_history_and_actionable_state_are_bounded(client, group, monkeypatch):
    group_id, ids, _ = group
    current, bills = populate(group_id, ids)
    OpeningBalance.objects.create(group=current, balances={ids[0]: "100", ids[1]: "-100", ids[2]: "0"},
                                  source="Synthetic prior ledger", cutoff=date(2019, 12, 31), accepted=True)
    PaymentProfile.objects.create(user=client.actor, vpa="synthetic@bank")
    Participant.objects.filter(pk=ids[2]).update(contact_email="synthetic@example.invalid")
    Invite.objects.bulk_create([Invite(participant_id=ids[2], token_hash=uuid4().hex, expires_at=timezone.now() + timedelta(days=1, seconds=i)) for i in range(350)])
    complete = snapshot(current)
    monkeypatch.setattr("ledger.services.snapshot", lambda *args: pytest.fail("Summary must not build the full snapshot"))
    response = send(client, "get", f"/groups/{group_id}/summary")
    assert response.status_code == 200, response.content
    summary = response.json()
    assert summary["read_mode"] == "summary"
    for key in ("balances", "transfers", "totals", "opening_balance"):
        assert summary[key] == complete[key]
    for key in ("expenses", "settlements", "activity", "payment_attempts"):
        assert len(summary[key]) == 50
    assert set(summary["history"]) == {"bills", "activity", "settlements", "attempts", "transactions"}
    assert len(summary["transactions"]) == 50
    assert all(value["next_cursor"] for value in summary["history"].values())
    assert len(summary["invites"]) == 1
    assert summary["invites"][0]["id"] == str(Invite.objects.order_by("-expires_at").first().id)
    assert next(person for person in summary["participants"] if person["id"] == ids[2])["email"] == "synthetic@example.invalid"
    assert next(person for person in summary["participants"] if person["id"] == ids[0])["payment_profile"]["vpa"] == "synthetic@bank"
    assert summary["expenses"][0]["notes"] == bills[0].notes
    assert all(set(item["data"]) <= {"id", "description"} for item in summary["activity"])
    member = get_user_model().objects.create_user(username=uid(), email="member@example.invalid")
    Participant.objects.filter(pk=ids[1]).update(user=member)
    member_summary = group_summary(member, group_id)
    assert member_summary["invites"] == []
    assert all("email" not in person for person in member_summary["participants"])


def test_keyset_pages_have_no_duplicates_or_omissions_with_ties_and_keep_deleted_records(client, group):
    group_id, ids, _ = group
    current, _ = populate(group_id, ids)
    for resource, expected in [("bills", 125), ("settlements", 125), ("activity", 126), ("attempts", 125)]:
        values, cursor = [], None
        while True:
            page = get_page(client, group_id, resource, limit=17, **({"cursor": cursor} if cursor else {}))
            assert page.status_code == 200, page.content
            data = page.json()
            assert data["read_mode"] == "page" and data["version"] == current.version
            values.extend(item["sequence"] if resource == "activity" else item["id"] for item in data["items"])
            cursor = data["next_cursor"]
            if not cursor:
                break
        assert len(values) == len(set(values)) == expected
    assert any(bill["deleted"] for bill in get_page(client, group_id, "bills").json()["items"])
    assert any(payment["date"] is None for payment in get_page(client, group_id, "settlements").json()["items"])


@pytest.mark.parametrize("resource", ["bills", "settlements", "attempts"])
@pytest.mark.parametrize("position,value", [(0, None), (0, "invalid-date"), (1, None), (1, "invalid-uuid")])
def test_tuple_keyset_invalid_signed_positions_are_rejected(client, group, resource, position, value):
    group_id, ids, _ = group
    populate(group_id, ids, count=3, payments=3, attempts=3)
    cursor = get_page(client, group_id, resource, limit=2).json()["next_cursor"]
    payload = signing.loads(cursor, salt=CURSOR_SALT)
    payload["after"][position] = value
    assert get_page(client, group_id, resource, limit=2, cursor=signing.dumps(payload, salt=CURSOR_SALT)).status_code == 422


def test_filters_and_signed_cursors_are_bound_to_account_group_resource_limit_and_view(client, group):
    group_id, ids, _ = group
    current, bills = populate(group_id, ids)
    Expense.objects.filter(pk=bills[-1].pk).update(notes="A distinctive search needle")
    assert [row["id"] for row in get_page(client, group_id, "bills", q="needle").json()["items"]] == [str(bills[-1].id)]
    assert all(row["deleted"] for row in get_page(client, group_id, "bills", deleted="deleted").json()["items"])
    assert all(not row["deleted"] for row in get_page(client, group_id, "bills", deleted="active").json()["items"])
    assert all(row["reversed"] for row in get_page(client, group_id, "settlements", reversed="reversed").json()["items"])
    assert get_page(client, group_id, "activity", kind="does_not_exist").json()["items"] == []
    cursor = get_page(client, group_id, "bills", limit=5).json()["next_cursor"]
    for resource, params in [("bills", {"limit": 6}), ("bills", {"limit": 5, "q": "needle"}),
                             ("bills", {"limit": 5, "deleted": "active"}), ("settlements", {"limit": 5})]:
        assert get_page(client, group_id, resource, cursor=cursor, **params).status_code == 422
    assert get_page(client, group_id, "bills", cursor=cursor + "tampered", limit=5).status_code == 422
    other = Group.objects.create(owner=client.actor, name="Other synthetic group")
    Participant.objects.create(group=other, name="Owner", user=client.actor)
    assert get_page(client, other.id, "bills", cursor=cursor, limit=5).status_code == 422
    member = get_user_model().objects.create_user(username=uid())
    Participant.objects.filter(pk=ids[1]).update(user=member)
    with pytest.raises(HttpError) as error:
        history_page(member, group_id, "bills", cursor=cursor, limit=5)
    assert error.value.status_code == 422
    for query in ({"limit": 0}, {"limit": 101}, {"deleted": "wrong"}, {"q": "x" * 201}):
        assert get_page(client, group_id, "bills", **query).status_code == 422
    assert len(get_page(client, group_id, "bills", limit=100).json()["items"]) == 100
    assert get_page(client, group_id, "unknown").status_code == 404


def test_version_change_restarts_pages_and_detail_instead_of_mixing_revisions(client, group):
    group_id, ids, _ = group
    current, bills = populate(group_id, ids)
    first = get_page(client, group_id, "bills").json()
    edited = expense(ids)
    edited.update(id=str(bills[0].id), version=1, date="2030-01-01")
    assert send(client, "put", f"/groups/{group_id}/expenses/{bills[0].id}", edited).status_code == 409  # Deleted bills require restore.
    edited.update(id=str(bills[1].id))
    assert send(client, "put", f"/groups/{group_id}/expenses/{bills[1].id}", edited).status_code == 200
    assert get_page(client, group_id, "bills", cursor=first["next_cursor"]).status_code == 409
    assert get_page(client, group_id, "activity", version=current.version).status_code == 409
    assert send(client, "get", f"/groups/{group_id}/expenses/{bills[1].id}?version={current.version}").status_code == 409
    fresh = send(client, "get", f"/groups/{group_id}/summary").json()
    assert fresh["expenses"][0]["id"] == str(bills[1].id)


def test_full_detail_is_group_scoped_including_deleted_restore_records_and_revoked_access(client, group):
    group_id, ids, _ = group
    current, bills = populate(group_id, ids)
    detail = send(client, "get", f"/groups/{group_id}/expenses/{bills[0].id}?version={current.version}")
    assert detail.status_code == 200
    assert detail.json()["deleted"] and detail.json()["notes"] == bills[0].notes
    assert detail.json()["read_mode"] == "detail" and detail.json()["group_version"] == current.version
    member = get_user_model().objects.create_user(username=uid())
    viewer = authenticated_client(member)
    assert send(viewer, "get", f"/groups/{group_id}/summary").status_code == 404
    Participant.objects.filter(pk=ids[1]).update(user=member)
    assert send(viewer, "get", f"/groups/{group_id}/expenses/{bills[0].id}").status_code == 200
    cursor = get_page(viewer, group_id, "bills").json()["next_cursor"]
    Participant.objects.filter(pk=ids[1]).update(removed=True)
    for path in ("/summary", f"/history/bills?{urlencode({'cursor': cursor})}", f"/expenses/{bills[0].id}"):
        assert send(viewer, "get", f"/groups/{group_id}{path}").status_code == 404
    assert send(client, "get", f"/groups/{uid()}/expenses/{bills[0].id}").status_code == 404
    assert send(client, "get", f"/groups/{group_id}/expenses/{uid()}").status_code == 404


def test_active_pair_lookup_finds_expired_quote_beyond_first_page_without_loading_all_attempts(client, group):
    group_id, ids, _ = group
    current, _ = populate(group_id, ids)
    old = PaymentAttempt.objects.create(group=current, sender_id=ids[0], recipient_id=ids[1], amount=600,
        payee="synthetic@bank", payee_version=1, group_version=current.version,
        expires_at=timezone.now() - timedelta(days=2), state="prepared")
    PaymentAttempt.objects.filter(pk=old.pk).update(created_at=timezone.now() - timedelta(days=3))
    page = get_page(client, group_id, "attempts", sender=ids[0], recipient=ids[1], state="active")
    assert page.status_code == 200 and [row["id"] for row in page.json()["items"]] == [str(old.id)]
    assert page.json()["next_cursor"] is None
    assert str(old.id) not in [row["id"] for row in group_summary(client.actor, group_id)["payment_attempts"]]
    assert get_page(client, group_id, "attempts", sender=ids[1], recipient=ids[0], state="active").json()["items"] == []


def test_ten_thousand_record_summary_has_bounded_bytes_queries_and_indexed_pages(client, group, capsys):
    group_id, ids, _ = group
    current, _ = populate(group_id, ids, count=10000, payments=10000, attempts=10000)
    # Planner assertions need this large fixture, not stale statistics left by
    # earlier rolled-back small fixtures. Keep the index/discard limits intact.
    with connection.cursor() as cursor:
        cursor.execute("ANALYZE ledger_change, ledger_group, ledger_participant")
    started = monotonic()
    with CaptureQueriesContext(connection) as queries:
        summary = group_summary(client.actor, group_id)
    duration = monotonic() - started
    encoded = json.dumps(summary, cls=DjangoJSONEncoder).encode()
    assert len(encoded) < 250_000
    assert len(queries) <= 18
    assert not any("COUNT(" in query["sql"].upper() for query in queries)
    assert not any('"ledger_change"."data",' in query["sql"] for query in queries)
    assert all(len(summary[key]) == 50 for key in ("expenses", "activity", "settlements", "payment_attempts"))
    complete_bytes = len(json.dumps(snapshot(current), cls=DjangoJSONEncoder).encode())
    assert complete_bytes > len(encoded) * 100
    plans = {}
    for name, query, index in [
        ("bills", current.expenses.order_by("-date", "-id")[:51], "bill_history_keyset"),
        ("settlements", current.settlements.order_by("-created_at", "-id")[:51], "payment_history_keyset"),
        ("attempts", current.attempts.order_by("-created_at", "-id")[:51], "attempt_history_keyset"),
        ("activity", current.changes.order_by("-sequence")[:51], "group_change_sequence"),
    ]:
        plan = query.explain(analyze=True, buffers=True, format="json")
        assert index in plan, plan
        plans[name] = json.loads(plan)[0]["Execution Time"]
    # A late keyset page must not scan/discard all preceding bill rows.
    position = current.expenses.order_by("-date", "-id").values_list("date", "id")[9900]
    payload = signing.loads(summary["history"]["bills"]["next_cursor"], salt=CURSOR_SALT)
    payload["after"] = [position[0].isoformat(), str(position[1])]
    with CaptureQueriesContext(connection) as late_queries:
        late = history_page(client.actor, group_id, "bills", cursor=signing.dumps(payload, salt=CURSOR_SALT))
    assert len(late["items"]) == 50
    sql = next(query["sql"] for query in late_queries if '"ledger_expense"' in query["sql"] and "LIMIT 51" in query["sql"])
    with connection.cursor() as cursor:
        cursor.execute("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + sql)
        late_plan = cursor.fetchone()[0][0]["Plan"]

    def discarded(plan):
        return plan.get("Rows Removed by Filter", 0) + sum(discarded(child) for child in plan.get("Plans", []))

    assert discarded(late_plan) <= 100, late_plan
    # The mixed timeline bounds each canonical branch before globally ordering
    # candidates. Deep dated and unknown-date pages both reach their own index.
    transaction_plans = {}
    transaction_cursor = signing.loads(summary["history"]["transactions"]["next_cursor"], salt=CURSOR_SALT)
    for name, query, index, position in [
        ("dated", current.settlements.filter(date__isnull=False).order_by("-date", "-id"), "payment_transaction_date", 6500),
        ("unknown", current.settlements.filter(date__isnull=True).order_by("-id"), "payment_unknown_date", 3200),
    ]:
        payment = query[position]
        transaction_cursor["after"] = [int(payment.date is not None), payment.date.isoformat() if payment.date else None, 1, str(payment.id)]
        with CaptureQueriesContext(connection) as transaction_queries:
            result = history_page(client.actor, group_id, "transactions", cursor=signing.dumps(transaction_cursor, salt=CURSOR_SALT))
        assert len(result["items"]) == 50 and len(json.dumps(result).encode()) < 40_000
        assert len(transaction_queries) <= 9
        if name == "unknown":
            assert all(item["kind"] == "payment" and item["date"] is None for item in result["items"])
        sql = next(item["sql"] for item in transaction_queries if '"ledger_settlement"' in item["sql"] and "LIMIT 51" in item["sql"])
        with connection.cursor() as cursor:
            cursor.execute("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + sql)
            plan = cursor.fetchone()[0][0]
        assert index in json.dumps(plan), plan
        assert discarded(plan["Plan"]) <= 100, plan
        transaction_plans[name] = plan["Execution Time"]
    with CaptureQueriesContext(connection) as activity_queries:
        activity = account_activity(client.actor)
    assert len(activity["items"]) == 50 and len(json.dumps(activity).encode()) < 25_000
    assert len(activity_queries) <= 9
    activity_position = current.changes.order_by("-created_at", "-id")[9900]
    activity_cursor = signing.loads(activity["next_cursor"], salt=CURSOR_SALT)
    activity_cursor["after"] = [activity_position.created_at.isoformat(), activity_position.id]
    with CaptureQueriesContext(connection) as activity_queries:
        late_activity = account_activity(client.actor, cursor=signing.dumps(activity_cursor, salt=CURSOR_SALT))
    assert len(late_activity["items"]) == 50
    sql = next(item["sql"] for item in activity_queries if '"ledger_change"' in item["sql"] and "LIMIT 51" in item["sql"])
    with connection.cursor() as cursor:
        cursor.execute("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + sql)
        activity_plan = cursor.fetchone()[0][0]
    assert "human_activity_order" in json.dumps(activity_plan), activity_plan
    assert discarded(activity_plan["Plan"]) <= 100, activity_plan
    with capsys.disabled():
        print(f"history benchmark: summary_bytes={len(encoded)} full_bytes={complete_bytes} queries={len(queries)} seconds={duration:.3f} page_explain_ms={plans} late_page_discarded={discarded(late_plan)}")
        print(f"transaction/activity benchmark: transaction_ms={transaction_plans} activity_bytes={len(json.dumps(activity).encode())} activity_queries={len(activity_queries)} deep_activity_ms={activity_plan['Execution Time']} discarded={discarded(activity_plan['Plan'])}")


@pytest.mark.django_db(transaction=True)
def test_waiting_summary_rechecks_membership_after_group_lock_revocation(client, group):
    group_id, ids, _ = group
    member = get_user_model().objects.create_user(username=uid())
    Participant.objects.filter(pk=ids[1]).update(user=member)
    waiting = Event()
    worker_pids = []

    def read_after_lock():
        close_old_connections()
        try:
            actor = get_user_model().objects.get(pk=member.pk)
            worker_pids.append(connections["default"].connection.info.backend_pid)
            waiting.set()
            group_summary(actor, group_id)
            return 200
        except HttpError as error:
            return error.status_code
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=1) as pool:
        with transaction.atomic():
            Group.objects.select_for_update().get(pk=group_id)
            future = pool.submit(read_after_lock)
            assert waiting.wait(5)
            deadline = monotonic() + 5
            while True:
                with connection.cursor() as cursor:
                    cursor.execute("SELECT wait_event_type FROM pg_stat_activity WHERE pid = %s", worker_pids)
                    row = cursor.fetchone()
                if row and row[0] == "Lock":
                    break
                assert monotonic() < deadline, "Summary did not wait for the group lock"
                sleep(0.01)
            remove_participant(client.actor, group_id, ids[1], {"command_id": uid()})
        assert future.result(timeout=10) == 404
