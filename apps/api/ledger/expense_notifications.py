"""Account unread bills, exact seen acknowledgements and delayed email reminders."""

from datetime import timedelta
from urllib.parse import urlsplit
from uuid import UUID, uuid4

from allauth.account.models import EmailAddress
from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import Exists, OuterRef, Q
from django.utils import timezone
from ninja.errors import HttpError

from . import email_delivery
from .email_links import EXPIRY_PLACEHOLDER, LINK_PLACEHOLDER, activate_email_link, issue_email_link
from .models import (
    ExpenseDigest,
    ExpenseNotice,
    ExpensePushDelivery,
    Group,
    NotificationPreference,
    Participant,
)
from .store_review import groups_for_actor, review_ids

EMAIL_DELAY = timedelta(minutes=10)
LINK_LIFETIME = timedelta(hours=24)
PROVIDER_RETRY_WINDOW = timedelta(hours=24)


def preferences(actor):
    row = NotificationPreference.objects.filter(user=actor).first()
    return {"expense_updates": row.expense_updates if row else True,
            "email_reminders": row.email_reminders if row else False}


def _locked_preference(actor):
    if not get_user_model().objects.select_for_update(no_key=True).filter(pk=actor.pk, is_active=True).exists():
        raise HttpError(401, "Sign in again to change notifications")
    row, _ = NotificationPreference.objects.get_or_create(user=actor)
    return NotificationPreference.objects.select_for_update().get(pk=row.pk)


@transaction.atomic
def update_preferences(actor, expense_updates, email_reminders):
    row = _locked_preference(actor)
    now = timezone.now()
    if expense_updates and not row.expense_updates:
        row.updates_enabled_at = now
    if email_reminders and (not row.email_reminders or not row.expense_updates and expense_updates):
        row.email_enabled_at = now
    row.expense_updates, row.email_reminders = expense_updates, email_reminders
    row.save(update_fields=["expense_updates", "email_reminders", "email_enabled_at", "updates_enabled_at"])
    from .models import BillChatDelivery, BillChatNotice
    chat = BillChatNotice.objects.filter(recipient=actor)
    if not expense_updates:
        chat.update(push_eligible=False)
        BillChatDelivery.objects.filter(recipient=actor, channel='push', state__in=['pending', 'sending']).update(state='cancelled', lease_id=None, lease_until=None)
    if not expense_updates or not email_reminders:
        chat.update(email_eligible=False)
        BillChatDelivery.objects.filter(recipient=actor, channel='email', state__in=['pending', 'sending', 'held']).update(state='cancelled', lease_id=None, lease_until=None)
    notices = ExpenseNotice.objects.filter(recipient=actor)
    if not expense_updates:
        notices.filter(push_processed_at__isnull=True).update(push_processed_at=now)
        ExpensePushDelivery.objects.filter(recipient=actor, state__in=["pending", "sending"]).update(
            state="skipped", lease_id=None, lease_until=None, last_error="expense_updates_off")
    if not expense_updates or not email_reminders:
        from .bill_email import cancel_bill_emails
        from .bill_email_models import BillEmailNotice
        addresses = {actor.email.strip().lower(), *EmailAddress.objects.filter(user=actor, verified=True).values_list("email", flat=True)}
        cancel_bill_emails(BillEmailNotice.objects.filter(Q(issued_user_id=actor.pk) | Q(recipient_email__in=addresses)), "preference_off")
        notices.filter(email_eligible=True).update(email_eligible=False)
        ExpenseDigest.objects.filter(recipient=actor, state__in=["pending", "sending"]).update(
            state="cancelled", lease_id=None, lease_until=None, last_error="preference_off")
    return preferences(actor)


@transaction.atomic
def foreground(actor):
    row = _locked_preference(actor)
    now = timezone.now()
    if not row.foreground_at or row.foreground_at <= now - timedelta(minutes=5):
        row.foreground_at = now
        row.save(update_fields=["foreground_at"])
    return {"ok": True}


def cancel_notices(query, reason):
    """Deletion/archive is final for this creation event, even after restoration."""
    now = timezone.now()
    query.update(cancelled_at=now, email_eligible=False, push_processed_at=now)
    from .bill_email import cancel_bill_emails
    from .bill_email_models import BillEmailNotice
    cancel_bill_emails(BillEmailNotice.objects.filter(expense_id__in=query.values("expense_id")), reason)
    ExpensePushDelivery.objects.filter(event_id__in=query.values("id"), state__in=["pending", "sending"]).update(
        state="skipped", lease_id=None, lease_until=None, last_error=reason)


def eligible_notice(notice):
    return bool(_eligible_notices([notice]))


def _eligible_notices(rows):
    users = set(get_user_model().objects.filter(pk__in={row.recipient_id for row in rows} - review_ids(), is_active=True).values_list("pk", flat=True))
    actor = next((row.recipient for row in rows if row.recipient_id in users), None)
    if not actor:
        return []
    groups = set(groups_for_actor(Group.objects.filter(id__in=[row.expense.group_id for row in rows], archived=False), actor).values_list("id", flat=True))
    members = {(group, user): str(person) for group, user, person in Participant.objects.filter(group_id__in=groups, user_id__in=users, removed=False).values_list("group_id", "user_id", "id")}
    return [row for row in rows if not row.seen_at and not row.cancelled_at and not row.expense.deleted
            and (person := members.get((row.expense.group_id, row.recipient_id)))
            and (int(row.expense.paid.get(person, "0")) > 0 or int(row.expense.shares.get(person, "0")) > 0)]


