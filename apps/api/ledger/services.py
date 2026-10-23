import hashlib
import json
from datetime import date

from django.contrib.auth import get_user_model
from django.db import transaction
from django.utils import timezone
from ninja.errors import HttpError

from .accounting import AccountingError, propose_transfers, validate_expense
from .models import (
    Change,
    CommandReceipt,
    Expense,
    ExpenseNotice,
    Group,
    Invite,
    OpeningBalance,
    Participant,
    PaymentProfile,
    Settlement,
)
from .profiles import participant_display_name
from .store_review import require_group_scope


def visible_group(actor, group_id, *, lock=False):
    query = Group.objects.filter(id=group_id, participants__user=actor, participants__removed=False)
    if lock:
        query = query.select_for_update(of=("self",))
    group = query.first()
    # The participant join may have been read before waiting for the group lock.
    # Recheck membership after acquiring it so a waiting write cannot outlive removal.
    if not group or (lock and not group.participants.filter(user=actor, removed=False).exists()):
        raise HttpError(404, "Group not found")
    require_group_scope(actor, group)
    return group


def previous_result(actor, command_id, operation, payload):
    fingerprint = hashlib.sha256(
        json.dumps([operation, payload], sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    receipt = CommandReceipt.objects.filter(actor=actor, command_id=command_id).first()
    if receipt and receipt.fingerprint != fingerprint:
        raise HttpError(409, "Command ID already used for different input")
    return receipt.result if receipt else None, fingerprint


def record_change(group, actor, command_id, fingerprint, kind, data):
    group.version += 1
    group.save(update_fields=["version"])
    Change.objects.create(group=group, sequence=group.version, actor=actor, kind=kind, data=data)
    result = {"id": str(group.id), "version": group.version}
    CommandReceipt.objects.create(actor=actor, command_id=command_id, fingerprint=fingerprint, result=result)
    return result


def writable(group):
    if group.archived:
        raise HttpError(409, "Unarchive this group before changing it")


def positive_amount(raw):
    if not isinstance(raw, str) or not raw.isascii() or not raw.isdecimal() or raw.startswith("0"):
        raise AccountingError("Use a positive integer paise string")
    if len(raw) > 10 or int(raw) > 1_000_000_000:
        raise AccountingError("Amount exceeds the bill limit")
    return int(raw)


def people(group, *, include_removed=False):
    participants = group.participants.all()
    if not include_removed:
        participants = participants.filter(removed=False)
    return {str(p.id): p for p in participants}


def keep_removed_balances_zero(group):
    removed = list(group.participants.filter(removed=True).values_list("id", flat=True))
    if not removed:
        return
    balances = snapshot(group)["balances"]
    if any(int(balances[str(person)]) for person in removed):
        raise HttpError(409, "This change would reopen a removed person's balance")


def expense_dict(expense):
    return {
        "id": str(expense.id),
        "version": expense.version,
        "description": expense.description,
        "total": str(expense.total),
        "paid": expense.paid,
        "shares": expense.shares,
        "split": expense.split,
        "date": expense.date.isoformat(),
        "category": expense.category,
        "notes": expense.notes,
        "deleted": expense.deleted,
    }


def finance_state(participant_ids, expense_rows, settlement_rows, opening_balances=None):
    """Exact totals from monetary tuples; history text is not needed for balances."""
    balances = {str(person): 0 for person in participant_ids}
    paid_totals, share_totals = dict(balances), dict(balances)
    spending = 0
    for total, paid, shares in expense_rows:
        spending += total
        for person in balances:
            paid_totals[person] += int(paid.get(person, "0"))
            share_totals[person] += int(shares.get(person, "0"))
    balances = {person: paid_totals[person] - share_totals[person] for person in balances}
    for sender, recipient, amount in settlement_rows:
        balances[str(sender)] += amount
        balances[str(recipient)] -= amount
    if opening_balances:
        for person, amount in opening_balances.items():
            balances[person] += int(amount)
    values = {person: str(amount) for person, amount in balances.items()}
    return {
        "balances": values,
        "transfers": propose_transfers(values),
        "totals": {
            "spending": str(spending),
            "paid": {person: str(amount) for person, amount in paid_totals.items()},
            "shares": {person: str(amount) for person, amount in share_totals.items()},
        },
    }


def snapshot(group):
    participants = list(group.participants.select_related("user").order_by("id"))
    expenses = list(group.expenses.order_by("date", "id"))
    settlements = list(group.settlements.order_by("created_at", "id"))
    opening = OpeningBalance.objects.filter(group=group).first()
    finance = finance_state(
        [p.id for p in participants],
        ((e.total, e.paid, e.shares) for e in expenses if not e.deleted),
        ((p.sender_id, p.recipient_id, p.amount) for p in settlements if not p.reversed),
        opening.balances if opening and opening.accepted else None,
    )
    result = {
        "id": str(group.id),
        "name": group.name,
        "version": group.version,
        "archived": group.archived,
        "is_direct": group.is_direct,
        "owner_id": group.owner_id,
        "participants": [
            {"id": str(p.id), "name": participant_display_name(p), "recorded_name": p.name,
             "user_id": p.user_id, "removed": p.removed}
            for p in participants
        ],
        "expenses": [expense_dict(e) for e in expenses],
        "settlements": [
            {
                "id": str(p.id),
                "sender": str(p.sender_id),
                "recipient": str(p.recipient_id),
                "amount": str(p.amount),
                "method": p.method,
                "recorded_by": p.recorded_by_id,
                "date": p.date.isoformat() if p.date else None,
                "attempt_id": str(p.attempt_id) if p.attempt_id else None,
                "reversed": p.reversed,
            }
            for p in settlements
        ],
        **finance,
        "activity": list(
            group.changes.order_by("sequence").values("sequence", "actor_id", "kind", "data", "created_at")
        ),
    }
    profiles = {
        profile.user_id: {"vpa": profile.vpa, "version": profile.version, "bank_verified": False}
        for profile in PaymentProfile.objects.filter(
            user_id__in=[p.user_id for p in participants if p.user_id and not p.removed]
        )
    }
    for participant in result["participants"]:
        participant["payment_profile"] = profiles.get(participant["user_id"])
    result["payment_attempts"] = [
        {
            "id": str(a.id),
            "sender": str(a.sender_id),
            "recipient": str(a.recipient_id),
            "amount": str(a.amount),
            "state": a.state,
            "payee": a.payee,
            "payee_version": a.payee_version,
            "group_version": a.group_version,
            "expires_at": a.expires_at.isoformat(),
            "settlement_id": str(a.settlement.id) if hasattr(a, "settlement") else None,
            "recorded_amount": str(a.settlement.amount) if hasattr(a, "settlement") else None,
        }
        for a in group.attempts.select_related("settlement").order_by("created_at", "id")
    ]
    result["invites"] = [
        {
            "id": str(i.id),
            "participant_id": str(i.participant_id),
            "claimant_id": i.claimant_id,
            "claimant_email": i.claimant.email if i.claimant else None,
            "approved": i.approved,
            "revoked": i.revoked,
            "expires_at": i.expires_at.isoformat(),
            "intended_email": i.intended_email,
            "send_state": i.send_state,
            "sent_at": i.sent_at.isoformat() if i.sent_at else None,
        }
        for i in Invite.objects.filter(participant__group=group).select_related("claimant").order_by("id")
    ]
    result["opening_balance"] = (
        None
        if not opening
        else {
            "id": str(opening.id),
            "balances": opening.balances,
            "source": opening.source,
            "cutoff": opening.cutoff.isoformat(),
            "acknowledgments": opening.acknowledgments,
            "accepted": opening.accepted,
        }
    )
    return result


@transaction.atomic
def create_group(actor, payload):
    get_user_model().objects.select_for_update().get(pk=actor.pk)
    # Keep pre-flag creation receipts replayable after the schema adds its default.
    if not payload.get("is_direct", False):
        payload = {key: value for key, value in payload.items() if key != "is_direct"}
    payload = {**payload, "participants": [
        {key: value for key, value in person.items() if key != "email" or value}
        for person in payload["participants"]
    ]}
    previous, fingerprint = previous_result(actor, payload["command_id"], "create_group", payload)
    if previous:
        visible_group(actor, previous["id"])
        return previous
    ids = [p["id"] for p in payload["participants"]]
    if len(set(ids)) != len(ids) or payload["self_participant_id"] not in ids:
        raise AccountingError("Participants must be unique and include the creator")
    if payload.get("is_direct", False) and len(ids) != 2:
        raise AccountingError("A direct ledger requires exactly two participants")
    if Group.objects.filter(id=payload["id"]).exists() or Participant.objects.filter(id__in=ids).exists():
        raise HttpError(409, "A supplied ID is already in use")
    group = Group.objects.create(
        id=payload["id"], name=payload["name"], owner=actor, is_direct=payload.get("is_direct", False)
    )
    Participant.objects.bulk_create(
        [
            Participant(
                id=p["id"],
                name=p["name"],
                group=group,
                user=actor if p["id"] == payload["self_participant_id"] else None,
                contact_email=clean_contact_email(p.get("email", "")),
            )
            for p in payload["participants"]
        ]
    )
    return record_change(
        group, actor, payload["command_id"], fingerprint, "group_created", {"name": group.name}
    )


def clean_contact_email(value):
    from django.core.exceptions import ValidationError

    from .otp import normalized_email

    try:
        return normalized_email(value) if value else ""
    except ValidationError as exc:
        raise AccountingError("Enter a valid contact email, or leave it empty") from exc


@transaction.atomic
def save_expense(actor, group_id, payload, expense_id=None):
    group = visible_group(actor, group_id, lock=True)
    operation = f"expense:{group_id}:{expense_id or 'new'}"
    previous, fingerprint = previous_result(actor, payload["command_id"], operation, payload)
    if previous:
        return previous
    writable(group)
    if expense_id and str(expense_id) != payload["id"]:
        raise AccountingError("Expense ID must match the URL")
    paid, shares = validate_expense(
        payload["total"], payload["paid"], payload["split"],
        list(people(group, include_removed=bool(expense_id))),
    )
    fields = {key: payload[key] for key in ["description", "split", "category", "notes"]}
    fields.update(
        total=int(payload["total"]), paid=paid, shares=shares, date=date.fromisoformat(payload["date"])
    )
    if expense_id:
        expense = group.expenses.filter(id=expense_id).first()
        if not expense:
            raise HttpError(404, "Expense not found")
        if expense.version != payload["version"] or expense.deleted:
            raise HttpError(409, "Expense changed; fetch the current revision before retrying")
        for person in group.participants.filter(removed=True):
            key = str(person.id)
            if (paid.get(key, "0"), shares.get(key, "0")) != (
                expense.paid.get(key, "0"), expense.shares.get(key, "0")
            ):
                raise HttpError(409, "Keep the removed person's historical paid amount and share unchanged")
        for key, value in fields.items():
            setattr(expense, key, value)
        expense.version += 1
        expense.save()
    else:
        if Expense.objects.filter(id=payload["id"]).exists():
            raise HttpError(409, "Expense ID already used")
        if group.expenses.count() >= 10_000:
            raise HttpError(409, "Group reached its tested expense limit")
        expense = Expense.objects.create(id=payload["id"], group=group, **fields)
    if expense_id is not None:
        from .bill_email import cancel_bill_emails
        from .bill_email_models import BillEmailNotice
        involved = [key for key in set(paid) | set(shares) if int(paid.get(key, "0")) > 0 or int(shares.get(key, "0")) > 0]
        cancel_bill_emails(BillEmailNotice.objects.filter(expense=expense).exclude(participant_id__in=involved), "involvement_removed")
    keep_removed_balances_zero(group)
    result = record_change(
        group, actor, payload["command_id"], fingerprint, "expense_saved", expense_dict(expense)
    )
    if expense_id is None:
        from .push import queue_new_bill
        queue_new_bill(expense, actor)
    return result


@transaction.atomic
def reverse_expense(actor, group_id, expense_id, payload):
    group = visible_group(actor, group_id, lock=True)
    previous, fingerprint = previous_result(
        actor, payload["command_id"], f"expense_reverse:{group_id}:{expense_id}", payload
    )
    if previous:
        return previous
    writable(group)
    expense = group.expenses.filter(id=expense_id).first()
    if not expense:
        raise HttpError(404, "Expense not found")
    if expense.version != payload["version"] or expense.deleted:
        raise HttpError(409, "Bill changed or was already reversed")
    original = expense_dict(expense) | {"reversal_of": str(expense.id)}
    expense.deleted = True  # Existing balance-exclusion projection; the record is retained.
    expense.version += 1
    expense.save(update_fields=["deleted", "version"])
    from .bill_email import cancel_bill_emails
    from .bill_email_models import BillEmailNotice
    cancel_bill_emails(BillEmailNotice.objects.filter(expense=expense), "bill_reversed")
    from .expense_notifications import cancel_notices
    cancel_notices(ExpenseNotice.objects.filter(expense=expense), "bill_reversed")
    keep_removed_balances_zero(group)
    return record_change(
        group,
        actor,
        payload["command_id"],
        fingerprint,
        "expense_reversed",
        original,
    )


@transaction.atomic
def record_settlement(actor, group_id, payload):
    group = visible_group(actor, group_id, lock=True)
    payload = {"attempt_id": None, **payload}
    try:
        previous, fingerprint = previous_result(
            actor, payload["command_id"], f"settlement:{group_id}", payload,
        )
    except HttpError as error:
        # Older clients omitted date but the schema fingerprint included date:null.
        # Replay only an existing dated record, never turn a new unknown date into Today.
        if error.status_code != 409 or "date" in payload or not Settlement.objects.filter(
            id=payload["id"], group=group, recorded_by=actor, date__isnull=False,
        ).exists():
            raise
        previous, fingerprint = previous_result(
            actor, payload["command_id"], f"settlement:{group_id}", {**payload, "date": None},
        )
    if previous:
        return previous
    writable(group)
    guarded = "expected_group_version" in payload
    if guarded and (payload["expected_group_version"] is None or group.version != payload["expected_group_version"]):
        raise HttpError(409, "This balance changed; review it before recording payment")
    if guarded and not payload.get("attempt_id"):
        raise AccountingError("Choose the exact prepared payment attempt")
    members = people(group)
    if (
        payload["sender"] not in members
        or payload["recipient"] not in members
        or payload["sender"] == payload["recipient"]
    ):
        raise AccountingError("Choose two different participants in this group")
    amount = positive_amount(payload["amount"])
    attempt = None
    if payload.get("attempt_id"):
        attempt = group.attempts.filter(id=payload["attempt_id"]).first()
        if (
            not attempt
            or str(attempt.sender_id) != payload["sender"]
            or str(attempt.recipient_id) != payload["recipient"]
        ):
            raise AccountingError("Payment attempt does not match this actual transfer")
        if hasattr(attempt, "settlement"):
            raise HttpError(409, "This payment already has a bookkeeping entry")
        if guarded:
            profile = PaymentProfile.objects.filter(user_id=attempt.recipient.user_id).first()
            if (attempt.state != "prepared" or amount != attempt.amount or attempt.sender.user_id != actor.pk
                or not profile or profile.version != attempt.payee_version or profile.vpa != attempt.payee):
                raise HttpError(409, "Payment details changed; review them before recording payment")
        attempt.state = "recorded"
        attempt.save(update_fields=["state"])
    elif group.attempts.filter(
        sender_id=payload["sender"], recipient_id=payload["recipient"], state__in=["prepared", "reported"]
    ).exists():
        raise HttpError(
            409,
            "Link the existing payment attempt before recording this transfer, so it cannot be counted twice",
        )
    if Settlement.objects.filter(id=payload["id"]).exists():
        raise HttpError(409, "Settlement ID already used")
    payment = Settlement.objects.create(
        id=payload["id"],
        group=group,
        sender=members[payload["sender"]],
        recipient=members[payload["recipient"]],
        amount=amount,
        date=(date.fromisoformat(payload["date"]) if payload["date"] else None)
        if "date" in payload else timezone.localdate(),
        recorded_by=actor,
        attempt=attempt,
    )
    keep_removed_balances_zero(group)
    return record_change(
        group,
        actor,
        payload["command_id"],
        fingerprint,
        "manual_settlement",
        {
            "id": str(payment.id),
            "sender": payload["sender"],
            "recipient": payload["recipient"],
            "amount": str(amount),
            "method": payment.method,
            "date": payment.date.isoformat() if payment.date else None,
        },
    )


@transaction.atomic
def reverse_settlement(actor, group_id, settlement_id, payload):
    group = visible_group(actor, group_id, lock=True)
    previous, fingerprint = previous_result(
        actor, payload["command_id"], f"reverse:{group_id}:{settlement_id}", payload
    )
    if previous:
        return previous
    writable(group)
    payment = group.settlements.filter(id=settlement_id).first()
    if not payment:
        raise HttpError(404, "Settlement not found")
    if payment.reversed:
        raise HttpError(409, "Settlement is already reversed")
    if actor.pk not in [
        group.owner_id,
        payment.recorded_by_id,
        payment.sender.user_id,
        payment.recipient.user_id,
    ]:
        raise HttpError(403, "Only the involved people or organizer can reverse this record")
    payment.reversed = True
    payment.save(update_fields=["reversed"])
    keep_removed_balances_zero(group)
    return record_change(
        group, actor, payload["command_id"], fingerprint, "settlement_reversed", {
            "id": str(payment.id), "reversal_of": str(payment.id),
            "sender": str(payment.sender_id), "recipient": str(payment.recipient_id),
            "amount": str(payment.amount), "date": payment.date.isoformat() if payment.date else None,
            "method": payment.method,
        }
    )
