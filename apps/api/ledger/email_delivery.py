"""The only outbound email boundary. Tests replace this function, never real inboxes."""

import base64
import json
import re
from datetime import timezone
from email.utils import parseaddr
from html import escape
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import DatabaseError, transaction
from django.template import Context, engines
from django.utils import timezone as django_timezone
from django.utils.crypto import salted_hmac
from django.views.decorators.debug import sensitive_variables


class EmailDeliveryUnavailable(Exception):
    pass


class EmailDeliveryHeld(EmailDeliveryUnavailable):
    """A durable attempt must be reconciled, not automatically sent again."""


@sensitive_variables()
def materialize_payload(payload: dict, *, recipient: str | None = None) -> dict:
    """Resolve a frozen email recipe without storing its bearer link or code."""
    if "_email_link_id" not in payload:
        return payload
    from .email_links import (
        CODE_PLACEHOLDER,
        EXPIRY_PLACEHOLDER,
        LINK_PLACEHOLDER,
        delivery_url,
        fallback_code,
    )
    from .models import EmailLoginGrant
    try:
        grant = EmailLoginGrant.objects.filter(id=payload["_email_link_id"]).first()
        if not grant or not grant.expires_at or payload.get("to") != [grant.email] or recipient is not None and recipient != grant.email:
            raise EmailDeliveryUnavailable()
        values = {
            LINK_PLACEHOLDER: delivery_url(grant.id),
            EXPIRY_PLACEHOLDER: grant.expires_at.astimezone(timezone.utc).strftime("%d %b %Y, %H:%M:%S UTC"),
        }
        if grant.purpose == "notice":
            from .bill_email import delivery_stop_url
            values["MEROSPLIT_BILL_EMAIL_STOP_LINK"] = delivery_stop_url(grant)
        if any(CODE_PLACEHOLDER in payload.get(part, "") for part in ("text", "html")):
            values[CODE_PLACEHOLDER] = fallback_code(grant.id)
    except (EmailLoginGrant.DoesNotExist, ValidationError, ValueError, TypeError):
        raise EmailDeliveryUnavailable() from None
    resolved = {key: value for key, value in payload.items() if key != "_email_link_id"}
    for part in ("text", "html"):
        if part in resolved:
            for marker, value in values.items():
                resolved[part] = resolved[part].replace(marker, escape(value, quote=True) if part == "html" else value)
    return resolved


@sensitive_variables()
def render_message(template: str, context: dict) -> tuple[str, str]:
    values = {**context, "logo_url": "cid:merosplit-logo"}
    engine = engines["django"].engine
    text = engine.get_template(f"email/{template}.txt").render(Context(values, autoescape=False))
    html = engine.get_template(f"email/{template}.html").render(Context(values, autoescape=True))
    return text, html


@sensitive_variables()
def message_payload(recipient: str, subject: str, text: str, html: str | None = None) -> dict:
    payload = {
        "from": settings.DEFAULT_FROM_EMAIL, "to": [recipient], "subject": subject, "text": text,
        "reply_to": settings.EMAIL_REPLY_TO,
    }
    if settings.EMAIL_PROVIDER == "cloudflare":
        payload["_email_provider"] = "cloudflare"
    if html is not None:
        payload["html"] = html
        logo = Path(__file__).with_name("email_assets").joinpath("merosplit-logo-144.png").read_bytes()
        payload["attachments"] = [{
            "filename": "merosplit-logo.png", "content": base64.b64encode(logo).decode("ascii"),
            "content_type": "image/png", "content_id": "merosplit-logo",
        }]
    return payload


