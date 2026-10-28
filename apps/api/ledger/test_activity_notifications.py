from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from uuid import uuid4

import pytest
from django.db import IntegrityError, connection, transaction
from django.utils import timezone

from .activity_notifications import queue_activity, send_activity_notifications
from .models import (
    ActivityPush,
    Expense,
    Group,
    NotificationPreference,
    Participant,
    PaymentAttempt,
    PushDevice,
    Settlement,
)
from .notification_content import money, new_bill_content, preview
from .push import send_pending_bill_notifications
from .push_provider import PushFailure
from .services import reverse_expense
from .test_api import client as client
from .test_api import expense, send, uid
from .test_api import group as group
from .test_membership import threaded
from .test_push import login, register

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture
def setup(client, group, settings, monkeypatch):
    settings.PUSH_PROVIDER = "expo"
    recipient = login()
    Participant.objects.filter(pk=group[1][1]).update(user=recipient.actor)
    device = register(recipient)
    PushDevice.objects.filter(pk=device.pk).update(ledger_updates=True)
    bill = expense(group[1], total="120000")
    bill["description"] = "Dinner"
    assert send(client, "post", f"/groups/{group[0]}/expenses", bill).status_code == 200
    sent = []

    def provider(device, data, **content):
        assert not connection.in_atomic_block
        assert not set(data) & {"amount", "description", "name", "currency"}
        sent.append((data, content))
        return str(uuid4())

    monkeypatch.setattr("ledger.push_provider.send_bill_notification", provider)
    monkeypatch.setattr("ledger.push_provider.check_bill_notification_receipt", lambda _: True)
    return recipient, device, bill, sent


def edit(client, group, bill, *, total="150000"):
    body = {**bill, "command_id": uid(), "version": Expense.objects.get(pk=bill["id"]).version,
            "total": total, "paid": {group[1][0]: total}}
    response = send(client, "put", f"/groups/{group[0]}/expenses/{bill['id']}", body)
    assert response.status_code == 200, response.content
    ActivityPush.objects.update(due_at=timezone.now())
    return body, response.json()


def test_concise_bill_preview_uses_current_share_and_currency(client, group, setup):
    recipient, device, bill, sent = setup
    PushDevice.objects.filter(pk=device.pk).update(currency="USD")
    from .models import ExpenseNotice, ExpensePushDelivery
    ExpenseNotice.objects.update(push_due_at=timezone.now())
    ExpensePushDelivery.objects.update(due_at=timezone.now())
    send_pending_bill_notifications()
    assert len(sent) == 1
    assert sent[0][1] == {"title": "A added Dinner", "body": "Your share is $400. · Functional test"}
    delivery = ExpensePushDelivery.objects.select_related("expense__group", "device").get()
    Expense.objects.filter(pk=bill["id"]).update(shares={group[1][0]: "120000"})
    delivery.expense.refresh_from_db()
    assert "included as a payer" in new_bill_content(delivery)["body"]


def test_edit_only_affected_people_and_replay_dedupes(client, group, setup):
    _, _, bill, sent = setup
    body, result = edit(client, group, bill)
    assert ActivityPush.objects.count() == 1
    assert send(client, "put", f"/groups/{group[0]}/expenses/{bill['id']}", body).json() == result
    with transaction.atomic():
        queue_activity(Group.objects.get(pk=group[0]), result, before={**bill, "shares": {key: "40000" for key in group[1]}})
    assert ActivityPush.objects.count() == 1
    send_activity_notifications()
    assert sent[0][0]["type"] == "bill_updated"
    assert sent[0][1] == {"title": "A updated Dinner", "body": "Your share changed from ₹400 to ₹500. · Functional test"}
    assert send_activity_notifications() == 0
    # A metadata edit is silent.
    body.update(command_id=uid(), version=2, notes="Receipt corrected")
    assert send(client, "put", f"/groups/{group[0]}/expenses/{bill['id']}", body).status_code == 200
    assert ActivityPush.objects.count() == 1


