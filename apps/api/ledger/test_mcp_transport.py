import asyncio
import hashlib
import io
import json
import secrets
import time
import tracemalloc
import warnings
from contextlib import asynccontextmanager
from datetime import timedelta
from uuid import uuid4

import httpx2
import pytest
from asgiref.sync import sync_to_async
from config.asgi import MeroSplitApplication
from django.core.serializers.json import DjangoJSONEncoder
from django.db import IntegrityError
from django.test import Client as DjangoClient
from django.utils import timezone
from mcp import Client
from mcp.client.streamable_http import streamable_http_client
from mcp.shared.exceptions import MCPError

from .mcp_models import McpOAuthClient, McpOAuthGrant
from .mcp_oauth import MCP_SCOPE, OAuthError
from .mcp_server import GROUP_RESOURCE, MAX_BODY, database_call
from .models import Change, CommandReceipt, Expense, ExpenseNotice, NotificationPreference, UploadedFile
from .test_mcp_tools import ledger as ledger

pytestmark = pytest.mark.django_db(transaction=True)
ORIGIN = "https://merosplit.omshejul.com"
ENDPOINT = f"{ORIGIN}/mcp"


@pytest.fixture(autouse=True)
def canonical_settings(settings, monkeypatch):
    settings.MCP_SERVER_URL = ENDPOINT
    settings.MCP_ALLOWED_HOSTS = ["merosplit.omshejul.com"]
    settings.MCP_ALLOWED_ORIGINS = [ORIGIN]
    settings.PUBLIC_WEB_URL = ORIGIN
    settings.ALLOWED_HOSTS = ["merosplit.omshejul.com", "testserver"]
    settings.EMAIL_CLIENT_IP_SOURCE = "remote_addr"
    def forbidden(*args, **kwargs):
        pytest.fail("Transport tests cannot call a real provider")
    monkeypatch.setattr("ledger.email_delivery.send_email", forbidden)
    monkeypatch.setattr("ledger.push_provider.send_bill_notification", forbidden)


@pytest.fixture
def bearer(ledger):
    client = McpOAuthClient.objects.create(name="Synthetic MCP client", redirect_uris=["http://127.0.0.1/callback"])
    raw = "mero_at_" + secrets.token_urlsafe(32)
    grant = McpOAuthGrant.objects.create(user=ledger[0], client=client, scope=MCP_SCOPE, resource=ENDPOINT,
        access_token_digest=hashlib.sha256(raw.encode()).hexdigest(), refresh_token_digest=hashlib.sha256(secrets.token_bytes(32)).hexdigest(),
        access_expires_at=timezone.now() + timedelta(hours=1), refresh_expires_at=timezone.now() + timedelta(days=90))
    return raw, grant


@asynccontextmanager
async def running_app(app, token=None):
    incoming, outgoing = asyncio.Queue(), asyncio.Queue()
    task = asyncio.create_task(app({"type": "lifespan", "asgi": {"version": "3.0"}, "state": {}}, incoming.get, outgoing.put))
    await incoming.put({"type": "lifespan.startup"})
    assert (await asyncio.wait_for(outgoing.get(), 5))["type"] == "lifespan.startup.complete"
    try:
        headers = {"Accept": "application/json, text/event-stream"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app), base_url=ORIGIN, headers=headers) as http:
            yield http
    finally:
        await incoming.put({"type": "lifespan.shutdown"})
        assert (await asyncio.wait_for(outgoing.get(), 5))["type"] == "lifespan.shutdown.complete"
        await asyncio.wait_for(task, 5)


def sdk(http, mode="auto"):
    return Client(streamable_http_client(ENDPOINT, http_client=http), mode=mode, cache=None, read_timeout_seconds=5)


