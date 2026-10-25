import logging
import re
import sys
from io import BytesIO

import pytest
from config.associations import APPLE_ASSOCIATION
from config.logging import RedactInvitePath
from django.test import Client
from PIL import Image

from .group_invite_views import invitation_card
from .group_invites import link_token
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
        assert 'Open MeroSplit' in html and '/app/invite/join#token=' in html
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


def test_unicode_metadata_stays_exact_while_unsupported_image_glyphs_get_a_clean_fallback():
    # The shipped Latin font has no Devanagari/emoji glyphs. Never render tofu.
    assert invitation_card('पुणे 🧡 & Mumbai') == invitation_card("You're invited")
    assert invitation_card('Mumbai') != invitation_card("You're invited")
