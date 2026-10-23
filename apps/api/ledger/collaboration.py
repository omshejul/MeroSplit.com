import hashlib
from datetime import timedelta

from allauth.account.models import EmailAddress
from django.contrib.auth import get_user_model
from django.core import signing
from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from ninja.errors import HttpError

from .accounting import AccountingError, propose_transfers
from .expense_notifications import cancel_notices
from .models import ExpenseNotice, ExpensePushDelivery, Invite, OpeningBalance, Participant
from .services import (
    clean_contact_email,
    keep_removed_balances_zero,
    people,
    previous_result,
    record_change,
    snapshot,
    visible_group,
    writable,
)
from .store_review import require_group_scope


def invite_token(invite_id):
    return signing.Signer(salt="splitdumb.participant-invite").sign(str(invite_id))


def valid_invite(token, *, lock=False):
    query = Invite.objects.select_related("participant__group", "claimant").filter(
        token_hash=hashlib.sha256(token.encode()).hexdigest(), revoked=False,
        expires_at__gt=timezone.now(), participant__removed=False,
    )
    if lock:
        query = query.select_for_update(of=("self",))
    invite = query.first()
    if not invite:
        raise HttpError(404, "Invitation expired or revoked")
    return invite


@transaction.atomic
def create_invite(actor, group_id, payload):
    group = visible_group(actor, group_id, lock=True)
    if group.owner_id != actor.pk:
        raise HttpError(403, "Only the organizer creates participant invitations")
    previous, fingerprint = previous_result(actor, payload["command_id"], f"invite:{group_id}", payload)
    if previous:
        return previous
    participant = group.participants.filter(
        id=payload["participant_id"], user__isnull=True, removed=False,
    ).first()
    if not participant:
        raise HttpError(409, "Choose an unclaimed participant in this group")
    if participant.contact_email:
        raise HttpError(409, "Use an email invitation for a person with a saved email")
    token = invite_token(payload["command_id"])
    invite = Invite.objects.create(
        id=payload["command_id"],
        participant=participant,
        token_hash=hashlib.sha256(token.encode()).hexdigest(),
        expires_at=timezone.now() + timedelta(days=7),
    )
    return record_change(
        group,
        actor,
        payload["command_id"],
        fingerprint,
        "invite_created",
        {"id": str(invite.id), "participant_id": str(participant.id)},
    )


def guest_view(token):
    invite = valid_invite(token)
    if invite.intended_email:
        return {"requires_email_verification": True, "group_id": str(invite.participant.group_id)}
    with transaction.atomic():
        # Sharing exposes one person's involvement, not all unrelated bills.
        group = invite.participant.group
        group = type(group).objects.select_for_update().get(id=group.id)
        invite = valid_invite(token)
        state = snapshot(group)
        person = str(invite.participant_id)
        expenses = [
            e
            for e in state["expenses"]
            if int(e["paid"].get(person, "0")) or int(e["shares"].get(person, "0"))
        ]
        settlements = [s for s in state["settlements"] if person in [s["sender"], s["recipient"]]]
        involved = {person}
        for expense in expenses:
            involved.update(p for p, amount in expense["paid"].items() if amount != "0")
            involved.update(p for p, amount in expense["shares"].items() if amount != "0")
        for settlement in settlements:
            involved.update([settlement["sender"], settlement["recipient"]])
        for expense in expenses:
            expense["paid"] = {p: amount for p, amount in expense["paid"].items() if p in involved}
            expense["shares"] = {p: amount for p, amount in expense["shares"].items() if p in involved}
            expense["split"]["values"] = {
                p: amount for p, amount in expense["split"]["values"].items() if p in involved
            }
        return {
            "group_id": str(group.id),
            "group_name": group.name,
            "participant": {"id": person, "name": invite.participant.name},
            "balance": state["balances"][person],
            "opening_balance": (
                {
                    "amount": state["opening_balance"]["balances"].get(person, "0"),
                    "source": state["opening_balance"]["source"],
                    "cutoff": state["opening_balance"]["cutoff"],
                    "accepted": state["opening_balance"]["accepted"],
                }
                if state["opening_balance"]
                else None
            ),
            "participants": [
                {"id": p["id"], "name": p["name"]} for p in state["participants"] if p["id"] in involved
            ],
            "expenses": expenses,
            "settlements": settlements,
            "claim_pending": bool(invite.claimant_id),
            "approved": invite.approved,
        }