@sensitive_variables()
def send_email(recipient: str, subject: str, text: str, delivery_id: str, *, html=None, payload=None) -> str:
    frozen = payload if payload is not None else message_payload(recipient, subject, text, html)
    # Missing marker means an existing Resend recipe, even after runtime cutover.
    provider = frozen.get("_email_provider", "resend")
    resolved = {key: value for key, value in materialize_payload(frozen, recipient=recipient).items() if key != "_email_provider"}
    if provider == "cloudflare":
        return send_cloudflare(recipient, delivery_id, resolved)
    if provider != "resend":
        raise EmailDeliveryUnavailable()
    key = getattr(settings, "RESEND_API_KEY", "")
    sender = resolved.get("from", "")
    if not key or not sender:
        raise EmailDeliveryUnavailable()
    request = Request(
        "https://api.resend.com/emails",
        data=json.dumps(resolved, sort_keys=True).encode(),
        headers={
            "Authorization": f"Bearer {key}", "Content-Type": "application/json", "Idempotency-Key": delivery_id,
            "User-Agent": "MeroSplit/0.3.1 (transactional email)",
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=10) as response:
            data = json.loads(response.read(65536))
            provider_id = data.get("id")
            if response.status not in (200, 201) or not isinstance(provider_id, str) or len(provider_id) > 200:
                raise EmailDeliveryUnavailable()
            return provider_id
    except (HTTPError, URLError, TimeoutError, ValueError, OSError):
        # Never include the provider response, recipient, code or authorization header.
        raise EmailDeliveryUnavailable() from None


def cloudflare_payload(payload: dict, delivery_id: str) -> dict:
    sender_name, sender = parseaddr(payload.get("from", ""))
    body = {**payload, "from": {"address": sender, "name": sender_name},
            "headers": {**payload.get("headers", {}), "X-MeroSplit-Delivery-ID": delivery_id}}
    if "attachments" in body:
        body["attachments"] = [{"filename": item["filename"], "content": item["content"], "type": item["content_type"],
                                "disposition": "inline" if item.get("content_id") else "attachment",
                                **({"content_id": item["content_id"]} if item.get("content_id") else {})} for item in body["attachments"]]
    return body


@sensitive_variables()
def send_cloudflare(recipient: str, delivery_id: str, payload: dict) -> str:
    from .models import CloudflareEmailDispatch

    account, token = settings.CLOUDFLARE_EMAIL_ACCOUNT_ID, settings.CLOUDFLARE_EMAIL_API_TOKEN
    sender_name, sender = parseaddr(payload.get("from", ""))
    if (not re.fullmatch(r"[a-fA-F0-9]{32}", account) or not token or sender != "mail@merosplit.com"
            or payload.get("to") != [recipient] or payload.get("cc") or payload.get("bcc") or not delivery_id or len(delivery_id) > 200):
        raise EmailDeliveryUnavailable()
    body = cloudflare_payload(payload, delivery_id)
    encoded = json.dumps(body, sort_keys=True).encode()
    if len(encoded) > 5 * 1024 * 1024:
        raise EmailDeliveryUnavailable()
    fingerprint = salted_hmac("cloudflare-email-dispatch", encoded, algorithm="sha256").hexdigest()
    try:
        # This commit is the send-once fence. Never put HTTP inside its transaction.
        with transaction.atomic(durable=True):
            row, created = CloudflareEmailDispatch.objects.select_for_update().get_or_create(delivery_id=delivery_id,
                defaults={"account_id": account, "payload_hash": fingerprint})
            if row.account_id != account or row.payload_hash != fingerprint:
                raise EmailDeliveryHeld()
            if row.state == "accepted":
                return row.provider_id
            if not created and row.state != "retryable":
                raise EmailDeliveryHeld()
            if not created:
                row.state = "sending"
                row.http_status = None
                row.save(update_fields=["state", "http_status", "updated_at"])
    except (DatabaseError, RuntimeError):
        raise EmailDeliveryUnavailable() from None

    request = Request(f"https://api.cloudflare.com/client/v4/accounts/{account}/email/sending/send", data=encoded,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", "User-Agent": "MeroSplit (transactional email)"}, method="POST")
    state, provider_id, status = "held", "", None
    try:
        with urlopen(request, timeout=10) as response:
            status = response.status
            data = json.loads(response.read(65536))
            result = data.get("result") if isinstance(data, dict) else None
            if status == 200 and isinstance(data, dict) and data.get("success") is True and not data.get("errors") and isinstance(result, dict):
                identifier = result.get("message_id")
                delivered, queued = result.get("delivered", []), result.get("queued", [])
                accepted = delivered + queued if isinstance(delivered, list) and isinstance(queued, list) else []
                if (isinstance(identifier, str) and 0 < len(identifier) <= 200 and not re.search(r"[\s\x00-\x1f]", identifier)
                        and accepted and all(isinstance(value, str) for value in accepted) and set(accepted) == {recipient}
                        and result.get("permanent_bounces", []) == [] and result.get("suppressed_recipients", []) == []):
                    state, provider_id = "accepted", identifier
    except HTTPError as error:
        status = error.code
        try:
            rejected = json.loads(error.read(65536))
            codes = {400: {10001, 10200, 10201, 10202}, 401: {10101, 10103}, 403: {10102, 10105, 10203}, 404: {10000}, 429: {10004}}
            errors = rejected.get("errors") if isinstance(rejected, dict) else None
            if (status in codes and isinstance(rejected, dict) and rejected.get("success") is False and rejected.get("result") is None
                    and isinstance(errors, list) and errors and all(isinstance(item, dict) and isinstance(item.get("code"), int) and item.get("code") in codes[status]
                    and isinstance(item.get("message"), str) for item in errors)):
                state = "retryable"  # Explicit pre-accept rejection only; never a transport timeout.
        except (ValueError, OSError):
            pass
    except (URLError, TimeoutError, ValueError, OSError, TypeError):
        pass
    try:
        CloudflareEmailDispatch.objects.filter(pk=delivery_id, state="sending").update(
            state=state, provider_id=provider_id, http_status=status, updated_at=django_timezone.now())
    except DatabaseError:
        raise EmailDeliveryHeld() from None  # The committed sending fence still prevents a second POST.
    if state == "accepted":
        return provider_id
    raise EmailDeliveryUnavailable() if state == "retryable" else EmailDeliveryHeld()
