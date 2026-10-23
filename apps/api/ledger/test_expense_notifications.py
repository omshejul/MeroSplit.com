import json
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from datetime import timedelta
from threading import Event
from time import monotonic

import pytest
from allauth.account.models import EmailAddress
from django.contrib.auth import get_user_model
from django.db import close_old_connections, connection, connections, transaction
from django.test import Client
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from . import email_delivery
from . import expense_notifications as notifications
from .models import (
    Expense,
    ExpenseDigest,
    ExpenseNotice,
    ExpensePushDelivery,
    Group,
    NotificationPreference,
    Participant,
    PushDevice,
)
from .otp import _verified_user
from .push import fanout_due_notices, send_pending_bill_notifications
from .services import save_expense
from .test_api import client as client
from .test_api import expense, send, uid
from .test_api import group as group
from .test_collaboration import account
from .test_push import configured as configured
from .test_push import register

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture
def clock(monkeypatch):
    value = [timezone.now()]
    monkeypatch.setattr(timezone, "now", lambda: value[0])
    return value


@pytest.fixture
def recipient(group):
    person = account()
    get_user_model().objects.filter(pk=person.actor.pk).update(email="synthetic@example.com")
    person.actor.refresh_from_db()
    EmailAddress.objects.create(user=person.actor, email=person.actor.email, verified=True, primary=True)
    Participant.objects.filter(pk=group[1][1]).update(user=person.actor)
    return person


@pytest.fixture
def providers(monkeypatch):
    calls = {"push": [], "email": []}
    def push(device, data):
        assert not connection.in_atomic_block
        calls["push"].append(data)
        return f"synthetic-ticket-{len(calls['push'])}"
    def email(recipient, subject, text, delivery_id, **kwargs):
        assert not connection.in_atomic_block
        calls["email"].append({"recipient": recipient, "subject": subject, "text": text, "key": delivery_id, **kwargs})
        return f"synthetic-email-{len(calls['email'])}"
    monkeypatch.setattr("ledger.push_provider.send_bill_notification", push)
    monkeypatch.setattr(email_delivery, "send_email", email)
    return calls


def add_bill(client, group, **kwargs):
    body = expense(group[1], **kwargs)
    response = send(client, "post", f"/groups/{group[0]}/expenses", body)
    assert response.status_code == 200, response.content
    return body


def enable(person, *, master=True, email=True):
    response = send(person, "put", "/me/notifications/preferences", {"expense_updates": master, "email_reminders": email})
    assert response.status_code == 200
    return response.json()


def feed(person, **params):
    from urllib.parse import urlencode
    response = send(person, "get", f"/me/notifications?{urlencode(params)}")
    assert response.status_code == 200, response.content
    return response.json()


def seen(person, rows):
    return send(person, "post", "/me/notifications/seen", {"notices": rows})


def test_recipients_use_paid_or_share_never_net_or_membership_alone(client, group, recipient, settings):
    bystander = account()
    Participant.objects.filter(pk=group[1][2]).update(user=bystander.actor)
    body = expense(group[1], total="20000")
    body["paid"] = {group[1][0]: "10000", group[1][1]: "10000"}
    body["split"] = {"mode": "exact", "values": {group[1][0]: "10000", group[1][1]: "10000"}}
    assert send(client, "post", f"/groups/{group[0]}/expenses", body).status_code == 200
    assert list(ExpenseNotice.objects.values_list("recipient_id", flat=True)) == [recipient.actor.pk]
    assert send(client, "post", f"/groups/{group[0]}/expenses", body).status_code == 200
    assert ExpenseNotice.objects.count() == 1 and not ExpensePushDelivery.objects.exists()
    settings.STORE_REVIEW_AUTH = [{"store": "apple", "user_id": recipient.actor.pk, "email": recipient.actor.email, "pin_hash": ""}]
    body.update(command_id=uid(), id=uid())
    # A mixed review group is already denied at the normal ledger boundary.
    assert send(client, "post", f"/groups/{group[0]}/expenses", body).status_code == 404
    assert ExpenseNotice.objects.count() == 1