@transaction.atomic
def claim_invite(actor, token, payload):
    # Serialize new membership with account-wide display-name changes/deletion.
    if not get_user_model().objects.select_for_update(no_key=True).filter(pk=actor.pk, is_active=True).exists():
        raise HttpError(401, "Sign in again to accept this invitation")
    invite = valid_invite(token)
    group = invite.participant.group
    # Lock group before invite, consistently with organizer approval.
    group = type(group).objects.select_for_update().get(id=group.id)
    invite = valid_invite(token, lock=True)
    require_group_scope(actor, group)
    if not invite.intended_email and invite.participant.contact_email:
        raise HttpError(409, "Ask the organizer to send an email invitation for this person")
    if invite.intended_email:
        from .email_invites import claim_email_invite
        return claim_email_invite(actor, invite, payload)
    previous, fingerprint = previous_result(actor, payload["command_id"], f"claim:{invite.id}", payload)
    if previous:
        return previous
    if invite.participant.user_id or Participant.objects.filter(group=group, user=actor).exists():
        raise HttpError(409, "Participant or account is already linked in this group")
    if invite.claimant_id and invite.claimant_id != actor.pk:
        raise HttpError(409, "Another claim is pending; ask the organizer to revoke and reissue")
    invite.claimant = actor
    invite.save(update_fields=["claimant"])
    return record_change(
        group,
        actor,
        payload["command_id"],
        fingerprint,
        "participant_claim_requested",
        {"id": str(invite.id), "participant_id": str(invite.participant_id), "claimant_id": actor.pk},
    )


@transaction.atomic
def review_invite(actor, group_id, invite_id, payload, approve):
    if approve:
        claimant_id = Invite.objects.filter(id=invite_id, participant__group_id=group_id, participant__group__owner_id=actor.pk).values_list("claimant_id", flat=True).first()
        if claimant_id:
            get_user_model().objects.select_for_update(no_key=True).filter(pk=claimant_id).exists()
    group = visible_group(actor, group_id, lock=True)
    if group.owner_id != actor.pk:
        raise HttpError(403, "Only the organizer can review participant claims")
    previous, fingerprint = previous_result(
        actor, payload["command_id"], f"review_invite:{group_id}:{invite_id}:{approve}", payload
    )
    if previous:
        return previous
    invite = (
        Invite.objects.select_for_update()
        .select_related("participant")
        .filter(id=invite_id, participant__group=group)
        .first()
    )
    if not invite:
        raise HttpError(404, "Invitation not found")
    if approve:
        if invite.claimant_id != claimant_id:
            raise HttpError(409, "The pending claim changed; review it again")
        if not invite.intended_email and invite.participant.contact_email:
            raise HttpError(409, "Send an email invitation before linking this person")
        if invite.intended_email and not EmailAddress.objects.filter(user_id=invite.claimant_id, email__iexact=invite.intended_email, verified=True).exists():
            raise HttpError(403, "The claimant must verify the email address that received this invitation")
        if (
            invite.revoked
            or invite.expires_at <= timezone.now()
            or not invite.claimant_id
            or invite.participant.user_id
            or invite.participant.removed
        ):
            raise HttpError(409, "This invitation has no valid pending claim")
        if Participant.objects.filter(group=group, user_id=invite.claimant_id).exists():
            raise HttpError(409, "Account already has a participant in this group")
        require_group_scope(invite.claimant, group)
        invite.participant.user_id = invite.claimant_id
        invite.participant.save(update_fields=["user"])
        invite.approved = True
    else:
        invite.revoked = True
    invite.save(update_fields=["approved", "revoked"])
    if approve:
        from .bill_email import promote_current_bill_emails
        promote_current_bill_emails(invite.participant)
    return record_change(
        group,
        actor,
        payload["command_id"],
        fingerprint,
        "participant_claim_approved" if approve else "invite_revoked",
        {"id": str(invite.id), "participant_id": str(invite.participant_id)},
    )


