"""Bounded title-only icon hints. Never writes financial versions or events."""

import hashlib
import hmac
import unicodedata
from datetime import timedelta
from uuid import UUID

from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import F, Q
from django.utils import timezone
from ninja.errors import HttpError

from .category_gateway import CATEGORIES, DEFINITION_REVISION, CategoryUnavailable, evaluate_title
from .models import Expense, ExpenseCategoryCache, ExpenseCategoryDecision
from .services import visible_group


def title_digest(title):
    return hmac.new(settings.SECRET_KEY.encode(), title.encode(), hashlib.sha256).hexdigest()


NORMALIZATION_VERSION = "nfc-casefold-space-v1"
UNRESOLVED = {"abandoned_claim", "scope_changed", "legacy_dispatch"}
TERMINAL = {"ready", "failed", "uncertain"}


def normalized_title(title):
    return " ".join(unicodedata.normalize("NFC", unicodedata.normalize("NFC", title).casefold()).split())


def cache_revision():
    return hashlib.sha256(f"{NORMALIZATION_VERSION}:{DEFINITION_REVISION}".encode()).hexdigest()


def normalized_digest(title):
    return title_digest(normalized_title(title))


def _binding(actor, expense):
    """The reader owns this cache, even when someone else created the shared-group bill."""
    raw, revision, now = title_digest(expense.description), cache_revision(), timezone.now()
    legacy = ExpenseCategoryDecision.objects.filter(
        expense=expense, requested_by=actor, title_digest=raw, cache__isnull=True,
        definition_revision__in=[DEFINITION_REVISION, revision],
    ).first()
    state = legacy.state if legacy and legacy.state in TERMINAL else "pending"
    error = legacy.last_error if legacy else ""
    if legacy and legacy.state == "claimed":
        state, error = "uncertain", "legacy_dispatch"
    cache, _ = ExpenseCategoryCache.objects.select_for_update().get_or_create(
        owner=actor, title_digest=normalized_digest(expense.description), definition_revision=revision,
        defaults={"state": state, "last_error": error, "category": legacy.category if legacy and state == "ready" else ""},
    )
    row, _ = ExpenseCategoryDecision.objects.get_or_create(
        expense=expense, requested_by=actor, title_digest=raw, definition_revision=revision,
        defaults={"cache": cache},
    )
    row = ExpenseCategoryDecision.objects.select_for_update().get(pk=row.pk)
    if row.last_error in UNRESOLVED:
        state, error = "uncertain", row.last_error
    if (legacy or row.last_error in UNRESOLVED) and state in TERMINAL and cache.state == "pending":
        cache.state, cache.last_error = state, error
        cache.category = legacy.category if legacy and state == "ready" else ""
    cache.last_used_at = now
    cache.save(update_fields=["state", "category", "last_error", "last_used_at"])
    # A claimed shared job is pending for other bills; only its actual dispatch binding owns a lease.
    state = cache.state if cache.state != "claimed" else "claimed" if row.state == "claimed" else "pending"
    if row.last_error in UNRESOLVED or legacy and (legacy.state == "claimed" or legacy.last_error in UNRESOLVED):
        state, error = "uncertain", row.last_error if row.last_error in UNRESOLVED else "legacy_dispatch"
    else:
        error = cache.last_error
    row.cache, row.last_used_at = cache, now
    row.state, row.category, row.last_error = state, cache.category if state == "ready" else "", error
    row.save(update_fields=["cache", "last_used_at", "state", "category", "last_error"])
    return row


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
    current_ids, items = [], []
    # All batches acquire shared cache keys in the same order, including disjoint groups.
    for expense in sorted(expenses, key=lambda row: (normalized_digest(row.description), str(row.pk))):
        if automatic(expense):
            row = _binding(actor, expense)
            current_ids.append(row.pk)
            category, state = row.category or None, "pending" if row.state == "claimed" else row.state
        else:
            category, state = manual_category(expense.category), "manual"
        items.append({"id": str(expense.pk), "group_id": str(expense.group_id),
                      "title": expense.description, "category": category, "state": state})
    ExpenseCategoryDecision.objects.filter(expense_id__in=ids, requested_by=actor, state="pending").exclude(pk__in=current_ids).update(
        state="stale", last_error="title_or_mode_changed")
    return {"items": items}


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


def _matches(row, expense, cache):
    return (expense is not None and automatic(expense)
            and row.requested_by_id == cache.owner_id
            and title_digest(expense.description) == row.title_digest
            and normalized_digest(expense.description) == cache.title_digest
            and row.definition_revision == cache.definition_revision == cache_revision())


@transaction.atomic
def _claim(identifier):
    candidate = ExpenseCategoryDecision.objects.filter(pk=identifier, cache__isnull=False).first()
    if not candidate or candidate.state != "pending":
        return None
    expense = _available(candidate.requested_by_id, candidate.expense_id)
    cache = ExpenseCategoryCache.objects.select_for_update(skip_locked=True).filter(pk=candidate.cache_id, state="pending").first()
    if not cache:
        return None
    # Deletion may hold the binding before its cache; never wait in that reverse lock order.
    row = ExpenseCategoryDecision.objects.select_for_update(skip_locked=True).filter(pk=identifier, state="pending").first()
    if not row or row.requested_by_id != candidate.requested_by_id or row.cache_id != candidate.cache_id:
        return None
    if not _matches(row, expense, cache):
        row.state, row.last_error = "stale", "not_eligible"
        row.save(update_fields=["state", "last_error"])
        return None
    cache.state, cache.lease_until = "claimed", timezone.now() + timedelta(seconds=20)
    cache.save(update_fields=["state", "lease_until"])
    row.state, row.lease_until = cache.state, cache.lease_until
    row.save(update_fields=["state", "lease_until"])
    return row, expense.description


