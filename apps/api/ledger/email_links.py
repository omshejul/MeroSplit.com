"""Recipient-bound email links; Django/allauth still own identities and sessions."""

import base64
import hashlib
import json
import secrets
from datetime import timedelta
from urllib.parse import urlsplit
from uuid import NAMESPACE_URL, UUID, uuid5

from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import transaction
from django.utils import timezone
from django.utils.crypto import salted_hmac
from django.views.decorators.debug import sensitive_variables
from ninja.errors import HttpError

from . import store_review
from .models import EmailCodeChallenge, EmailLoginGrant, Group, Invite
from .otp import COOLDOWN, EmailCodeInvalid, consume_limits, normalized_email

LINK_PLACEHOLDER = "MEROSPLIT_EMAIL_LOGIN_LINK"
EXPIRY_PLACEHOLDER = "MEROSPLIT_EMAIL_LOGIN_EXPIRY"
CODE_PLACEHOLDER = "MEROSPLIT_EMAIL_LOGIN_CODE"


def _metadata(grant):
    return json.dumps([str(grant.id), grant.email, grant.purpose, grant.target, grant.delivery_origin, grant.source_key, grant.issued_user_id,
                       grant.expires_at.isoformat() if grant.expires_at else None,
                       grant.email_reminders_disclosed], sort_keys=True, separators=(",", ":"))


@sensitive_variables()
def _proof(grant):
    return base64.urlsafe_b64encode(salted_hmac(
        "merosplit.email-login-link.v1", _metadata(grant), algorithm="sha256",
    ).digest()).decode().rstrip("=")


def _stored_digest(grant):
    return hashlib.sha256(_proof(grant).encode()).hexdigest()


def _valid_metadata(grant):
    return bool(grant.expires_at and grant.proof_digest and secrets.compare_digest(grant.proof_digest, _stored_digest(grant)))


def _target(target):
    if target == {"kind": "home"}:
        return target
    if isinstance(target, dict) and set(target) == {"kind", "invite_id"} and target["kind"] == "invite":
        return {"kind": "invite", "invite_id": str(UUID(str(target["invite_id"])))}
    if isinstance(target, dict) and set(target) == {"kind", "notice_id"} and target["kind"] == "notice":
        return {"kind": "notice", "notice_id": str(UUID(str(target["notice_id"])))}
    raise ValueError("Unsupported email destination")


def issue_email_link(email, *, purpose, target, source_key, expires_at=None, email_reminders_disclosed=False, renewal_of=None):
    """No user/group locks: safe inside the existing invitation/digest transaction."""
    from allauth.account.models import EmailAddress

    email, target = normalized_email(email), _target(target)
    origin = urlsplit(settings.PUBLIC_WEB_URL)
    if origin.scheme != "https" or not origin.netloc or origin.username or origin.password or origin.query or origin.fragment or origin.path not in {"", "/"}:
        raise ValueError("Email destination is unavailable")
    if purpose not in {"login", "invite", "digest", "notice"} or (target["kind"] == "invite" and purpose != "invite"):
        raise ValueError("Unsupported email purpose")
    if (purpose == "notice") != (target["kind"] == "notice"):
        raise ValueError("Unsupported email purpose")
    if target["kind"] == "notice":
        from .bill_email_models import BillEmailNotice
        if not BillEmailNotice.objects.filter(pk=target["notice_id"], recipient_email=email).exists():
            raise ValueError("Notification is unavailable")
    if target["kind"] == "invite":
        invite_expiry = Invite.objects.filter(pk=target["invite_id"]).values_list("expires_at", flat=True).first()
        if not invite_expiry:
            raise ValueError("Invitation is unavailable")
        expires_at = min(expires_at, invite_expiry) if expires_at else invite_expiry
    ids = set(get_user_model().objects.filter(email__iexact=email).values_list("pk", flat=True))
    ids.update(EmailAddress.objects.filter(email__iexact=email).values_list("user_id", flat=True))
    grant, created = EmailLoginGrant.objects.get_or_create(source_key=source_key, defaults={
        "email": email, "purpose": purpose, "target": target,
        "delivery_origin": f"{origin.scheme}://{origin.netloc}",
        # A plain immutable ID avoids inserting a user FK while an invitation
        # holds its organizer's group lock. Bind the FK only under the user's
        # consume lock; a deleted issued identity must never be recreated.
        "issued_user_id": next(iter(ids)) if len(ids) == 1 else None,
        "invitation_id": target.get("invite_id"),
        "renewal_of_id": renewal_of,
        "expires_at": expires_at, "email_reminders_disclosed": email_reminders_disclosed,
    })
    if not created and (grant.email != email or grant.purpose != purpose or grant.target != target
                        or grant.email_reminders_disclosed != email_reminders_disclosed
                        or (expires_at is not None and grant.expires_at != expires_at)):
        raise ValueError("Email delivery metadata changed")
    if created and expires_at:
        grant.proof_digest = _stored_digest(grant)
        grant.save(update_fields=["proof_digest"])
    return grant


