import logging
import re
import sys
from io import BytesIO

import pytest
from config.associations import APPLE_ASSOCIATION
from config.logging import RedactInvitePath
from django.test import Client
from PIL import Image, ImageChops, ImageDraw, ImageFont, features

from .group_invites import link_token
from .invite_card import ASSETS, font_choices, invitation_card, text_width, title_fonts, title_lines
from .models import Change, CommandReceipt, Group, GroupInviteLink, Invite, MembershipDelivery, Participant
from .test_api import client as client
from .test_api import group as group
from .test_group_invites import account, join, link

pytestmark = pytest.mark.django_db


def test_short_code_is_reusable_strong_and_legacy_still_works(client, group):
    gid, *_ = group
    code = link(client, gid)
    assert re.fullmatch(r"[A-Za-z0-9_-]{32}", code)
    saved = GroupInviteLink.objects.get(group_id=gid)
    assert code == saved.public_code and link(client, gid) == code
    old = link_token(saved)
    assert join(account(), old).status_code == 200
    assert join(account(), code).status_code == 200
    # Old database rows remain valid; codes are allocated only by an explicit Copy.
    GroupInviteLink.objects.filter(pk=saved.pk).update(public_code=None)
    count = CommandReceipt.objects.count(), Change.objects.count()
    assert Client().get('/j/' + code).status_code == 404
    assert (CommandReceipt.objects.count(), Change.objects.count()) == count
    assert join(account(), old).status_code == 200
    assert link(client, gid) != code


def test_crawler_preview_exposes_only_group_title_and_never_joins(client, group):
    gid, *_ = group
    name = 'Mumbai <script>alert("hi")</script> & पुणे 🧡'
    Group.objects.filter(pk=gid).update(name=name)
    code = link(client, gid)
    path = '/j/' + code
    before = [list(model.objects.values()) for model in [GroupInviteLink, Participant, Change, CommandReceipt, Invite, MembershipDelivery]]
    browser = Client()
    for agent in ['facebookexternalhit/1.1', 'Twitterbot/1.0', 'WhatsApp/2', 'Mozilla/5.0']:
        response = browser.get(path, HTTP_USER_AGENT=agent)
        assert response.status_code == 200
        html = response.content.decode()
        assert '<script>' not in html and '&lt;script&gt;' in html and 'पुणे 🧡' in html
        assert f'content="https://merosplit.com{path}/card.png"' in html
        assert 'summary_large_image' in html and '<meta property="og:image:width" content="1200">' in html
        assert 'Continue to join' in html and '/app/invite/join#token=' in html
        assert 'http-equiv' not in html and '<script' not in html
        assert client.actor.email not in html and 'balances' not in html and 'participants' not in html
        assert response['Cache-Control'] == 'private, no-store'
        assert response['Referrer-Policy'] == 'no-referrer'
        assert response['X-Robots-Tag'] == 'noindex, nofollow, noarchive'
        assert "default-src 'none'" in response['Content-Security-Policy']
    for suffix in ['', '/card.png']:
        head = browser.head(path + suffix)
        assert head.status_code == 200 and head.content == b''
    png = browser.get(path + '/card.png')
    assert png['Content-Type'] == 'image/png'
    assert Image.open(BytesIO(png.content)).size == (1200, 630)
    assert [list(model.objects.values()) for model in [GroupInviteLink, Participant, Change, CommandReceipt, Invite, MembershipDelivery]] == before


@pytest.mark.parametrize('invalid', ['archived', 'is_direct', 'owner_changed', 'owner_removed', 'owner_inactive', 'revoked', 'deleted'])
def test_page_and_image_use_same_current_capability_authorization(client, group, invalid):
    gid, *_ = group
    code = link(client, gid)
    row = Group.objects.get(pk=gid)
    if invalid in ['archived', 'is_direct']:
        Group.objects.filter(pk=gid).update(**{invalid: True})
    elif invalid == 'owner_changed':
        Group.objects.filter(pk=gid).update(owner=account().actor)
    elif invalid == 'owner_removed':
        Participant.objects.filter(group_id=gid, user=client.actor).update(removed=True)
    elif invalid == 'owner_inactive':
        client.actor.is_active = False
        client.actor.save(update_fields=['is_active'])
    elif invalid == 'revoked':
        GroupInviteLink.objects.filter(group_id=gid).delete()
    else:
        row.delete()
    for suffix in ['', '/card.png']:
        for method in ['get', 'head']:
            response = getattr(Client(), method)('/j/' + code + suffix)
            assert response.status_code == 404
            assert code not in response.content.decode()
            assert response['Cache-Control'] == 'private, no-store'
    assert join(account(), code).status_code == 404


