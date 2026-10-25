"""Bounded group browsing; complete snapshots remain the export/legacy contract."""

import hashlib
from datetime import date, datetime
from uuid import UUID

from django.core import signing
from django.core.exceptions import ValidationError
from django.db import transaction
from django.db.models import Exists, F, OuterRef, Q, Value
from django.db.models.fields.json import KeyTextTransform
from django.db.models.fields.tuple_lookups import TupleLessThan
from django.db.models.functions import Coalesce
from django.utils import timezone
from ninja.errors import HttpError

from .models import Change, Expense, Group, Invite, OpeningBalance, Participant, PaymentProfile, Settlement
from .profiles import participant_display_name
from .services import expense_dict, finance_state, visible_group
from .store_review import groups_for_actor

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
            if resource == "activity":
                query = query.filter(**{f"{order}__lt": after[0]})
            else:
                if any(value is None for value in after):
                    raise ValueError("Missing history position")
                # Native row comparison reaches the composite index directly,
                # rather than filtering all preceding rows through an OR.
                query = query.filter(TupleLessThan((F(order), F("id")), tuple(after)))
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
    return transaction_page(actor, group, limit, cursor, (filters or {}).get("q", "")) if resource == "transactions" else _page(actor, group, resource, limit, cursor, filters)


def settlement_dict(payment):
    return {"id": str(payment.id), "sender": str(payment.sender_id), "recipient": str(payment.recipient_id),
            "amount": str(payment.amount), "method": payment.method, "recorded_by": payment.recorded_by_id,
            "date": payment.date.isoformat() if payment.date else None, "attempt_id": str(payment.attempt_id) if payment.attempt_id else None, "reversed": payment.reversed}


def detail_actor(group, actor_id):
    if actor_id is None:
        return None
    person = group.participants.filter(user_id=actor_id).select_related("user").first()
    return participant_display_name(person) if person else None


def reversal_record(group, kind, original):
    record = group.changes.alias(record_identity=Coalesce(
        KeyTextTransform("settlement_id", "data"), KeyTextTransform("id", "data"),
    )).filter(kind=kind, record_identity=original["id"]).order_by("-id").first()
    if not record:
        return None
    fields = ("id", "version", "description", "total", "paid", "shares", "split", "date", "category") if kind == "expense_reversed" else ("id", "sender", "recipient", "amount", "method", "date")
    return {"id": str(record.id), "sequence": record.sequence, "created_at": record.created_at.isoformat(),
            "kind": "bill_reversed" if kind == "expense_reversed" else "payment_reversed", "actor_name": detail_actor(group, record.actor_id),
            "reversal_of": original["id"], "original": {key: record.data.get(key, original[key]) for key in fields}}


def attempt_dict(attempt):
    payment = getattr(attempt, "settlement", None)
    return {"id": str(attempt.id), "sender": str(attempt.sender_id), "recipient": str(attempt.recipient_id),
            "amount": str(attempt.amount), "state": attempt.state, "group_version": attempt.group_version,
            "expires_at": attempt.expires_at.isoformat(), "settlement_id": str(payment.id) if payment else None,
            "recorded_amount": str(payment.amount) if payment else None}


@transaction.atomic
def payment_attempt_detail(actor, group_id, attempt_id, *, version=None):
    group = visible_group(actor, group_id, lock=True)
    _check_version(group, version)
    attempt = group.attempts.select_related("settlement").filter(pk=attempt_id).first()
    if not attempt:
        raise HttpError(404, "Payment attempt not found")
    payment = getattr(attempt, "settlement", None)
    return {**attempt_dict(attempt), "read_mode": "detail", "group_id": str(group.id), "current_group_version": group.version,
            "settlement": settlement_dict(payment) if payment else None}


@transaction.atomic
def settlement_detail(actor, group_id, settlement_id, *, version=None):
    group = visible_group(actor, group_id, lock=True)
    _check_version(group, version)
    payment = group.settlements.filter(pk=settlement_id).first()
    if not payment:
        raise HttpError(404, "Payment record not found")
    result = {**settlement_dict(payment), "read_mode": "detail", "group_id": str(group.id), "group_version": group.version,
              "recorded_by_name": detail_actor(group, payment.recorded_by_id) if payment.method != "splitwise_import" else None}
    if payment.reversed and (reversal := reversal_record(group, "settlement_reversed", result)):
        result["reversal"] = reversal
    return result


