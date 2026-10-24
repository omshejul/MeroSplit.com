"""Personal group departure and private list visibility; ledger history stays intact."""
from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from ninja.errors import HttpError

from .bill_email import cancel_bill_emails
from .bill_email_models import BillEmailNotice
from .models import CommandReceipt, ExpenseNotice, ExpensePushDelivery, Invite, OpeningBalance
from .services import finance_state, previous_result, record_change, visible_group


def _receipt_context(actor, group_id, payload, action):
    if not get_user_model().objects.select_for_update(no_key=True).filter(pk=actor.pk, is_active=True).exists():
        raise HttpError(401, "Sign in again")
    return previous_result(actor, payload["command_id"], f"{action}_group:{group_id}", payload)


def _next_organizer(group, person):
    candidates = list(group.participants.filter(removed=False, user__is_active=True).exclude(pk=person.pk))
    if not candidates:
        return None
    joined = {}
    for change in group.changes.filter(kind__in=["group_created", "participant_added", "participant_claim_approved"]).order_by("sequence"):
        for participant_id in change.data.get("linked_participant_ids", []):
            joined[str(participant_id)] = change.sequence
        if change.kind == "group_created":
            for candidate in candidates:
                if candidate.user_id == change.actor_id:
                    joined.setdefault(str(candidate.id), change.sequence)
        elif change.kind == "participant_claim_approved":
            participant_id = str(change.data.get("participant_id", ""))
            # A previously deleted account can be replaced through a fresh claim.
            # Its current member joined at that latest claim, not the former identity.
            joined[participant_id] = change.sequence
    if any(str(candidate.id) not in joined for candidate in candidates):
        raise HttpError(409, "The next organizer could not be determined from this group's joining history")
    return min(candidates, key=lambda candidate: (joined[str(candidate.id)], str(candidate.id)))


def _can_leave(group, person):
    opening = OpeningBalance.objects.filter(group=group).first()
    finance = finance_state(
        group.participants.values_list("id", flat=True),
        group.expenses.filter(deleted=False).values_list("total", "paid", "shares"),
        group.settlements.filter(reversed=False).values_list("sender_id", "recipient_id", "amount"),
        opening.balances if opening and opening.accepted else None,
    )
    balance = abs(int(finance["balances"][str(person.id)]))
    if balance:
        amount = f"{balance // 100:,}" + (f".{balance % 100:02}" if balance % 100 else "")
        raise HttpError(409, f"Settle ₹{amount} first")
    attempts = group.attempts.filter(Q(sender=person) | Q(recipient=person))
    if attempts.filter(state="reported").exists():
        raise HttpError(409, "Resolve the reported payment first")
    if opening and not opening.accepted and int(opening.balances.get(str(person.id), "0")):
        raise HttpError(409, "Resolve the opening balance proposal first")
    return attempts


@transaction.atomic
def leave_group(actor, group_id, payload):
    previous, fingerprint = _receipt_context(actor, group_id, payload, "leave")
    if previous:
        return previous  # A committed departure has already revoked ordinary GET access.
    group = visible_group(actor, group_id, lock=True)
    person = group.participants.get(user=actor, removed=False)
    attempts = _can_leave(group, person)
    successor = _next_organizer(group, person) if group.owner_id == actor.pk else None
    if group.owner_id == actor.pk and successor is None and not payload.get("remove_membership", False):
        # Installed clients called this Remove from my list and promised restore.
        person.hidden = True
        person.save(update_fields=["hidden"])
        result = {"id": str(group.id), "version": group.version, "disposition": "hidden"}
        CommandReceipt.objects.create(actor=actor, command_id=payload["command_id"], fingerprint=fingerprint, result=result)
        return result
    if group.owner_id == actor.pk and successor is None:
        # No active organizer remains to manage a later guest claim.
        Invite.objects.filter(participant__group=group, approved=False).update(revoked=True)
    # A historical owner FK may remain when no active successor exists. It grants
    # no access: all ledger/organizer entrypoints require an active participant.
    if successor:
        group.owner_id = successor.user_id
        group.import_source_hash = ""
        group.save(update_fields=["owner", "import_source_hash"])
    person.removed, person.hidden = True, False
    person.save(update_fields=["removed", "hidden"])
    from .membership_notifications import cancel_membership
    from .models import MembershipDelivery
    cancel_membership(MembershipDelivery.objects.filter(participant=person), 'member_left')
    attempts.filter(state="prepared").update(state="cancelled")
    Invite.objects.filter(participant=person).update(revoked=True)
    now = timezone.now()
    ExpenseNotice.objects.filter(expense__group=group, recipient=actor).update(
        cancelled_at=now, email_eligible=False, push_processed_at=now,
    )
    ExpensePushDelivery.objects.filter(expense__group=group, recipient=actor,
                                      state__in=["pending", "sending", "queued", "checking", "skipped"]).update(
        state="skipped", last_error="member_left", lease_id=None, lease_until=None,
    )
    cancel_bill_emails(BillEmailNotice.objects.filter(participant=person), "member_left")
    from .chat_notifications import cancel_chat_notices
    from .models import BillChatNotice
    cancel_chat_notices(BillChatNotice.objects.filter(participant=person), 'member_left')
    result = record_change(group, actor, payload["command_id"], fingerprint, "participant_removed",
                           {"id": str(person.id), "removed": True, "owner_id": group.owner_id})
    result["disposition"] = "left"
    CommandReceipt.objects.filter(actor=actor, command_id=payload["command_id"]).update(result=result)
    return result


@transaction.atomic
def restore_group(actor, group_id, payload):
    previous, fingerprint = _receipt_context(actor, group_id, payload, "restore")
    if previous:
        return previous
    group = visible_group(actor, group_id, lock=True)
    person = group.participants.get(user=actor, removed=False)
    person.hidden = False
    person.save(update_fields=["hidden"])
    result = {"id": str(group.id), "version": group.version, "disposition": "restored"}
    CommandReceipt.objects.create(actor=actor, command_id=payload["command_id"], fingerprint=fingerprint, result=result)
    return result