def test_edit_waits_for_grace_and_skips_superseded_amount(client, group, setup):
    _, _, bill, sent = setup
    body = {**bill, "command_id": uid(), "version": 1, "total": "150000", "paid": {group[1][0]: "150000"}}
    assert send(client, "put", f"/groups/{group[0]}/expenses/{bill['id']}", body).status_code == 200
    assert send_activity_notifications() == 0
    edit(client, group, bill, total="180000")
    send_activity_notifications()
    assert len(sent) == 1 and "₹600" in sent[0][1]["body"]
    assert ActivityPush.objects.filter(state="cancelled").count() == 1


@pytest.mark.parametrize("change", ["archive", "removed", "unlink", "inactive", "logout", "rebound", "optout", "oldclient", "actor_removed", "expired_event"])
def test_fresh_eligibility_checks(client, group, setup, change):
    recipient, device, bill, sent = setup
    edit(client, group, bill)
    if change == "archive":
        Group.objects.filter(pk=group[0]).update(archived=True)
    elif change == "removed":
        Participant.objects.filter(pk=group[1][1]).update(removed=True)
    elif change == "unlink":
        Participant.objects.filter(pk=group[1][1]).update(user=None)
    elif change == "inactive":
        recipient.actor.is_active = False
        recipient.actor.save()
    elif change == "logout":
        device.session.delete()
    elif change == "rebound":
        PushDevice.objects.filter(pk=device.pk).update(revision=2)
    elif change == "optout":
        NotificationPreference.objects.create(user=recipient.actor, expense_updates=False)
    elif change == "oldclient":
        PushDevice.objects.filter(pk=device.pk).update(ledger_updates=False)
    elif change == "actor_removed":
        Participant.objects.filter(pk=group[1][0]).update(removed=True)
    else:
        job = ActivityPush.objects.get()
        ActivityPush.objects.filter(pk=job.pk).update(created_at=timezone.now() - timedelta(hours=2))
    send_activity_notifications()
    assert not sent


def test_deletion_notifies_only_financial_people(client, group, setup):
    _, _, bill, sent = setup
    payload = {"command_id": uid(), "version": 1}
    path = f"/groups/{group[0]}/expenses/{bill['id']}/reverse"
    assert send(client, "post", path, payload).status_code == 200
    assert send(client, "post", path, payload).status_code == 200
    assert ActivityPush.objects.count() == 1
    send_activity_notifications()
    assert sent[0][1] == {"title": "A deleted Dinner", "body": "₹400 removed from your share. · Functional test"}


def test_rollback_and_unique_constraint(client, group, setup):
    _, _, bill, _ = setup
    with pytest.raises(RuntimeError), transaction.atomic():
        reverse_expense(client.actor, group[0], bill["id"], {"command_id": uid(), "version": 1})
        assert ActivityPush.objects.count() == 1
        raise RuntimeError("rollback")
    assert not ActivityPush.objects.exists()
    edit(client, group, bill)
    job = ActivityPush.objects.get()
    with pytest.raises(IntegrityError), transaction.atomic():
        ActivityPush.objects.create(change=job.change, group=job.group, actor=job.actor, participant=job.participant, recipient=job.recipient,
            device=job.device, device_revision=job.device_revision, event_id=uuid4(), kind=job.kind,
            payload=job.payload, due_at=timezone.now())


@pytest.mark.parametrize("error", ["network_error", "http_500"])
def test_uncertain_send_is_held_never_blindly_retried(client, group, setup, monkeypatch, error):
    _, _, bill, sent = setup
    edit(client, group, bill)
    def unavailable(*args, **kwargs):
        sent.append("attempt")
        raise PushFailure(error)
    monkeypatch.setattr("ledger.push_provider.send_bill_notification", unavailable)
    send_activity_notifications()
    ActivityPush.objects.update(due_at=timezone.now())
    send_activity_notifications()
    assert sent == ["attempt"]
    assert ActivityPush.objects.get().state == "held"


