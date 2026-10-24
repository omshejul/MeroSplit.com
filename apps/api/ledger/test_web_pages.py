import html
import re

import pytest
from django.test import Client
from django.utils.html import strip_tags

from .test_api import client as client
from .test_api import expense, send
from .test_api import group as group
from .test_collaboration import invite

pytestmark = pytest.mark.django_db


def visible(response):
    source = re.sub(r"<(script|style)\b[^>]*>.*?</\1>", "", response.content.decode(), flags=re.S)
    return html.unescape(strip_tags(source))


def test_invite_redirects_to_same_app_without_exposing_records(client, group):
    group_id, ids, _ = group
    bill = expense(ids, payer=0, beneficiaries=[1], total="12345")
    bill["description"] = "Private train tickets"
    assert send(client, "post", f"/groups/{group_id}/expenses", bill).status_code == 200
    _, token = invite(client, group_id, ids[1])
    response = Client().get(f"/invite/{token}")
    assert response.status_code == 302
    assert response["Location"].startswith("/app/invite/")
    assert "Private train tickets" not in response.content.decode()
    assert response["Cache-Control"] == "no-store"
    assert response["Referrer-Policy"] == "no-referrer"


@pytest.mark.parametrize("path", ["/privacy", "/support", "/delete-account"])
def test_public_pages_match_account_sync_and_preserve_deletion_disclosures(path):
    response = Client().get(path)
    assert response.status_code == 200
    text = visible(response)
    assert b'href="mailto:mail@merosplit.com' in response.content
    assert b"mail@merosplit.com" not in response.content and b"mail@merosplit.com" not in response.content
    for obsolete in ["without an account", "Phone-only groups", "Sync settings", "pause automatic", "shared account copy", "Your data", "Me → Data", "Me → Account", "uses email and password"]:
        assert obsolete not in text
    if path == "/support":
        assert "Groups and People" in text and "sync automatically" in text
        assert "four-digit code sent to your email" in text and "Me has import, Export data and account controls" in text
    else:
        assert "five minutes" in text
        assert "provider" in text
        assert "no configured scheduled database backups or point-in-time recovery" in text
        assert "previously" in text.lower()