def test_creation_rollback_and_edit_never_add_another_recipient_notice(client, group, recipient):
    with pytest.raises(RuntimeError), transaction.atomic():
        save_expense(client.actor, group[0], expense(group[1]))
        assert ExpenseNotice.objects.count() == 1
        raise RuntimeError("rollback")
    assert ExpenseNotice.objects.count() == 0
    body = add_bill(client, group)
    body.update(command_id=uid(), version=1, description="Changed synthetic bill")
    assert send(client, "put", f"/groups/{group[0]}/expenses/{body['id']}", body).status_code == 200
    assert ExpenseNotice.objects.count() == 1 and ExpenseNotice.objects.get().expense_version == 1


@pytest.mark.parametrize("change", ["deleted_restored", "archived_unarchived", "involvement_removed"])
def test_cancelled_creation_is_not_replayed_by_restore_or_archive_roundtrip(client, group, recipient, clock, providers, configured, change):
    enable(recipient)
    register(recipient)
    body = add_bill(client, group)
    if change == "deleted_restored":
        assert send(client, "delete", f"/groups/{group[0]}/expenses/{body['id']}", {"command_id": uid(), "version": 1}).status_code == 200
        assert send(client, "post", f"/groups/{group[0]}/expenses/{body['id']}/restore", {"command_id": uid(), "version": 2}).status_code == 200
    elif change == "archived_unarchived":
        for value in (True, False):
            assert send(client, "post", f"/groups/{group[0]}/archive", {"command_id": uid(), "archived": value}).status_code == 200
    else:
        body.update(command_id=uid(), version=1, split={"mode": "equal", "values": {group[1][0]: "1"}})
        assert send(client, "put", f"/groups/{group[0]}/expenses/{body['id']}", body).status_code == 200
    clock[0] += timedelta(days=2)
    send_pending_bill_notifications()
    notifications.send_pending_digests()
    assert not providers["push"] and not providers["email"] and feed(recipient)["notices"] == []


def test_feed_fetch_is_not_seen_and_exact_current_revision_ack_is_account_scoped(client, group, recipient, clock):
    body = add_bill(client, group)
    with CaptureQueriesContext(connection) as queries:
        notices = feed(recipient)["notices"]
    assert len(queries) <= 7 and len(notices) == 1
    assert set(notices[0]) == {"id", "group_id", "expense_id", "expense_version", "created_at"}
    row = ExpenseNotice.objects.get()
    assert row.seen_at is None and not NotificationPreference.objects.filter(user=recipient.actor).exists()
    item = {"id": str(row.id), "expense_version": 1}
    assert seen(account(), [item]).json() == {"seen": 0}
    assert seen(recipient, [{**item, "expense_version": 99}]).json() == {"seen": 0}
    body.update(command_id=uid(), version=1, description="Edited")
    assert send(client, "put", f"/groups/{group[0]}/expenses/{body['id']}", body).status_code == 200
    assert seen(recipient, [item]).json() == {"seen": 0}
    assert seen(recipient, [{**item, "expense_version": 2}]).json() == {"seen": 1}
    assert seen(recipient, [item]).json() == {"seen": 0} and feed(recipient)["notices"] == []


def test_scoped_feed_can_reach_visible_bill_behind_fifty_other_unread_bills(client, group, recipient, clock):
    first = add_bill(client, group)
    for _ in range(51):
        clock[0] += timedelta(seconds=1)
        add_bill(client, group)
    ordinary = feed(recipient)
    assert ordinary["has_more"] and first["id"] not in [row["expense_id"] for row in ordinary["notices"]]
    assert [row["expense_id"] for row in feed(recipient, expense_ids=first["id"])["notices"]] == [first["id"]]
    assert send(recipient, "get", "/me/notifications?expense_ids=bad").status_code == 422
    assert send(recipient, "get", "/me/notifications?expense_ids=" + ",".join(uid() for _ in range(51))).status_code == 422
    assert send(recipient, "get", "/me/notifications?limit=101").status_code == 422