@pytest.mark.parametrize("mode", ["auto", "legacy", "2026-07-28"])
def test_official_sdk_negotiation_tools_schema_resource_and_no_session_affinity(ledger, bearer, mode):
    async def check():
        app = MeroSplitApplication()
        async with running_app(app, bearer[0]) as http:
            async with sdk(http, mode) as client:
                tools = (await client.list_tools()).tools
                assert len(tools) == 12
                assert all("actor" not in tool.input_schema["properties"] and "user_id" not in tool.input_schema["properties"] for tool in tools)
                by_name = {tool.name: tool for tool in tools}
                assert all(tool.annotations.idempotent_hint for tool in tools)
                assert by_name["get_group"].annotations.read_only_hint
                assert not by_name["record_external_payment"].annotations.read_only_hint
                assert by_name["reverse_expense"].annotations.destructive_hint
                assert by_name["reverse_external_payment"].annotations.destructive_hint
                assert by_name["save_expense"].annotations.destructive_hint
                assert [tool.name for tool in tools if tool.meta and "ui" in tool.meta] == ["render_group"]
                payment_schema = by_name["record_external_payment"].input_schema
                assert {"attempt_id", "expected_group_version"}.isdisjoint(payment_schema["properties"])
                assert "date" in payment_schema["required"]
                assert "email" not in json.dumps(by_name["create_group"].input_schema)
                context = await client.call_tool("get_account_context", {})
                assert not context.is_error and context.structured_content["account"]["id"] == ledger[0].pk
                assert bearer[0] not in json.dumps(context.model_dump(mode="json"))
                resource = await client.read_resource(GROUP_RESOURCE)
                assert resource.contents[0].mime_type == "text/html;profile=mcp-app"
                assert "<!doctype html>" in resource.contents[0].text.lower()
                rendered = await client.call_tool("render_group", {"group_id": str(ledger[3].id)})
                assert rendered.structured_content["group"]["name"] == ledger[3].name
                assert len(rendered.structured_content["transactions"]) == 2
                assert ledger[0].email not in json.dumps(rendered.model_dump(mode="json"))
            manager = app.mcp.app.routes[0].endpoint.app.session_manager
            assert manager.stateless and not manager._server_instances and not manager._session_owners
    asyncio.run(check())


