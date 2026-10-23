"""The only outbound email boundary. Tests replace this function, never real inboxes."""

import base64
import json
from datetime import timezone
from html import escape
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from django.conf import settings
from django.core.exceptions import ValidationError
from django.template import Context, engines
from django.views.decorators.debug import sensitive_variables


class EmailDeliveryUnavailable(Exception):
    pass


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
    key = getattr(settings, "RESEND_API_KEY", "")
    sender = getattr(settings, "DEFAULT_FROM_EMAIL", "")
    if not key or not sender:
        raise EmailDeliveryUnavailable()
    resolved = materialize_payload(payload if payload is not None else message_payload(recipient, subject, text, html), recipient=recipient)
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