def test_visible_ack_inside_grace_suppresses_all_devices_without_hiding_other_bills(client, group, recipient, clock, providers, configured):
    register(recipient)
    register(recipient)
    first, second = add_bill(client, group), add_bill(client, group)
    assert send_pending_bill_notifications() == 0 and not providers["push"]
    notice = ExpenseNotice.objects.get(expense_id=first["id"])
    assert seen(recipient, [{"id": str(notice.id), "expense_version": 1}]).json() == {"seen": 1}
    clock[0] += timedelta(seconds=30)
    assert send_pending_bill_notifications() == 2
    assert len(providers["push"]) == 2
    assert all(data["expense_id"] == second["id"] and data["notice_id"] == data["event_id"] for data in providers["push"])
    assert ExpenseNotice.objects.get(expense_id=second["id"]).seen_at is None


def test_binding_appearing_during_grace_gets_one_route_but_later_registration_does_not_replay(client, group, recipient, clock, providers, configured):
    add_bill(client, group)
    clock[0] += timedelta(seconds=20)
    device = register(recipient)
    clock[0] += timedelta(seconds=10)
    assert send_pending_bill_notifications() == 1
    register(recipient)
    assert send_pending_bill_notifications() == 0 and len(providers["push"]) == 1
    old_revision = device.revision
    PushDevice.objects.filter(pk=device.pk).update(updated_at=clock[0] - timedelta(days=31))
    refreshed = register(recipient, device.id, device.token)
    assert refreshed.revision == old_revision and refreshed.updated_at == clock[0]


def test_account_preferences_are_prospective_and_master_off_survives_registration(client, group, recipient, clock, configured, providers):
    assert send(recipient, "get", "/me/notifications/preferences").json() == {"expense_updates": True, "email_reminders": False}
    old = add_bill(client, group)
    enable(recipient)
    assert not ExpenseNotice.objects.get(expense_id=old["id"]).email_eligible
    added = add_bill(client, group)
    assert ExpenseNotice.objects.get(expense_id=added["id"]).email_eligible
    enable(recipient, master=False)
    register(recipient)
    later = add_bill(client, group)
    assert not ExpenseNotice.objects.filter(email_eligible=True).exists()
    assert ExpenseNotice.objects.get(expense_id=later["id"]).push_processed_at
    clock[0] += timedelta(days=2)
    send_pending_bill_notifications()
    notifications.send_pending_digests()
    assert not providers["push"] and not providers["email"] and len(feed(recipient)["notices"]) == 3
    assert send(recipient, "get", "/me/notifications/preferences").json()["expense_updates"] is False


def test_only_actual_new_otp_identity_has_disclosed_email_default(client, clock):
    assert not NotificationPreference.objects.filter(user=client.actor).exists()
    with transaction.atomic():
        _verified_user(client.actor.email)
    assert not NotificationPreference.objects.filter(user=client.actor).exists()
    with transaction.atomic():
        user, _ = _verified_user("new-synthetic@example.com")
    preference = NotificationPreference.objects.get(user=user)
    assert preference.expense_updates and preference.email_reminders and preference.email_enabled_at == clock[0]


def test_digest_waits_both_thresholds_and_sends_generic_once_across_groups(client, group, recipient, clock, providers):
    enable(recipient)
    first = add_bill(client, group)
    other_ids = [uid(), uid(), uid()]
    other_body = {"command_id": uid(), "id": uid(), "name": "Other synthetic group", "self_participant_id": other_ids[0],
                  "participants": [{"id": person, "name": "Synthetic person"} for person in other_ids]}
    assert send(client, "post", "/groups", other_body).status_code == 200
    Participant.objects.filter(pk=other_ids[1]).update(user=recipient.actor)
    add_bill(client, (other_body["id"], other_ids, other_body))
    clock[0] += timedelta(hours=23)
    assert notifications.send_pending_digests() == 0
    assert send(recipient, "post", "/me/notifications/foreground", {}).json() == {"ok": True}
    recorded = NotificationPreference.objects.get(user=recipient.actor).foreground_at
    clock[0] += timedelta(minutes=1)
    send(recipient, "post", "/me/notifications/foreground", {})
    assert NotificationPreference.objects.get(user=recipient.actor).foreground_at == recorded
    clock[0] += timedelta(hours=1)
    assert notifications.send_pending_digests() == 0
    clock[0] = recorded + timedelta(hours=24)
    assert notifications.send_pending_digests() == 1
    digest = ExpenseDigest.objects.get()
    assert digest.state == "accepted" and digest.notices.count() == 2
    message = providers["email"][0]
    assert message["key"] == f"expense-digest/{digest.id}"
    assert "Open MeroSplit" in message["payload"]["html"] and "cid:merosplit-logo" in message["payload"]["html"]
    assert message["payload"]["attachments"][0]["content_id"] == "merosplit-logo"
    for secret in (first["description"], group[2]["name"], first["total"], group[1][1], first["id"]):
        assert secret not in message["text"] and secret not in message["payload"]["html"]
    clock[0] += timedelta(days=2)
    assert notifications.send_pending_digests() == 0 and len(providers["email"]) == 1
    assert not ExpenseNotice.objects.filter(seen_at__isnull=False).exists()


