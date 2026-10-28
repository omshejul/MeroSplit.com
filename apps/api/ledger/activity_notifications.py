"""Committed financial pushes, with bounded delivery and no blind resend."""
from datetime import timedelta
from uuid import uuid4

from allauth.core.internal.sessionkit import get_session_user
from config.sessions import SessionStore
from django.conf import settings
from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from ninja.errors import HttpError

from . import push_provider
from .models import ActivityPush, CommandReceipt, NotificationPreference, PushDevice
from .notification_content import activity_content
from .store_review import groups_for_actor, review_ids


def repayment(group, sender_id, recipient_id):
    from .services import snapshot
    return next((int(row["amount"]) for row in snapshot(group)["transfers"]
                 if row["sender"] == str(sender_id) and row["recipient"] == str(recipient_id)), 0)


def queue_activity(group, result, *, before=None):
    """Called inside the ledger transaction, after its idempotent change write."""
    change = group.changes.get(sequence=result["version"])
    data, targets = change.data, []
    if data.get("source"):
        return
    people = list(group.participants.filter(removed=False, user__is_active=True).select_related("user"))
    if change.kind in {"expense_saved", "expense_reversed"}:
        if change.kind == "expense_saved" and before is None:
            return
        kind = "bill_updated" if change.kind == "expense_saved" else "bill_deleted"
        for person in people:
            key = str(person.id)
            share, paid = data.get("shares", {}).get(key, "0"), data.get("paid", {}).get(key, "0")
            old_share, old_paid = (before or data).get("shares", {}).get(key, "0"), (before or data).get("paid", {}).get(key, "0")
            if kind == "bill_updated" and (int(share), int(paid)) == (int(old_share), int(old_paid)):
                continue
            if not any(int(value) for value in (share, paid, old_share, old_paid)):
                continue
            targets.append((person, {"expense_id": data["id"], "version": data["version"], "description": data["description"],
                                     "share": share, "paid": paid, "before_share": old_share, "before_paid": old_paid}))
    elif change.kind in {"manual_settlement", "payment_confirm"}:
        payment_id = data.get("settlement_id", data["id"])
        payment = group.settlements.select_related("sender", "recipient").get(pk=payment_id)
        # The ledger source survives device logout/rebinding; delivery rows may not.
        if group.changes.filter(sequence__lt=change.sequence).filter(
            Q(kind="manual_settlement", data__id=str(payment.id))
            | Q(kind="payment_confirm", data__settlement_id=str(payment.id))
        ).exists():
            return
        kind = "payment_recorded"
        for person in people:
            if person.id in {payment.sender_id, payment.recipient_id}:
                targets.append((person, {"settlement_id": str(payment.id), "amount": str(payment.amount),
                                         "sender": str(payment.sender_id), "recipient": str(payment.recipient_id),
                                         "direction": "incoming" if person.id == payment.recipient_id else "outgoing"}))
    else:
        return
    _queue_targets(group, change.actor_id, kind, targets, change=change)


def _queue_targets(group, actor_id, kind, targets, *, change=None, command=None):
    now = timezone.now()
    disabled = set(NotificationPreference.objects.filter(user_id__in=[p.user_id for p, _ in targets],
        expense_updates=False).values_list("user_id", flat=True))
    targets = {person.user_id: (person, payload, uuid4()) for person, payload in targets
               if person.user_id != actor_id and person.user_id not in disabled | review_ids()
               and actor_id not in review_ids()}
    if not targets:
        return
    # Lock every device in one stable order, also across concurrent groups.
    devices = PushDevice.objects.select_for_update(of=("self",)).filter(user_id__in=targets, ledger_updates=True,
        session__expire_date__gt=now, updated_at__gte=now - timedelta(days=30)).order_by("id")
    jobs = []
    for device in devices:
        person, payload, event_id = targets[device.user_id]
        jobs.append(ActivityPush(change=change, command=command, group=group, actor_id=actor_id,
            created_at=change.created_at if change else now, participant=person, recipient=person.user,
            device=device, device_revision=device.revision, event_id=event_id, kind=kind, payload=payload,
            due_at=now + timedelta(seconds=30) if kind == "bill_updated" else now))
    ActivityPush.objects.bulk_create(jobs, ignore_conflicts=True)



def eligible(job):
    now = timezone.now()
    person, device, group = job.participant, job.device, job.group
    if (now > job.created_at + timedelta(hours=1) or group.archived or person.removed
            or person.user_id != job.recipient_id or not job.recipient.is_active or not job.actor_id
            or job.recipient_id in review_ids() or job.actor_id in review_ids()
            or not group.participants.filter(user_id=job.actor_id, removed=False, user__is_active=True).exists()
            or not groups_for_actor(type(group).objects.filter(pk=group.pk), job.recipient).exists()):
        return False
    pref = NotificationPreference.objects.filter(user_id=job.recipient_id).first()
    if pref and (not pref.expense_updates or pref.updates_enabled_at and pref.updates_enabled_at > job.created_at):
        return False
    if (device.user_id != job.recipient_id or device.revision != job.device_revision or not device.ledger_updates
            or device.provider != settings.PUSH_PROVIDER or device.session.expire_date <= now
            or device.updated_at < now - timedelta(days=30)):
        return False
    user = get_session_user(SessionStore(session_key=device.session_id))
    if not user or user.pk != job.recipient_id:
        return False
    data = job.payload
    if job.kind in {"bill_updated", "bill_deleted"}:
        bill = group.expenses.filter(pk=data["expense_id"]).first()
        # Never send an old amount or a deletion that has since been restored.
        return bool(bill and bill.version == data["version"] + (job.kind == "bill_deleted")
                    and bill.deleted == (job.kind == "bill_deleted"))
    if job.kind == "payment_recorded":
        return group.settlements.filter(pk=data["settlement_id"], reversed=False,
            sender__removed=False, recipient__removed=False).exists()
    recipient = group.participants.filter(pk=data["recipient"], user_id=job.actor_id, removed=False).first()
    return bool(recipient and repayment(group, person.id, recipient.id) == int(data["amount"]))


