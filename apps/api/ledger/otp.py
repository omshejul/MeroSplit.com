"""Four-digit email challenges, using allauth identities and PostgreSQL limits."""

import ipaddress
import secrets
from datetime import timedelta
from uuid import uuid4

from allauth.account.adapter import get_adapter
from allauth.account.models import EmailAddress
from django.conf import settings
from django.contrib.auth import get_user_model
from django.contrib.auth.hashers import check_password
from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.db import transaction
from django.utils import timezone
from django.utils.crypto import salted_hmac
from django.views.decorators.debug import sensitive_variables

from . import email_delivery, store_review
from .models import EmailCodeChallenge, EmailRateBucket

TTL = 180
COOLDOWN = 60
MAX_ATTEMPTS = 3


class EmailCodeInvalid(Exception):
    pass


class EmailCodeLimited(Exception):
    pass


def normalized_email(value) -> str:
    if not isinstance(value, str) or len(value) > 254:
        raise ValidationError("Enter a valid email address")
    value = value.strip().lower()
    validate_email(value)
    return value


def client_network(request) -> str:
    # Railway overwrites X-Real-IP on its public HTTP edge. Deployment opt-in
    # and an exact HTTPS public host are required; X-Forwarded-For is never used.
    value = request.META.get("REMOTE_ADDR", "")
    if settings.EMAIL_CLIENT_IP_SOURCE == "railway_public" and request.is_secure():
        host = request.get_host().partition(":")[0].lower().rstrip(".")
        if (
            host in settings.EMAIL_RAILWAY_PUBLIC_HOSTS and "." in host and not host.replace(".", "").isdigit()
            and not host.endswith((".internal", ".local", ".localhost"))
        ):
            value = request.META.get("HTTP_X_REAL_IP", "")
    try:
        if "%" in value:
            return "unknown-network"
        address = ipaddress.ip_address(value)
        return str(ipaddress.ip_network(f"{address}/{24 if address.version == 4 else 64}", strict=False))
    except ValueError:
        return "unknown-network"


def _digest(value: str) -> str:
    return salted_hmac("merosplit.email-security", value, algorithm="sha256").hexdigest()


def consume_limits(limits: list[tuple[str, str, int, int]]) -> None:
    """Call inside atomic; lock stable bucket keys in order across workers."""
    now = timezone.now()
    buckets = []
    for action, subject, seconds, maximum in limits:
        window = int(now.timestamp()) // seconds
        key = _digest(f"{action}:{subject}:{seconds}:{window}")
        expires = timezone.datetime.fromtimestamp((window + 1) * seconds, tz=timezone.get_current_timezone())
        buckets.append((key, expires, maximum))
    locked = []
    for key, expires, maximum in sorted(buckets):
        EmailRateBucket.objects.get_or_create(key=key, defaults={"expires_at": expires})
        row = EmailRateBucket.objects.select_for_update().get(key=key)
        if row.count >= maximum:
            raise EmailCodeLimited()
        locked.append(row)
    for row in locked:
        row.count += 1
        row.save(update_fields=["count"])