def test_seen_or_off_during_provider_submission_retains_honest_acceptance(client, group, recipient, clock, monkeypatch, configured):
    enable(recipient)
    register(recipient)
    add_bill(client, group)
    clock[0] += timedelta(seconds=30)
    def push(device, data):
        assert not connection.in_atomic_block
        assert seen(recipient, [{"id": data["notice_id"], "expense_version": 1}]).json() == {"seen": 1}
        return "accepted-despite-in-flight-seen"
    monkeypatch.setattr("ledger.push_provider.send_bill_notification", push)
    assert send_pending_bill_notifications() == 1
    delivery = ExpensePushDelivery.objects.get()
    assert delivery.state == "queued" and delivery.provider_id == "accepted-despite-in-flight-seen"
    add_bill(client, group)
    clock[0] += timedelta(hours=24)
    def email(*args, **kwargs):
        assert not connection.in_atomic_block
        enable(recipient, master=False)
        return "accepted-despite-in-flight-off"
    monkeypatch.setattr(email_delivery, "send_email", email)
    notifications.send_pending_digests()
    digest = ExpenseDigest.objects.get()
    assert digest.state == "accepted" and digest.provider_id == "accepted-despite-in-flight-off"
    assert not NotificationPreference.objects.get(user=recipient.actor).expense_updates


def test_missing_push_route_or_provider_failure_never_triggers_immediate_email(client, group, recipient, clock, providers, configured, monkeypatch):
    from .push_provider import PushFailure
    enable(recipient)
    register(recipient)
    add_bill(client, group)
    def unavailable(*args):
        raise PushFailure("network_error")
    monkeypatch.setattr("ledger.push_provider.send_bill_notification", unavailable)
    clock[0] += timedelta(seconds=30)
    send_pending_bill_notifications()
    assert notifications.send_pending_digests() == 0 and not providers["email"]
    clock[0] += timedelta(hours=24)
    assert notifications.send_pending_digests() == 1 and len(providers["email"]) == 1


def test_expense_master_off_does_not_block_requested_otp_or_explicit_invitation(client, group, providers):
    enable(client, master=False, email=False)
    response = Client().post("/_allauth/app/v1/auth/code/request", json.dumps({"email": "requested-synthetic@example.com"}), content_type="application/json")
    assert response.status_code == 200
    target = group[1][2]
    assert send(client, "post", f"/groups/{group[0]}/participants/{target}/contact", {"command_id": uid(), "email": "invited-synthetic@example.com"}).status_code == 200
    assert send(client, "post", f"/groups/{group[0]}/participants/{target}/email-invite", {"command_id": uid()}).status_code == 200
    assert len(providers["email"]) == 2 and not ExpenseDigest.objects.exists()


@pytest.mark.parametrize("change", ["seen", "email_off", "master_off", "removed", "deleted", "archived", "unverified", "invalid_email", "changed_email", "inactive"])
def test_digest_rechecks_all_permissions_immediately_before_provider(client, group, recipient, clock, providers, monkeypatch, change):
    enable(recipient)
    body = add_bill(client, group)
    clock[0] += timedelta(hours=24)
    assert notifications.create_due_digest()
    original = notifications._digest_still_eligible
    changed = []
    def mutate(digest):
        if not changed:
            changed.append(True)
            if change == "seen":
                row = ExpenseNotice.objects.get()
                seen(recipient, [{"id": str(row.id), "expense_version": 1}])
            elif change in ("email_off", "master_off"):
                enable(recipient, master=change != "master_off", email=change != "email_off")
            elif change == "removed":
                Participant.objects.filter(pk=group[1][1]).update(removed=True)
            elif change == "deleted":
                Expense.objects.filter(pk=body["id"]).update(deleted=True)
            elif change == "archived":
                Group.objects.filter(pk=group[0]).update(archived=True)
            elif change == "unverified":
                EmailAddress.objects.filter(user=recipient.actor).update(verified=False)
            elif change in ("invalid_email", "changed_email"):
                get_user_model().objects.filter(pk=recipient.actor.pk).update(email="changed@example.invalid" if change == "invalid_email" else "changed@example.com")
            else:
                get_user_model().objects.filter(pk=recipient.actor.pk).update(is_active=False)
        return original(digest)
    monkeypatch.setattr(notifications, "_digest_still_eligible", mutate)
    notifications.send_pending_digests()
    assert not providers["email"]