def test_crash_after_dispatch_is_held_and_known_ticket_only_checks_receipt(client, group, setup):
    _, _, bill, sent = setup
    edit(client, group, bill)
    ActivityPush.objects.update(state="sending", first_attempt_at=timezone.now(), lease_until=timezone.now() - timedelta(seconds=1))
    send_activity_notifications()
    assert not sent and ActivityPush.objects.get().state == "held"
    ActivityPush.objects.update(state="queued", provider_id="ticket", due_at=timezone.now())
    send_activity_notifications()
    assert not sent and ActivityPush.objects.get().state == "sent"


def test_explicit_rate_rejection_can_retry_without_duplicate_acceptance(client, group, setup, monkeypatch):
    _, _, bill, sent = setup
    edit(client, group, bill)
    attempts = []
    def provider(*args, **kwargs):
        attempts.append(1)
        if len(attempts) == 1:
            raise PushFailure("http_429")
        sent.append("accepted")
        return "ticket"
    monkeypatch.setattr("ledger.push_provider.send_bill_notification", provider)
    send_activity_notifications()
    assert ActivityPush.objects.get().state == "pending"
    ActivityPush.objects.update(due_at=timezone.now())
    send_activity_notifications()
    assert sent == ["accepted"]
    assert ActivityPush.objects.get().state == "queued"


def test_recorded_payment_notifies_counterparty_and_reversal_cancels(client, group, setup):
    _, _, _, sent = setup
    payload = {"command_id": uid(), "id": uid(), "sender": group[1][0], "recipient": group[1][1], "amount": "50000"}
    path = f"/groups/{group[0]}/settlements"
    assert send(client, "post", path, payload).status_code == 200
    assert send(client, "post", path, payload).status_code == 200
    assert ActivityPush.objects.count() == 1
    send_activity_notifications()
    assert sent[0][1] == {"title": "A recorded a ₹500 payment", "body": "Marked as paid to you. · Functional test"}
    # A reversed record must not generate an old payment alert.
    ActivityPush.objects.update(state="pending", first_attempt_at=None, provider_id="", due_at=timezone.now())
    Settlement.objects.filter(pk=payload["id"]).update(reversed=True)
    send_activity_notifications()
    assert len(sent) == 1 and ActivityPush.objects.get().state == "cancelled"


def reminder(client, group, amount="40000", **overrides):
    return send(client, "post", f"/groups/{group[0]}/payment-reminders", {
        "command_id": uid(), "sender": group[1][1], "amount": amount,
        "group_version": Group.objects.get(pk=group[0]).version, **overrides})


def test_reminder_current_debt_replay_and_durable_cooldown(client, group, setup):
    _, _, _, sent = setup
    command_id = uid()
    version = Group.objects.get(pk=group[0]).version
    first = reminder(client, group, command_id=command_id)
    assert first.status_code == 200, first.content
    replay = reminder(client, group, command_id=command_id, group_version=first.json()["version"])
    assert replay.json() == first.json()
    assert ActivityPush.objects.count() == 1
    assert Group.objects.get(pk=group[0]).version == version, "A reminder must not invalidate prepared payments"
    send_activity_notifications()
    assert sent[0][1] == {"title": "A reminder from A", "body": "You owe A ₹400. · Functional test"}
    assert reminder(client, group).status_code == 429


@pytest.mark.parametrize("invalid", ["stale", "amount", "outsider", "self", "unlinked", "oldclient", "notifications_off"])
def test_reminder_rejects_invalid_requests(client, group, setup, invalid):
    recipient, device, _, _ = setup
    changes = {}
    if invalid == "stale":
        changes["group_version"] = 0
    elif invalid == "amount":
        changes["amount"] = "1"
    elif invalid == "outsider":
        client = login()
    elif invalid == "self":
        changes["sender"] = group[1][0]
    elif invalid == "unlinked":
        Participant.objects.filter(pk=group[1][1]).update(user=None)
    elif invalid == "oldclient":
        PushDevice.objects.filter(pk=device.pk).update(ledger_updates=False)
    else:
        NotificationPreference.objects.create(user=recipient.actor, expense_updates=False)
    assert reminder(client, group, **changes).status_code in {404, 409, 422}
    assert not ActivityPush.objects.exists()