def test_unauthenticated_bearer_challenge_and_strict_ingress(ledger, bearer):
    async def check():
        async with running_app(MeroSplitApplication()) as http:
            response = await http.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping"})
            assert response.status_code == 401
            assert f'resource_metadata="{ORIGIN}/.well-known/oauth-protected-resource/mcp"' in response.headers["WWW-Authenticate"]
            assert response.headers["Cache-Control"] == "no-store"
            assert "Access-Control-Allow-Origin" not in response.headers
            metadata = await http.get("/.well-known/oauth-protected-resource/mcp")
            assert metadata.status_code == 200 and metadata.json()["resource"] == ENDPOINT
            for method in ("get", "delete"):
                response = await getattr(http, method)("/mcp")
                assert response.status_code == 401 and "resource_metadata=" in response.headers["WWW-Authenticate"]
            for header, value, status in [("Host", "attacker.invalid", 421), ("Origin", "https://attacker.invalid", 403),
                                          ("Origin", "null", 403), ("Origin", "", 403)]:
                response = await http.post("/mcp", headers={header: value}, json={})
                assert response.status_code == status
            for token in ("invalid", "", "mero_at_wrong"):
                response = await http.get("/mcp", headers={"Authorization": f"Bearer {token}"})
                assert response.status_code == 401
        async with running_app(MeroSplitApplication(), bearer[0]) as http:
            for method in ("get", "delete"):
                response = await getattr(http, method)("/mcp")
                assert response.status_code == 405 and response.headers["Allow"] == "POST"
            response = await http.post("/mcp", content=b"x" * (MAX_BODY + 1), headers={"Content-Type": "application/json"})
            assert response.status_code == 413
            async def chunks():
                for _ in range(3):
                    yield b"x" * (MAX_BODY // 2)
            response = await http.post("/mcp", content=chunks(), headers={"Content-Type": "application/json"})
            assert response.status_code == 413  # No Content-Length: enforce received bytes too.
            response = await http.post("/mcp", content=b"{}", headers=[("Authorization", f"Bearer {bearer[0]}"), ("Authorization", "Bearer other")])
            assert response.status_code == 400
    asyncio.run(check())


def test_invalid_bearer_rate_limit_is_durable_across_app_instances(ledger):
    async def check():
        async with running_app(MeroSplitApplication()) as one, running_app(MeroSplitApplication()) as two:
            for index in range(60):
                response = await (one if index % 2 else two).get("/mcp")
                assert response.status_code == 401
            response = await two.get("/mcp")
            assert response.status_code == 429 and response.headers["Retry-After"] == "60"
    asyncio.run(check())


def test_valid_bearer_quota_returns_one_429_response(ledger, bearer, monkeypatch):
    from . import mcp_server
    def limited(*args, **kwargs):
        raise OAuthError("temporarily_unavailable", 429)
    monkeypatch.setattr(mcp_server, "authenticate_access_token", limited)
    async def check():
        async with running_app(MeroSplitApplication(), bearer[0]) as http:
            response = await http.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping"})
            assert response.status_code == 429
            assert response.headers["Retry-After"] == "60"
    asyncio.run(check())


def test_revoke_between_http_verifier_and_tool_boundary_prevents_command(ledger, bearer, monkeypatch):
    from . import mcp_server
    original = mcp_server.authenticate_access_token
    armed = False
    def authenticate(raw, **kwargs):
        result = original(raw, **kwargs)
        if armed and kwargs.get("enforce_limits", True) and result:
            McpOAuthGrant.objects.filter(pk=result[1].pk).update(revoked_at=timezone.now())
        return result
    monkeypatch.setattr(mcp_server, "authenticate_access_token", authenticate)
    async def check():
        nonlocal armed
        async with running_app(MeroSplitApplication(), bearer[0]) as http:
            async with sdk(http) as client:
                armed = True
                result = await client.call_tool("create_group", {"id": str(uuid4()), "command_id": str(uuid4()),
                    "name": "Never created", "self_participant_id": str(ledger[4].id),
                    "participants": [{"id": str(ledger[4].id), "name": "Self"}]})
                assert result.is_error and result.structured_content["error"]["status"] == 401
    asyncio.run(check())
    assert not CommandReceipt.objects.exists()


def test_separate_worker_instances_reconnect_permissions_revocation_and_command_replay(ledger, bearer):
    async def check():
        first, second = MeroSplitApplication(), MeroSplitApplication()
        async with running_app(first, bearer[0]) as one, running_app(second, bearer[0]) as two:
            async with sdk(one) as a:
                group_id, self_id = str(uuid4()), str(uuid4())
                arguments = {"id": group_id, "command_id": str(uuid4()), "name": "Cross-worker synthetic",
                             "self_participant_id": self_id, "participants": [{"id": self_id, "name": "Self"}]}
                result = await a.call_tool("create_group", arguments)
                assert not result.is_error and result.structured_content == {"id": group_id, "version": 1, "linked_participant_ids": []}
                bill_payload = {"id": str(uuid4()), "command_id": str(uuid4()), "description": "One SDK bill", "total": "101",
                                "paid": {str(ledger[4].id): "101"}, "split": {"mode": "equal", "values": {str(ledger[4].id): "1", str(ledger[5].id): "1"}},
                                "date": "2026-10-18"}
                bill_args = {"group_id": str(ledger[3].id), "payload": bill_payload}
                bill_result = await a.call_tool("save_expense", bill_args)
                assert not bill_result.is_error and bill_result.structured_content["version"] == 8
            async with sdk(two) as b:
                replay = await b.call_tool("create_group", arguments)
                assert replay.structured_content == result.structured_content
                replay = await b.call_tool("save_expense", bill_args)
                assert replay.structured_content == bill_result.structured_content
                invalid = await b.call_tool("save_expense", {"group_id": str(ledger[3].id),
                    "payload": {**bill_payload, "id": str(uuid4()), "command_id": str(uuid4()), "total": "99"}})
                assert invalid.is_error and invalid.structured_content["error"]["status"] == 422
                stale = await b.call_tool("get_bill", {"group_id": str(ledger[3].id), "bill_id": str(ledger[-2].id), "version": 0})
                assert stale.is_error and stale.structured_content["error"]["status"] == 409
                changed = await b.call_tool("create_group", {**arguments, "name": "Changed same command"})
                assert changed.is_error and changed.structured_content["error"]["code"] == "conflict"
                await sync_to_async(database_call, thread_sensitive=False)(
                    lambda: ledger[4].__class__.objects.filter(pk=ledger[4].pk).update(removed=True))
                forbidden = await b.call_tool("get_group", {"group_id": str(ledger[3].id)})
                assert forbidden.is_error and forbidden.structured_content["error"]["status"] == 404
            await sync_to_async(database_call, thread_sensitive=False)(
                lambda: McpOAuthGrant.objects.filter(pk=bearer[1].pk).update(revoked_at=timezone.now()))
            for http in (one, two):
                response = await http.post("/mcp", json={"jsonrpc": "2.0", "id": 4, "method": "ping"})
                assert response.status_code == 401
    asyncio.run(check())
    assert CommandReceipt.objects.count() == Change.objects.count() == 2
    assert Expense.objects.count() == 2 and ExpenseNotice.objects.count() == 1



def test_one_initialized_sdk_client_alternates_instances_without_reinitializing(ledger, bearer, record_property):
    # Independent app lifespans in ONE process, not an OS-worker/load-balancer test.
    class AlternatingTransport(httpx2.AsyncBaseTransport):
        def __init__(self, first, second):
            self.transports = [httpx2.ASGITransport(first), httpx2.ASGITransport(second)]
            self.next_instance, self.trace = 1, []

        async def handle_async_request(self, request):
            message = json.loads(await request.aread())
            method = message['method']
            if method in {'initialize', 'notifications/initialized'}:
                assert not any(row['method'] == 'tools/call' for row in self.trace)
                instance = 0
            else:
                instance, self.next_instance = self.next_instance, 1 - self.next_instance
            assert 'mcp-session-id' not in request.headers
            response = await self.transports[instance].handle_async_request(request)
            assert 'mcp-session-id' not in response.headers
            self.trace.append({'instance': 'AB'[instance], 'method': method, 'status': response.status_code})
            return response

        async def aclose(self):
            for transport in self.transports:
                await transport.aclose()

    async def check():
        first, second = MeroSplitApplication(), MeroSplitApplication()
        async with running_app(first), running_app(second):
            transport = AlternatingTransport(first, second)
            async with httpx2.AsyncClient(transport=transport, base_url=ORIGIN,
                    headers={'Authorization': f'Bearer {bearer[0]}'}) as http:
                async with sdk(http, mode='legacy') as client:  # ONE client; cache=None in sdk().
                    await client.list_tools()  # B has never received initialize.
                    group = await client.call_tool('get_group', {'group_id': str(ledger[3].id)})
                    assert not group.is_error and group.structured_content['id'] == str(ledger[3].id)
                    args = {'group_id': str(ledger[3].id), 'payload': {
                        'id': str(uuid4()), 'command_id': str(uuid4()), 'description': 'Alternating synthetic bill',
                        'total': '101', 'paid': {str(ledger[4].id): '101'},
                        'split': {'mode': 'equal', 'values': {str(ledger[4].id): '1', str(ledger[5].id): '1'}},
                        'date': '2026-10-18'}}
                    written = await client.call_tool('save_expense', args)
                    replayed = await client.call_tool('save_expense', args)
                    assert not written.is_error and not replayed.is_error
                    assert written.structured_content == replayed.structured_content
                    assert written.structured_content['version'] == 8
                    await sync_to_async(database_call, thread_sensitive=False)(
                        lambda: McpOAuthGrant.objects.filter(pk=bearer[1].pk).update(revoked_at=timezone.now()))
                    for _ in range(2):
                        with pytest.raises(MCPError):
                            await client.call_tool('get_account_context', {})
                        assert transport.trace[-1]['status'] == 401
            assert [row['instance'] for row in transport.trace if row['method'] == 'initialize'] == ['A']
            requests = [row for row in transport.trace if row['method'] not in {'initialize', 'notifications/initialized'}]
            assert [row['instance'] for row in requests] == ['BA'[i % 2] for i in range(len(requests))]
            assert [row['status'] for row in requests[-2:]] == [401, 401]
            record_property('same_client_non_affinity', json.dumps({'processes': 1, 'instances': 2,
                'sdk_clients': 1, 'cache': None, 'trace': transport.trace}))
    asyncio.run(check())
    assert CommandReceipt.objects.count() == Change.objects.count() == 1
    assert Expense.objects.count() == 2 and ExpenseNotice.objects.count() == 1

def test_sdk_reads_do_not_ack_or_mutate_preference_and_malformed_tools_cannot_change_actor(ledger, bearer):
    actor, _, _, group, _, _, _, bill, _ = ledger
    NotificationPreference.objects.create(user=actor, expense_updates=True, email_reminders=False)
    ExpenseNotice.objects.create(expense=bill, recipient=actor, expense_version=1,
                                 created_at=timezone.now(), push_due_at=timezone.now())
    def notices():
        return json.dumps({"notice": list(ExpenseNotice.objects.values()), "preferences": list(NotificationPreference.objects.values())},
                          cls=DjangoJSONEncoder, sort_keys=True)
    before = notices()
    async def check():
        async with running_app(MeroSplitApplication(), bearer[0]) as http:
            async with sdk(http) as client:
                for name in ("get_group", "render_group", "list_transactions"):
                    result = await client.call_tool(name, {"group_id": str(group.id)})
                    assert not result.is_error
                result = await client.call_tool("list_groups", {"limit": True})
                assert result.is_error
                result = await client.call_tool("get_account_context", {"actor": ledger[2].pk})
                assert result.is_error and result.structured_content["error"]["status"] == 422
                result = await client.call_tool("record_external_payment", {"group_id": str(group.id), "id": str(uuid4()),
                    "command_id": str(uuid4()), "sender": str(ledger[5].id), "recipient": str(ledger[4].id), "amount": "1",
                    "date": None, "expected_group_version": None})
                assert result.is_error and result.structured_content["error"]["status"] == 422
    asyncio.run(check())
    assert notices() == before


def test_database_cleanup_and_expected_error_mapping_without_leaking_unexpected_error(ledger, bearer, monkeypatch, caplog):
    from . import mcp_tools
    closed = []
    # Observe the actual worker-local connection, rather than its main-thread proxy.
    from django.db.backends.postgresql.base import DatabaseWrapper
    original_wrapper_close = DatabaseWrapper.close
    def tracked_close(self):
        closed.append(self)
        return original_wrapper_close(self)
    monkeypatch.setattr(DatabaseWrapper, "close", tracked_close)
    async def check():
        async with running_app(MeroSplitApplication(), bearer[0]) as http:
            async with sdk(http) as client:
                def conflict(actor):
                    raise IntegrityError("private SQL detail") from SimpleConstraint("actor_command_once")
                monkeypatch.setattr(mcp_tools, "get_account_context", conflict)
                result = await client.call_tool("get_account_context", {})
                assert result.is_error and result.structured_content["error"]["status"] == 409
                assert "private SQL detail" not in json.dumps(result.model_dump(mode="json"))
                def crash(actor):
                    raise RuntimeError("unexpected-private-detail")
                monkeypatch.setattr(mcp_tools, "get_account_context", crash)
                result = await client.call_tool("get_account_context", {})
                assert result.is_error and "unexpected-private-detail" not in json.dumps(result.model_dump(mode="json"))
    asyncio.run(check())
    assert closed and all(item.connection is None for item in closed)
    assert bearer[0] not in caplog.text


class SimpleConstraint(Exception):
    def __init__(self, name):
        self.diag = type("Diagnostic", (), {"constraint_name": name})()


def test_asgi_django_static_legal_associations_auth_csrf_and_bounded_media_concurrently(ledger, bearer, tmp_path, monkeypatch, record_property):
    from config import web
    root = tmp_path / "export"
    root.mkdir()
    (root / "index.html").write_text("<!doctype html><title>MeroSplit synthetic export</title>")
    wasm = b"\x00asm" + b"w" * (2 * 1024 * 1024)
    font = b"f" * (1024 * 1024)
    (root / "sqlite-0123456789abcdef.wasm").write_bytes(wasm)
    (root / "font-0123456789abcdef.ttf").write_bytes(font)
    monkeypatch.setenv("MEROSPLIT_WEB_ROOT", str(root))
    actor = ledger[0]
    browser = DjangoClient(enforce_csrf_checks=True)
    browser.force_login(actor)
    cookie = "; ".join(f"{key}={value.value}" for key, value in browser.cookies.items())
    upload = UploadedFile.objects.create(avatar_owner=actor, uploaded_by=actor, object_key="synthetic/avatar.jpg",
        source_hash="f" * 64, name="synthetic.jpg", content_type="image/jpeg", size=20 * 1024 * 1024, state="active")
    cap = 20 * 1024 * 1024
    streams = []
    class Upstream(io.BytesIO):
        def close(self):
            self.bytes_read = self.tell()
            super().close()
    def open_fake(url, timeout):
        stream = Upstream(b"m" * (cap + 100))
        streams.append(stream)
        return stream
    monkeypatch.setattr(web, "urlopen", open_fake)
    monkeypatch.setattr(web, "download_url", lambda user, file_id: {"url": "https://fake-storage.example.invalid/no-network"})
    async def check():
        async with running_app(MeroSplitApplication(), bearer[0]) as http:
            with warnings.catch_warnings(record=True) as caught:
                warnings.simplefilter("always")
                started = time.perf_counter()
                tracemalloc.start()
                try:
                    responses = await asyncio.gather(http.get("/app/sqlite-0123456789abcdef.wasm"),
                        http.get("/app/font-0123456789abcdef.ttf"), http.get(f"/app/media/{upload.id}", headers={"Cookie": cookie}),
                        http.post("/mcp", json={"jsonrpc": "2.0", "id": 5, "method": "ping"}))
                    _, peak = tracemalloc.get_traced_memory()
                finally:
                    tracemalloc.stop()
            binary, typeface, media, ping = responses
            assert all(response.status_code == 200 for response in responses)
            assert binary.content == wasm and binary.headers["Content-Type"] == "application/wasm"
            assert typeface.content == font and binary.headers["Cache-Control"].endswith("immutable")
            assert len(media.content) == cap and media.headers["Cache-Control"] == "private, no-store"
            assert media.headers["Cross-Origin-Resource-Policy"] == "same-origin"
            assert ping.json()["result"] == {}
            assert any("synchronous iterators" in str(item.message) for item in caught)
            assert len(streams) == 1 and streams[0].closed and streams[0].bytes_read == cap
            metrics = {"elapsed_seconds": round(time.perf_counter() - started, 4), "peak_traced_bytes": peak,
                       "response_bytes": [len(response.content) for response in responses],
                       "sha256": [hashlib.sha256(response.content).hexdigest() for response in responses[:3]],
                       "note": "One synthetic concurrent batch, includes fake upstream and client buffering; not a global RAM bound"}
            record_property("asgi_concurrent_buffering", json.dumps(metrics))
            for route in ("/app/", "/support", "/privacy", "/delete-account", "/.well-known/apple-app-site-association", "/.well-known/assetlinks.json"):
                response = await http.get(route)
                assert response.status_code == 200
            response = await http.post("/_allauth/browser/v1/auth/code/request", json={"email": "never-send@example.invalid"})
            assert response.status_code == 403  # Django CSRF still owns the browser route.
            response = await http.get("/api/v1/me", headers={"Cookie": cookie})
            assert response.status_code == 200 and response.json()["id"] == actor.pk
            response = await http.get(f"/app/media/{upload.id}")
            assert response.status_code == 401
    asyncio.run(check())


def test_mcp_railway_http_upstream_matches_django_networks_and_trust_boundary(settings, monkeypatch):
    from django.core.handlers.asgi import ASGIRequest

    from .mcp_server import McpRequestBoundary
    from .otp import client_network

    settings.EMAIL_CLIENT_IP_SOURCE = 'railway_public'
    settings.EMAIL_RAILWAY_PUBLIC_HOSTS = ['merosplit.omshejul.com']
    settings.SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')
    networks = []
    monkeypatch.setattr('ledger.mcp_server.authenticate_request', lambda raw, network: networks.append(network))

    async def downstream(scope, receive, send):
        await send({'type': 'http.response.start', 'status': 204, 'headers': []})
        await send({'type': 'http.response.body', 'body': b''})

    async def probe(real_ip, *, forwarded=True, host='merosplit.omshejul.com'):
        headers = [(b'host', host.encode()), (b'x-real-ip', real_ip.encode()),
                   (b'x-forwarded-for', b'192.0.2.88')]
        if forwarded:
            headers.append((b'x-forwarded-proto', b'https'))
        scope = {'type': 'http', 'asgi': {'version': '3.0'}, 'http_version': '1.1', 'method': 'POST',
                 'scheme': 'http', 'path': '/mcp', 'raw_path': b'/mcp', 'query_string': b'',
                 'root_path': '', 'headers': headers, 'client': ('10.44.0.9', 4000), 'server': ('10.44.0.8', 8080)}
        output = []
        async def receive():
            return {'type': 'http.request', 'body': b'', 'more_body': False}
        async def send(message):
            output.append(message)
        await McpRequestBoundary(downstream)(scope, receive, send)
        return output[0]['status'], client_network(ASGIRequest(scope, io.BytesIO())) if host != 'attacker.invalid' else None

    async def check():
        for value, expected in [('198.51.100.19', '198.51.100.0/24'), ('203.0.113.41', '203.0.113.0/24')]:
            status, django_network = await probe(value)
            assert status == 204 and networks[-1] == django_network == expected
        assert networks[0] != networks[1]
        before = len(networks)
        assert (await probe('198.51.100.19', host='attacker.invalid'))[0] == 421
        assert len(networks) == before
        status, django_network = await probe('198.51.100.19', forwarded=False)
        assert status == 204 and networks[-1] == django_network == '10.44.0.0/24'
        settings.EMAIL_CLIENT_IP_SOURCE = 'remote_addr'
        status, django_network = await probe('198.51.100.19')
        assert status == 204 and networks[-1] == django_network == '10.44.0.0/24'
        settings.EMAIL_CLIENT_IP_SOURCE = 'railway_public'
        settings.EMAIL_RAILWAY_PUBLIC_HOSTS = ['other.example.invalid']
        status, django_network = await probe('198.51.100.19')
        assert status == 204 and networks[-1] == django_network == '10.44.0.0/24'
        settings.EMAIL_RAILWAY_PUBLIC_HOSTS = ['merosplit.omshejul.com']
        settings.SECURE_PROXY_SSL_HEADER = None
        status, django_network = await probe('198.51.100.19')
        assert status == 204 and networks[-1] == django_network == '10.44.0.0/24'
    asyncio.run(check())


def test_authenticated_mcp_history_origin_is_durable_and_request_scoped(ledger, bearer):
    from .expense_history import expense_version_history, verified_mcp_history
    from .services import save_expense

    body = {"id": str(uuid4()), "command_id": str(uuid4()), "description": "MCP provenance bill", "total": "101",
            "paid": {str(ledger[4].id): "101"}, "split": {"mode": "equal", "values": {str(ledger[4].id): "1", str(ledger[5].id): "1"}},
            "date": "2026-10-21"}

    async def check():
        async with running_app(MeroSplitApplication(), bearer[0]) as http:
            async with sdk(http) as client:
                arguments = {"group_id": str(ledger[3].id), "payload": body}
                created = await client.call_tool("save_expense", arguments)
                assert not created.is_error
                replay = await client.call_tool("save_expense", arguments)
                assert replay.structured_content == created.structured_content
                edited = {**body, "command_id": str(uuid4()), "version": 1, "description": "Edited through MCP"}
                assert not (await client.call_tool("save_expense", {"group_id": str(ledger[3].id), "expense_id": body["id"], "payload": edited})).is_error
                stale = {**edited, "command_id": str(uuid4()), "description": "Rejected stale edit"}
                assert (await client.call_tool("save_expense", {"group_id": str(ledger[3].id), "expense_id": body["id"], "payload": stale})).is_error
                assert not (await client.call_tool("reverse_expense", {"group_id": str(ledger[3].id), "bill_id": body["id"], "payload": {"command_id": str(uuid4()), "version": 2}})).is_error
    asyncio.run(check())
    history = expense_version_history(ledger[0], ledger[3].id, body['id'])['items']
    assert len(history) == 3 and all(item['via_mcp'] for item in history)
    assert all(item['actor_name'] == 'Canonical owner' for item in history)
    assert not verified_mcp_history.get()
    # Calling the plain command with the same person is not authenticated MCP provenance.
    plain = {**body, 'id': str(uuid4()), 'command_id': str(uuid4())}
    save_expense(ledger[0], ledger[3].id, plain | {'category': 'other', 'notes': ''})
    assert not expense_version_history(ledger[0], ledger[3].id, plain['id'])['items'][0]['via_mcp']
    from django.db import transaction
    from ninja.errors import HttpError

    from .mcp_server import invoke_tool
    doomed = {**plain, 'id': str(uuid4()), 'command_id': str(uuid4())}
    count = Change.objects.count()
    def rolled_back(actor):
        with transaction.atomic():
            save_expense(actor, ledger[3].id, doomed | {'category': 'other', 'notes': ''})
            raise HttpError(409, 'Synthetic rollback')
    assert invoke_tool(bearer[0], rolled_back).is_error
    assert Change.objects.count() == count and not Expense.objects.filter(pk=doomed['id']).exists()
    assert not verified_mcp_history.get()
    data = json.dumps(history)
    assert bearer[0] not in data and 'client_id' not in data and 'access_token' not in data


def test_actual_oauth_mcp_same_generic_edit_without_auto_flag_is_manual(ledger, bearer):
    from . import expense_categories
    body = {"id": str(uuid4()), "command_id": str(uuid4()), "description": "Synthetic dinner", "date": "2026-10-21", "total": "100", "paid": {str(ledger[3].participants.first().id): "100"}, "split": {"mode": "equal", "values": {str(person.id): "1" for person in ledger[3].participants.all()}}, "category": "general", "category_auto": True}
    async def check():
        async with running_app(MeroSplitApplication(), bearer[0]) as http:
            async with sdk(http) as client:
                assert not (await client.call_tool("save_expense", {"group_id": str(ledger[3].id), "payload": body})).is_error
                def ready():
                    expense_categories.expense_icons(ledger[0], body["id"])
                    expense_categories.process_category_decisions(evaluate=lambda *args: "food")
                await sync_to_async(ready, thread_sensitive=False)()
                edited = body | {"command_id": str(uuid4()), "version": 1}
                edited.pop("category_auto")
                assert not (await client.call_tool("save_expense", {"group_id": str(ledger[3].id), "expense_id": body["id"], "payload": edited})).is_error
    asyncio.run(check())
    assert Expense.objects.get(pk=body["id"]).category_auto is False
    assert expense_categories.expense_icons(ledger[0], body["id"])["items"][0]["state"] == "manual"