def test_exact_routes_no_query_echo_no_redirects_and_post_never_joins(client, group):
    gid, *_ = group
    code = link(client, gid)
    count = Participant.objects.count()
    for path in ['/j/' + code + '?next=https://untrusted.invalid', '/j/' + code + '/card.png?other=1', '/j/' + 'z' * 32]:
        response = Client().get(path)
        assert response.status_code == 404 and 'Location' not in response
        assert code not in response.content.decode() and 'untrusted.invalid' not in response.content.decode()
    for path in ['/j/' + code, '/j/' + code + '/card.png']:
        assert Client().post(path).status_code == 405
    assert Participant.objects.count() == count
    assert {'/': '/j/*'} in APPLE_ASSOCIATION['applinks']['details'][0]['components']


@pytest.mark.parametrize('invalid', ['missing', 'revoked', 'archived', 'query'])
def test_unavailable_invitation_has_private_recovery_page(client, group, invalid):
    gid, *_ = group
    code = link(client, gid)
    name = Group.objects.get(pk=gid).name
    path = '/j/' + code
    if invalid == 'missing':
        path = '/j/' + 'z' * 32
    elif invalid == 'revoked':
        GroupInviteLink.objects.filter(group_id=gid).delete()
    elif invalid == 'archived':
        Group.objects.filter(pk=gid).update(archived=True)
    else:
        path += '?next=private-value'
    before = Participant.objects.count(), CommandReceipt.objects.count(), Change.objects.count()
    response = Client().get(path)
    html = response.content.decode()
    assert response.status_code == 404 and response['Content-Type'].startswith('text/html')
    assert '<h1>Invitation unavailable</h1>' in html
    assert 'Ask the person who invited you to share a new link.' in html
    assert '<a href="/app/">Go to MeroSplit</a>' in html
    assert code not in html and name not in html and client.actor.email not in html and 'private-value' not in html
    assert response['Cache-Control'] == 'private, no-store' and response['Referrer-Policy'] == 'no-referrer'
    nonce = re.search(r'<style nonce="([A-Za-z0-9_-]+)">', html).group(1)
    assert f"'nonce-{nonce}'" in response['Content-Security-Policy']
    assert "default-src 'none'" in response['Content-Security-Policy'] and '<script' not in html
    assert (Participant.objects.count(), CommandReceipt.objects.count(), Change.objects.count()) == before


def test_card_is_group_specific_bounded_for_long_titles():
    a = invitation_card('Weekend away')
    b = invitation_card('Mumbai and Pune with friends for a very long and wonderful holiday in the mountains and by the sea ' * 2)
    assert a != b
    for png in [a, b]:
        image = Image.open(BytesIO(png))
        assert image.size == (1200, 630) and image.format == 'PNG'


def test_request_and_error_logging_redacts_short_capability_and_query():
    code = 'aB0_' * 8
    for msg, args in [('%s', ('GET /j/' + code + '/card.png?x=private HTTP/1.1',)), ('Unavailable: /j/' + code, ()), ('https://merosplit.com/j/' + code, ())]:
        record = logging.LogRecord('django.request', logging.ERROR, '', 0, msg, args, None)
        assert RedactInvitePath().filter(record)
        assert code not in record.getMessage() and 'private' not in record.getMessage()
        assert '/j/[redacted]' in record.getMessage()
    try:
        raise ValueError("Synthetic failure at https://merosplit.com/j/" + code)
    except ValueError:
        record = logging.LogRecord('django.request', logging.ERROR, '', 0, 'Request failed', (), sys.exc_info())
        RedactInvitePath().filter(record)
        assert code not in logging.Formatter().format(record)
        assert 'ValueError' in logging.Formatter().format(record)
    from django.conf import settings
    assert 'invite_path' in settings.LOGGING['handlers']['console']['filters']
    for logger in ['django.request', 'django.security', 'django.server', 'uvicorn.access', 'uvicorn.error']:
        assert settings.LOGGING['loggers'][logger]['handlers'] == ['console']


