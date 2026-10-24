import base64
import csv
import io
import json
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from decimal import Decimal
from urllib.error import HTTPError, URLError
from uuid import uuid4

import pytest
from allauth.account.models import EmailAddress
from django.contrib.auth import get_user_model
from django.db import close_old_connections, connection, connections, transaction
from django.utils import timezone

from . import balance_statements as statements
from . import email_delivery, statement_csv
from .models import (
    BalanceStatement,
    CloudflareEmailDispatch,
    Expense,
    Group,
    NotificationPreference,
    OpeningBalance,
    Participant,
    Settlement,
)
from .test_api import client as client
from .test_api import expense, send, uid
from .test_api import group as group
from .test_cloudflare_email_delivery import Response
from .test_cloudflare_email_delivery import cloudflare as cloudflare
from .test_collaboration import account

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture(autouse=True)
def verified(client):
    client.actor.email = "statement-recipient@example.test"
    client.actor.save(update_fields=["email"])
    EmailAddress.objects.create(user=client.actor, email=client.actor.email, verified=True, primary=True)


def config(client, enabled=True, frequency="monthly"):
    return send(client, "put", "/me/balance-statements/preferences", {"enabled": enabled, "frequency": frequency})


def channels(client, master=True, email=True):
    return send(client, "put", "/me/notifications/preferences", {"expense_updates": master, "email_reminders": email})


def manual(client, command=None):
    result = send(client, "post", "/me/balance-statements/send", {"command_id": str(command or uuid4())})
    assert result.status_code == 200, result.content
    return BalanceStatement.objects.get(pk=result.json()["id"])


def provider(monkeypatch, client):
    calls = []
    def http(request, timeout):
        assert not connection.in_atomic_block
        body = json.loads(request.data)
        assert CloudflareEmailDispatch.objects.get(pk=body["headers"]["X-MeroSplit-Delivery-ID"]).state == "sending"
        assert body["to"] == [client.actor.email]
        assert body["attachments"][0]["disposition"] == "attachment"
        assert body["attachments"][0]["type"] == "text/csv; charset=utf-8"
        calls.append(request.data)
        return Response({"success": True, "errors": [], "result": {"message_id": "synthetic-statement", "queued": [client.actor.email]}})
    monkeypatch.setattr(email_delivery, "urlopen", http)
    return calls


@pytest.mark.parametrize("frequency,now,expected", [
    ("monthly", "2026-12-31T23:59:59+00:00", "2027-01-01T00:00:00+00:00"),
    ("monthly", "2028-02-01T00:00:00+00:00", "2028-03-01T00:00:00+00:00"),
    ("weekly", "2026-10-19T00:00:00+00:00", "2026-10-26T00:00:00+00:00"),
    ("weekly", "2026-10-25T23:59:59+00:00", "2026-10-26T00:00:00+00:00"),
])
def test_future_utc_boundaries(frequency, now, expected):
    assert statements.next_boundary(frequency, datetime.fromisoformat(now)).isoformat() == expected


def test_default_off_legacy_two_fields_preserve_consent_and_resume_without_backlog(client):
    assert send(client, "get", "/me/balance-statements/preferences").json() == {"enabled": False, "frequency": "monthly", "next_at": None, "delivery": None}
    assert config(client).json()["next_at"] is None
    assert channels(client).status_code == 200
    pref = NotificationPreference.objects.get(user=client.actor)
    assert pref.balance_statements and pref.statement_next_at > timezone.now()
    pending = BalanceStatement.objects.create(user=client.actor, period_key="monthly:old", due_at=timezone.now())
    assert channels(client, master=False).json() == {"expense_updates": False, "email_reminders": True}
    pending.refresh_from_db()
    assert pending.state == "cancelled" and not pending.payload
    assert config(client, frequency="weekly").json()["next_at"] is None
    channels(client)
    pref.refresh_from_db()
    assert pref.balance_statements and pref.statement_frequency == "weekly"
    assert pref.statement_next_at == statements.next_boundary("weekly", timezone.now())
    assert statements.enqueue_due(10) is None
    assert BalanceStatement.objects.count() == 1


def test_manual_self_only_idempotent_rate_limited_and_never_subscribes(client):
    command = uuid4()
    first = manual(client, command)
    assert manual(client, command).id == first.id
    assert not NotificationPreference.objects.get(user=client.actor).balance_statements
    assert send(client, "post", "/me/balance-statements/send", {"command_id": uid()}).status_code == 429
    for extra in [{"recipient": "other@example.test"}, {"user_id": 123}, {"group_id": uid()}]:
        assert send(client, "post", "/me/balance-statements/send", {"command_id": uid(), **extra}).status_code == 422
    other = account()
    assert send(other, "get", f"/me/balance-statements/{first.id}").status_code == 404
    assert config(client, enabled="true").status_code == 422
    assert config(client, frequency="daily").status_code == 422


