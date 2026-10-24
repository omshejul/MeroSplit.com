"""Explicit email delivery and verified-address claims for unclaimed participants."""

from datetime import timedelta
from urllib.parse import urlsplit

from allauth.account.models import EmailAddress
from django.db import transaction
from django.utils import timezone
from ninja.errors import HttpError

from . import email_delivery
from .collaboration import invite_token
from .email_links import EXPIRY_PLACEHOLDER, LINK_PLACEHOLDER, issue_email_link
from .models import Change, Group, Invite, Participant
from .otp import EmailCodeLimited, consume_limits
from .profiles import display_name
from .services import clean_contact_email, previous_result, record_change, visible_group, writable
from .store_review import require_no_review_email


def _person(actor, group_id, participant_id):
    group = visible_group(actor, group_id, lock=True)
    if group.owner_id != actor.pk:
        raise HttpError(403, "Only the organizer can invite this person")
    writable(group)
    person = group.participants.filter(id=participant_id, user__isnull=True, removed=False).first()
    if not person:
        raise HttpError(409, "Choose an unclaimed person in this ledger")
    return group, person


@transaction.atomic
def update_contact(actor, group_id, participant_id, payload):
    group, person = _person(actor, group_id, participant_id)
    previous, fingerprint = previous_result(actor, payload["command_id"], f"contact:{participant_id}", payload)
    if previous:
        return previous
    email = clean_contact_email(payload["email"])
    if email != person.contact_email:
        person.contact_email = email
        person.save(update_fields=["contact_email"])
        Invite.objects.filter(participant=person, approved=False).update(revoked=True)
        from .bill_email import cancel_bill_emails
        from .bill_email_models import BillEmailNotice
        cancel_bill_emails(BillEmailNotice.objects.filter(participant=person), "contact_changed")
        from .chat_notifications import cancel_chat_notices
        from .models import BillChatNotice
        cancel_chat_notices(BillChatNotice.objects.filter(participant=person, recipient__isnull=True), 'contact_changed')
    return record_change(group, actor, payload["command_id"], fingerprint, "contact_changed", {"participant_id": str(person.id)})


def invite_status(invite):
    retry_after = max(0, 60 - int((timezone.now() - invite.last_send_at).total_seconds())) if invite.last_send_at else 0
    return {
        "id": str(invite.id), "state": invite.send_state,
        "sent_at": invite.sent_at.isoformat() if invite.sent_at else None, "retry_after": retry_after,
    }


@transaction.atomic
def _finish_delivery(invite, group_id, state, provider_id=""):
    group = Group.objects.select_for_update().filter(id=group_id).first()
    if not group:
        return invite
    current = Invite.objects.select_for_update().filter(
        id=invite.id, send_attempts=invite.send_attempts, send_state="sending",
    ).first()
    if not current:
        return invite
    current.send_state, current.provider_id = state, provider_id
    current.sent_at = timezone.now() if state == "sent" else None
    current.save(update_fields=["send_state", "provider_id", "sent_at"])
    group.version += 1
    group.save(update_fields=["version"])
    Change.objects.create(
        group=group, sequence=group.version, kind="email_invite_delivery",
        data={"id": str(current.id), "state": state},
    )
    return current


