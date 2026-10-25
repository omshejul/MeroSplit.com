"""Expense-only version history from the existing transactional Change log."""
from contextvars import ContextVar

from django.db import transaction
from ninja.errors import HttpError

from .profiles import participant_display_name

verified_mcp_history = ContextVar("verified_mcp_history", default=False)

FIELDS = ("description", "total", "paid", "split", "date", "category", "notes", "deleted")


def history_details(group, actor, before):
    people = list(group.participants.select_related("user"))
    return {"before": before, "currency": "INR",
            **({"origin": "mcp"} if verified_mcp_history.get() else {}),
            "actor_name": next((participant_display_name(p) for p in people if p.user_id == actor.pk), None),
            "names": {str(p.id): participant_display_name(p) for p in people}}


def values(snapshot):
    # Split history includes the actual allocated amounts, not merely the mode.
    split = snapshot.get("split") or {}
    return {**{field: snapshot.get(field) for field in FIELDS},
            "paid": {key: amount for key, amount in (snapshot.get("paid") or {}).items() if str(amount) != "0"},
            "split": {"definition": split, "shares": {key: amount for key, amount in (snapshot.get("shares") or {}).items()
                                                        if key in split.get("values", {})}}}


def history_entry(row, earlier, actor_names=None):
    data = row.data
    details = data.get("_history", {})
    before = details.get("before")
    created = row.kind == "expense_saved" and data.get("version") == 1 and not data.get("source")
    if row.kind == "expense_reversed":
        changes = [{"field": "deleted", "before": False, "after": True}]
    elif created:
        if not all(key in data for key in ("description", "total", "paid", "split", "shares")):
            return None
        changes = [{"field": key, "before": None, "after": values(data)[key]}
                   for key in ("description", "total", "paid", "split")]
    else:
        if before is None and earlier and earlier.kind == "expense_saved":
            previous = earlier.data
            # A gap or imported snapshot is not proof of an earlier edit.
            if (isinstance(data.get("version"), int) and previous.get("version") == data["version"] - 1
                    and not data.get("source") and not previous.get("source")):
                before = previous
        if not isinstance(before, dict):
            return None
        old, new = values(before), values(data)
        changes = [{"field": key, "before": old[key], "after": new[key]}
                   for key in FIELDS if key in before and key in data and old[key] != new[key]]
    if not changes:
        return None
    return {"id": str(row.id), "sequence": row.sequence, "created_at": row.created_at.isoformat(),
            "actor_name": details.get("actor_name") or (actor_names or {}).get(row.actor_id), "names": details.get("names", {}),
            "currency": details.get("currency", "INR"), "kind": "created" if created else "edited",
            "changes": changes, "labels_recorded": bool(details.get("names")), "via_mcp": details.get("origin") == "mcp"}


@transaction.atomic
def expense_version_history(actor, group_id, expense_id, *, before=None, limit=50):
    from .services import visible_group

    group = visible_group(actor, group_id, lock=True)
    if not group.expenses.filter(pk=expense_id).exists():
        raise HttpError(404, "Expense not found")
    if not 1 <= limit <= 100 or before is not None and before < 1:
        raise HttpError(422, "Invalid history page")
    query = group.changes.filter(kind__in=["expense_saved", "expense_reversed"], data__id=str(expense_id))
    if before is not None:
        query = query.filter(sequence__lt=before)
    rows = list(query.order_by("-sequence")[:limit + 1])
    actor_names = {person.user_id: participant_display_name(person) for person in group.participants.select_related("user") if person.user_id}
    items, gap = [], False
    for i, row in enumerate(rows[:limit]):
        entry = history_entry(row, rows[i + 1] if i + 1 < len(rows) else None, actor_names)
        if entry:
            items.append(entry)
        if "_history" not in row.data:
            gap = True
    return {"group_id": str(group.id), "expense_id": str(expense_id), "items": items,
            "next_before": rows[limit - 1].sequence if len(rows) > limit else None,
            "legacy_gap": gap or not rows, "version": group.version}
