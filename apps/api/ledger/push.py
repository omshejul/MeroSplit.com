"""Device ownership and the committed new-bill notification outbox."""

import hashlib
from datetime import timedelta
from uuid import uuid4

from allauth.core.internal.sessionkit import get_session_user
from allauth.headless import app_settings
from config.sessions import SessionStore
from django.conf import settings
from django.contrib.auth import get_user_model
from django.contrib.sessions.models import Session
from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from ninja.errors import HttpError

from .models import ExpenseNotice, ExpensePushDelivery, Group, NotificationPreference, Participant, PushDevice
from .store_review import groups_for_actor, review_ids


def register_device(request, installation_id, payload):
    if not settings.PUSH_PROVIDER or payload["provider"] != settings.PUSH_PROVIDER:
        raise HttpError(503, "Push notifications are not configured for this provider")
    payload = dict(payload)
    bill_chat = payload.pop("bill_chat", False)
    token = request.headers.get("X-Session-Token")
    session = app_settings.TOKEN_STRATEGY.lookup_session(token) if token else request.session
    user = get_session_user(session) if session else None
    if not user or user.pk != request.auth.pk:
        raise HttpError(401, "Sign in again to register this device")
    with transaction.atomic():
        # Serialize with account deletion and logout before retaining a registration.
        actor = get_user_model().objects.select_for_update(no_key=True).filter(pk=request.auth.pk).first()
        if not actor:
            raise HttpError(401, "Sign in again to register this device")
        session_row = (
            Session.objects.select_for_update()
            .filter(session_key=session.session_key, expire_date__gt=timezone.now())
            .first()
        )
        if not actor.is_active or not session_row:
            raise HttpError(401, "Sign in again to register this device")
        token_hash = hashlib.sha256(payload["token"].encode()).hexdigest()
        # Lock both identities in a stable order; unique constraints also protect first registration races.
        devices = list(
            PushDevice.objects.select_for_update()
            .filter(Q(id=installation_id) | Q(provider=payload["provider"], token_hash=token_hash))
            .order_by("id")
        )
        device = next((item for item in devices if item.id == installation_id), None)
        for old in devices:
            if old.id != installation_id:
                old.delete()  # A refreshed installation owns this exact native token now.
        binding = {
            "user_id": request.auth.pk,
            "session_id": session_row.pk,
            "token_hash": token_hash,
            **payload,
        }
        if device:
            device.bill_chat = bill_chat
            if any(getattr(device, key) != value for key, value in binding.items()):
                device.revision += 1
                for key, value in binding.items():
                    setattr(device, key, value)
                device.save()
            else:
                device.save(update_fields=["updated_at", "bill_chat"])
        else:
            device = PushDevice.objects.create(id=installation_id, bill_chat=bill_chat, **binding)
    return {"id": str(device.id), "enabled": True}


@transaction.atomic
def remove_device(actor, installation_id):
    # Lock before Django collects cascading deliveries, including a concurrent enqueue.
    device = PushDevice.objects.select_for_update().filter(id=installation_id, user=actor).first()
    if device:
        device.delete()
    return {"removed": True}


def queue_new_bill(expense, actor):
    """Called only by the normal CREATE transaction, never imports or edits."""
    now = timezone.now()
    members = Participant.objects.filter(
        group=expense.group, user__is_active=True, removed=False,
    ).exclude(user=actor).exclude(user_id__in=review_ids())
    recipients = {person.user_id for person in members if int(expense.paid.get(str(person.id), "0")) > 0 or int(expense.shares.get(str(person.id), "0")) > 0}
    prefs = {row.user_id: row for row in NotificationPreference.objects.filter(user_id__in=recipients)}
    notices = []
    for recipient in recipients:
        pref = prefs.get(recipient)
        enabled = not pref or pref.expense_updates
        notices.append(ExpenseNotice(expense=expense, recipient_id=recipient, expense_version=expense.version,
            created_at=now, push_due_at=now + timedelta(seconds=30), push_processed_at=None if enabled else now,
            email_policy=1, email_eligible=bool(enabled and pref and pref.email_reminders and pref.email_enabled_at)))
    ExpenseNotice.objects.bulk_create(notices)
    from .bill_email import queue_bill_emails
    queue_bill_emails(expense, actor)
    # Reserve existing bindings inside the bill transaction; grace-time fanout
    # also captures newly available routes once, without replay on later registration.
    _queue_devices(notices, now)