def notice_feed(actor, limit=50, expense_ids=""):
    if not 1 <= limit <= 100:
        raise HttpError(422, "Choose a notification page size from 1 to 100")
    query = ExpenseNotice.objects.filter(recipient=actor, seen_at__isnull=True, cancelled_at__isnull=True)
    if expense_ids:
        try:
            if len(expense_ids) > 1850:
                raise ValueError()
            supplied = expense_ids.split(",")
            if len(supplied) > 50:
                raise ValueError()
            query = query.filter(expense_id__in=[UUID(value) for value in supplied])
        except (ValueError, TypeError) as exc:
            raise HttpError(422, "Choose up to 50 bill IDs") from exc
    rows = list(query
                .select_related("expense__group", "recipient").order_by("-created_at", "-id")[:limit + 1])
    valid, cancelled = [], []
    allowed = {row.id for row in _eligible_notices(rows)}
    for notice in rows:
        if notice.id in allowed:
            valid.append({"id": str(notice.id), "group_id": str(notice.expense.group_id), "expense_id": str(notice.expense_id),
                          "expense_version": notice.expense_version, "created_at": notice.created_at.isoformat()})
        else:
            cancelled.append(notice.id)
    if cancelled:
        ExpenseNotice.objects.filter(id__in=cancelled).update(cancelled_at=timezone.now(), email_eligible=False)
    return {"notices": valid[:limit], "has_more": len(rows) > limit}


@transaction.atomic
def mark_seen(actor, notices):
    # Group locks make the accepted revision check serialize with bill edits/removal.
    requested = {item["id"]: item["expense_version"] for item in notices}
    candidates = ExpenseNotice.objects.filter(id__in=requested, recipient=actor, seen_at__isnull=True, cancelled_at__isnull=True)
    group_ids = candidates.values_list("expense__group_id", flat=True)
    list(Group.objects.filter(id__in=group_ids).order_by("id").select_for_update())
    rows = list(candidates.select_related("expense__group", "recipient").select_for_update(of=("self",)))
    ids = [row.id for row in _eligible_notices(rows) if row.expense.version == requested[str(row.id)] and row.expense.version >= row.expense_version]
    now = timezone.now()
    count = ExpenseNotice.objects.filter(id__in=ids, seen_at__isnull=True).update(seen_at=now, email_eligible=False)
    ExpensePushDelivery.objects.filter(expense_id__in=[row.expense_id for row in rows if row.id in ids], recipient=actor,
                                      state__in=["pending", "sending"]).update(state="skipped", lease_id=None, lease_until=None, last_error="seen")
    return {"seen": count}


def verified_recipient(user):
    email = user.email.strip().lower()
    from .bill_email import mailbox_digest
    from .bill_email_models import BillEmailPreference
    if BillEmailPreference.objects.filter(email_digest=mailbox_digest(email), suppressed=True).exists():
        return None
    domain = email.rpartition("@")[2]
    if not user.is_active or user.pk in review_ids() or not domain or domain == "invalid" or domain.endswith(".invalid"):
        return None
    return email if EmailAddress.objects.filter(user=user, email__iexact=email, verified=True).exists() else None


def _unmailed(now):
    return ExpenseNotice.objects.filter(email_eligible=True, digest__isnull=True, seen_at__isnull=True,
                                        cancelled_at__isnull=True, email_policy=1, created_at__lte=now - EMAIL_DELAY)


def create_due_digest():
    now = timezone.now()
    with transaction.atomic():
        pref = (NotificationPreference.objects.select_for_update(skip_locked=True, of=("self",))
                .filter(expense_updates=True, email_reminders=True, email_enabled_at__isnull=False)
                .filter(Exists(_unmailed(now).filter(recipient_id=OuterRef("user_id"), created_at__gte=OuterRef("email_enabled_at"))))
                .exclude(Exists(ExpenseDigest.objects.filter(recipient_id=OuterRef("user_id"), email_policy=1, state__in=["pending", "sending", "held"])))
                .select_related("user").order_by("user_id").first())
        if not pref:
            return None
        email = verified_recipient(pref.user)
        rows = list(_unmailed(now).filter(recipient_id=pref.user_id, created_at__gte=pref.email_enabled_at)
                    .select_related("expense__group", "recipient").select_for_update(of=("self",)).order_by("created_at", "id")[:100]) if pref.email_enabled_at else []
        eligible, discarded = [], []
        allowed = {row.id for row in _eligible_notices(rows)} if email else set()
        for row in rows:
            (eligible if row.id in allowed else discarded).append(row.id)
        if discarded:
            ExpenseNotice.objects.filter(id__in=discarded).update(email_eligible=False)
        if not eligible:
            return None
        origin = urlsplit(settings.PUBLIC_WEB_URL)
        if (origin.scheme != "https" or not origin.netloc or origin.username or origin.password
                or origin.query or origin.fragment or origin.path not in {"", "/"}):
            return None
        identifier = uuid4()
        grant = issue_email_link(email, purpose="digest", target={"kind": "home"}, source_key=f"expense-digest/{identifier}")
        text, html = email_delivery.render_message("expense_digest", {"app_url": LINK_PLACEHOLDER, "expires_at": EXPIRY_PLACEHOLDER})
        payload = email_delivery.message_payload(email, "You have unread updates in MeroSplit", text, html)
        payload["_email_link_id"] = str(grant.id)
        digest = ExpenseDigest.objects.create(id=identifier, recipient=pref.user, recipient_email=email, due_at=now, payload=payload)
        ExpenseNotice.objects.filter(id__in=eligible).update(digest=digest)
        return digest.id


