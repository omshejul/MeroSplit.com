"""Opt-in calendar statements, using the existing worker and email dispatch fence."""

import base64
import hashlib
import json
from datetime import datetime, timedelta
from datetime import timezone as dt_timezone
from uuid import uuid4

from allauth.account.models import EmailAddress
from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from django.views.decorators.debug import sensitive_variables
from ninja.errors import HttpError

from . import email_delivery
from .expense_notifications import _locked_preference
from .models import BalanceStatement, CloudflareEmailDispatch, Group, NotificationPreference
from .otp import EmailCodeLimited, consume_limits
from .statement_csv import StatementTooLarge, financial_statement
from .store_review import groups_for_actor, review_ids

LEASE = timedelta(minutes=2)
MAX_WIRE_BYTES = 4 * 1024 * 1024  # Below the ordinary 5 MiB message limit, leaving MIME headroom.


def statement_recipient(actor):
    """Statements have explicit consent separate from bill-notice mailbox opt-outs."""
    if not actor.is_active:
        raise HttpError(401, "Sign in again to request a statement")
    if actor.pk in review_ids():
        raise HttpError(403, "Statements are unavailable for demo accounts")
    email = actor.email.strip().lower()
    domain = email.rpartition("@")[2]
    if not domain or domain == "invalid" or domain.endswith(".invalid"):
        raise HttpError(409, "Add a valid account email before requesting a statement")
    if not EmailAddress.objects.filter(user=actor, email__iexact=email, verified=True).exists():
        raise HttpError(409, "Verify your current account email by signing in with its email code, then try again")
    return email


def next_boundary(frequency, now):
    now = now.astimezone(dt_timezone.utc)
    if frequency == "weekly":
        return now.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=7 - now.weekday())
    return datetime(now.year + (now.month == 12), now.month % 12 + 1, 1, tzinfo=dt_timezone.utc)


def delivery_status(row):
    return {"id": str(row.id), "command_id": str(row.request_id) if row.request_id else None, "state": row.state, "error": row.last_error,
            "created_at": row.created_at.isoformat(), "accepted_at": row.accepted_at.isoformat() if row.accepted_at else None}


def preferences(actor):
    row = NotificationPreference.objects.filter(user=actor).first()
    latest = BalanceStatement.objects.filter(user=actor).order_by("-created_at", "-id").first()
    return {"enabled": row.balance_statements if row else False,
            "frequency": row.statement_frequency if row else "monthly",
            "next_at": row.statement_next_at.isoformat() if row and row.statement_next_at else None,
            "delivery": delivery_status(latest) if latest else None}


def reset_schedule(row, now):
    """Called under the account/preference lock on consent or frequency changes."""
    jobs = BalanceStatement.objects.filter(user_id=row.user_id).exclude(period_key="")
    jobs.filter(state="pending").update(state="cancelled", cancelled_at=now, payload={}, recipient_email="", last_error="preference_changed")
    # An in-flight POST cannot be recalled. Keep its lease for honest receipt reconciliation.
    jobs.filter(state="sending").update(cancelled_at=now)
    row.statement_next_at = next_boundary(row.statement_frequency, now) if row.balance_statements and row.expense_updates and row.email_reminders else None
    row.save(update_fields=["statement_next_at"])


@transaction.atomic
def update_preferences(actor, enabled, frequency):
    row = _locked_preference(actor)
    actor.refresh_from_db(fields=["email", "is_active"])
    if enabled:
        statement_recipient(actor)
    if (row.balance_statements, row.statement_frequency) != (enabled, frequency):
        row.balance_statements, row.statement_frequency = enabled, frequency
        row.save(update_fields=["balance_statements", "statement_frequency"])
        reset_schedule(row, timezone.now())
    return preferences(actor)


@transaction.atomic
def request_statement(actor, command_id):
    _locked_preference(actor)
    actor.refresh_from_db(fields=["email", "is_active"])
    existing = BalanceStatement.objects.filter(user=actor, request_id=command_id).first()
    if existing:
        return delivery_status(existing)
    statement_recipient(actor)
    try:
        consume_limits([("balance_statement", str(actor.pk), 600, 1), ("balance_statement", str(actor.pk), 86400, 5)])
    except EmailCodeLimited:
        raise HttpError(429, "Wait before requesting another statement") from None
    return delivery_status(BalanceStatement.objects.create(user=actor, request_id=command_id, due_at=timezone.now()))


def enqueue_due(limit):
    now = timezone.now()
    users = list(NotificationPreference.objects.filter(statement_next_at__lte=now).order_by("statement_next_at").values_list("user_id", flat=True)[:limit])
    for user_id in users:
        with transaction.atomic():
            from django.contrib.auth import get_user_model
            actor = get_user_model().objects.select_for_update(no_key=True).filter(pk=user_id, is_active=True).first()
            if not actor:
                continue
            pref = _locked_preference(actor)
            if not pref.statement_next_at or pref.statement_next_at > now:
                continue
            if pref.balance_statements and pref.expense_updates and pref.email_reminders:
                period = f"{pref.statement_frequency}:{pref.statement_next_at.date().isoformat()}"
                BalanceStatement.objects.get_or_create(user=actor, period_key=period, defaults={"due_at": now})
            if not (pref.balance_statements and pref.expense_updates and pref.email_reminders):
                reset_schedule(pref, now)
            if pref.balance_statements and pref.expense_updates and pref.email_reminders:
                pref.statement_next_at = next_boundary(pref.statement_frequency, now)
                pref.save(update_fields=["statement_next_at"])


def _visible_groups(actor):
    return groups_for_actor(Group.objects.filter(participants__user=actor, participants__removed=False), actor).order_by("id")