def _queue_devices(notices, now):
    targets = {}
    for notice in notices:
        if not notice.push_processed_at and not notice.seen_at and not notice.cancelled_at:
            targets.setdefault(notice.recipient_id, []).append(notice)
    if not targets:
        return
    # Bill creation already holds the group lock. Rebinding/revocation must not
    # remove a selected device between this read and the delivery FK insert.
    devices = PushDevice.objects.select_for_update(of=("self",)).filter(
        user_id__in=targets, session__expire_date__gt=now, updated_at__gte=now - timedelta(days=30)
    ).order_by("id")
    ExpensePushDelivery.objects.bulk_create(
        [
            ExpensePushDelivery(
                expense_id=notice.expense_id,
                recipient_id=device.user_id,
                device=device,
                device_revision=device.revision,
                event_id=notice.id,
                due_at=notice.push_due_at,
            )
            for device in devices
            for notice in targets[device.user_id]
        ], ignore_conflicts=True,
    )


def fanout_due_notices(*, limit=100):
    from .expense_notifications import _eligible_notices
    now = timezone.now()
    with transaction.atomic():
        notices = list(ExpenseNotice.objects.select_for_update(skip_locked=True, of=("self",))
            .filter(push_processed_at__isnull=True, push_due_at__lte=now)
            .select_related("expense__group", "recipient").order_by("push_due_at", "id")[:limit])
        disabled = set(NotificationPreference.objects.filter(user_id__in=[notice.recipient_id for notice in notices], expense_updates=False).values_list("user_id", flat=True))
        _queue_devices([notice for notice in _eligible_notices(notices) if notice.recipient_id not in disabled], now)
        ExpenseNotice.objects.filter(id__in=[notice.id for notice in notices]).update(push_processed_at=now)
    return len(notices)


def eligible_delivery(delivery):
    from .expense_notifications import eligible_notice, preferences
    device, expense = delivery.device, delivery.expense
    notice = ExpenseNotice.objects.select_related("expense__group", "recipient").filter(expense=expense, recipient_id=delivery.recipient_id).first()
    if not notice or notice.push_due_at > timezone.now() or not eligible_notice(notice) or not preferences(delivery.recipient)["expense_updates"]:
        return False
    if review_ids() and not groups_for_actor(Group.objects.filter(pk=expense.group_id), delivery.recipient).exists():
        return False
    if (
        not PushDevice.objects.filter(
            pk=device.pk, user_id=delivery.recipient_id, revision=delivery.device_revision
        ).exists()
        or device.user_id != delivery.recipient_id
        or device.revision != delivery.device_revision
        or device.provider != settings.PUSH_PROVIDER
        or not delivery.recipient.is_active
        or expense.deleted
        or expense.group.archived
        or device.session.expire_date <= timezone.now()
        or device.updated_at < timezone.now() - timedelta(days=30)
        or not Participant.objects.filter(
            group=expense.group, user_id=delivery.recipient_id, removed=False,
        ).exists()
    ):
        return False
    user = get_session_user(SessionStore(session_key=device.session_id))
    return bool(user and user.pk == delivery.recipient_id)


def claim_delivery():
    now = timezone.now()
    with transaction.atomic():
        delivery = (
            ExpensePushDelivery.objects.select_for_update(skip_locked=True)
            .filter(Q(state="pending", due_at__lte=now) | Q(state="sending", lease_until__lte=now))
            .order_by("due_at", "id")
            .first()
        )
        if not delivery:
            return None
        if delivery.attempts >= 8:
            delivery.state = "failed"
            delivery.last_error = "lease_retry_exhausted"
            delivery.lease_until = None
            delivery.save(update_fields=["state", "last_error", "lease_until"])
            return None
        delivery.state = "sending"
        delivery.attempts += 1
        delivery.lease_id = uuid4()
        delivery.lease_until = now + timedelta(minutes=2)
        delivery.save(update_fields=["state", "attempts", "lease_id", "lease_until"])
        return delivery.id, delivery.lease_id