@transaction.atomic
def _finish(claim, category, state, error):
    expense = _available(claim.requested_by_id, claim.expense_id)
    cache = ExpenseCategoryCache.objects.select_for_update().filter(pk=claim.cache_id, state="claimed").first()
    if not cache:
        return
    row = ExpenseCategoryDecision.objects.select_for_update(skip_locked=True).filter(pk=claim.pk, state="claimed").first()
    if not row or row.cache_id != claim.cache_id:
        cache.state, cache.category, cache.last_error, cache.lease_until = "uncertain", "", "scope_changed", None
        cache.save(update_fields=["state", "category", "last_error", "lease_until"])
        return
    if (not _matches(row, expense, cache) or row.requested_by_id != claim.requested_by_id
            or row.title_digest != claim.title_digest or row.definition_revision != claim.definition_revision
            or row.lease_until != claim.lease_until or cache.lease_until != claim.lease_until
            or not cache.lease_until or cache.lease_until <= timezone.now()):
        category, state, error = None, "uncertain", "scope_changed"
    cache.category, cache.state, cache.last_error, cache.lease_until = category or "", state, error, None
    cache.save(update_fields=["category", "state", "last_error", "lease_until"])
    row.category, row.state, row.last_error, row.lease_until = cache.category, state, error, None
    row.save(update_fields=["category", "state", "last_error", "lease_until"])


def cleanup_category_cache(limit=100):
    """90-day inactivity, at most100 binding/cache candidates each tick. Never remove dispatch uncertainty."""
    limit = max(0, min(limit, 100))
    cutoff = timezone.now() - timedelta(days=90)
    retired = TERMINAL | {"stale"}
    protected = Q(cache__state="claimed") | (Q(cache__state="pending") & ~Q(state="stale"))
    candidates = list(ExpenseCategoryDecision.objects.filter(state__in=retired, lease_until__isnull=True, last_used_at__lt=cutoff)
                      .exclude(last_error__in=UNRESOLVED).exclude(protected).exclude(cache__last_error__in=UNRESOLVED).order_by("last_used_at", "pk").values_list("pk", flat=True)[:limit])
    removed = 0
    for identifier in candidates:
        with transaction.atomic():
            row = ExpenseCategoryDecision.objects.filter(pk=identifier).first()
            if not row:
                continue
            expense = _available(row.requested_by_id, row.expense_id)
            cache = ExpenseCategoryCache.objects.select_for_update().filter(pk=row.cache_id).first() if row.cache_id else None
            if cache and (cache.state == "claimed" or cache.state == "pending" and row.state != "stale" or cache.last_error in UNRESOLVED):
                continue
            row = ExpenseCategoryDecision.objects.select_for_update(skip_locked=True).filter(pk=identifier, state__in=retired, lease_until__isnull=True, last_used_at__lt=cutoff).exclude(last_error__in=UNRESOLVED).first()
            if not row:
                continue
            if (expense is not None and automatic(expense) and title_digest(expense.description) == row.title_digest
                    and row.definition_revision in {DEFINITION_REVISION, cache_revision()}):
                row.last_used_at = timezone.now()  # A still-active binding is retained and rotates out of the bounded scan.
                row.save(update_fields=["last_used_at"])
            else:
                row.delete()
                removed += 1
    unused = Q(state__in=TERMINAL) | Q(state="pending", lease_until__isnull=True, last_error="", category="")
    ids = list(ExpenseCategoryCache.objects.filter(unused, last_used_at__lt=cutoff, bindings__isnull=True)
               .exclude(last_error__in=UNRESOLVED).order_by("last_used_at", "pk").values_list("pk", flat=True)[:limit])
    for identifier in ids:
        with transaction.atomic():
            cache = ExpenseCategoryCache.objects.select_for_update(skip_locked=True).filter(unused, pk=identifier, last_used_at__lt=cutoff).exclude(last_error__in=UNRESOLVED).first()
            if cache and not cache.bindings.exists():
                cache.delete()
                removed += 1
    return removed


def process_category_decisions(*, evaluate=None):
    cleanup_category_cache()
    key = settings.AI_GATEWAY_API_KEY
    if not key:
        return 0
    # Unknown dispatch outcomes remain terminal fences, including rows from0028.
    expired = Q(lease_until__lte=timezone.now()) | Q(lease_until__isnull=True)
    caches = ExpenseCategoryCache.objects.filter(state="claimed").filter(expired)
    # One row per autocommit write avoids holding expiry locks across a reader's multi-title batch.
    for identifier in caches.order_by("pk").values_list("pk", flat=True)[:100]:
        caches.filter(pk=identifier).update(state="uncertain", category="", last_error="abandoned_claim", lease_until=None)
    bindings = ExpenseCategoryDecision.objects.filter(state="claimed").filter(
        expired | Q(cache__state="uncertain", cache__last_error="abandoned_claim"))
    for identifier in bindings.order_by("pk").values_list("pk", flat=True)[:100]:
        bindings.filter(pk=identifier).update(state="uncertain", category="", last_error="abandoned_claim", lease_until=None)
    identifier = (ExpenseCategoryDecision.objects.filter(state="pending", cache__state="pending", cache__owner_id=F("requested_by_id"))
                  .order_by("pk").values_list("pk", flat=True).first())
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
        category, state, error = None, "failed", code if code.startswith("gateway_http_") and code[13:].isdigit() else "gateway_unavailable"
    except Exception:
        category, state, error = None, "failed", "gateway_unavailable"
    _finish(row, category, state, error)
    return 1