def test_reminder_settled_before_dispatch_is_cancelled(client, group, setup):
    _, _, _, sent = setup
    assert reminder(client, group).status_code == 200
    payload = {"command_id": uid(), "id": uid(), "sender": group[1][1], "recipient": group[1][0], "amount": "40000"}
    assert send(client, "post", f"/groups/{group[0]}/settlements", payload).status_code == 200
    send_activity_notifications()
    assert all(row[0]["type"] != "payment_reminder" for row in sent)
    assert ActivityPush.objects.get(kind="payment_reminder").state == "cancelled"


def test_content_sanitization_and_amounts():
    assert money("123456789") == "₹12,34,567.89"
    assert money("40000", "USD") == "$400"
    assert money("40001", "EUR") == "€400.01"
    assert money("40000", "invalid") == "₹400"
    assert preview("\u202eevil\n name\x00") == "evil name"
    assert len(preview("x" * 200)) == 60


def test_currency_refresh_preserves_binding_and_pending_event(client, group, setup):
    recipient, device, bill, sent = setup
    edit(client, group, bill)
    response = send(recipient, "put", f"/me/push-devices/{device.id}", {
        "provider": device.provider, "platform": device.platform, "token": device.token,
        "ledger_updates": True, "bill_chat": True, "currency": "EUR"})
    assert response.status_code == 200
    device.refresh_from_db()
    assert device.revision == 1 and device.currency == "EUR"
    send_activity_notifications()
    assert "€400 to €500" in sent[0][1]["body"]


def test_two_devices_share_one_event_and_legacy_device_gets_no_new_type(client, group, setup):
    recipient, _, bill, sent = setup
    second = register(recipient)
    register(recipient)  # Legacy client remains capability-gated.
    PushDevice.objects.filter(pk=second.pk).update(ledger_updates=True)
    edit(client, group, bill)
    assert ActivityPush.objects.count() == 2
    assert len(set(ActivityPush.objects.values_list("event_id", flat=True))) == 1
    send_activity_notifications()
    assert len(sent) == 2


def test_simultaneous_reminder_replay_is_one_event(client, group, setup):
    from .activity_notifications import send_payment_reminder
    payload = {"command_id": uid(), "sender": group[1][1], "amount": "40000",
               "group_version": Group.objects.get(pk=group[0]).version}
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: threaded(lambda: send_payment_reminder(client.actor, group[0], payload)), range(2)))
    assert results[0] == results[1]
    assert ActivityPush.objects.count() == 1


def test_third_party_payment_record_names_actual_counterparty(client, group, setup):
    _, _, _, sent = setup
    payload = {"command_id": uid(), "id": uid(), "sender": group[1][1], "recipient": group[1][2], "amount": "50000"}
    assert send(client, "post", f"/groups/{group[0]}/settlements", payload).status_code == 200
    send_activity_notifications()
    assert sent[0][1]["title"] == "A recorded a ₹500 payment"
    assert sent[0][1]["body"] == "Marked as paid by you to C. · Functional test"


def test_payment_confirmation_does_not_notify_again_after_device_replacement(client, group, setup):
    recipient, device, _, sent = setup
    attempt = PaymentAttempt.objects.create(group_id=group[0], sender_id=group[1][0], recipient_id=group[1][1],
        amount=50000, payee="example@upi", payee_version=1, group_version=2, state="reported",
        expires_at=timezone.now() + timedelta(minutes=5))
    payload = {"command_id": uid(), "id": uid(), "sender": group[1][0], "recipient": group[1][1],
               "amount": "50000", "attempt_id": str(attempt.id)}
    assert send(client, "post", f"/groups/{group[0]}/settlements", payload).status_code == 200
    send_activity_notifications()
    assert len(sent) == 1
    device.delete()  # Retires the delivery, but must not erase semantic dedupe.
    replacement = register(recipient)
    PushDevice.objects.filter(pk=replacement.pk).update(ledger_updates=True)
    assert send(recipient, "post", f"/groups/{group[0]}/payment-attempts/{attempt.id}/confirm", {"command_id": uid()}).status_code == 200
    assert not ActivityPush.objects.exists()
    send_activity_notifications()
    assert len(sent) == 1