def _digest_still_eligible(digest):
    now = timezone.now()
    pref = NotificationPreference.objects.select_related("user").filter(user_id=digest.recipient_id, expense_updates=True, email_reminders=True).first()
    if not pref or verified_recipient(pref.user) != digest.recipient_email:
        return False
    rows = list(digest.notices.select_related("expense__group", "recipient"))
    return any(row.email_eligible and row.email_policy == 1 and row.created_at <= now - EMAIL_DELAY for row in _eligible_notices(rows))


def _cancel_digest(current):
    current.update(state="cancelled", lease_id=None, lease_until=None, last_error="ineligible")


def claim_digest():
    now = timezone.now()
    with transaction.atomic():
        row = (ExpenseDigest.objects.select_for_update(skip_locked=True)
               .filter(Q(state="pending", due_at__lte=now) | Q(state="sending", lease_until__lte=now))
               .order_by("due_at", "id").first())
        if not row:
            return None
        if row.first_attempt_at and (now >= row.first_attempt_at + PROVIDER_RETRY_WINDOW or row.attempts >= 8):
            row.state, row.last_error, row.lease_until = "held", "ambiguous_delivery", None
            row.save(update_fields=["state", "last_error", "lease_until"])
            return row.id, None
        row.lease_id, row.lease_until, row.state = uuid4(), now + timedelta(minutes=2), "sending"
        row.save(update_fields=["lease_id", "lease_until", "state"])
        return row.id, row.lease_id


def send_pending_digests(*, limit=100):
    processed = 0
    for _ in range(limit):
        create_due_digest()
        claimed = claim_digest()
        if not claimed:
            break
        digest_id, lease_id = claimed
        if not lease_id:
            processed += 1
            continue
        row = ExpenseDigest.objects.select_related("recipient").filter(id=digest_id, lease_id=lease_id, state="sending").first()
        if not row:
            continue
        current = ExpenseDigest.objects.filter(id=digest_id, lease_id=lease_id, state="sending", lease_until__gt=timezone.now())
        if not _digest_still_eligible(row):
            _cancel_digest(current)
            processed += 1
            continue
        if not row.first_attempt_at:
            # Discard invalid entries before the first provider attempt; never reassign them.
            notices = list(row.notices.select_related("expense__group", "recipient"))
            allowed = {notice.id for notice in _eligible_notices(notices) if notice.email_eligible}
            ExpenseNotice.objects.filter(pk__in=[notice.id for notice in notices if notice.id not in allowed]).update(digest=None, email_eligible=False)
        with transaction.atomic():
            locked = current.select_for_update().first()
            if not locked:
                continue
            now = timezone.now()
            current.update(first_attempt_at=row.first_attempt_at or now, attempts=row.attempts + 1)
            # Expiry starts with the first eligible attempt, never while work is deferred.
            if not _digest_still_eligible(row) or not current.filter(lease_until__gt=timezone.now()).exists():
                _cancel_digest(current)
                processed += 1
                continue
            if link_id := row.payload.get("_email_link_id"):
                activate_email_link(link_id, (locked.first_attempt_at or now) + LINK_LIFETIME)
        try:
            provider_id = email_delivery.send_email(row.recipient_email, row.payload["subject"], row.payload["text"],
                                                    f"expense-digest/{row.id}", payload=row.payload)
        except email_delivery.EmailDeliveryUnavailable as error:
            current.update(state="held" if isinstance(error, email_delivery.EmailDeliveryHeld) else "pending", due_at=timezone.now() + timedelta(minutes=min(60, 2 ** row.attempts)),
                           lease_until=None, last_error="delivery_uncertain")
        else:
            with transaction.atomic():
                pref = NotificationPreference.objects.select_for_update().filter(user_id=row.recipient_id).first()
                # A concurrent seen/off can cancel retries after submission, but
                # cannot undo provider acceptance. Keep that receipt honestly.
                accepted = ExpenseDigest.objects.filter(pk=row.pk).exclude(state="accepted").update(
                    state="accepted", provider_id=provider_id, accepted_at=timezone.now(), lease_until=None, last_error="")
                if accepted and pref:
                    pref.last_digest_at = timezone.now()
                    pref.save(update_fields=["last_digest_at"])
        processed += 1
    return processed
