"""Reusable group capabilities. Joining always requires an authenticated action."""
import re
import secrets
from uuid import UUID

from django.contrib.auth import get_user_model
from django.core import signing
from django.db import transaction
from django.utils import timezone
from ninja.errors import HttpError

from .models import CommandReceipt, Group, GroupInviteLink, Invite, Participant
from .profiles import display_name
from .services import previous_result, record_change, visible_group, writable
from .store_review import require_group_scope


def link_token(link):
    # Random per-group identifier + 256-bit MAC; only the identifier is persisted.
    # Deliberately not TimestampSigner: these reusable links have no expiry.
    return signing.Signer(salt="merosplit.group-join.v1").sign(str(link.id))


def resolve_link(token, *, lock=False):
    if re.fullmatch(r"[A-Za-z0-9_-]{32}", token):
        link = GroupInviteLink.objects.filter(public_code=token).first()
    else:
        try:
            if len(token) > 128:
                raise ValueError()
            link_id = UUID(signing.Signer(salt="merosplit.group-join.v1").unsign(token))
        except (ValueError, signing.BadSignature):
            raise HttpError(404, "This invite link is unavailable") from None
        link = GroupInviteLink.objects.filter(pk=link_id).first()
    if not link:
        raise HttpError(404, "This invite link is unavailable")
    query = Group.objects.filter(pk=link.group_id)
    if lock:
        query = query.select_for_update()
    group = query.first()
    # An old organizer's link must not survive their departure or an ownership change.
    if not group or group.archived or group.is_direct or group.owner_id != link.created_by_id or not group.participants.filter(user_id=link.created_by_id, removed=False, user__is_active=True).exists():
        raise HttpError(404, "This invite link is unavailable")
    return link, group


def ensure_public_code(link):
    # Called only under the group's write lock, never by public GET/HEAD.
    if not link.public_code:
        link.public_code = secrets.token_urlsafe(24)
        link.save(update_fields=["public_code"])
    return link.public_code


@transaction.atomic
def create_link(actor, group_id, payload):
    group = visible_group(actor, group_id, lock=True)
    writable(group)
    if group.owner_id != actor.pk or group.is_direct:
        raise HttpError(403, "Only the organizer can share a group invite link")
    previous, fingerprint = previous_result(actor, payload["command_id"], f"group_link:{group.id}", payload)
    if previous:
        link = GroupInviteLink.objects.filter(group=group, created_by=actor).first()
        if not link or previous.get("invite_link_id") != str(link.id):
            raise HttpError(409, "The invitation changed; create a new link")
        return previous, ensure_public_code(link)
    link, created = GroupInviteLink.objects.get_or_create(group=group, defaults={"created_by": actor})
    if link.created_by_id != actor.pk:
        # A successor gets a new capability; the departed organizer's URL stays invalid.
        link.delete()
        link = GroupInviteLink.objects.create(group=group, created_by=actor)
        created = True
    if created:
        result = record_change(group, actor, payload["command_id"], fingerprint, "group_invite_link_created", {})
    else:
        result = {"id": str(group.id), "version": group.version}
        CommandReceipt.objects.create(actor=actor, command_id=payload["command_id"], fingerprint=fingerprint, result=result)
    result = {**result, "invite_link_id": str(link.id)}
    CommandReceipt.objects.filter(actor=actor, command_id=payload["command_id"]).update(result=result)
    return result, ensure_public_code(link)


def claimable_people(group):
    pending = Invite.objects.filter(participant__group=group, revoked=False, approved=False,
                                    claimant__isnull=False, expires_at__gt=timezone.now()).values("participant_id")
    return group.participants.filter(user__isnull=True, contact_email="", removed=False).exclude(id__in=pending)


@transaction.atomic
def preview_link(actor, token):
    _, group = resolve_link(token, lock=True)
    require_group_scope(actor, group)
    person = group.participants.filter(user=actor).first()
    if person and person.removed:
        raise HttpError(403, "Ask the organizer to add you again")
    choices = list(claimable_people(group).order_by("id")) if not person else []
    # Only authenticated capability holders see eligible labels, never emails or money.
    return {"name": group.name, "already_member": bool(person), "version": group.version,
            "people": [] if person else [{"id": str(p.id), "name": p.name} for p in choices]}


@transaction.atomic
def join_link(actor, payload):
    # Same lock order as account deletion/display-name and existing invite claims.
    user = get_user_model().objects.select_for_update(no_key=True).filter(pk=actor.pk, is_active=True).first()
    if not user:
        raise HttpError(401, "Sign in again")
    _, group = resolve_link(payload["token"], lock=True)
    require_group_scope(actor, group)
    person = group.participants.filter(user=actor).first()
    if person and person.removed:
        raise HttpError(403, "Ask the organizer to add you again")
    # Absent new defaults must retain the original legacy command fingerprint.
    payload = {key: value for key, value in payload.items() if key not in {"participant_id", "preview_version", "display_name"} or value is not None and value != ""}
    previous, fingerprint = previous_result(actor, payload["command_id"], f"group_join:{group.id}", payload)
    if previous:
        return previous
    if person:
        if payload.get("participant_id"):
            raise HttpError(409, "Your account already belongs to this group. Refresh the invitation.")
        result = {"id": str(group.id), "version": group.version}
        CommandReceipt.objects.create(actor=actor, command_id=payload["command_id"], fingerprint=fingerprint, result=result)
        return result
    target_id = payload.get("participant_id")
    label = payload.get("display_name", "").strip()
    if "display_name" in payload and not label:
        raise HttpError(422, "Enter your name in this group")
    if target_id:
        person = claimable_people(group).select_for_update().filter(id=target_id).first()
        if not person or payload.get("preview_version") != group.version:
            raise HttpError(409, "This person or invitation changed. Refresh and choose again.")
        person.user = user
        person.display_name_override = label or person.name
        person.save(update_fields=["user", "display_name_override"])
        Invite.objects.filter(participant=person, approved=False).update(revoked=True)
        return record_change(group, actor, payload["command_id"], fingerprint, "participant_claim_approved",
                             {"participant_id": str(person.id), "linked_participant_ids": [str(person.id)]})
    # Never auto-match a guest name/email or take over an existing financial identity.
    name = (display_name(user) or "Member")[:120]
    person = Participant.objects.create(group=group, user=user, name=name, display_name_override=label)
    return record_change(group, actor, payload["command_id"], fingerprint, "participant_added",
                         {"id": str(person.id), "name": person.name, "linked_participant_ids": [str(person.id)]})