def transaction_page(actor, group, limit=50, cursor=None, q=""):
    _limit(limit)
    q = q.strip()
    if len(q) > 200:
        raise HttpError(422, "Check the bill search")
    context = {"actor": actor.pk, "group": str(group.id), "version": group.version, "resource": "transactions", "limit": limit, "q": q}
    after = None
    if cursor:
        try:
            if len(cursor) > 4096:
                raise ValueError()
            payload = signing.loads(cursor, salt=CURSOR_SALT, max_age=86400)
            if not isinstance(payload, dict) or any(payload.get(key) != value for key, value in context.items() if key != "version"):
                raise ValueError()
            _check_version(group, payload.get("version"))
            after = payload["after"]
            if not isinstance(after, list) or len(after) != 4 or type(after[0]) is not int or after[0] not in (0, 1) or type(after[2]) is not int or after[2] not in (0, 1):
                raise ValueError()
            after = (after[0], date.fromisoformat(after[1]) if after[0] else None, after[2], UUID(after[3]))
            if not after[0] and (payload["after"][1] is not None or after[2] != 1):
                raise ValueError()
        except signing.SignatureExpired as exc:
            raise HttpError(409, "History page expired; refresh its summary") from exc
        except (signing.BadSignature, ValueError, TypeError, KeyError, AttributeError) as exc:
            raise HttpError(422, "Invalid transaction cursor") from exc
    branches = []
    for query, kind, known in ((group.expenses.all(), 0, 1), (group.settlements.filter(date__isnull=False), 1, 1), (group.settlements.filter(date__isnull=True), 1, 0)):
        if q:
            if kind == 1:
                continue
            query = query.filter(Q(description__icontains=q) | Q(notes__icontains=q))
        if after:
            if known > after[0]:
                continue
            if known == after[0]:
                if not known:
                    query = query.filter(id__lt=after[3])
                elif kind == after[2]:
                    query = query.filter(TupleLessThan((F("date"), F("id")), (after[1], after[3])))
                else:
                    query = query.filter(**{"date__lte" if kind < after[2] else "date__lt": after[1]})
        # Each branch contributes its best K candidates; the database applies one
        # global ordering/limit over their UNION, including all cross-kind ties.
        branches.append(query.annotate(kind_order=Value(kind), known=Value(known)).values("id", "date", "kind_order", "known")
                        .order_by(*(["-date"] if known else []), "-id")[:limit + 1])
    if branches:
        # Django returns the original sliced queryset for UNION with no peers.
        # A lone branch already has the same ordering as the global result.
        keys = list(branches[0]) if len(branches) == 1 else list(
            branches[0].union(*branches[1:], all=True).order_by("-known", "-date", "-kind_order", "-id")[:limit + 1])
    else:
        keys = []
    more, keys = len(keys) > limit, keys[:limit]
    bills = {row.id: row for row in group.expenses.filter(id__in=[key["id"] for key in keys if key["kind_order"] == 0])}
    payments = {row.id: row for row in group.settlements.filter(id__in=[key["id"] for key in keys if key["kind_order"] == 1])}
    items = []
    for key in keys:
        if key["kind_order"] == 0:
            bill = expense_dict(bills[key["id"]])
            items.append({"kind": "bill", "date": bill["date"], "bill": {field: bill[field] for field in ("id", "version", "description", "total", "paid", "shares", "date", "category", "category_auto", "deleted")}})
        else:
            payment = settlement_dict(payments[key["id"]])
            items.append({"kind": "payment", "date": payment["date"], "payment": payment})
    position = keys[-1] if more else None
    next_cursor = signing.dumps({**context, "after": [position["known"], position["date"].isoformat() if position["date"] else None,
                                                    position["kind_order"], str(position["id"])]}, salt=CURSOR_SALT) if position else None
    return {"read_mode": "page", "group_id": str(group.id), "version": group.version, "items": items, "next_cursor": next_cursor}


ACTIVITY_KINDS = ["expense_saved", "expense_deleted", "expense_restored", "expense_reversed", "manual_settlement", "payment_confirm",
                  "settlement_reversed", "participant_added", "participant_claim_approved", "participant_removed",
                  "group_created", "group_archived", "group_unarchived"]


def _activity_groups(actor):
    return groups_for_actor(Group.objects.filter(participants__user=actor, participants__removed=False), actor)


