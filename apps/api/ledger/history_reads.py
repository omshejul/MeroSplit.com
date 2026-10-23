"""Bounded group browsing; complete snapshots remain the export/legacy contract."""

from django.core import signing
from django.core.exceptions import ValidationError
from django.db import transaction
from django.db.models import Q
from django.db.models.fields.json import KeyTextTransform
from django.utils import timezone
from ninja.errors import HttpError

from .models import Invite, OpeningBalance, PaymentProfile
from .services import expense_dict, finance_state, visible_group

CURSOR_SALT = "merosplit.group-history.v1"


def _filters(resource, supplied):
    if resource == "bills":
        values = {"deleted": supplied.get("deleted", "all"), "q": supplied.get("q", "").strip()}
        if values["deleted"] not in {"active", "deleted", "all"} or len(values["q"]) > 200:
            raise HttpError(422, "Check the bill filters")
    elif resource == "settlements":
        values = {"reversed": supplied.get("reversed", "all")}
        if values["reversed"] not in {"active", "reversed", "all"}:
            raise HttpError(422, "Check the payment filter")
    elif resource == "activity":
        values = {"kind": supplied.get("kind", "").strip()}
        if len(values["kind"]) > 40:
            raise HttpError(422, "Check the activity filter")
    elif resource == "attempts":
        values = {"state": supplied.get("state", "all"), **{
            key: str(supplied[key]) if supplied.get(key) else "" for key in ("sender", "recipient")
        }}
        if values["state"] not in {"active", "all"}:
            raise HttpError(422, "Check the payment-attempt filter")
    else:
        raise HttpError(404, "History not found")
    return values


def _limit(limit):
    if not 1 <= limit <= 100:
        raise HttpError(422, "Page size must be between 1 and 100")


def _check_version(group, version):
    if version is not None and version != group.version:
        raise HttpError(409, "Group changed; refresh its summary before loading more history")


def _page(actor, group, resource, limit=50, cursor=None, supplied=None):
    _limit(limit)
    filters = _filters(resource, supplied or {})
    context = {"actor": actor.pk, "group": str(group.id), "version": group.version,
               "resource": resource, "filters": filters, "limit": limit}
    after = None
    if cursor:
        try:
            if len(cursor) > 4096:
                raise signing.BadSignature()
            payload = signing.loads(cursor, salt=CURSOR_SALT, max_age=86400)
        except signing.SignatureExpired as exc:
            raise HttpError(409, "History page expired; refresh its summary") from exc
        except (signing.BadSignature, ValueError, TypeError) as exc:
            raise HttpError(422, "Invalid history cursor") from exc
        if not isinstance(payload, dict) or any(payload.get(key) != value for key, value in context.items() if key != "version"):
            raise HttpError(422, "This cursor belongs to another history view")
        _check_version(group, payload.get("version"))
        after = payload.get("after")
        if not isinstance(after, list) or len(after) != (1 if resource == "activity" else 2):
            raise HttpError(422, "Invalid history position")

    if resource == "bills":
        query, order = group.expenses.all(), "date"
        if filters["deleted"] != "all":
            query = query.filter(deleted=filters["deleted"] == "deleted")
        if filters["q"]:
            query = query.filter(Q(description__icontains=filters["q"]) | Q(notes__icontains=filters["q"]))
    elif resource == "settlements":
        query, order = group.settlements.all(), "created_at"
        if filters["reversed"] != "all":
            query = query.filter(reversed=filters["reversed"] == "reversed")
    elif resource == "attempts":
        # Expired prepared quotes still need an explicit payer cancellation.
        states = ["prepared", "reported"] if filters["state"] == "active" else ["prepared", "reported", "recorded", "cancelled"]
        query = group.attempts.filter(state__in=states, sender__removed=False, recipient__removed=False).exclude(settlement__reversed=True).select_related("settlement")
        for key in ("sender", "recipient"):
            if filters[key]:
                query = query.filter(**{f"{key}_id": filters[key]})
        order = "created_at"
    else:
        query, order = group.changes.all(), "sequence"
        if filters["kind"]:
            query = query.filter(kind=filters["kind"])
        query = query.annotate(event_id=KeyTextTransform("id", "data"), description=KeyTextTransform("description", "data")).values("sequence", "actor_id", "kind", "created_at", "event_id", "description")

    try:
        if after:
            query = query.filter(**{f"{order}__lt": after[0]}) if resource == "activity" else query.filter(
                Q(**{f"{order}__lt": after[0]}) | Q(**{order: after[0], "id__lt": after[1]})
            )
        rows = list(query.order_by(f"-{order}", *([] if resource == "activity" else ["-id"]))[:limit + 1])
    except (ValidationError, ValueError, TypeError) as exc:
        raise HttpError(422, "Invalid history position") from exc
    more, rows = len(rows) > limit, rows[:limit]
    items = []
    for row in rows:
        if resource == "bills":
            items.append(expense_dict(row))
        elif resource == "settlements":
            items.append({"id": str(row.id), "sender": str(row.sender_id), "recipient": str(row.recipient_id),
                          "amount": str(row.amount), "method": row.method, "recorded_by": row.recorded_by_id,
                          "date": row.date.isoformat() if row.date else None, "attempt_id": str(row.attempt_id) if row.attempt_id else None, "reversed": row.reversed})
        elif resource == "attempts":
            payment = getattr(row, "settlement", None)
            items.append({"id": str(row.id), "sender": str(row.sender_id), "recipient": str(row.recipient_id),
                          "amount": str(row.amount), "state": row.state, "payee": row.payee,
                          "payee_version": row.payee_version, "group_version": row.group_version,
                          "expires_at": row.expires_at.isoformat(), "settlement_id": str(payment.id) if payment else None,
                          "recorded_amount": str(payment.amount) if payment else None})
        else:
            items.append({key: row[key] for key in ("sequence", "actor_id", "kind", "created_at")}
                         | {"data": {key: row[value] for key, value in (("id", "event_id"), ("description", "description")) if row[value] is not None}})
    next_cursor = None
    if more:
        row = rows[-1]
        position = [row["sequence"]] if resource == "activity" else [getattr(row, order).isoformat(), str(row.id)]
        next_cursor = signing.dumps({**context, "after": position}, salt=CURSOR_SALT)
    return {"read_mode": "page", "group_id": str(group.id), "version": group.version,
            "items": items, "next_cursor": next_cursor}