def _scope(actor, recipient):
    ids = list(_visible_groups(actor).values_list("id", flat=True))
    list(Group.objects.select_for_update().filter(id__in=ids).order_by("id"))
    groups = list(_visible_groups(actor).filter(id__in=ids))  # Recheck only the groups whose locks we hold.
    content = [recipient, [(str(group.id), group.version) for group in groups]]
    return groups, hashlib.sha256(json.dumps(content).encode()).hexdigest()


def _finish(row, state, reason="", provider_id=""):
    row.state, row.last_error, row.provider_id = state, reason, provider_id
    row.lease_id = row.lease_until = None
    if state == "accepted":
        row.accepted_at = timezone.now()
    if state == "cancelled":
        row.cancelled_at = timezone.now()
    if state != "pending":
        row.payload, row.recipient_email = {}, ""
    row.save()


@sensitive_variables()
def _prepare(job_id):
    from django.contrib.auth import get_user_model
    now = timezone.now()
    with transaction.atomic():
        user_id = BalanceStatement.objects.filter(pk=job_id).values_list("user_id", flat=True).first()
        actor = get_user_model().objects.select_for_update(no_key=True).filter(pk=user_id, is_active=True).first()
        if not actor or not actor.is_active:
            BalanceStatement.objects.filter(pk=job_id, state__in=["pending", "sending"]).update(state="cancelled", payload={}, recipient_email="", last_error="account_unavailable")
            return None
        pref = _locked_preference(actor)
        row = BalanceStatement.objects.select_for_update(skip_locked=True).filter(pk=job_id).first()
        if not row or row.state not in ["pending", "sending"] or row.due_at > now or row.lease_until and row.lease_until > now:
            return None
        fence = CloudflareEmailDispatch.objects.filter(pk=f"balance-statement:{row.id}").first()
        if fence and fence.state == "accepted":
            _finish(row, "accepted", provider_id=fence.provider_id)
            return None
        if fence and fence.state != "retryable":
            _finish(row, "held", "delivery_unknown")
            return None
        try:
            recipient = statement_recipient(actor)
        except HttpError:
            _finish(row, "cancelled", "no_longer_eligible")
            return None
        if row.cancelled_at or row.period_key and not (pref.balance_statements and pref.expense_updates and pref.email_reminders):
            _finish(row, "cancelled", "no_longer_eligible")
            return None
        groups, scope = _scope(actor, recipient)
        if row.payload and (row.scope_hash != scope or row.recipient_email != recipient):
            _finish(row, "cancelled", "scope_changed")
            return None
        if not row.payload:
            try:
                attachments, summary = financial_statement(groups, actor.pk)
                payload = email_delivery.message_payload(recipient, "Your MeroSplit balance statement",
                    f"Your balances as of {now.strftime('%d %b %Y')}\n\n{summary}\n\n"
                    "Balances.csv shows who owes or is owed in each group. Transactions.csv lists bills, payments and agreed starting balances. "
                    "All amounts are in Indian rupees. Reversed records keep their original amounts; the amount counted in balances is zero. "
                    "Payments are shared records, not bank verification.\n\nOpen MeroSplit: https://merosplit.com/app/")
                payload["_email_provider"] = "cloudflare"
                payload["attachments"] = [{"filename": filename, "content_type": "text/csv; charset=utf-8", "content": base64.b64encode(data).decode("ascii")}
                    for filename, data in attachments.items()]
                wire = email_delivery.cloudflare_payload({key: value for key, value in payload.items() if key != "_email_provider"}, f"balance-statement:{row.id}")
                if len(json.dumps(wire, sort_keys=True).encode()) > MAX_WIRE_BYTES:
                    raise StatementTooLarge()
            except StatementTooLarge:
                _finish(row, "failed", "too_big")
                return None
            row.payload, row.recipient_email, row.scope_hash = payload, recipient, scope
        if row.attempts >= 3:
            _finish(row, "failed", "delivery_unavailable")
            return None
        row.state, row.lease_id, row.lease_until = "sending", uuid4(), now + LEASE
        row.attempts += 1
        row.first_attempt_at = row.first_attempt_at or now
        row.save()
        return row


@sensitive_variables()
def send_balance_statements(*, limit=100):
    enqueue_due(limit)
    now = timezone.now()
    ids = list(BalanceStatement.objects.filter(Q(state="pending", due_at__lte=now) | Q(state="sending", lease_until__lte=now)).order_by("due_at", "id").values_list("id", flat=True)[:limit])
    for job_id in ids:
        row = _prepare(job_id)
        if row is None:
            continue
        provider_id, error = "", ""
        try:
            provider_id = email_delivery.send_email(row.recipient_email, row.payload["subject"], row.payload["text"], f"balance-statement:{row.id}", payload=row.payload)
        except email_delivery.EmailDeliveryHeld:
            error = "delivery_unknown"
        except email_delivery.EmailDeliveryUnavailable:
            error = "delivery_unavailable"
        with transaction.atomic():
            current = BalanceStatement.objects.select_for_update().filter(pk=row.id, state="sending", lease_id=row.lease_id).first()
            if current:
                if provider_id:
                    _finish(current, "accepted", provider_id=provider_id)
                else:
                    fence = CloudflareEmailDispatch.objects.filter(pk=f"balance-statement:{row.id}").first()
                    if fence and fence.state == "accepted":
                        _finish(current, "accepted", provider_id=fence.provider_id)
                    elif error == "delivery_unknown" or fence and fence.state not in ["retryable"]:
                        _finish(current, "held", "delivery_unknown")
                    elif current.cancelled_at:
                        _finish(current, "cancelled", "preference_changed")
                    else:
                        current.due_at = timezone.now() + timedelta(minutes=10)
                        _finish(current, "pending", error)
    return len(ids)
