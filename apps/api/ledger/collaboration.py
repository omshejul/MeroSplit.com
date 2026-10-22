import hashlib
from datetime import timedelta

from django.core import signing
from django.db import transaction
from django.utils import timezone
from ninja.errors import HttpError

from .accounting import AccountingError, propose_transfers
from .models import Invite, OpeningBalance, Participant
from .services import people, previous_result, record_change, snapshot, visible_group, writable


def invite_token(invite_id):
    return signing.Signer(salt="splitdumb.participant-invite").sign(str(invite_id))


def valid_invite(token, *, lock=False):
    query = Invite.objects.select_related("participant__group", "claimant").filter(
        token_hash=hashlib.sha256(token.encode()).hexdigest(), revoked=False, expires_at__gt=timezone.now()
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
    participant = group.participants.filter(id=payload["participant_id"], user__isnull=True).first()
    if not participant:
        raise HttpError(409, "Choose an unclaimed participant in this group")
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
    invite = valid_invite(token)
    group = invite.participant.group
    # Lock group before invite, consistently with organizer approval.
    group = type(group).objects.select_for_update().get(id=group.id)
    invite = valid_invite(token, lock=True)
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
        if (
            invite.revoked
            or invite.expires_at <= timezone.now()
            or not invite.claimant_id
            or invite.participant.user_id
        ):
            raise HttpError(409, "This invitation has no valid pending claim")
        if Participant.objects.filter(group=group, user_id=invite.claimant_id).exists():
            raise HttpError(409, "Account already has a participant in this group")
        invite.participant.user_id = invite.claimant_id
        invite.participant.save(update_fields=["user"])
        invite.approved = True
    else:
        invite.revoked = True
    invite.save(update_fields=["approved", "revoked"])
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
    person = group.participants.get(user=actor)
    opening.acknowledgments[str(person.id)] = {"user_id": actor.pk, "at": timezone.now().isoformat()}
    opening.accepted = all(
        p in opening.acknowledgments for p, amount in opening.balances.items() if amount != "0"
    )
    opening.save(update_fields=["acknowledgments", "accepted"])
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
    previous, fingerprint = previous_result(
        actor, payload["command_id"], f"add_participant:{group_id}", payload
    )
    if previous:
        return previous
    writable(group)
    if group.participants.count() >= 100:
        raise HttpError(409, "Group participant limit reached")
    if Participant.objects.filter(id=payload["id"]).exists():
        raise HttpError(409, "Participant ID is already in use")
    if not payload["name"].strip():
        raise AccountingError("Enter a participant name")
    person = Participant.objects.create(id=payload["id"], group=group, name=payload["name"].strip())
    return record_change(
        group,
        actor,
        payload["command_id"],
        fingerprint,
        "participant_added",
        {"id": str(person.id), "name": person.name},
    )