def test_manual_parallel_replay_is_one_job(client):
    command = uuid4()
    def run():
        close_old_connections()
        try:
            actor = get_user_model().objects.get(pk=client.actor.pk)
            return statements.request_statement(actor, command)["id"]
        finally:
            connections.close_all()
    with ThreadPoolExecutor(max_workers=2) as pool:
        ids = list(pool.map(lambda _: run(), range(2)))
    assert ids[0] == ids[1]
    assert BalanceStatement.objects.count() == 1


def test_financial_csv_all_records_exact_balances_reversals_bom_and_no_private_content(client, group, monkeypatch):
    group_id, people, _ = group
    Group.objects.filter(pk=group_id).update(name="=unsafe group")
    Participant.objects.filter(pk=people[1]).update(name=" +unsafe name", contact_email="excluded-contact@example.test")
    bill = expense(people, total="10001")
    bill.update(description="@unsafe bill", notes="excluded private notes")
    assert send(client, "post", f"/groups/{group_id}/expenses", bill).status_code == 200
    reverse = expense(people, total="31")
    assert send(client, "post", f"/groups/{group_id}/expenses", reverse).status_code == 200
    Expense.objects.filter(pk=reverse["id"]).update(deleted=True)
    Settlement.objects.create(group_id=group_id, sender_id=people[1], recipient_id=people[0], amount=334)
    Settlement.objects.create(group_id=group_id, sender_id=people[1], recipient_id=people[0], amount=777, reversed=True)
    OpeningBalance.objects.create(group_id=group_id, balances={people[0]: "200", people[1]: "-200"}, source="excluded-private-source", cutoff="2026-01-01", accepted=True)
    calls = provider(monkeypatch, client)
    job = manual(client)
    version = Group.objects.get(pk=group_id).version
    statements.send_balance_statements()
    job.refresh_from_db()
    assert job.state == "accepted" and job.accepted_at and not job.payload and not job.recipient_email
    assert Group.objects.get(pk=group_id).version == version
    body = json.loads(calls[0])
    data = base64.b64decode(body["attachments"][0]["content"])
    assert data.startswith(b"\xef\xbb\xbf")
    text = data.decode("utf-8-sig")
    assert "'=unsafe group" in text and "' +unsafe name" in text and "'@unsafe bill" in text
    for private in ["excluded", client.actor.email, "contact_email", "chat", "invite", "upi", "local_uri"]:
        assert private not in text
    rows = list(csv.DictReader(io.StringIO(text)))
    reversed_rows = [row for row in rows if row["status"] == "reversed"]
    assert {Decimal(row["original_amount_inr"]) for row in reversed_rows} == {Decimal("0.31"), Decimal("7.77")}
    assert all(row["net_inr"] == "0.00" for row in reversed_rows)
    balances = {row["participant_id"]: int(Decimal(row["current_balance_inr"]) * 100) for row in rows if row["record_type"] == "balance"}
    shares = Expense.objects.get(pk=bill["id"]).shares
    assert sorted(map(int, shares.values())) == [3333, 3334, 3334]
    assert balances == {people[0]: 10001 - int(shares[people[0]]) - 334 + 200, people[1]: -int(shares[people[1]]) + 334 - 200, people[2]: -int(shares[people[2]])}
    assert sum(balances.values()) == 0
    assert all(re.fullmatch(r"-?\d+\.\d{2}", value) for row in rows for key, value in row.items() if key.endswith("_inr") and value)
    statements.send_balance_statements()
    assert len(calls) == 1


@pytest.mark.parametrize("change", ["membership", "email", "verification", "inactive"])
def test_dispatch_revalidates_current_account_and_group_scope(client, group, monkeypatch, change):
    calls = provider(monkeypatch, client)
    job = manual(client)
    if change == "membership":
        prepared = statements._prepare(job.id)
        Participant.objects.filter(group_id=group[0], user=client.actor).update(removed=True)
        BalanceStatement.objects.filter(pk=job.id).update(lease_until=timezone.now() - timedelta(seconds=1))
        assert prepared.payload
    elif change == "email":
        client.actor.email = "changed@example.test"
        client.actor.save(update_fields=["email"])
    elif change == "verification":
        EmailAddress.objects.filter(user=client.actor).update(verified=False)
    else:
        get_user_model().objects.filter(pk=client.actor.pk).update(is_active=False)
    statements.send_balance_statements()
    job.refresh_from_db()
    assert job.state == "cancelled" and not job.payload and not calls