@transaction.atomic
def create_opening(actor, group_id, payload):
    group = visible_group(actor, group_id, lock=True)
    if actor.pk != group.owner_id:
        raise HttpError(403, "Only the organizer proposes opening balances")
    previous, fingerprint = previous_result(actor, payload["command_id"], f"opening:{group_id}", payload)
    if previous:
        return previous
    writable(group)
    members = people(group)
    if set(payload["balances"]) != set(members) or not any(v != "0" for v in payload["balances"].values()):
        raise AccountingError("Provide a nonzero opening vector for exactly these participants")
    propose_transfers(payload["balances"])
    if OpeningBalance.objects.filter(group=group).exists():
        raise HttpError(409, "This group already has an opening-balance proposal")
    acknowledgments = {
        p: {"user_id": actor.pk, "at": timezone.now().isoformat()}
        for p, member in members.items()
        if member.user_id == actor.pk
    }
    opening = OpeningBalance.objects.create(
        id=payload["id"],
        group=group,
        balances=payload["balances"],
        source=payload["source"],
        cutoff=payload["cutoff"],
        acknowledgments=acknowledgments,
    )
    return record_change(
        group,
        actor,
        payload["command_id"],
        fingerprint,
        "opening_proposed",
        {
            "id": str(opening.id),
            "balances": opening.balances,
            "source": opening.source,
            "cutoff": payload["cutoff"],
            "accepted": False,
        },
    )


@transaction.atomic
def acknowledge_opening(actor, group_id, opening_id, payload):
    group = visible_group(actor, group_id, lock=True)
    previous, fingerprint = previous_result(
        actor, payload["command_id"], f"ack_opening:{group_id}:{opening_id}", payload
    )
    if previous:
        return previous
    writable(group)
    opening = OpeningBalance.objects.filter(id=opening_id, group=group).first()
    if not opening:
        raise HttpError(404, "Opening balances not found")
    person = group.participants.get(user=actor, removed=False)
    opening.acknowledgments[str(person.id)] = {"user_id": actor.pk, "at": timezone.now().isoformat()}
    opening.accepted = all(
        p in opening.acknowledgments for p, amount in opening.balances.items() if amount != "0"
    )
    opening.save(update_fields=["acknowledgments", "accepted"])
    keep_removed_balances_zero(group)
    return record_change(
        group,
        actor,
        payload["command_id"],
        fingerprint,
        "opening_acknowledged",
        {"id": str(opening.id), "participant_id": str(person.id), "accepted": opening.accepted},
    )


@transaction.atomic
def archive_group(actor, group_id, payload):
    group = visible_group(actor, group_id, lock=True)
    if group.owner_id != actor.pk:
        raise HttpError(403, "Only the organizer archives a group")
    previous, fingerprint = previous_result(actor, payload["command_id"], f"archive:{group_id}", payload)
    if previous:
        return previous
    group.archived = payload["archived"]
    group.save(update_fields=["archived"])
    if group.archived:
        from .bill_email import cancel_bill_emails
        from .bill_email_models import BillEmailNotice
        cancel_bill_emails(BillEmailNotice.objects.filter(expense__group=group), "group_archived")
        cancel_notices(ExpenseNotice.objects.filter(expense__group=group), "group_archived")
        from .chat_notifications import cancel_chat_notices
        from .models import BillChatNotice
        cancel_chat_notices(BillChatNotice.objects.filter(message__expense__group=group), 'group_archived')
    return record_change(
        group,
        actor,
        payload["command_id"],
        fingerprint,
        "group_archived" if group.archived else "group_unarchived",
        {"archived": group.archived},
    )