@transaction.atomic
def history_page(actor, group_id, resource, *, limit=50, cursor=None, version=None, filters=None):
    group = visible_group(actor, group_id, lock=True)
    _check_version(group, version)
    return _page(actor, group, resource, limit, cursor, filters)


@transaction.atomic
def expense_detail(actor, group_id, expense_id, *, version=None):
    group = visible_group(actor, group_id, lock=True)
    _check_version(group, version)
    expense = group.expenses.filter(id=expense_id).first()
    if not expense:
        raise HttpError(404, "Expense not found")
    return {**expense_dict(expense), "read_mode": "detail", "group_id": str(group.id), "group_version": group.version}


@transaction.atomic
def group_summary(actor, group_id, *, limit=50):
    _limit(limit)
    group = visible_group(actor, group_id, lock=True)
    participants = list(group.participants.order_by("id"))
    opening = OpeningBalance.objects.filter(group=group).first()
    finance = finance_state(
        [person.id for person in participants],
        group.expenses.filter(deleted=False).values_list("total", "paid", "shares").iterator(chunk_size=1000),
        group.settlements.filter(reversed=False).values_list("sender_id", "recipient_id", "amount").iterator(chunk_size=1000),
        opening.balances if opening and opening.accepted else None,
    )
    profiles = {profile.user_id: {"vpa": profile.vpa, "version": profile.version, "bank_verified": False}
                for profile in PaymentProfile.objects.filter(user_id__in=[person.user_id for person in participants if person.user_id and not person.removed])}
    pages = {resource: _page(actor, group, resource, limit) for resource in ("bills", "activity", "settlements", "attempts")}
    invites = []
    if group.owner_id == actor.pk:
        invites = [{"id": str(invite.id), "participant_id": str(invite.participant_id),
                    "claimant_id": invite.claimant_id, "claimant_email": invite.claimant.email if invite.claimant else None,
                    "approved": invite.approved, "revoked": False, "expires_at": invite.expires_at.isoformat(),
                    "intended_email": invite.intended_email, "send_state": invite.send_state,
                    "sent_at": invite.sent_at.isoformat() if invite.sent_at else None}
                   for invite in Invite.objects.filter(participant__group=group, participant__removed=False,
                                                       participant__user__isnull=True, revoked=False, approved=False, expires_at__gt=timezone.now())
                   .select_related("claimant").order_by("participant_id", "-expires_at", "-id").distinct("participant_id")[:100]]
    return {
        "read_mode": "summary", "id": str(group.id), "name": group.name, "version": group.version,
        "archived": group.archived, "is_direct": group.is_direct, "owner_id": group.owner_id,
        "participants": [{"id": str(person.id), "name": person.name, "user_id": person.user_id, "removed": person.removed,
                          "payment_profile": profiles.get(person.user_id), **({"email": person.contact_email} if group.owner_id == actor.pk else {})}
                         for person in participants],
        **finance, "expenses": pages["bills"]["items"], "activity": pages["activity"]["items"],
        "settlements": pages["settlements"]["items"], "payment_attempts": pages["attempts"]["items"], "invites": invites,
        "history": {resource: {"next_cursor": page["next_cursor"]} for resource, page in pages.items()},
        "opening_balance": None if not opening else {"id": str(opening.id), "balances": opening.balances,
            "source": opening.source, "cutoff": opening.cutoff.isoformat(), "acknowledgments": opening.acknowledgments, "accepted": opening.accepted},
    }