@transaction.atomic
def activate_email_link(grant_id, expires_at):
    grant = EmailLoginGrant.objects.select_for_update().get(pk=grant_id)
    if grant.expires_at is None:
        grant.expires_at = expires_at
        grant.proof_digest = _stored_digest(grant)
        grant.save(update_fields=["expires_at", "proof_digest"])
    elif grant.expires_at != expires_at:
        raise ValueError("Email expiry is already frozen")
    return grant


@sensitive_variables()
def delivery_url(grant_id):
    grant = EmailLoginGrant.objects.get(pk=grant_id)
    if not _valid_metadata(grant):
        raise ValueError("Email link is unavailable")
    origin = urlsplit(grant.delivery_origin)
    if origin.scheme != "https" or not origin.netloc or origin.username or origin.password or origin.query or origin.fragment or origin.path not in {"", "/"}:
        raise ValueError("Email destination is unavailable")
    return f"{origin.scheme}://{origin.netloc}/app/sign-in/{grant.id}#proof={_proof(grant)}"


@sensitive_variables()
def fallback_code(grant_id):
    grant = EmailLoginGrant.objects.get(pk=grant_id)
    digest = salted_hmac("merosplit.email-login-code.v1", _metadata(grant), algorithm="sha256").digest()
    return f"{int.from_bytes(digest, 'big') % 10000:04d}"


def _email_mutex(email):
    now = timezone.now()
    EmailCodeChallenge.objects.get_or_create(email=email, defaults={
        "requested_at": now - timedelta(seconds=COOLDOWN), "expires_at": now,
    })
    return EmailCodeChallenge.objects.select_for_update().get(email=email)


def _limits(email, network):
    limits = [("otp-confirm-network", network, 3600, 100), ("otp-confirm-network", network, 86400, 300)]
    if email:
        limits += [("otp-confirm-email", email, 3600, 10), ("otp-confirm-email", email, 86400, 30),
                   ("otp-confirm-email-budget", email, 900, 3)]
    consume_limits(limits)


def _recipient(grant):
    from .otp import _verified_user

    if store_review.entry_for_email(grant.email) or (grant.issued_user_id and not get_user_model().objects.filter(pk=grant.issued_user_id, is_active=True).exists()):
        raise EmailCodeInvalid()
    identity = _verified_user(grant.email, email_reminders_disclosed=grant.purpose == "login" and grant.email_reminders_disclosed)
    if not identity:
        raise EmailCodeInvalid()
    user, email = identity
    expected_user = grant.recipient_id or grant.issued_user_id
    if user.pk in store_review.review_ids() or (expected_user and expected_user != user.pk):
        raise EmailCodeInvalid()
    if expected_user and user.email.strip().lower() != grant.email:
        raise EmailCodeInvalid()
    return user, email


def _unconsumed_proof(grant, proof):
    if (not grant or not isinstance(proof, str) or len(proof) != 43 or not proof.isascii() or not _valid_metadata(grant)
            or not secrets.compare_digest(_proof(grant), proof) or grant.revoked_at or grant.consumed_at
            or grant.expires_at <= timezone.now()):
        raise EmailCodeInvalid()


def _recipient_before_login(grant):
    """Resolve a recipient without verifying, creating or updating an identity."""
    from allauth.account.models import EmailAddress

    User = get_user_model()
    if store_review.entry_for_email(grant.email):
        raise EmailCodeInvalid()
    ids = set(User.objects.filter(email__iexact=grant.email).values_list("pk", flat=True))
    addresses = EmailAddress.objects.filter(email__iexact=grant.email)
    ids.update(addresses.values_list("user_id", flat=True))
    if len(ids) > 1 or addresses.count() > 1:
        raise EmailCodeInvalid()
    expected = grant.recipient_id or grant.issued_user_id
    user = User.objects.filter(pk=next(iter(ids))).first() if ids else None
    if (expected and (not user or user.pk != expected or user.email.strip().lower() != grant.email)
            or user and (not user.is_active or user.pk in store_review.review_ids())):
        raise EmailCodeInvalid()
    # An unsaved recipient lets the same read-only destination guards apply to
    # a mailbox whose account will be created only during confirmed exchange.
    return user or User(email=grant.email)