def test_foreground_activity_after_digest_creation_defers_without_losing_unread(client, group, recipient, clock, providers):
    enable(recipient)
    add_bill(client, group)
    clock[0] += timedelta(hours=24)
    assert notifications.create_due_digest()
    send(recipient, "post", "/me/notifications/foreground", {})
    notifications.send_pending_digests()
    row = ExpenseDigest.objects.get()
    assert row.state == "pending" and row.first_attempt_at is None and not providers["email"]
    clock[0] += timedelta(hours=24)
    assert notifications.send_pending_digests() == 1 and len(providers["email"]) == 1


def test_uncertain_digest_retries_same_frozen_key_payload_and_holds_after_provider_window(client, group, recipient, clock, monkeypatch):
    enable(recipient)
    add_bill(client, group)
    calls = []
    def timeout(recipient, subject, text, delivery_id, **kwargs):
        assert not connection.in_atomic_block
        calls.append((recipient, subject, text, delivery_id, kwargs))
        raise email_delivery.EmailDeliveryUnavailable()
    monkeypatch.setattr(email_delivery, "send_email", timeout)
    clock[0] += timedelta(hours=24)
    assert notifications.send_pending_digests() == 1
    row = ExpenseDigest.objects.get()
    created_later = add_bill(client, group)
    clock[0] += timedelta(minutes=2)
    assert notifications.send_pending_digests() == 1 and calls[0] == calls[1]
    assert ExpenseNotice.objects.get(expense_id=created_later["id"]).digest_id is None
    clock[0] += timedelta(hours=24)
    assert notifications.send_pending_digests() == 1
    row.refresh_from_db()
    assert row.state == "held" and len(calls) == 2
    assert notifications.send_pending_digests() == 0 and ExpenseDigest.objects.count() == 1


def test_two_workers_create_and_accept_one_digest_without_repeating_notices(client, group, recipient, clock, providers):
    enable(recipient)
    for _ in range(3):
        add_bill(client, group)
    clock[0] += timedelta(hours=24)
    def work(_):
        close_old_connections()
        try:
            return notifications.send_pending_digests(limit=1)
        finally:
            connections.close_all()
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(work, range(2)))
    assert ExpenseDigest.objects.count() == 1 and len(providers["email"]) == 1
    assert ExpenseNotice.objects.filter(digest=ExpenseDigest.objects.get()).count() == 3


def test_new_arrivals_wait_for_next_rolling_day_and_never_reuse_accepted_events(client, group, recipient, clock, providers):
    enable(recipient)
    add_bill(client, group)
    clock[0] += timedelta(hours=24)
    assert notifications.send_pending_digests() == 1
    added = add_bill(client, group)
    clock[0] += timedelta(hours=23, minutes=59)
    assert notifications.send_pending_digests() == 0
    clock[0] += timedelta(minutes=1)
    assert notifications.send_pending_digests() == 1 and len(providers["email"]) == 2
    assert ExpenseDigest.objects.count() == 2
    assert all(digest.notices.count() == 1 for digest in ExpenseDigest.objects.all())
    assert ExpenseNotice.objects.get(expense_id=added["id"]).digest.state == "accepted"


