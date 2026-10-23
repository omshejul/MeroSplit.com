import html
import re

import pytest
from django.test import Client
from django.utils.html import strip_tags

from .test_api import client as client
from .test_api import expense, send, uid
from .test_api import group as group
from .test_collaboration import account, invite

pytestmark = pytest.mark.django_db


def visible(response):
    source = re.sub(r"<(script|style)\b[^>]*>.*?</\1>", "", response.content.decode(), flags=re.S)
    return html.unescape(strip_tags(source))


def test_invite_renders_names_rupees_unknown_dates_and_only_involved_records(client, group):
    group_id, ids, _ = group
    bill = expense(ids, payer=0, beneficiaries=[1], total="12345")
    bill["description"] = "Train <tickets>"
    bill["notes"] = "Seat <script>alert('unsafe')</script>"
    assert send(client, "post", f"/groups/{group_id}/expenses", bill).status_code == 200
    private = expense(ids, payer=0, beneficiaries=[2])
    private["description"] = "Unrelated private bill"
    assert send(client, "post", f"/groups/{group_id}/expenses", private).status_code == 200
    assert send(client, "post", f"/groups/{group_id}/settlements", {
        "command_id": uid(), "id": uid(), "sender": ids[1], "recipient": ids[0], "amount": "2345", "date": None,
    }).status_code == 200
    _, token = invite(client, group_id, ids[1])
    response = Client().get(f"/invite/{token}")
    assert response.status_code == 200
    text = visible(response)
    assert "Owes ₹100" in text and "Train <tickets>" in text
    assert "A paid ₹123.45" in text and "B paid A" in text and "₹23.45" in text
    assert "Date unknown" in text and "Join as B" in text and "Sign in to join" in text
    assert "Unrelated private bill" not in text
    assert not any(person in text for person in ids)
    assert "paise" not in text and "claim" not in text.lower()
    assert "<script>alert('unsafe')</script>" not in response.content.decode()
    assert response["Cache-Control"] == "no-store" and response["Referrer-Policy"] == "no-referrer"
    assert 'name="csrfmiddlewaretoken"' in response.content.decode()
    assert 'name="robots" content="noindex, nofollow"' in response.content.decode()


def test_invite_join_request_and_approval_render_states(client, group):
    group_id, ids, _ = group
    invitation, token = invite(client, group_id, ids[1])
    member = account()
    browser = Client()
    browser.force_login(member.actor)
    response = browser.get(f"/invite/{token}")
    assert 'id="claim"' in response.content.decode()
    assert "Request to join" in visible(response)
    assert send(member, "post", f"/invites/{token}/claim", {"command_id": uid()}).status_code == 200
    response = browser.get(f"/invite/{token}")
    assert 'id="claim"' not in response.content.decode()
    assert "Waiting for the organizer to approve" in visible(response)
    assert member.actor.email not in Client().get(f"/invite/{token}").content.decode()
    assert send(client, "post", f"/groups/{group_id}/invites/{invitation}/approve", {
        "command_id": uid(),
    }).status_code == 200
    response = browser.get(f"/invite/{token}")
    assert 'id="claim"' not in response.content.decode()
    assert "This person has joined" in visible(response)


def test_invite_opening_proposal_is_named_and_not_counted_before_agreement(client, group):
    group_id, ids, _ = group
    opening = {"command_id": uid(), "id": uid(), "balances": {
        ids[0]: "9999", ids[1]: "-9999", ids[2]: "0",
    }, "source": "Previous trip", "cutoff": "2026-01-01"}
    assert send(client, "post", f"/groups/{group_id}/opening-balances", opening).status_code == 200
    _, token = invite(client, group_id, ids[1])
    response = Client().get(f"/invite/{token}")
    text = visible(response)
    assert "Proposed opening balance" in text and "Owes ₹99.99" in text
    assert "Previous trip" in text and "2026-01-01" in text
    assert "Not included until everyone required agrees" in text
    assert "Settled up" in text


@pytest.mark.parametrize("path", ["/privacy", "/support", "/delete-account"])
def test_public_pages_match_account_sync_and_preserve_deletion_disclosures(path):
    response = Client().get(path)
    assert response.status_code == 200
    text = visible(response)
    for obsolete in ["without an account", "Phone-only groups", "Sync settings", "pause automatic", "shared account copy", "Your data"]:
        assert obsolete not in text
    if path == "/support":
        assert "Groups and People" in text and "sync automatically" in text and "Me → Data" in text
    else:
        assert "five minutes" in text
        assert "provider" in text
        assert "no configured scheduled database backups or point-in-time recovery" in text
        assert "previously" in text.lower()