@pytest.mark.parametrize("name", ["Weekend away", "पुणे 🧡 & Mumbai", "A very long group title for friends travelling together through Mumbai and Pune and the mountains by the sea"])
def test_rendered_card_draws_platform_and_actual_group_title_with_safe_wrapping(name, monkeypatch):
    calls = []
    original = ImageDraw.ImageDraw.text
    def record(draw, xy, text, *args, **kwargs):
        calls.append((xy, text))
        return original(draw, xy, text, *args, **kwargs)
    monkeypatch.setattr(ImageDraw.ImageDraw, "text", record)
    png = invitation_card(name)
    image = Image.open(BytesIO(png))
    assert image.size == (1200, 630) and image.info["Title"] == name and image.info["Software"] == "MeroSplit"
    assert any(text == "MeroSplit" for _, text in calls), "Platform name must be visibly drawn, not only metadata"
    drawn_name = "".join(text for xy, text in calls if xy[1] in {336, 376, 428})
    if len(name) < 40:
        assert drawn_name.replace(" ", "") == name.replace(" ", "")
    else:
        assert drawn_name.endswith("…") and name.replace(" ", "").startswith(drawn_name.removesuffix("…").replace(" ", ""))
    # Title ink stays inside a central square crop, including both measured lines.
    area = image.crop((0, 280, 1200, 460))
    bounds = ImageChops.difference(area, Image.new("RGB", area.size, "#FAF8F5")).getbbox()
    assert bounds and bounds[0] >= 285 and bounds[2] <= 915


def test_devanagari_is_shaped_with_licensed_glyphs_and_emoji_is_monochrome():
    assert features.check("raqm"), "Install libfribidi0 for the Pillow wheel's RAQM shaping"
    fonts = title_fonts(80)
    choices = font_choices("पुणे 🧡 & Mumbai", fonts)
    assert choices["प"] == 1 and choices["🧡"] == 2 and choices["M"] == 0
    assert all(value.layout_engine == ImageFont.Layout.RAQM for value in fonts)
    basic = ImageFont.truetype(str(ASSETS / "NotoSansDevanagari.ttf"), 80, layout_engine=ImageFont.Layout.BASIC)
    basic.set_variation_by_axes([600, 100])
    assert bytes(fonts[1].getmask("क्षि")) != bytes(basic.getmask("क्षि")), "Actual shaping must run"
    for name in ["पुणे " * 24, "पुणे" * 30]:
        choices = font_choices(name, fonts)
        lines = title_lines(name, fonts, choices, 600)
        assert len(lines) <= 2 and all(text_width(line, fonts, choices) <= 600 for line in lines)


def test_uncovered_script_or_missing_shaper_keeps_real_html_identity_without_fake_image(client, group, monkeypatch):
    gid, *_ = group
    code = link(client, gid)
    Group.objects.filter(pk=gid).update(name="北京旅行")
    page = Client().get('/j/' + code)
    assert "北京旅行" in page.content.decode()
    response = Client().get('/j/' + code + '/card.png')
    assert response.status_code == 503 and "You're invited" not in response.content.decode()
    Group.objects.filter(pk=gid).update(name="पुणे & Mumbai")
    monkeypatch.setattr(features, "check", lambda _: False)
    assert Client().get('/j/' + code + '/card.png').status_code == 503
    assert "पुणे &amp; Mumbai" in Client().get('/j/' + code).content.decode()


def test_invite_fonts_ship_exact_upstream_files_and_redistribution_licenses():
    import hashlib
    import json
    manifest = json.loads((ASSETS / "invite-fonts.json").read_text())
    assert len(manifest["files"]) == 4
    for row in manifest["files"]:
        assert hashlib.sha256((ASSETS / row["file"]).read_bytes()).hexdigest() == row["sha256"]
        assert "raw.githubusercontent.com/google/fonts/" + manifest["upstream_commit"] in row["url"]
    for name in ["OFL-NotoSansDevanagari.txt", "OFL-NotoEmoji.txt"]:
        assert "SIL OPEN FONT LICENSE" in (ASSETS / name).read_text()