def send_pending_bill_notifications(*, limit=100):
    # Import the single selected provider here; no network runs in ledger transactions.
    from .push_provider import PushFailure, send_bill_notification

    fanout_due_notices(limit=limit)
    processed = 0
    for _ in range(limit):
        claimed = claim_delivery()
        if not claimed:
            break
        delivery_id, lease_id = claimed
        delivery = (
            ExpensePushDelivery.objects.select_related("device__session", "expense__group", "recipient")
            .filter(id=delivery_id, lease_id=lease_id)
            .first()
        )
        if not delivery:
            continue  # Logout/rebinding may have removed the device and its deliveries.
        current = ExpensePushDelivery.objects.filter(id=delivery_id, lease_id=lease_id)
        if not eligible_delivery(delivery):
            current.update(state="skipped", last_error="ineligible", lease_until=None)
            processed += 1
            continue
        data = {
            "type": "new_bill",
            "event_id": str(delivery.event_id),
            "notice_id": str(delivery.event_id),
            "recipient_user_id": str(delivery.recipient_id),
            "group_id": str(delivery.expense.group_id),
            "expense_id": str(delivery.expense_id),
        }
        notice = ExpenseNotice.objects.filter(pk=delivery.event_id).first()
        if not notice or not current.filter(state="sending", lease_until__gt=timezone.now()).exists():
            continue
        data["expense_version"] = notice.expense_version
        try:
            provider_id = send_bill_notification(delivery.device, data)
        except PushFailure as error:
            if error.invalid_token:
                PushDevice.objects.filter(id=delivery.device_id, revision=delivery.device_revision).delete()
                current.update(state="skipped", last_error=error.code, lease_until=None)
            else:
                current.update(
                    state="failed" if error.permanent or delivery.attempts >= 8 else "pending",
                    due_at=timezone.now() + timedelta(seconds=min(3600, 30 * 2 ** min(delivery.attempts, 7))),
                    last_error=error.code,
                    lease_until=None,
                )
        else:
            # Seen/off may commit while the provider is already handling this
            # request. Retain its ticket; subsequent work only polls the receipt.
            ExpensePushDelivery.objects.filter(id=delivery_id, provider_id="").update(
                state="queued",
                provider_id=provider_id[:200],
                ticketed_at=timezone.now(),
                due_at=timezone.now() + timedelta(minutes=15),
                receipt_attempts=0,
                last_error="",
                lease_until=None,
            )
        processed += 1
    return processed


def check_pending_bill_receipts(*, limit=100):
    from .push_provider import PushFailure, check_bill_notification_receipt

    processed = 0
    for _ in range(limit):
        now = timezone.now()
        with transaction.atomic():
            delivery = (
                ExpensePushDelivery.objects.select_for_update(skip_locked=True)
                .filter(Q(state="queued", due_at__lte=now) | Q(state="checking", lease_until__lte=now))
                .order_by("due_at", "id")
                .first()
            )
            if not delivery:
                break
            delivery.state = "checking"
            delivery.receipt_attempts += 1
            delivery.lease_id = uuid4()
            delivery.lease_until = now + timedelta(minutes=2)
            delivery.save(update_fields=["state", "receipt_attempts", "lease_id", "lease_until"])
        current = ExpensePushDelivery.objects.filter(id=delivery.id, lease_id=delivery.lease_id)
        # A receipt lookup submits only the already-accepted ticket ID, never a new notification.
        try:
            received = check_bill_notification_receipt(delivery.provider_id)
        except PushFailure as error:
            if error.invalid_token:
                PushDevice.objects.filter(id=delivery.device_id, revision=delivery.device_revision).delete()
                current.update(state="skipped", last_error=error.code, lease_until=None)
            elif error.resend:
                current.update(
                    state="failed" if error.permanent or delivery.attempts >= 8 else "pending",
                    due_at=now + timedelta(seconds=min(3600, 30 * 2 ** min(delivery.attempts, 7))),
                    provider_id="",
                    ticketed_at=None,
                    lease_until=None,
                    last_error=error.code,
                )
            else:
                expired = now - delivery.ticketed_at >= timedelta(hours=24)
                current.update(
                    state="failed" if error.permanent or expired else "queued",
                    due_at=now + timedelta(minutes=15),
                    lease_until=None,
                    last_error=error.code,
                )
        else:
            expired = now - delivery.ticketed_at >= timedelta(hours=24)
            current.update(
                state="sent" if received else ("failed" if expired else "queued"),
                sent_at=now if received else None,
                due_at=now + timedelta(minutes=15),
                lease_until=None,
                last_error="" if received else "receipt_unavailable",
            )
        processed += 1
    return processed
