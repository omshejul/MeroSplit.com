"""Bounded title-only icon hints. Never writes financial versions or events."""

import hashlib
import hmac
from datetime import timedelta
from uuid import UUID

from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from ninja.errors import HttpError

from .category_gateway import CATEGORIES, DEFINITION_REVISION, CategoryUnavailable, evaluate_title
from .models import Expense, ExpenseCategoryDecision
from .services import visible_group


def title_digest(title):
    return hmac.new(settings.SECRET_KEY.encode(), title.encode(), hashlib.sha256).hexdigest()


def automatic(expense):
    # Om explicitly authorized older unknown General/Other values for cosmetic inference.
    return (
        not expense.deleted
        and expense.description not in {"Deleted bill", "Removed content"}
        and expense.category_auto is not False
        and expense.category.strip().casefold() in {"", "general", "other"}
    )


def manual_category(value):
    key = "".join(c for c in value.casefold() if c.isalpha())
    aliases = {
        "foodanddrink": "food",
        "diningout": "food",
        "electricity": "utilities",
        "gas": "utilities",
        "transportation": "transport",
        "hotel": "travel",
        "medicine": "health",
        "medical": "health",
    }
    return aliases.get(key, key if key in CATEGORIES else "general")


@transaction.atomic
def expense_icons(actor, identifiers):
    try:
        ids = [UUID(value) for value in identifiers.split(",") if value]
    except (ValueError, AttributeError):
        raise HttpError(422, "Choose valid expenses") from None
    if not 1 <= len(ids) <= 20 or len(set(ids)) != len(ids):
        raise HttpError(422, "Choose 1 to 20 expenses")
    expenses = list(Expense.objects.filter(pk__in=ids).select_related("group"))
    if len(expenses) != len(ids):
        raise HttpError(404, "Expenses unavailable")
    # Authorize the whole bounded batch before creating any cosmetic work.
    try:
        for group_id in sorted({row.group_id for row in expenses}):
            group = visible_group(actor, group_id, lock=True)
            if group.participants.filter(user=actor, hidden=True).exists():
                raise HttpError(404, "Expenses unavailable")
    except HttpError:
        raise HttpError(404, "Expenses unavailable") from None
    # Values read before the locks may predate a concurrent edit or manual choice.
    locked_groups = {row.group_id for row in expenses}
    expenses = list(Expense.objects.filter(pk__in=ids, group_id__in=locked_groups))
    if len(expenses) != len(ids):
        raise HttpError(404, "Expenses unavailable")
    eligible = {row.pk: title_digest(row.description) for row in expenses if automatic(row)}
    current = Q(pk__in=[])
    for expense_id, digest in eligible.items():
        current |= Q(expense_id=expense_id, title_digest=digest, definition_revision=DEFINITION_REVISION)
    ExpenseCategoryDecision.objects.filter(expense_id__in=ids, state="pending").exclude(current).update(
        state="stale", last_error="title_or_mode_changed"
    )
    ExpenseCategoryDecision.objects.bulk_create(
        [
            ExpenseCategoryDecision(
                expense_id=expense_id,
                title_digest=digest,
                definition_revision=DEFINITION_REVISION,
                requested_by=actor,
            )
            for expense_id, digest in eligible.items()
        ],
        ignore_conflicts=True,
    )
    ExpenseCategoryDecision.objects.filter(current, state="stale").update(
        state="pending", requested_by=actor, last_error=""
    )
    cached = {row.expense_id: row for row in ExpenseCategoryDecision.objects.filter(current)}
    return {
        "items": [
            {
                "id": str(row.pk),
                "group_id": str(row.group_id),
                "title": row.description,
                "category": manual_category(row.category)
                if not automatic(row)
                else cached[row.pk].category or None,
                "state": "manual"
                if not automatic(row)
                else "pending"
                if cached[row.pk].state in {"pending", "claimed"}
                else cached[row.pk].state,
            }
            for row in expenses
        ]
    }


def _available(actor_id, expense_id):
    actor = get_user_model().objects.filter(pk=actor_id, is_active=True).first()
    expense = Expense.objects.filter(pk=expense_id).first()
    if not actor or not expense:
        return None
    try:
        group = visible_group(actor, expense.group_id, lock=True)
        if group.participants.filter(user=actor, hidden=True).exists():
            return None
    except HttpError:
        return None
    # Reread after the group lock, which also serializes edits/deletion/membership changes.
    return group.expenses.get(pk=expense_id)


@transaction.atomic
def _claim(identifier):
    candidate = ExpenseCategoryDecision.objects.filter(pk=identifier).first()
    if not candidate or candidate.state != "pending":
        return None
    expense = _available(candidate.requested_by_id, candidate.expense_id)
    row = (
        ExpenseCategoryDecision.objects.select_for_update(skip_locked=True)
        .filter(pk=identifier, state="pending")
        .first()
    )
    if not row or row.requested_by_id != candidate.requested_by_id:
        return None
    if (
        not expense
        or not automatic(expense)
        or title_digest(expense.description) != row.title_digest
        or row.definition_revision != DEFINITION_REVISION
    ):
        row.state = "stale"
        row.last_error = "not_eligible"
        row.save(update_fields=["state", "last_error"])
        return None
    row.state = "claimed"
    row.lease_until = timezone.now() + timedelta(seconds=20)
    row.save(update_fields=["state", "lease_until"])
    return row, expense.description


@transaction.atomic
def _finish(claim, category, state, error):
    expense = _available(claim.requested_by_id, claim.expense_id)
    row = ExpenseCategoryDecision.objects.select_for_update().filter(pk=claim.pk, state="claimed").first()
    if not row:
        return
    if (
        not expense
        or not automatic(expense)
        or title_digest(expense.description) != claim.title_digest
        or row.requested_by_id != claim.requested_by_id
        or row.definition_revision != DEFINITION_REVISION
        or not row.lease_until
        or row.lease_until <= timezone.now()
    ):
        category, state, error = None, "uncertain", "scope_changed"
    row.category = category or ""
    row.state = state
    row.last_error = error
    row.lease_until = None
    row.save(update_fields=["category", "state", "last_error", "lease_until"])


def process_category_decisions(*, evaluate=None):
    key = settings.AI_GATEWAY_API_KEY
    if not key:
        return 0
    # An abandoned request may have reached the provider. Never silently spend twice.
    ExpenseCategoryDecision.objects.filter(state="claimed", lease_until__lte=timezone.now()).update(
        state="uncertain", category="", last_error="abandoned_claim", lease_until=None
    )
    identifier = (
        ExpenseCategoryDecision.objects.filter(state="pending")
        .order_by("id")
        .values_list("pk", flat=True)
        .first()
    )
    if identifier is None or not (claim := _claim(identifier)):
        return 0
    row, title = claim
    try:
        category = (evaluate or evaluate_title)(title, key)
        if category not in CATEGORIES or category == "general":
            category = None
        state, error = ("ready" if category else "uncertain"), ""
    except CategoryUnavailable as cause:
        code = str(cause)
        category, state, error = (
            None,
            "failed",
            code if code.startswith("gateway_http_") and code[13:].isdigit() else "gateway_unavailable",
        )
    except Exception:
        category, state, error = None, "failed", "gateway_unavailable"
    _finish(row, category, state, error)
    return 1