def send_person_invite(actor, group_id, participant_id, payload, origin, network):
    require_no_review_email(actor)
    with transaction.atomic():
        group, person = _person(actor, group_id, participant_id)
        previous, fingerprint = previous_result(actor, payload["command_id"], f"email_invite:{participant_id}", payload)
        now = timezone.now()
        if previous:
            invite = Invite.objects.filter(id=payload["command_id"], participant=person).first()
            if not invite or invite.revoked or invite.expires_at <= now:
                raise HttpError(409, "This invitation is no longer active; send a new invitation")
            result = previous
            if invite.send_state == "sent":
                return {**result, "invite": invite_status(invite)}
            if invite.last_send_at and invite.last_send_at > now - timedelta(seconds=60):
                raise HttpError(429, "Wait a minute before retrying this invitation")
            if invite.send_attempts >= 3 or invite.last_send_at < now - timedelta(hours=23):
                raise HttpError(409, "Send a new invitation to try again")
        else:
            if not person.contact_email:
                raise HttpError(422, "Add this person's email before sending an invitation")
            parsed = urlsplit(origin)
            if (parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password
                    or parsed.query or parsed.fragment or parsed.path not in {"", "/"}):
                raise HttpError(503, "Invitation delivery is unavailable")
            if Invite.objects.filter(participant=person, last_send_at__gt=now - timedelta(seconds=60)).exists():
                raise HttpError(429, "Wait a minute before sending another invitation")
            token = invite_token(payload["command_id"])
            import hashlib
            invite = Invite.objects.create(
                id=payload["command_id"], participant=person,
                token_hash=hashlib.sha256(token.encode()).hexdigest(),
                expires_at=now + timedelta(days=7), intended_email=person.contact_email,
                delivery_origin=origin.rstrip("/"),
            )
            grant = issue_email_link(
                invite.intended_email, purpose="invite", target={"kind": "invite", "invite_id": str(invite.id)},
                source_key=f"invite/{invite.id}", expires_at=invite.expires_at,
            )
            text, html = email_delivery.render_message("invitation", {
                "inviter_name": display_name(actor) or "Someone", "invite_url": LINK_PLACEHOLDER,
                "expires_at": EXPIRY_PLACEHOLDER,
            })
            invite.email_payload = email_delivery.message_payload(
                invite.intended_email, "Join your MeroSplit ledger", text, html,
            )
            invite.email_payload["_email_link_id"] = str(grant.id)
            invite.save(update_fields=["email_payload"])
            Invite.objects.filter(participant=person, approved=False).exclude(id=invite.id).update(revoked=True)
            result = record_change(
                group, actor, payload["command_id"], fingerprint, "email_invite_created",
                {"id": str(invite.id), "participant_id": str(person.id)},
            )
        try:
            consume_limits([
                ("invite-email", invite.intended_email, 86400, 5),
                ("invite-sender", str(actor.pk), 3600, 20), ("invite-network", network, 3600, 100),
            ])
        except EmailCodeLimited as exc:
            raise HttpError(429, "Invitation limit reached; try again later") from exc
        invite.send_state, invite.last_send_at = "sending", now
        invite.send_attempts += 1
        invite.save(update_fields=["send_state", "last_send_at", "send_attempts"])
    try:
        provider_id = email_delivery.send_email(
            invite.intended_email, invite.email_payload["subject"], invite.email_payload["text"],
            f"invite/{invite.id}", payload=invite.email_payload,
        )
    except email_delivery.EmailDeliveryUnavailable:
        invite = _finish_delivery(invite, group.id, "failed")
        return {**result, "invite": invite_status(invite)}
    invite = _finish_delivery(invite, group.id, "sent", provider_id)
    return {**result, "invite": invite_status(invite)}


def claim_email_invite(actor, invite, payload):
    # Caller holds the normal group then invite locks from claim_invite.
    group = invite.participant.group
    if not EmailAddress.objects.filter(user=actor, email__iexact=invite.intended_email, verified=True).exists():
        raise HttpError(403, "Sign in and verify the email address that received this invitation")
    previous, fingerprint = previous_result(actor, payload["command_id"], f"claim:{invite.id}", payload)
    if previous:
        visible_group(actor, group.id)
        return previous
    writable(group)
    if invite.participant.removed:
        raise HttpError(409, "This invitation cannot be accepted")
    if invite.participant.user_id or Participant.objects.filter(group=group, user=actor).exists():
        raise HttpError(409, "This ledger is already linked to an account")
    invite.participant.user = actor
    invite.participant.save(update_fields=["user"])
    invite.claimant, invite.approved = actor, True
    invite.save(update_fields=["claimant", "approved"])
    from .bill_email import promote_current_bill_emails
    promote_current_bill_emails(invite.participant)
    return record_change(
        group, actor, payload["command_id"], fingerprint, "participant_claim_approved",
        {"id": str(invite.id), "participant_id": str(invite.participant_id)},
    )