def _claim():
    now = timezone.now()
    with transaction.atomic():
        job = ActivityPush.objects.select_for_update(skip_locked=True).filter(
            Q(state__in=["pending", "queued"], due_at__lte=now) | Q(state="sending", lease_until__lte=now)
        ).order_by("due_at", "id").first()
        if not job:
            return None
        if (job.first_attempt_at and not job.provider_id or job.attempts >= 8
                or now > job.created_at + timedelta(hours=1)):
            job.state, job.lease_until, job.last_error = "held", None, "delivery_uncertain"
            job.save(update_fields=["state", "lease_until", "last_error"])
            return job.id, None
        job.state, job.lease_id, job.lease_until = "sending", uuid4(), now + timedelta(minutes=2)
        job.save(update_fields=["state", "lease_id", "lease_until"])
        return job.id, job.lease_id


def send_activity_notifications(*, limit=100):
    processed = 0
    for _ in range(limit):
        claimed = _claim()
        if not claimed:
            break
        identifier, lease = claimed
        processed += 1
        if lease is None:
            continue
        job = ActivityPush.objects.select_related("group", "participant", "recipient", "device__session").filter(pk=identifier, lease_id=lease).first()
        current = ActivityPush.objects.filter(pk=identifier, lease_id=lease, state="sending", lease_until__gt=timezone.now())
        if not job or not current.exists():
            continue
        if not eligible(job):
            current.update(state="cancelled", lease_until=None, last_error="ineligible")
            continue
        if not current.update(first_attempt_at=job.first_attempt_at or timezone.now(), attempts=job.attempts + 1):
            continue
        try:
            if job.provider_id:
                if not push_provider.check_bill_notification_receipt(job.provider_id):
                    current.update(state="queued", due_at=timezone.now() + timedelta(minutes=15), lease_until=None)
                    continue
                ticket, state = job.provider_id, "sent"
            else:
                data = {"type": job.kind, "event_id": str(job.event_id), "recipient_user_id": str(job.recipient_id),
                        "group_id": str(job.group_id)}
                if "expense_id" in job.payload:
                    data["expense_id"] = job.payload["expense_id"]
                ticket = push_provider.send_bill_notification(job.device, data, **activity_content(job))
                state = "queued"
        except push_provider.PushFailure as error:
            if error.invalid_token:
                PushDevice.objects.filter(pk=job.device_id, revision=job.device_revision).delete()
            elif not job.provider_id and not error.permanent and (error.resend or error.code in {"http_429", "rate_limited"}):
                # An explicit rejection proves no push was accepted; a bounded retry is safe.
                current.update(state="pending", first_attempt_at=None, lease_until=None, last_error=error.code,
                    due_at=timezone.now() + timedelta(seconds=min(3600, 30 * 2 ** min(job.attempts, 7))))
            else:
                # A timeout can mean Expo accepted the push. Hold instead of duplicating it.
                current.update(state="queued" if job.provider_id and not error.permanent else "held",
                    due_at=timezone.now() + timedelta(minutes=15), lease_until=None, last_error=error.code)
        else:
            current.update(provider_id=ticket, state=state, lease_until=None, last_error="", due_at=timezone.now() + timedelta(minutes=15))
    return processed


@transaction.atomic
def send_payment_reminder(actor, group_id, payload):
    from .otp import EmailCodeLimited, consume_limits
    from .services import previous_result, visible_group, writable
    group = visible_group(actor, group_id, lock=True)
    previous, fingerprint = previous_result(actor, payload["command_id"], f"payment_reminder:{group_id}", payload)
    if previous:
        return previous
    writable(group)
    recipient = group.participants.get(user=actor, removed=False)
    sender = group.participants.filter(pk=payload["sender"], removed=False, user__is_active=True).first()
    if not sender or sender.user_id == actor.pk:
        raise HttpError(422, "Choose another member who owes you")
    amount = repayment(group, sender.id, recipient.id)
    if group.version != payload["group_version"] or amount <= 0 or amount != int(payload["amount"]):
        raise HttpError(409, "This balance changed. Refresh before sending a reminder.")
    from .push import registered_push_ids
    if (not PushDevice.objects.filter(pk__in=registered_push_ids(sender.user), ledger_updates=True).exists()
            or NotificationPreference.objects.filter(user=sender.user, expense_updates=False).exists()):
        raise HttpError(409, "This person hasn't enabled push reminders on a supported app yet.")
    try:
        consume_limits([("payment-reminder-pair", f"{actor.pk}:{sender.user_id}", 86400, 1),
                        ("payment-reminder-sender", str(actor.pk), 86400, 10)])
    except EmailCodeLimited:
        raise HttpError(429, "Reminder limit reached. Try again tomorrow.") from None
    result = {"id": str(group.id), "version": group.version}
    command = CommandReceipt.objects.create(actor=actor, command_id=payload["command_id"], fingerprint=fingerprint, result=result)
    _queue_targets(group, actor.pk, "payment_reminder", [(sender,
        {"sender": str(sender.id), "recipient": str(recipient.id), "amount": str(amount)})], command=command)
    return result