def _activity_revision(actor):
    # Only small group metadata is read; never materialize cross-group histories.
    values = _activity_groups(actor).order_by("id").values_list("id", "version")
    return hashlib.sha256("|".join(f"{group}:{version}" for group, version in values).encode()).hexdigest()


def account_activity(actor, *, limit=50, cursor=None):
    _limit(limit)
    revision = _activity_revision(actor)
    context = {"actor": actor.pk, "resource": "account_activity", "limit": limit}
    query = Change.objects.filter(group_id__in=_activity_groups(actor).values("id"), kind__in=ACTIVITY_KINDS)
    prior_payment_event = Change.objects.alias(payment_id=Coalesce(KeyTextTransform("settlement_id", "data"), KeyTextTransform("id", "data"))).filter(
        group_id=OuterRef("group_id"), kind__in=["manual_settlement", "payment_confirm"], payment_id=OuterRef("confirmed_payment_id"),
    ).filter(Q(kind="manual_settlement") | Q(id__lt=OuterRef("id")))
    query = query.alias(confirmed_payment_id=KeyTextTransform("settlement_id", "data"), prior_payment_event=Exists(prior_payment_event)).filter(
        ~Q(kind="payment_confirm") | Q(prior_payment_event=False))
    if cursor:
        try:
            if len(cursor) > 4096:
                raise ValueError()
            payload = signing.loads(cursor, salt=CURSOR_SALT, max_age=86400)
            if not isinstance(payload, dict) or any(payload.get(key) != value for key, value in context.items()):
                raise ValueError()
            if payload.get("revision") != revision:
                raise HttpError(409, "Activity changed; refresh before loading more")
            after = payload["after"]
            if not isinstance(after, list) or len(after) != 2 or type(after[1]) is not int or after[1] < 1:
                raise ValueError()
            stamp = datetime.fromisoformat(after[0])
            if not timezone.is_aware(stamp):
                raise ValueError()
            query = query.filter(TupleLessThan((F("created_at"), F("id")), (stamp, after[1])))
        except signing.SignatureExpired as exc:
            raise HttpError(409, "Activity page expired; refresh before loading more") from exc
        except (signing.BadSignature, ValueError, TypeError, KeyError, AttributeError) as exc:
            raise HttpError(422, "Invalid activity cursor") from exc
    rows = list(query.select_related("group").order_by("-created_at", "-id")[:limit + 1])
    more, rows = len(rows) > limit, rows[:limit]
    groups = {row.group_id for row in rows}
    bill_ids, payment_ids, person_ids = set(), set(), set()
    actors = Q(pk__in=[])
    for row in rows:
        if row.actor_id:
            actors |= Q(group_id=row.group_id, user_id=row.actor_id)
        value = row.data.get("settlement_id") if row.kind == "payment_confirm" else row.data.get("participant_id") if row.kind == "participant_claim_approved" else row.data.get("id")
        try:
            identifier = UUID(value) if isinstance(value, str) else None
        except ValueError:
            identifier = None
        if row.kind.startswith("expense_"):
            bill_ids.add(identifier)
        elif row.kind in ("manual_settlement", "payment_confirm", "settlement_reversed"):
            payment_ids.add(identifier)
        elif row.kind.startswith("participant_"):
            person_ids.add(identifier)
    bills = {str(bill.id): bill for bill in Expense.objects.filter(group_id__in=groups, id__in=bill_ids - {None})}
    payments = {str(payment.id): payment for payment in Settlement.objects.filter(group_id__in=groups, id__in=payment_ids - {None})}
    person_ids.update(person for payment in payments.values() for person in (payment.sender_id, payment.recipient_id))
    people = {str(person.id): person for person in Participant.objects.filter(group_id__in=groups)
              .filter(actors | Q(id__in=person_ids - {None})).select_related("user")}
    def person_view(person):
        return {"id": str(person.id), "name": participant_display_name(person), "is_self": person.user_id == actor.pk and not person.removed}
    items = []
    for row in rows:
        actor_person = next((person for person in people.values() if person.group_id == row.group_id and person.user_id == row.actor_id), None) if row.actor_id else None
        label = participant_display_name(actor_person) if actor_person else "Someone"
        item = {"id": str(row.id), "created_at": row.created_at.isoformat(), "group": {"id": str(row.group_id), "name": row.group.name},
                "actor": {"name": label, "is_self": bool(actor_person and not actor_person.removed and row.actor_id == actor.pk)} if row.actor_id else None}
        if row.kind.startswith("expense_"):
            bill = bills.get(row.data.get("id"))
            if not bill or bill.group_id != row.group_id:
                continue
            item["kind"] = {"expense_deleted": "bill_deleted", "expense_restored": "bill_restored", "expense_reversed": "bill_reversed"}.get(row.kind, "bill_added" if row.data.get("version") == 1 else "bill_edited")
            item["bill"] = {"id": str(bill.id), "description": bill.description, "deleted": bill.deleted, "category": bill.category, "category_auto": bill.category_auto}
        elif row.kind in ("manual_settlement", "payment_confirm", "settlement_reversed"):
            payment = payments.get(row.data.get("settlement_id") if row.kind == "payment_confirm" else row.data.get("id"))
            if not payment or payment.group_id != row.group_id:
                continue
            if row.kind == "payment_confirm" and payment.method != "recipient_confirmed":
                continue  # A later receipt acknowledgement never invents another payment.
            sender, recipient = people.get(str(payment.sender_id)), people.get(str(payment.recipient_id))
            if not sender or not recipient:
                continue
            item["kind"] = "payment_reversed" if row.kind == "settlement_reversed" else "payment_recorded"
            item["payment"] = {"id": str(payment.id), "sender": person_view(sender), "recipient": person_view(recipient),
                               "amount": str(payment.amount), "reversed": payment.reversed}
        elif row.kind.startswith("participant_"):
            person = people.get(row.data.get("participant_id") if row.kind == "participant_claim_approved" else row.data.get("id"))
            if not person or person.group_id != row.group_id:
                continue
            item["kind"] = {"participant_added": "member_added", "participant_claim_approved": "member_joined", "participant_removed": "member_removed"}[row.kind]
            item["person"] = person_view(person)
        else:
            item["kind"] = row.kind
        items.append(item)
    if _activity_revision(actor) != revision:
        raise HttpError(409, "Activity changed; refresh before loading more")
    next_cursor = signing.dumps({**context, "revision": revision, "after": [rows[-1].created_at.isoformat(), rows[-1].id]}, salt=CURSOR_SALT) if more else None
    return {"read_mode": "activity", "revision": revision, "items": items, "next_cursor": next_cursor}