def test_due_schedule_once_and_worker_restarts_are_safe(client, monkeypatch):
    channels(client)
    config(client)
    due = timezone.now() - timedelta(seconds=1)
    NotificationPreference.objects.filter(user=client.actor).update(statement_next_at=due)
    calls = provider(monkeypatch, client)
    statements.send_balance_statements()
    NotificationPreference.objects.filter(user=client.actor).update(statement_next_at=due)  # Replay the same calendar period.
    statements.send_balance_statements()
    assert len(calls) == BalanceStatement.objects.count() == 1
    assert NotificationPreference.objects.get(user=client.actor).statement_next_at > timezone.now()


def test_unknown_transport_is_held_never_resent(client, monkeypatch):
    calls = []
    def timeout(request, **kwargs):
        calls.append(request.data)
        raise URLError("synthetic timeout")
    monkeypatch.setattr(email_delivery, "urlopen", timeout)
    job = manual(client)
    statements.send_balance_statements()
    statements.send_balance_statements()
    job.refresh_from_db()
    assert job.state == "held" and job.last_error == "delivery_unknown"
    assert not job.payload and len(calls) == 1


def test_proven_preaccept_rejection_retries_identical_bytes_and_key(client, monkeypatch):
    calls = provider(monkeypatch, client)
    accepting = email_delivery.urlopen
    rejected = []
    def reject(request, **kwargs):
        rejected.append(request.data)
        data = {"success": False, "result": None, "errors": [{"code": 10004, "message": "synthetic rate limit"}]}
        raise HTTPError(request.full_url, 429, "", {}, io.BytesIO(json.dumps(data).encode()))
    monkeypatch.setattr(email_delivery, "urlopen", reject)
    job = manual(client)
    statements.send_balance_statements()
    job.refresh_from_db()
    assert job.state == "pending" and job.payload
    BalanceStatement.objects.filter(pk=job.id).update(due_at=timezone.now())
    monkeypatch.setattr(email_delivery, "urlopen", accepting)
    statements.send_balance_statements()
    assert calls == rejected
    job.refresh_from_db()
    assert job.state == "accepted"


def test_accepted_receipt_reconciles_after_local_failure_and_consent_cancellation(client, monkeypatch):
    calls = provider(monkeypatch, client)
    job = manual(client)
    finish = statements._finish
    def fail(row, state, *args, **kwargs):
        if state == "accepted":
            raise RuntimeError("synthetic DB/process failure")
        return finish(row, state, *args, **kwargs)
    monkeypatch.setattr(statements, "_finish", fail)
    with pytest.raises(RuntimeError):
        statements.send_balance_statements()
    BalanceStatement.objects.filter(pk=job.id).update(lease_until=timezone.now() - timedelta(seconds=1), cancelled_at=timezone.now())
    monkeypatch.setattr(statements, "_finish", finish)
    statements.send_balance_statements()
    job.refresh_from_db()
    assert job.state == "accepted" and job.provider_id == "synthetic-statement" and len(calls) == 1


@pytest.mark.parametrize("budget", ["csv", "wire"])
def test_oversize_is_terminal_without_truncation_or_provider_post(client, group, monkeypatch, budget):
    calls = provider(monkeypatch, client)
    monkeypatch.setattr(statement_csv if budget == "csv" else statements, "MAX_CSV_BYTES" if budget == "csv" else "MAX_WIRE_BYTES", 100)
    job = manual(client)
    statements.send_balance_statements()
    job.refresh_from_db()
    assert job.state == "failed" and job.last_error == "too_big" and not job.payload and not calls


def test_account_deletion_removes_pending_content_but_keeps_content_free_provider_fence(client, monkeypatch):
    provider(monkeypatch, client)
    job = manual(client)
    statements.send_balance_statements()
    user_id = client.actor.pk
    assert send(client, "delete", "/account").status_code == 200
    assert not BalanceStatement.objects.filter(user_id=user_id).exists()
    assert CloudflareEmailDispatch.objects.filter(pk=f"balance-statement:{job.id}", state="accepted").exists()


@pytest.mark.parametrize("fence_state", ["sending", "held"])
def test_expired_unknown_fence_is_held_without_second_post(client, monkeypatch, fence_state):
    calls = provider(monkeypatch, client)
    job = manual(client)
    statements._prepare(job.id)
    CloudflareEmailDispatch.objects.create(delivery_id=f"balance-statement:{job.id}", account_id="a" * 32,
                                          payload_hash="synthetic", state=fence_state)
    BalanceStatement.objects.filter(pk=job.id).update(lease_until=timezone.now() - timedelta(seconds=1))
    statements.send_balance_statements()
    job.refresh_from_db()
    assert job.state == "held" and job.last_error == "delivery_unknown" and not calls


