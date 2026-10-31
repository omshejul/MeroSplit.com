"""Browser OAuth through real routes, then ledger operations through the official SDK."""

import asyncio
import base64
import hashlib
import json
import re
from urllib.parse import parse_qs, urlencode, urlsplit
from uuid import uuid4

import pytest
from config.asgi import MeroSplitApplication
from django.test import Client as Browser
from mcp import Client
from mcp.client.streamable_http import streamable_http_client

from .models import Change, CommandReceipt, Expense, Settlement
from .test_mcp_transport import running_app
from .test_web_app import exported_app as exported_app

pytestmark = pytest.mark.django_db(transaction=True)
ORIGIN = "https://merosplit.com"
RESOURCE = f"{ORIGIN}/mcp"
CALLBACK = "https://review-agent.example.invalid/callback"


@pytest.fixture
def connections(settings, monkeypatch, exported_app):
    settings.MCP_SERVER_URL = RESOURCE
    settings.MCP_ALLOWED_HOSTS = ["merosplit.com"]
    settings.MCP_ALLOWED_ORIGINS = [ORIGIN]
    settings.PUBLIC_WEB_URL = ORIGIN
    settings.ALLOWED_HOSTS = ["merosplit.com", "testserver"]
    settings.EMAIL_CLIENT_IP_SOURCE = "remote_addr"
    settings.STORE_REVIEW_AUTH = []
    delivered = {}

    def fake_email(recipient, subject, text, delivery_id, **kwargs):
        delivered[recipient] = text
        return "synthetic-provider-accepted"

    def forbidden_provider(*args, **kwargs):
        pytest.fail("The MCP journey must not call external providers")

    monkeypatch.setattr("ledger.email_delivery.send_email", fake_email)
    monkeypatch.setattr("ledger.push_provider.send_bill_notification", forbidden_provider)

    def connect(email, name):
        browser = Browser(enforce_csrf_checks=True, HTTP_HOST="merosplit.com", HTTP_ORIGIN=ORIGIN)
        discovery = browser.get("/.well-known/oauth-protected-resource/mcp", secure=True)
        assert discovery.status_code == 200 and discovery.json()["resource"] == RESOURCE
        metadata = browser.get("/.well-known/oauth-authorization-server", secure=True).json()
        assert metadata["issuer"] == ORIGIN
        registered = browser.post(urlsplit(metadata["registration_endpoint"]).path,
            data=json.dumps({"client_name": "MeroSplit journey", "application_type": "web", "redirect_uris": [CALLBACK]}),
            content_type="application/json", secure=True)
        assert registered.status_code == 201
        client_id, verifier = registered.json()["client_id"], "journey-verifier-" + uuid4().hex * 2
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
        started = browser.get(urlsplit(metadata["authorization_endpoint"]).path, {
            "client_id": client_id, "redirect_uri": CALLBACK, "response_type": "code", "scope": "merosplit:mcp",
            "resource": RESOURCE, "code_challenge": challenge, "code_challenge_method": "S256", "state": "journey-state",
        }, secure=True)
        assert started.status_code == 302 and started["Location"] == "/app/"
        assert browser.get(started["Location"], secure=True).status_code == 200

        def json_post(path, data):
            return browser.post(path, data=json.dumps(data), content_type="application/json", secure=True,
                                HTTP_X_CSRFTOKEN=browser.cookies["csrftoken"].value)

        requested = json_post("/_allauth/browser/v1/auth/code/request", {"email": email})
        assert requested.status_code == 200
        code = re.search(r"(?m)^([0-9]{4})$", delivered[email]).group(1)
        confirmed = json_post("/_allauth/browser/v1/auth/code/confirm", {
            "challenge_id": requested.json()["data"]["challenge_id"], "code": code,
        })
        assert confirmed.status_code == 200
        account = browser.get("/api/v1/me", secure=True).json()
        profile = browser.put("/api/v1/me/profile", data=json.dumps({"display_name": name}),
            content_type="application/json", secure=True, HTTP_X_CSRFTOKEN=browser.cookies["csrftoken"].value)
        assert profile.status_code == 200
        pending = browser.get("/api/v1/me/mcp/pending", secure=True).json()["authorization_url"]
        consent = browser.get(pending, secure=True)
        assert consent.status_code == 200 and email.encode() in consent.content
        assert browser.get("/api/v1/me/mcp", secure=True).json()["connections"] == []
        request_id = parse_qs(urlsplit(pending).query)["request"][0]
        # Submit the rendered form token rather than bypassing browser CSRF.
        csrf = re.search(rb'name="csrfmiddlewaretoken" value="([^"]+)"', consent.content).group(1).decode()
        allowed = browser.post("/oauth/authorize", data=urlencode({"request": request_id, "expected_user_id": str(account["id"]),
            "decision": "allow", "csrfmiddlewaretoken": csrf}), content_type="application/x-www-form-urlencoded", secure=True)
        assert allowed.status_code == 302
        callback = urlsplit(allowed["Location"])
        assert callback.scheme + "://" + callback.netloc + callback.path == CALLBACK
        params = parse_qs(callback.query)
        assert params["state"] == ["journey-state"] and params["iss"] == [ORIGIN]
        token_data = {"grant_type": "authorization_code", "client_id": client_id, "redirect_uri": CALLBACK,
                      "code": params["code"][0], "code_verifier": verifier, "resource": RESOURCE}
        tokens = browser.post("/oauth/token", data=urlencode(token_data),
            content_type="application/x-www-form-urlencoded", secure=True)
        assert tokens.status_code == 200
        replay = browser.post("/oauth/token", data=urlencode(token_data),
            content_type="application/x-www-form-urlencoded", secure=True)
        assert replay.status_code == 400 and replay.json()["error"] == "invalid_grant"
        return browser, account, client_id, tokens.json()

    return connect