@transaction.atomic
def expense_detail(actor, group_id, expense_id, *, version=None):
    group = visible_group(actor, group_id, lock=True)
    _check_version(group, version)
    expense = group.expenses.filter(id=expense_id).first()
    if not expense:
        raise HttpError(404, "Expense not found")
    creation = group.changes.filter(kind="expense_saved", data__id=str(expense.id), data__version=1).order_by("id").first()
    result = {**expense_dict(expense), "read_mode": "detail", "group_id": str(group.id), "group_version": group.version,
              "added_by": detail_actor(group, creation.actor_id) if creation and not creation.data.get("source") else None}
    if expense.deleted and (reversal := reversal_record(group, "expense_reversed", result)):
        result["reversal"] = reversal
    return result


@transaction.atomic
def group_summary(actor, group_id, *, limit=50):
    _limit(limit)
    group = visible_group(actor, group_id, lock=True)
    participants = list(group.participants.select_related("user").order_by("id"))
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
    transactions = transaction_page(actor, group, limit)
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
        "hidden": next(person.hidden for person in participants if person.user_id == actor.pk and not person.removed),
        "archived": group.archived, "is_direct": group.is_direct, "owner_id": group.owner_id,
        "participants": [{"id": str(person.id), "name": participant_display_name(person), "recorded_name": person.name,
                          "user_id": person.user_id, "removed": person.removed,
                          "payment_profile": profiles.get(person.user_id), **({"email": person.contact_email} if group.owner_id == actor.pk else {})}
                         for person in participants],
        **finance, "expenses": pages["bills"]["items"], "activity": pages["activity"]["items"],
        "settlements": pages["settlements"]["items"], "payment_attempts": pages["attempts"]["items"], "invites": invites,
        "transactions": transactions["items"],
        "history": {**{resource: {"next_cursor": page["next_cursor"]} for resource, page in pages.items()},
                    "transactions": {"next_cursor": transactions["next_cursor"]}},
        "opening_balance": None if not opening else {"id": str(opening.id), "balances": opening.balances,
            "source": opening.source, "cutoff": opening.cutoff.isoformat(), "acknowledgments": opening.acknowledgments, "accepted": opening.accepted},
    }