@pytest.mark.parametrize("change", ["seen", "master_off", "membership_removed"])
def test_competing_database_change_commits_before_final_digest_check(client, group, recipient, clock, providers, monkeypatch, change):
    enable(recipient)
    add_bill(client, group)
    clock[0] += timedelta(hours=24)
    ready, release = Event(), Event()
    original = notifications._digest_still_eligible
    def pause(digest):
        if not ready.is_set():
            ready.set()
            assert release.wait(10)
        return original(digest)
    monkeypatch.setattr(notifications, "_digest_still_eligible", pause)
    def run():
        close_old_connections()
        try:
            return notifications.send_pending_digests(limit=1)
        finally:
            connections.close_all()
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(run)
        try:
            assert ready.wait(10)
            if change == "seen":
                assert seen(recipient, [{"id": str(ExpenseNotice.objects.get().id), "expense_version": 1}]).json() == {"seen": 1}
            elif change == "master_off":
                enable(recipient, master=False)
            else:
                Participant.objects.filter(pk=group[1][1]).update(removed=True)
        finally:
            release.set()
        future.result(timeout=10)
    assert not providers["email"]


def test_browser_mutations_keep_csrf_and_bounded_exact_ack_validation(recipient):
    browser = Client(enforce_csrf_checks=True)
    browser.force_login(recipient.actor)
    for path, body in (("preferences", {"expense_updates": False, "email_reminders": False}), ("seen", {"notices": []}), ("foreground", {})):
        assert send(browser, "put" if path == "preferences" else "post", f"/me/notifications/{path}", body).status_code == 403
    assert send(recipient, "post", "/me/notifications/seen", {"notices": [{"id": uid(), "expense_version": 1}] * 101}).status_code == 422
    assert send(recipient, "put", "/me/notifications/preferences", {"expense_updates": "false", "email_reminders": False}).status_code == 422
    assert send(Client(), "get", "/me/notifications").status_code == 401


def test_fanout_and_account_deletion_keep_notice_before_device_lock_order(client, group, recipient, clock, configured, monkeypatch):
    register(recipient)
    add_bill(client, group)
    clock[0] += timedelta(seconds=30)
    selected, release, deleting = Event(), Event(), Event()
    from . import push
    original = push._queue_devices
    def pause(notices, now):
        selected.set()
        assert release.wait(10)
        return original(notices, now)
    monkeypatch.setattr(push, "_queue_devices", pause)
    def fanout():
        close_old_connections()
        try:
            return fanout_due_notices()
        finally:
            connections.close_all()
    def remove():
        close_old_connections()
        def observe(execute, sql, params, many, context):
            if sql.startswith("DELETE") and '"ledger_expensenotice"' in sql:
                deleting.set()
            return execute(sql, params, many, context)
        try:
            with connection.execute_wrapper(observe):
                return send(Client(**recipient.defaults), "delete", "/account").status_code
        finally:
            connections.close_all()
    with ThreadPoolExecutor(max_workers=2) as pool:
        pending = pool.submit(fanout)
        assert selected.wait(10)
        deletion = pool.submit(remove)
        try:
            assert deleting.wait(10)
            with pytest.raises(TimeoutError):
                deletion.result(timeout=0.2)
        finally:
            release.set()
        assert pending.result(timeout=10) == 1 and deletion.result(timeout=10) == 200
    assert not ExpenseNotice.objects.exists() and not ExpensePushDelivery.objects.exists()


def test_digest_builder_and_deletion_keep_preference_before_notice_lock_order(client, group, recipient, clock, monkeypatch):
    enable(recipient)
    add_bill(client, group)
    clock[0] += timedelta(hours=24)
    selected, release, deleting = Event(), Event(), Event()
    original = notifications._eligible_notices
    def pause(rows):
        selected.set()  # The builder holds preference and candidate notice locks.
        assert release.wait(10)
        return original(rows)
    monkeypatch.setattr(notifications, "_eligible_notices", pause)
    def build():
        close_old_connections()
        try:
            return notifications.create_due_digest()
        finally:
            connections.close_all()
    def remove():
        close_old_connections()
        def observe(execute, sql, params, many, context):
            if '"ledger_notificationpreference"' in sql and "FOR UPDATE" in sql:
                deleting.set()
            return execute(sql, params, many, context)
        try:
            with connection.execute_wrapper(observe):
                return send(Client(**recipient.defaults), "delete", "/account").status_code
        finally:
            connections.close_all()
    with ThreadPoolExecutor(max_workers=2) as pool:
        building = pool.submit(build)
        assert selected.wait(10)
        deletion = pool.submit(remove)
        try:
            assert deleting.wait(10)
            with pytest.raises(TimeoutError):
                deletion.result(timeout=0.2)
        finally:
            release.set()
        assert building.result(timeout=10) and deletion.result(timeout=10) == 200
    assert not ExpenseNotice.objects.exists() and not ExpenseDigest.objects.exists()
    assert not NotificationPreference.objects.exists() and not get_user_model().objects.filter(pk=recipient.actor.pk).exists()


