"""Explicit authenticated group joining. Bearer capabilities never appear in paths."""
from uuid import UUID

from django.contrib.auth import get_user_model
from django.core import signing
from django.db import transaction
from ninja.errors import HttpError

from .models import CommandReceipt, Group, GroupInviteLink, Participant
from .profiles import display_name
from .services import previous_result, record_change, visible_group, writable
from .store_review import require_group_scope


def link_token(link):
    # Random per-group identifier + 256-bit MAC; only the identifier is persisted.
    # Deliberately not TimestampSigner: these reusable links have no expiry.
    return signing.Signer(salt="merosplit.group-join.v1").sign(str(link.id))


def resolve_link(token, *, lock=False):
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
        return previous, link_token(link)
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
    return result, link_token(link)


@transaction.atomic
def preview_link(actor, token):
    _, group = resolve_link(token, lock=True)
    require_group_scope(actor, group)
    person = group.participants.filter(user=actor).first()
    if person and person.removed:
        raise HttpError(403, "Ask the organizer to add you again")
    # No ledger, emails or membership list is disclosed before explicit joining.
    return {"name": group.name, "already_member": bool(person)}


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
    previous, fingerprint = previous_result(actor, payload["command_id"], f"group_join:{group.id}", payload)
    if previous:
        return previous
    if person:
        result = {"id": str(group.id), "version": group.version}
        CommandReceipt.objects.create(actor=actor, command_id=payload["command_id"], fingerprint=fingerprint, result=result)
        return result
    # Never auto-match a guest name/email or take over an existing financial identity.
    name = (display_name(user) or "Member")[:120]
    person = Participant.objects.create(group=group, user=user, name=name)
    return record_change(group, actor, payload["command_id"], fingerprint, "participant_added",
                         {"id": str(person.id), "name": person.name, "linked_participant_ids": [str(person.id)]})