def _inspect_destination(grant, user):
    if grant.purpose == "notice" and grant.target.get("kind") == "notice":
        from .bill_email import validate_notification_entry
        validate_notification_entry(grant, user)
        return
    target = _target(grant.target)
    if target == {"kind": "home"}:
        return
    if str(grant.invitation_id) != target["invite_id"]:
        raise EmailCodeInvalid()
    invite = Invite.objects.select_related("participant__group").filter(pk=target["invite_id"]).first()
    if (not invite or invite.revoked or invite.expires_at <= timezone.now() or invite.participant.group.archived
            or invite.intended_email.lower() != grant.email or invite.participant.removed):
        raise EmailCodeInvalid()
    store_review.require_group_scope(user, invite.participant.group)
    if invite.approved:
        if not user.pk or invite.participant.user_id != user.pk or invite.claimant_id != user.pk:
            raise EmailCodeInvalid()
    elif invite.participant.user_id or user.pk and invite.participant.group.participants.filter(user=user).exists():
        raise EmailCodeInvalid()


@sensitive_variables()
def inspect_email_link(grant_id, proof):
    """Bearer-proof inspection is lock-free and performs no database writes."""
    grant = EmailLoginGrant.objects.filter(pk=grant_id).first()
    _unconsumed_proof(grant, proof)
    user = _recipient_before_login(grant)
    _inspect_destination(grant, user)
    return {"email": grant.email, "user_id": user.pk, "purpose": grant.purpose}


def _require_switch(actor, target_user_id, switch_from_user_id):
    current_id = actor.pk if actor is not None and actor.is_authenticated and actor.is_active else None
    if switch_from_user_id is not None and (type(switch_from_user_id) is not int or switch_from_user_id <= 0
                                            or current_id != switch_from_user_id):
        raise EmailCodeInvalid()
    if current_id is not None and current_id != target_user_id and switch_from_user_id != current_id:
        raise EmailCodeInvalid()


def _destination(grant, user, *, claim):
    if grant.purpose == "notice" and grant.target.get("kind") == "notice":
        from .bill_email import validate_notification_entry
        return validate_notification_entry(grant, user)
    if grant.target == {"kind": "home"}:
        return {"kind": "home"}
    target = _target(grant.target)
    if str(grant.invitation_id) != target["invite_id"]:
        raise EmailCodeInvalid()
    candidate = Invite.objects.filter(pk=target["invite_id"]).values_list("participant__group_id", flat=True).first()
    group = Group.objects.select_for_update().filter(pk=candidate).first()
    invite = Invite.objects.select_for_update(of=("self",)).select_related("participant").filter(pk=target["invite_id"]).first()
    if (not group or not invite or invite.revoked or invite.expires_at <= timezone.now() or group.archived
            or invite.intended_email.lower() != grant.email or invite.participant.removed):
        raise EmailCodeInvalid()
    store_review.require_group_scope(user, group)
    if invite.approved:
        if invite.participant.user_id != user.pk or invite.claimant_id != user.pk:
            raise EmailCodeInvalid()
    elif claim:
        from .email_invites import claim_email_invite
        command_id = uuid5(NAMESPACE_URL, f"merosplit.email-link-claim:{grant.id}")
        claim_email_invite(user, invite, {"command_id": str(command_id)})
    else:
        raise EmailCodeInvalid()
    return {"kind": "group", "group_id": str(group.id)}