def test_seeded_due_queue_feed_and_claim_use_bounded_indexed_queries(client, group, recipient, clock, capsys):
    enable(recipient)
    add_bill(client, group)
    original = ExpenseNotice.objects.get()
    # Different expenses preserve the real uniqueness and FK constraints.
    bills = [Expense(id=uid(), group_id=group[0], description="Synthetic queue fixture", total=100,
        paid={group[1][0]: "100"}, shares={group[1][1]: "100"}, split={"mode": "exact", "values": {group[1][1]: "100"}}, date="2026-01-01") for _ in range(2000)]
    Expense.objects.bulk_create(bills)
    # Unread push-only notices coexist with prospective email opt-in. If every
    # row is eligible, the unread index is equally selective for this query.
    ExpenseNotice.objects.bulk_create([ExpenseNotice(expense=bill, recipient=recipient.actor, expense_version=1, created_at=clock[0],
        push_due_at=clock[0] + timedelta(seconds=30), email_eligible=i % 10 == 0) for i, bill in enumerate(bills)])
    assert ExpenseNotice.objects.filter(email_eligible=True).count() == 201
    assert ExpenseNotice.objects.filter(email_eligible=False).count() == 1800
    clock[0] += timedelta(hours=24)
    with connection.cursor() as cursor:
        cursor.execute("ANALYZE ledger_expensenotice, ledger_notificationpreference, ledger_expensedigest")
    with CaptureQueriesContext(connection) as queries:
        data = feed(recipient)
    assert len(data["notices"]) == 50 and len(queries) <= 7
    plans = {
        "push": ExpenseNotice.objects.filter(push_processed_at__isnull=True, push_due_at__lte=clock[0]).order_by("push_due_at", "id")[:100].explain(analyze=True, buffers=True, format="json"),
        "unread": ExpenseNotice.objects.filter(recipient=recipient.actor, seen_at__isnull=True, cancelled_at__isnull=True).order_by("-created_at", "-id")[:51].explain(analyze=True, buffers=True, format="json"),
        "email": notifications._unmailed(clock[0]).filter(recipient=recipient.actor, created_at__gte=NotificationPreference.objects.get(user=recipient.actor).email_enabled_at).order_by("created_at", "id")[:100].explain(analyze=True, buffers=True, format="json"),
    }
    assert "expense_notice_push_due" in plans["push"] and "expense_notice_unread" in plans["unread"]
    assert "expense_notice_email_due" in plans["email"]
    with CaptureQueriesContext(connection) as claimed:
        identifier = notifications.create_due_digest()
    assert identifier and ExpenseDigest.objects.get(pk=identifier).notices.count() == 100 and len(claimed) <= 12
    assert ExpenseNotice.objects.get(pk=original.pk).recipient_id == recipient.actor.pk
    oldest_due = ExpenseNotice.objects.filter(push_processed_at__isnull=True).order_by("push_due_at").first().push_due_at
    started = monotonic()
    with CaptureQueriesContext(connection) as fanout_queries:
        assert fanout_due_notices(limit=100) == 100
    fanout_seconds = monotonic() - started
    assert len(fanout_queries) <= 10
    with capsys.disabled():
        print("notification queue benchmark:", json.dumps({"rows": 2001, "feed_queries": len(queries), "digest_queries": len(claimed),
            "push_ms": json.loads(plans["push"])[0]["Execution Time"], "unread_ms": json.loads(plans["unread"])[0]["Execution Time"],
            "email_ms": json.loads(plans["email"])[0]["Execution Time"]}))
        print("notification fanout benchmark:", json.dumps({"batch": 100, "queries": len(fanout_queries), "seconds": fanout_seconds,
              "oldest_due_age_seconds": (clock[0] - oldest_due).total_seconds()}))