@transaction.atomic
def add_participant(actor, group_id, payload):
    group = visible_group(actor, group_id, lock=True)
    if group.owner_id != actor.pk:
        raise HttpError(403, "Only the organizer can add participants")
    if not payload.get("email"):
        payload = {key: value for key, value in payload.items() if key != "email"}
    previous, fingerprint = previous_result(
        actor, payload["command_id"], f"add_participant:{group_id}", payload
    )
    if previous:
        return previous
    writable(group)
    if group.is_direct:
        raise HttpError(409, "A direct ledger has exactly two participants")
    if group.participants.count() >= 100:
        raise HttpError(409, "Group participant limit reached")
    if Participant.objects.filter(id=payload["id"]).exists():
        raise HttpError(409, "Participant ID is already in use")
    if not payload["name"].strip():
        raise AccountingError("Enter a participant name")
    person = Participant.objects.create(
        id=payload["id"], group=group, name=payload["name"].strip(),
        contact_email=clean_contact_email(payload.get("email", "")),
    )
    return record_change(
        group,
        actor,
        payload["command_id"],
        fingerprint,
        "participant_added",
        {"id": str(person.id), "name": person.name},
    )


@transaction.atomic
def remove_participant(actor, group_id, participant_id, payload):
    group = visible_group(actor, group_id, lock=True)
    if group.owner_id != actor.pk:
        raise HttpError(403, "Only the organizer can remove participants")
    previous, fingerprint = previous_result(
        actor, payload["command_id"], f"remove_participant:{group_id}:{participant_id}", payload,
    )
    if previous:
        return previous
    person = group.participants.filter(id=participant_id).first()
    if not person:
        raise HttpError(404, "Participant not found")
    if person.user_id == group.owner_id:
        raise HttpError(409, "The organizer cannot be removed")
    if person.removed:
        raise HttpError(409, "This person was already removed")
    balance = abs(int(snapshot(group)["balances"][str(person.id)]))
    if balance:
        amount = f"{balance // 100:,}" + (f".{balance % 100:02}" if balance % 100 else "")
        raise HttpError(409, f"Settle ₹{amount} first")
    involved_attempts = group.attempts.filter(Q(sender=person) | Q(recipient=person))
    if involved_attempts.filter(state="reported").exists():
        raise HttpError(409, "Resolve the reported payment first")
    opening = OpeningBalance.objects.filter(group=group, accepted=False).first()
    if opening and int(opening.balances.get(str(person.id), "0")):
        raise HttpError(409, "Resolve the opening balance proposal first")
    from .bill_email import cancel_bill_emails
    from .bill_email_models import BillEmailNotice
    cancel_bill_emails(BillEmailNotice.objects.filter(participant=person), "member_removed")
    from .chat_notifications import cancel_chat_notices
    from .models import BillChatNotice
    cancel_chat_notices(BillChatNotice.objects.filter(participant=person), 'member_removed')
    person.removed = True
    person.save(update_fields=["removed"])
    Invite.objects.filter(participant=person).update(revoked=True)
    involved_attempts.filter(state="prepared").update(state="cancelled")
    if person.user_id:
        ExpenseNotice.objects.filter(expense__group=group, recipient_id=person.user_id).update(cancelled_at=timezone.now(), email_eligible=False)
        ExpensePushDelivery.objects.filter(
            expense__group=group, recipient_id=person.user_id,
            state__in=["pending", "sending", "queued", "checking", "skipped"],
        ).update(state="skipped", last_error="member_removed", lease_id=None, lease_until=None)
    if group.is_direct:
        group.archived = True
        group.save(update_fields=["archived"])
    return record_change(
        group, actor, payload["command_id"], fingerprint, "participant_removed",
        {"id": str(person.id), "removed": True, "archived": group.archived},
    )