@sensitive_variables()
def request_email_code(email: str, network: str) -> dict:
    now, code = timezone.now(), f"{secrets.randbelow(10000):04d}"
    demo = store_review.entry_for_email(email)
    with transaction.atomic():
        EmailCodeChallenge.objects.get_or_create(
            email=email, defaults={"requested_at": now - timedelta(seconds=COOLDOWN), "expires_at": now},
        )
        challenge = EmailCodeChallenge.objects.select_for_update().get(email=email)
        if challenge.requested_at > now - timedelta(seconds=COOLDOWN):
            raise EmailCodeLimited()
        consume_limits([
            ("otp-request-email", email, 3600, 5), ("otp-request-email", email, 86400, 20),
            ("otp-request-network", network, 3600, 30), ("otp-request-network", network, 86400, 100),
        ])
        challenge.challenge_id = uuid4()
        challenge.digest = _digest(f"{challenge.challenge_id}:demo:{demo['pin_hash']}") if demo else _digest(f"{challenge.challenge_id}:{email}:{code}")
        challenge.requested_at, challenge.expires_at = now, now + timedelta(seconds=TTL)
        challenge.attempts, challenge.consumed, challenge.delivered = 0, False, False
        challenge.save()
    result = {"challenge_id": str(challenge.challenge_id), "expires_in": TTL, "retry_after": COOLDOWN}
    if demo:
        return result  # A reusable demo credential is not a delivered email code.
    text, html = email_delivery.render_message("sign_in", {"code": code, "expires_minutes": TTL // 60})
    email_delivery.send_email(email, "Your MeroSplit sign-in code", text, f"otp/{challenge.challenge_id}", html=html)
    EmailCodeChallenge.objects.filter(pk=challenge.pk, challenge_id=challenge.challenge_id).update(delivered=True)
    return result


@sensitive_variables()
def confirm_email_code(challenge_id, code: str, network: str):
    # A nonexistent challenge still consumes the shared network verification quota.
    email = EmailCodeChallenge.objects.filter(challenge_id=challenge_id).values_list("email", flat=True).first()
    failure, user, login_email, method = False, None, email, "code"
    with transaction.atomic():
        challenge = EmailCodeChallenge.objects.select_for_update().filter(email=email).first() if email else None
        limits = [("otp-confirm-network", network, 3600, 100), ("otp-confirm-network", network, 86400, 300)]
        if email:
            limits += [
                ("otp-confirm-email", email, 3600, 10), ("otp-confirm-email", email, 86400, 30),
                ("otp-confirm-email-budget", email, 900, MAX_ATTEMPTS),
            ]
        consume_limits(limits)
        entry = store_review.entry_for_email(email)
        demo = bool(challenge and entry and entry["pin_hash"] and secrets.compare_digest(
            challenge.digest, _digest(f"{challenge_id}:demo:{entry['pin_hash']}"),
        ))
        if (
            not challenge or challenge.challenge_id != challenge_id or challenge.consumed or not (challenge.delivered or demo)
            or challenge.expires_at <= timezone.now() or challenge.attempts >= MAX_ATTEMPTS
        ):
            failure = True
        else:
            challenge.attempts += 1
            valid = isinstance(code, str) and len(code) == 4 and code.isascii() and code.isdecimal()
            valid = valid and (check_password(code, entry["pin_hash"]) if demo else secrets.compare_digest(challenge.digest, _digest(f"{challenge_id}:{email}:{code}")))
            if valid:
                if demo:
                    identity_user = store_review.credential_user(entry)
                    identity = (identity_user, email) if identity_user else None
                    method = "demo_credential"
                else:
                    identity = _verified_user(email)
                if identity:
                    user, login_email = identity
                challenge.consumed = True
            else:
                failure = True
            challenge.save(update_fields=["attempts", "consumed"])
    if failure or not user:
        raise EmailCodeInvalid()
    return user, login_email, method


def _verified_user(email: str):
    User = get_user_model()
    ids = set(User.objects.filter(email__iexact=email).values_list("pk", flat=True))
    ids.update(EmailAddress.objects.filter(email__iexact=email).values_list("user_id", flat=True))
    if len(ids) > 1:
        return None  # Conflicting legacy identities require recovery, never an implicit merge.
    if ids:
        user = User.objects.select_for_update().get(pk=next(iter(ids)))
        if not user.is_active:
            return None
    else:
        user = get_adapter().new_user(None)
        user.username, user.email = f"email-{uuid4().hex}", email
        user.set_unusable_password()
        user.save()
    addresses = list(EmailAddress.objects.filter(user=user, email__iexact=email))
    if len(addresses) > 1:
        return None
    address = addresses[0] if addresses else None
    if address is None:
        address = EmailAddress.objects.create(user=user, email=email, primary=not user.email or user.email.lower() == email)
    elif address.email != email:
        # Allauth's manager looks up normalized addresses exactly. Preserve User.email
        # and its password/session hash while repairing a legacy address's casing.
        address.email = email
        address.save(update_fields=["email"])
    if not address.set_verified(commit=True):
        return None
    return user, address.email