def test_browser_oauth_sdk_ledger_and_disconnect_journey(connections):
    browser, account, client_id, tokens = connections("plugin-owner@example.invalid", "Plugin owner")
    outsider, _, _, outsider_tokens = connections("plugin-outsider@example.invalid", "Plugin outsider")
    group_id, owner, peer, third, bill_id, payment_id = [str(uuid4()) for _ in range(6)]

    async def ledger_journey():
        async with running_app(MeroSplitApplication(), tokens["access_token"]) as http:
            async with Client(streamable_http_client(RESOURCE, http_client=http), cache=None) as client:
                async def call(name, arguments):
                    result = await client.call_tool(name, arguments)
                    assert not result.is_error, result.structured_content
                    return result.structured_content

                assert (await call("get_account_context", {}))["account"]["id"] == account["id"]
                assert (await call("list_groups", {}))["groups"] == []
                group = {"id": group_id, "command_id": str(uuid4()), "name": "Plugin journey",
                    "self_participant_id": owner, "participants": [{"id": owner, "name": "Plugin owner"},
                        {"id": peer, "name": "Priya"}, {"id": third, "name": "Rahul"}]}
                created = await call("create_group", group)
                assert await call("create_group", group) == created
                payload = {"id": bill_id, "command_id": str(uuid4()), "description": "Dinner", "total": "90000",
                    "paid": {owner: "90000"}, "split": {"mode": "equal", "values": {owner: "1", peer: "1", third: "1"}},
                    "date": "2026-10-31", "notes": "Synthetic plugin journey"}
                saved = await call("save_expense", {"group_id": group_id, "payload": payload, "icon": "general"})
                assert await call("save_expense", {"group_id": group_id, "payload": payload, "icon": "general"}) == saved
                assert (await call("get_group", {"group_id": group_id}))["balances"] == {owner: "60000", peer: "-30000", third: "-30000"}
                edit = {**payload, "command_id": str(uuid4()), "version": 1, "total": "120000", "paid": {owner: "120000"}}
                await call("save_expense", {"group_id": group_id, "expense_id": bill_id, "payload": edit})
                stale = await client.call_tool("save_expense", {"group_id": group_id, "expense_id": bill_id,
                    "payload": {**edit, "command_id": str(uuid4())}})
                assert stale.is_error and stale.structured_content["error"]["status"] == 409
                bill = await call("get_bill", {"group_id": group_id, "bill_id": bill_id})
                assert bill["version"] == 2 and bill["total"] == "120000" and bill["notes"] == payload["notes"]
                payment = {"group_id": group_id, "id": payment_id, "command_id": str(uuid4()),
                    "sender": peer, "recipient": owner, "amount": "30000", "date": "2026-10-31"}
                recorded = await call("record_external_payment", payment)
                assert await call("record_external_payment", payment) == recorded
                assert (await call("get_group", {"group_id": group_id}))["balances"] == {owner: "50000", peer: "-10000", third: "-40000"}
                reversal = {"group_id": group_id, "payment_id": payment_id, "payload": {"command_id": str(uuid4())}}
                reversed_payment = await call("reverse_external_payment", reversal)
                assert await call("reverse_external_payment", reversal) == reversed_payment
                assert (await call("get_payment", {"group_id": group_id, "payment_id": payment_id}))["reversed"] is True
                reversal = {"group_id": group_id, "bill_id": bill_id, "payload": {"command_id": str(uuid4()), "version": 2}}
                reversed_bill = await call("reverse_expense", reversal)
                assert await call("reverse_expense", reversal) == reversed_bill
                retained = await call("get_bill", {"group_id": group_id, "bill_id": bill_id})
                assert retained["deleted"] is True and retained["reversal"]["reversal_of"] == bill_id
                rendered = await call("render_group", {"group_id": group_id})
                assert rendered["group"]["balances"] == {owner: "0", peer: "0", third: "0"}
                assert len((await call("list_transactions", {"group_id": group_id}))["items"]) == 2
        async with running_app(MeroSplitApplication(), outsider_tokens["access_token"]) as http:
            async with Client(streamable_http_client(RESOURCE, http_client=http), cache=None) as client:
                assert (await client.call_tool("list_groups", {})).structured_content["groups"] == []
                denied = await client.call_tool("get_group", {"group_id": group_id})
                assert denied.is_error and denied.structured_content["error"]["status"] == 404
                denied = await client.call_tool("record_external_payment", {"group_id": group_id, "id": str(uuid4()),
                    "command_id": str(uuid4()), "sender": peer, "recipient": owner, "amount": "100", "date": None})
                assert denied.is_error and denied.structured_content["error"]["status"] == 404

    asyncio.run(ledger_journey())
    # The ordinary app sees the same retained records, not an MCP-only ledger.
    response = browser.get(f"/api/v1/groups/{group_id}", secure=True)
    assert response.status_code == 200
    state = response.json()
    assert state["balances"] == {owner: "0", peer: "0", third: "0"}
    assert len(state["expenses"]) == len(state["settlements"]) == 1
    assert state["expenses"][0]["deleted"] is True and state["expenses"][0]["version"] == 3
    assert state["settlements"][0]["reversed"] is True
    assert outsider.get(f"/api/v1/groups/{group_id}", secure=True).status_code == 404
    assert Expense.objects.count() == Settlement.objects.count() == 1
    assert CommandReceipt.objects.count() == 6  # Group, bill, edit, payment, two reversals.
    changes = Change.objects.filter(group_id=group_id, kind__in=["expense_saved", "expense_reversed"])
    assert changes.count() == 3 and all(row.data["_history"]["origin"] == "mcp" for row in changes)

    refreshed = browser.post("/oauth/token", data=urlencode({"grant_type": "refresh_token", "client_id": client_id,
        "refresh_token": tokens["refresh_token"], "resource": RESOURCE}), content_type="application/x-www-form-urlencoded", secure=True)
    assert refreshed.status_code == 200
    rotated = refreshed.json()

    async def verify_rotated_tokens():
        async with running_app(MeroSplitApplication(), tokens["access_token"]) as old:
            assert (await old.post(RESOURCE, json={"jsonrpc": "2.0", "id": 1, "method": "ping"})).status_code == 401
        async with running_app(MeroSplitApplication(), rotated["access_token"]) as http:
            async with Client(streamable_http_client(RESOURCE, http_client=http), cache=None) as client:
                result = await client.call_tool("get_account_context", {})
                assert not result.is_error and result.structured_content["account"]["id"] == account["id"]

    asyncio.run(verify_rotated_tokens())
    connection = browser.get("/api/v1/me/mcp", secure=True).json()["connections"][0]
    revoked = browser.delete(f"/api/v1/me/mcp/{connection['id']}", secure=True,
        HTTP_X_CSRFTOKEN=browser.cookies["csrftoken"].value, HTTP_X_MEROSPLIT_ACCOUNT=str(account["id"]))
    assert revoked.status_code == 200

    async def verify_disconnect():
        for token in [tokens["access_token"], rotated["access_token"]]:
            async with running_app(MeroSplitApplication(), token) as http:
                assert (await http.post(RESOURCE, json={"jsonrpc": "2.0", "id": 1, "method": "ping"})).status_code == 401

    asyncio.run(verify_disconnect())
    for token in [tokens["refresh_token"], rotated["refresh_token"]]:
        rejected = browser.post("/oauth/token", data=urlencode({"grant_type": "refresh_token", "client_id": client_id,
            "refresh_token": token, "resource": RESOURCE}), content_type="application/x-www-form-urlencoded", secure=True)
        assert rejected.status_code == 400 and rejected.json()["error"] == "invalid_grant"
    assert browser.get("/api/v1/me/mcp", secure=True).json()["connections"] == []
