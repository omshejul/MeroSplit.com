"""Read-only social previews for the same group capability used by the app."""
import secrets
import unicodedata
from io import BytesIO
from pathlib import Path
from urllib.parse import quote

from django.http import HttpResponse
from django.shortcuts import render
from django.views.decorators.http import require_safe
from ninja.errors import HttpError
from PIL import Image, ImageDraw, ImageFont, features

from .group_invites import link_token, resolve_link

ASSETS = Path(__file__).parent / "assets"
ORIGIN = "https://merosplit.com"


def _headers(response):
    response["Cache-Control"] = "private, no-store"
    response["X-Robots-Tag"] = "noindex, nofollow, noarchive"
    response["Referrer-Policy"] = "no-referrer"
    response["X-Content-Type-Options"] = "nosniff"
    response["Content-Security-Policy"] = "default-src 'none'; img-src 'self'; style-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    return response


def _font(size, weight=400):
    font = ImageFont.truetype(str(ASSETS / "StackSansText.ttf"), size)
    font.set_variation_by_axes([weight])
    return font


def _title_lines(name, font):
    # Measure whole strings. Preserve Unicode in metadata; only the image is cropped.
    words = name.split()
    lines, current = [], ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if font.getlength(candidate) <= 720:
            current = candidate
        elif current:
            lines.append(current)
            current = word
        else:
            lines.append(word)
    if current:
        lines.append(current)
    lines = lines or [name]
    if len(lines) > 2:
        lines = [lines[0], " ".join(lines[1:])]
    for i, line in enumerate(lines):
        if font.getlength(line) > 720:
            while line and font.getlength(line + "…") > 720:
                line = line[:-1]
            lines[i] = line.rstrip() + "…"
    return lines


def _image_title(name, font):
    # Never turn missing glyphs into boxes or fake a transliterated group name.
    missing = font.getmask("\u0378")  # Unassigned code point: the font's .notdef glyph.
    signature = missing.size, bytes(missing)
    for character in name:
        glyph = font.getmask(character)
        if (glyph.size, bytes(glyph)) == signature or (
            not features.check("raqm") and unicodedata.bidirectional(character) in {"R", "AL", "AN"}
        ):
            return "You're invited"
    return name


def invitation_card(name):
    image = Image.new("RGB", (1200, 630), "#FAF8F5")
    draw = ImageDraw.Draw(image)
    with Image.open(ASSETS / "merosplit-icon.png") as logo:
        logo = logo.convert("RGBA").resize((96, 96), Image.Resampling.LANCZOS)
        image.paste(logo, (552, 100), logo)
    font = _font(72, 600)
    name = _image_title(name, font)
    if font.getlength(name) > 1400:
        font = _font(60, 600)
    lines = _title_lines(name, font)
    top = 260 if len(lines) == 1 else 224
    for i, line in enumerate(lines):
        draw.text((600, top + i * 84), line, font=font, fill="#202020", anchor="mt")
    draw.text((600, 430), "Join this group on MeroSplit", font=_font(36), fill="#404040", anchor="mt")
    draw.text((600, 548), "Split bills with friends", font=_font(28), fill="#555555", anchor="mt")
    result = BytesIO()
    image.save(result, format="PNG")
    return result.getvalue()


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
        return _headers(HttpResponse(invitation_card(group.name) if request.method == "GET" else b"", content_type="image/png"))
    nonce = secrets.token_urlsafe(16)
    response = render(request, "ledger/group_invite.html", {
        "group_name": group.name, "canonical": f"{ORIGIN}/j/{code}",
        "image": f"{ORIGIN}/j/{code}/card.png", "nonce": nonce,
        "app_url": f"{ORIGIN}/app/invite/join#token={quote(link_token(link), safe='')}",
    })
    _headers(response)
    response["Content-Security-Policy"] = response["Content-Security-Policy"].replace("style-src 'self'", f"style-src 'self' 'nonce-{nonce}'")
    return response