def test_parallel_workers_send_one_post_and_manual_survives_schedule_optout(client, monkeypatch):
    calls = provider(monkeypatch, client)
    job = manual(client)
    channels(client, master=False, email=False)
    def run():
        close_old_connections()
        try:
            statements.send_balance_statements()
        finally:
            connections.close_all()
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(lambda _: run(), range(2)))
    job.refresh_from_db()
    assert job.state == "accepted" and len(calls) == 1
    assert not NotificationPreference.objects.get(user=client.actor).balance_statements


@pytest.mark.parametrize("change", ["financial_revision", "verified_email"])
def test_changed_frozen_scope_cancels_instead_of_minting_new_payload(client, group, monkeypatch, change):
    calls = provider(monkeypatch, client)
    job = manual(client)
    statements._prepare(job.id)
    if change == "financial_revision":
        Group.objects.filter(pk=group[0]).update(version=999)
    else:
        client.actor.email = "new-verified@example.test"
        client.actor.save(update_fields=["email"])
        EmailAddress.objects.create(user=client.actor, email=client.actor.email, verified=True)
    BalanceStatement.objects.filter(pk=job.id).update(lease_until=timezone.now() - timedelta(seconds=1))
    statements.send_balance_statements()
    job.refresh_from_db()
    assert job.state == "cancelled" and job.last_error == "scope_changed" and not calls


def test_daily_limit_and_same_command_replay_do_not_increment_quota(client, monkeypatch):
    clock = [datetime(2026, 10, 19, 1, tzinfo=timezone.get_current_timezone())]
    monkeypatch.setattr(timezone, "now", lambda: clock[0])
    for _ in range(5):
        command = uuid4()
        assert manual(client, command).id == manual(client, command).id
        clock[0] += timedelta(minutes=11)
    assert send(client, "post", "/me/balance-statements/send", {"command_id": uid()}).status_code == 429
    assert BalanceStatement.objects.count() == 5


def test_scope_recheck_never_includes_a_new_group_without_its_lock(client, group, monkeypatch):
    visible = statements._visible_groups
    calls = []
    def scope(actor):
        calls.append(True)
        if len(calls) == 2:
            added = Group.objects.create(owner=actor, name="Newly joined")
            Participant.objects.create(group=added, name="Self", user=actor)
        return visible(actor)
    monkeypatch.setattr(statements, "_visible_groups", scope)
    with transaction.atomic():
        locked, _ = statements._scope(client.actor, client.actor.email)
    assert [str(row.id) for row in locked] == [group[0]]
    assert visible(client.actor).count() == 2


def test_explicit_statement_consent_preserves_an_unrelated_bill_mailbox_optout(client, monkeypatch):
    from .bill_email import mailbox_digest
    from .expense_notifications import verified_recipient
    from .models import BillEmailPreference
    suppression = BillEmailPreference.objects.create(email_digest=mailbox_digest(client.actor.email), suppressed=True)
    assert verified_recipient(client.actor) is None
    calls = provider(monkeypatch, client)
    job = manual(client)
    statements.send_balance_statements()
    statements.send_balance_statements()
    job.refresh_from_db()
    assert job.state == "accepted" and len(calls) == 1
    assert config(client).json()["next_at"] is None  # Scheduling still requires Email ON.
    statements.send_balance_statements()
    assert len(calls) == 1
    channels(client)
    pref = NotificationPreference.objects.get(user=client.actor)
    assert pref.balance_statements and pref.statement_next_at > timezone.now()
    NotificationPreference.objects.filter(user=client.actor).update(statement_next_at=timezone.now())
    statements.send_balance_statements()
    assert len(calls) == 2
    channels(client, master=False)
    pref.refresh_from_db()
    assert pref.balance_statements and pref.statement_next_at is None
    suppression.refresh_from_db()
    assert suppression.suppressed and verified_recipient(client.actor) is None


def test_unverified_statement_error_is_actionable_and_never_posts(client, monkeypatch):
    calls = provider(monkeypatch, client)
    EmailAddress.objects.filter(user=client.actor).update(verified=False)
    for response in [send(client, "post", "/me/balance-statements/send", {"command_id": uid()}), config(client)]:
        assert response.status_code == 409
        assert "signing in with its email code" in response.json()["detail"]
    assert not calls and not BalanceStatement.objects.exists()
