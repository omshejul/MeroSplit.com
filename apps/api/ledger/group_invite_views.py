"""Read-only social previews for the same group capability used by the app."""
import secrets
from urllib.parse import quote

from django.http import HttpResponse
from django.shortcuts import render
from django.views.decorators.http import require_safe
from ninja.errors import HttpError

from .group_invites import link_token, resolve_link
from .invite_card import invitation_card

ORIGIN = "https://merosplit.com"


def _headers(response):
    response["Cache-Control"] = "private, no-store"
    response["X-Robots-Tag"] = "noindex, nofollow, noarchive"
    response["Referrer-Policy"] = "no-referrer"
    response["X-Content-Type-Options"] = "nosniff"
    response["Content-Security-Policy"] = "default-src 'none'; img-src 'self'; style-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    return response


@require_safe
def group_invite_preview(request, code, card=False):
    request.get_host()  # Enforce ALLOWED_HOSTS even when a proxy bypasses redirects.
    try:
        if request.GET:
            raise HttpError(404, "This invite link is unavailable")
        link, group = resolve_link(code)
    except HttpError:
        return _headers(HttpResponse("This invite link is unavailable.", status=404, content_type="text/plain; charset=utf-8"))
    if card:
        try:
            content = invitation_card(group.name)
        except (RuntimeError, ValueError):
            # Full group identity remains in HTML/OG metadata. Never publish a fake title.
            return _headers(HttpResponse("Preview image is unavailable.", status=503, content_type="text/plain; charset=utf-8"))
        return _headers(HttpResponse(content if request.method == "GET" else b"", content_type="image/png"))
    nonce = secrets.token_urlsafe(16)
    response = render(request, "ledger/group_invite.html", {
        "group_name": group.name, "canonical": f"{ORIGIN}/j/{code}",
        "image": f"{ORIGIN}/j/{code}/card.png", "nonce": nonce,
        "app_url": f"{ORIGIN}/app/invite/join#token={quote(link_token(link), safe='')}",
    })
    _headers(response)
    response["Content-Security-Policy"] = response["Content-Security-Policy"].replace("style-src 'self'", f"style-src 'self' 'nonce-{nonce}'")
    return response