@sensitive_variables()
def exchange_email_link(grant_id, proof, network, *, actor=None, switch_from_user_id=None):
    # The email row is also OTP's identity-creation mutex. Grant is locked last,
    # after user/group/invite, matching issuance and account-deletion ordering.
    initial = EmailLoginGrant.objects.filter(pk=grant_id).first()
    failure, result = False, None
    with transaction.atomic():
        if initial:
            _email_mutex(initial.email)
        _limits(initial.email if initial else None, network)
        try:
            with transaction.atomic():
                _unconsumed_proof(initial, proof)
                candidate = _recipient_before_login(initial)
                _require_switch(actor, candidate.pk, switch_from_user_id)
                user, email = _recipient(initial)
                _require_switch(actor, user.pk, switch_from_user_id)
                if not user.first_name.strip() and initial.target.get("kind") == "invite":
                    from .profiles import update_display_name
                    name = Invite.objects.filter(pk=initial.target.get("invite_id")).values_list("participant__name", flat=True).first()
                    if name and name.strip():
                        update_display_name(user, name)
                        user.first_name = name.strip()
                destination = _destination(initial, user, claim=True)
                grant = EmailLoginGrant.objects.select_for_update().get(pk=grant_id)
                if grant.revoked_at or grant.consumed_at or grant.expires_at <= timezone.now() or not _valid_metadata(grant) or _metadata(grant) != _metadata(initial):
                    raise EmailCodeInvalid()
                grant.consumed_at, grant.recipient = timezone.now(), user
                grant.save(update_fields=["consumed_at", "recipient"])
                if grant.source_key.startswith("otp/"):
                    EmailCodeChallenge.objects.filter(email=email, challenge_id=grant.source_key.removeprefix("otp/")).update(consumed=True)
                result = user, email, destination
        except (EmailCodeInvalid, HttpError, ValueError, EmailLoginGrant.DoesNotExist):
            failure = True
    if failure:
        raise EmailCodeInvalid()
    return result


@transaction.atomic
def resume_email_link(grant_id, actor):
    grant = EmailLoginGrant.objects.filter(pk=grant_id).first()
    if (not grant or not actor.is_authenticated or (grant.recipient_id or grant.issued_user_id) != actor.pk or grant.revoked_at
            or not _valid_metadata(grant) or store_review.entry_for_email(grant.email)):
        raise EmailCodeInvalid()
    user = get_user_model().objects.select_for_update(no_key=True).filter(pk=actor.pk, is_active=True).first()
    if not user or user.pk in store_review.review_ids() or user.email.strip().lower() != grant.email:
        raise EmailCodeInvalid()
    destination = _destination(grant, user, claim=False)
    current = EmailLoginGrant.objects.select_for_update().filter(pk=grant_id).first()
    if not current or current.revoked_at or _metadata(current) != _metadata(grant) or not _valid_metadata(current):
        raise EmailCodeInvalid()
    return user, destination


def renew_email_link(grant_id, network):
    # Selector possession can request delivery only to its frozen known address.
    # Missing selectors consume a network bucket but reveal no recipient.
    from .otp import deliver_login_link, request_email_code

    grant = EmailLoginGrant.objects.filter(pk=grant_id).first()
    if not grant or store_review.entry_for_email(grant.email) or not _valid_metadata(grant) or (
        (grant.recipient_id or grant.issued_user_id) and not get_user_model().objects.filter(pk=grant.recipient_id or grant.issued_user_id, is_active=True, email__iexact=grant.email).exists()
    ):
        with transaction.atomic():
            consume_limits([("otp-request-network", network, 3600, 30), ("otp-request-network", network, 86400, 100)])
        return False
    with transaction.atomic():
        challenge = _email_mutex(grant.email)
        pending = grant.renewals.filter(delivered_at__isnull=True).order_by("-created_at").first()
        if pending:
            now = timezone.now()
            if challenge.requested_at > now - timedelta(seconds=COOLDOWN):
                from .otp import EmailCodeLimited
                raise EmailCodeLimited()
            consume_limits([
                ("otp-request-email", grant.email, 3600, 5), ("otp-request-email", grant.email, 86400, 20),
                ("otp-request-network", network, 3600, 30), ("otp-request-network", network, 86400, 100),
            ])
            challenge.requested_at = now
            challenge.save(update_fields=["requested_at"])
    if pending:
        # The provider's answer was uncertain. Same immutable body and key;
        # do not extend even an expired credential or reset the provider window.
        if pending.created_at < timezone.now() - timedelta(hours=23):
            return False
        deliver_login_link(pending.id)
        return True
    target, purpose = {"kind": "home"}, "login"
    if grant.target.get("kind") == "invite":
        invite = Invite.objects.filter(pk=grant.target.get("invite_id"), revoked=False, expires_at__gt=timezone.now(),
                                       intended_email=grant.email, participant__removed=False, participant__group__archived=False).first()
        if invite:
            target, purpose = grant.target, "invite"
    request_email_code(grant.email, network, link_target=target, link_purpose=purpose, renewal_of=grant.id,
                       email_reminders_disclosed=grant.purpose == "login" and grant.email_reminders_disclosed)
    return True
