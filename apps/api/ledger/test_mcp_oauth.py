import base64
import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier
from urllib.parse import parse_qs, urlencode, urlsplit
from uuid import uuid4

import pytest
from django.contrib.auth import get_user_model
from django.contrib.sessions.models import Session
from django.db import close_old_connections, connections
from django.test import Client
from django.utils import timezone

from . import email_delivery, email_links
from . import mcp_oauth as oauth
from .mcp_models import McpOAuthClient, McpOAuthGrant, McpOAuthPendingAuthorization, McpOAuthRefreshDigest
from .models import EmailRateBucket
from .test_web_app import exported_app as exported_app

pytestmark = pytest.mark.django_db
NETWORK = "192.0.2.0/24"
RESOURCE = "https://merosplit.omshejul.com/mcp"
REDIRECT = "https://agent.example.invalid/callback?existing=1"
VERIFIER = "synthetic-only-verifier-" + "x" * 43
CHALLENGE = base64.urlsafe_b64encode(hashlib.sha256(VERIFIER.encode()).digest()).decode().rstrip("=")


@pytest.fixture(autouse=True)
def canonical(settings):
    settings.MCP_SERVER_URL = RESOURCE


def user(name="Synthetic account"):
    return get_user_model().objects.create_user(username=uuid4().hex, email=f"{uuid4().hex}@example.invalid", first_name=name)


def registered(**updates):
    return oauth.register_client({"client_name": "Synthetic client", "redirect_uris": [REDIRECT], **updates}, NETWORK)


def pending(client_id=None, **updates):
    return oauth.begin_authorization({"client_id": client_id or registered()["client_id"], "redirect_uri": REDIRECT,
        "response_type": "code", "code_challenge": CHALLENGE, "code_challenge_method": "S256", "state": "state-123",
        "scope": oauth.MCP_SCOPE, "resource": RESOURCE, **updates}, NETWORK)


def approved(actor=None):
    actor = actor or user()
    row = pending()
    url = oauth.decide_authorization(actor, row.id, approved=True, expected_user_id=actor.pk, network=NETWORK)
    code = parse_qs(urlsplit(url).query)["code"][0]
    return actor, row, code


def code_data(row, code, **updates):
    return {"grant_type": "authorization_code", "client_id": str(row.client_id), "redirect_uri": REDIRECT,
            "code": code, "code_verifier": VERIFIER, "resource": RESOURCE, **updates}


def granted(actor=None):
    actor, row, code = approved(actor)
    return actor, row, oauth.exchange_code(code_data(row, code), NETWORK)


def refreshed(row, tokens, **updates):
    return oauth.exchange_refresh({"grant_type": "refresh_token", "client_id": str(row.client_id),
        "resource": RESOURCE, "refresh_token": tokens["refresh_token"], **updates}, NETWORK)


def post(client, path, data, *, json_body=False, **extra):
    return client.post(path, data=json.dumps(data) if json_body else urlencode(data),
        content_type="application/json" if json_body else "application/x-www-form-urlencoded", REMOTE_ADDR="192.0.2.12", **extra)


def browser(actor=None, *, csrf=False):
    result = Client(enforce_csrf_checks=csrf)
    result.force_login(actor or user(), backend="allauth.account.auth_backends.AuthenticationBackend")
    return result


def authorize_browser(client, client_id=None):
    params = {"client_id": client_id or registered()["client_id"], "redirect_uri": REDIRECT, "response_type": "code",
        "code_challenge": CHALLENGE, "code_challenge_method": "S256", "state": "state-123", "resource": RESOURCE}
    response = client.get("/oauth/authorize", params)
    return response, client.session.get(oauth.MCP_PENDING_SESSION_KEY)


def test_metadata_uses_one_canonical_issuer_resource_and_no_untrusted_host():
    for path in ["/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]:
        response = Client().get(path)
        assert response.status_code == 200
        body = response.json()
        assert "testserver" not in response.content.decode()
        assert body.get("issuer", body.get("authorization_servers", [None])[0]) == "https://merosplit.omshejul.com"
        assert body["scopes_supported"] == [oauth.MCP_SCOPE]
        if "issuer" in body:
            assert body["code_challenge_methods_supported"] == ["S256"]
            assert body["token_endpoint_auth_methods_supported"] == ["none"]
            assert body["client_id_metadata_document_supported"] is False
        else:
            assert body["resource"] == RESOURCE and body["bearer_methods_supported"] == ["header"]


@pytest.mark.parametrize("redirect", [REDIRECT, "http://127.0.0.1:43897/callback", "http://[::1]:8080/callback", "http://localhost:9080/oauth", "cursor://anysphere.cursor-mcp/oauth", "com.example.agent:/oauth"])
def test_public_registration_exact_redirect_and_bounded_metadata(redirect):
    response = post(Client(enforce_csrf_checks=True), "/oauth/register", {"client_name": "Agent", "redirect_uris": [redirect],
        "logo_uri": "http://169.254.169.254/latest/meta-data/"}, json_body=True)
    assert response.status_code == 201
    body = response.json()
    assert body["redirect_uris"] == [redirect] and body["token_endpoint_auth_method"] == "none"
    assert "client_secret" not in body
    assert McpOAuthClient.objects.get().redirect_uris == [redirect]
    assert Client().options("/oauth/register").status_code == 200


@pytest.mark.parametrize("updates", [
    {"redirect_uris": []}, {"redirect_uris": [REDIRECT] * 11}, {"redirect_uris": "https://agent.example.invalid"},
    {"redirect_uris": ["http://agent.example.invalid/callback"]}, {"redirect_uris": ["javascript:alert(1)"]},
    {"redirect_uris": ["data:text/html,x"]}, {"redirect_uris": ["file:///etc/passwd"]},
    {"redirect_uris": ["https://agent.example.invalid/#"]}, {"redirect_uris": ["https://*.example.invalid/callback"]},
    {"redirect_uris": ["https://name:password@agent.example.invalid/"]}, {"redirect_uris": ["https://agent.example.invalid:bad/"]},
    {"redirect_uris": [" https://agent.example.invalid/callback"]}, {"redirect_uris": ["cursor://callback"], "application_type": "web"},
    {"token_endpoint_auth_method": "client_secret_basic"}, {"client_secret": "synthetic-never-accepted"},
    {"scope": "admin"}, {"grant_types": ["password"]}, {"response_types": ["token"]},
    {"client_name": "x" * 121}, {"client_name": "\n<script>"}, {"client_name": " "},
])
def test_registration_rejects_unsafe_public_client_metadata(updates):
    response = post(Client(), "/oauth/register", {"client_name": "Agent", "redirect_uris": [REDIRECT], **updates}, json_body=True)
    assert response.status_code == 400 and not McpOAuthClient.objects.exists()


def test_registration_body_and_duplicate_field_limits_before_rows():
    client = Client()
    for body in ["[]", "null", '{"redirect_uris":[],"redirect_uris":[]}', '{"client_name":"' + "x" * 17000 + '"}']:
        assert client.post("/oauth/register", data=body, content_type="application/json").status_code == 400
    assert not McpOAuthClient.objects.exists()


def test_logged_out_request_retained_for_normal_login_then_explicit_consent():
    client = Client()
    response, request_id = authorize_browser(client)
    assert response.status_code == 302 and response["Location"] == "/app/"
    assert request_id and not McpOAuthGrant.objects.exists()
    actor = user()
    client.force_login(actor, backend="allauth.account.auth_backends.AuthenticationBackend")
    assert client.session[oauth.MCP_PENDING_SESSION_KEY] == request_id
    assert client.get("/api/v1/me/mcp/pending").json() == {"authorization_url": f"/oauth/authorize?request={request_id}"}
    response = client.get(f"/oauth/authorize?request={request_id}")
    assert response.status_code == 200 and b"Connect Synthetic client" in response.content and b"Cancel" in response.content
    assert actor.email.encode() in response.content and not McpOAuthGrant.objects.exists()


def test_manual_code_login_then_name_preserves_pending_and_never_implies_consent(exported_app, monkeypatch):
    monkeypatch.setattr(email_delivery, "send_email", lambda *args, **kwargs: "synthetic-accepted")
    client = Client(enforce_csrf_checks=True)
    _, request_id = authorize_browser(client)
    client.get("/app/")
    csrf = client.cookies["csrftoken"].value
    email = "synthetic-code-recipient@example.invalid"
    challenge = post(client, "/_allauth/browser/v1/auth/code/request", {"email": email}, json_body=True, HTTP_X_CSRFTOKEN=csrf)
    assert challenge.status_code == 200
    grant = email_links.EmailLoginGrant.objects.get(source_key=f"otp/{challenge.json()['data']['challenge_id']}")
    response = post(client, "/_allauth/browser/v1/auth/code/confirm", {"challenge_id": challenge.json()["data"]["challenge_id"],
        "code": email_links.fallback_code(grant.id)}, json_body=True, HTTP_X_CSRFTOKEN=csrf)
    assert response.status_code == 200 and client.session[oauth.MCP_PENDING_SESSION_KEY] == request_id
    assert not McpOAuthGrant.objects.exists()
    assert client.get(f"/oauth/authorize?request={request_id}")["Location"] == "/app/"
    response = client.put("/api/v1/me/profile", data=json.dumps({"display_name": "Synthetic chosen name"}),
        content_type="application/json", HTTP_X_CSRFTOKEN=client.cookies["csrftoken"].value)
    assert response.status_code == 200
    assert client.get("/api/v1/me/mcp/pending").json()["authorization_url"] == f"/oauth/authorize?request={request_id}"
    assert client.get(f"/oauth/authorize?request={request_id}").status_code == 200
    assert not McpOAuthGrant.objects.exists()


def test_different_account_email_link_rotation_preserves_only_valid_pending_and_relabels_consent(exported_app):
    old, intended = user("Old synthetic account"), user("Intended synthetic account")
    client = browser(old, csrf=True)
    response, request_id = authorize_browser(client)
    client.get(response["Location"])
    grant = email_links.issue_email_link(intended.email, purpose="login", target={"kind": "home"},
        source_key=f"synthetic/{uuid4()}", expires_at=timezone.now() + timedelta(seconds=180))
    proof = urlsplit(email_links.delivery_url(grant.id)).fragment.removeprefix("proof=")
    result = post(client, "/_allauth/browser/v1/auth/link/exchange", {"grant_id": str(grant.id), "proof": proof},
        json_body=True, HTTP_X_CSRFTOKEN=client.cookies["csrftoken"].value)
    assert result.status_code == 400 and client.session[oauth.MCP_PENDING_SESSION_KEY] == request_id
    assert client.get("/api/v1/me").json()["id"] == old.pk
    grant.refresh_from_db()
    assert grant.consumed_at is None
    result = post(client, "/_allauth/browser/v1/auth/link/exchange", {"grant_id": str(grant.id), "proof": proof, "switch_from_user_id": old.pk},
        json_body=True, HTTP_X_CSRFTOKEN=client.cookies["csrftoken"].value)
    assert result.status_code == 200 and result.json()["data"]["user"]["id"] == intended.pk
    assert client.session[oauth.MCP_PENDING_SESSION_KEY] == request_id
    assert client.get("/api/v1/me/mcp/pending").json()["authorization_url"] == f"/oauth/authorize?request={request_id}"
    page = client.get(f"/oauth/authorize?request={request_id}")
    assert intended.email.encode() in page.content and old.email.encode() not in page.content
    data = {"request": request_id, "expected_user_id": str(old.pk), "decision": "allow"}
    assert post(client, "/oauth/authorize", data, HTTP_X_CSRFTOKEN=client.cookies["csrftoken"].value).status_code == 403
    assert not McpOAuthGrant.objects.exists()
    assert post(client, "/oauth/authorize", {**data, "expected_user_id": str(intended.pk)},
        HTTP_X_CSRFTOKEN=client.cookies["csrftoken"].value).status_code == 302
    assert McpOAuthPendingAuthorization.objects.get(pk=request_id).user_id == intended.pk


def test_expired_pending_is_cleared_without_returning_client_redirect():
    client = browser()
    _, request_id = authorize_browser(client)
    McpOAuthPendingAuthorization.objects.filter(pk=request_id).update(expires_at=timezone.now() - timedelta(seconds=1))
    assert client.get("/api/v1/me/mcp/pending").json() == {"authorization_url": None}
    assert oauth.MCP_PENDING_SESSION_KEY not in client.session


def test_browser_disconnect_requires_csrf_and_expected_account_and_is_owner_scoped():
    actor, _, tokens = granted()
    grant_id = McpOAuthGrant.objects.get().pk
    client = browser(actor, csrf=True)
    response, _ = authorize_browser(client)
    client.get(response["Location"])
    path = f"/api/v1/me/mcp/{grant_id}"
    assert client.delete(path).status_code == 403
    csrf = client.cookies["csrftoken"].value
    assert client.delete(path, HTTP_X_CSRFTOKEN=csrf, HTTP_X_MEROSPLIT_ACCOUNT=str(actor.pk + 1)).status_code == 401
    outsider = browser(user(), csrf=True)
    response, _ = authorize_browser(outsider)
    outsider.get(response["Location"])
    assert outsider.delete(path, HTTP_X_CSRFTOKEN=outsider.cookies["csrftoken"].value).status_code == 200
    assert oauth.authenticate_access_token(tokens["access_token"])
    assert client.delete(path, HTTP_X_CSRFTOKEN=csrf, HTTP_X_MEROSPLIT_ACCOUNT=str(actor.pk)).status_code == 200
    assert not oauth.authenticate_access_token(tokens["access_token"])


def test_consent_requires_cookie_csrf_and_exact_displayed_account_and_browser():
    actor = user()
    client = browser(actor, csrf=True)
    response, request_id = authorize_browser(client)
    page = client.get(response["Location"])
    assert page.status_code == 200
    data = {"request": request_id, "decision": "allow", "expected_user_id": str(actor.pk)}
    assert post(client, "/oauth/authorize", data).status_code == 403
    csrf = client.cookies["csrftoken"].value
    assert post(client, "/oauth/authorize", {**data, "expected_user_id": str(actor.pk + 1)}, HTTP_X_CSRFTOKEN=csrf).status_code == 403
    assert post(browser(actor), "/oauth/authorize", data).status_code == 400
    assert Client().get(f"/oauth/authorize?request={request_id}").status_code == 400
    response = post(client, "/oauth/authorize", data, HTTP_X_CSRFTOKEN=csrf)
    assert response.status_code == 302 and parse_qs(urlsplit(response["Location"]).query)["state"] == ["state-123"]
    assert not McpOAuthGrant.objects.exists()  # Consent issues only a PKCE-bound code.
    assert not client.get("/api/v1/me/mcp/pending").json()["authorization_url"]


def test_consent_escapes_client_names_and_name_onboarding_stays_before_consent():
    client = browser()
    response, _ = authorize_browser(client, registered(client_name="<script>alert('x')</script>")["client_id"])
    page = client.get(response["Location"])
    assert b"&lt;script&gt;" in page.content and b"<script>" not in page.content
    assert page["Cache-Control"] == "no-store" and page["Referrer-Policy"] == "same-origin"
    unnamed = browser(user(""))
    response, _ = authorize_browser(unnamed)
    assert unnamed.get(response["Location"])["Location"] == "/app/"


def test_cancel_preserves_state_issuer_and_never_creates_tokens():
    client = browser()
    _, request_id = authorize_browser(client)
    actor_id = client.session["_auth_user_id"]
    response = post(client, "/oauth/authorize", {"request": request_id, "decision": "cancel", "expected_user_id": actor_id})
    query = parse_qs(urlsplit(response["Location"]).query)
    assert query == {"existing": ["1"], "error": ["access_denied"], "state": ["state-123"], "iss": [oauth.issuer_url()]}
    assert McpOAuthPendingAuthorization.objects.get(pk=request_id).denied_at
    assert not McpOAuthGrant.objects.exists()


@pytest.mark.parametrize("updates", [{"response_type": "token"}, {"code_challenge_method": "plain"}, {"code_challenge": "x"},
    {"resource": "https://attacker.example.invalid/mcp"}, {"scope": "admin"}, {"state": "x" * 1025},
    {"redirect_uri": REDIRECT + "&extra=1"}, {"client_id": str(uuid4())}])
def test_authorization_rejects_pkce_resource_scope_client_and_redirect_changes(updates):
    with pytest.raises(oauth.OAuthError):
        pending(**updates)
    assert not McpOAuthPendingAuthorization.objects.exists()


def test_approved_code_is_bound_and_one_use_without_raw_storage():
    actor, row, code = approved()
    for update in [{"code_verifier": "z" * 60}, {"redirect_uri": "https://attacker.example.invalid/callback"},
                   {"client_id": registered()["client_id"]}, {"resource": "https://attacker.example.invalid/mcp"}, {"scope": "admin"}]:
        with pytest.raises(oauth.OAuthError):
            oauth.exchange_code(code_data(row, code, **update), NETWORK)
    tokens = oauth.exchange_code(code_data(row, code), NETWORK)
    assert tokens["expires_in"] == 3600 and tokens["scope"] == oauth.MCP_SCOPE
    assert oauth.authenticate_access_token(tokens["access_token"])[0].pk == actor.pk
    with pytest.raises(oauth.OAuthError, match="invalid_grant"):
        oauth.exchange_code(code_data(row, code), NETWORK)
    stored = json.dumps({"pending": list(McpOAuthPendingAuthorization.objects.values()), "grants": list(McpOAuthGrant.objects.values())}, default=str)
    assert code not in stored and tokens["access_token"] not in stored and tokens["refresh_token"] not in stored
    assert VERIFIER not in stored
    for session in Session.objects.all():
        assert code not in json.dumps(session.get_decoded()) and tokens["access_token"] not in json.dumps(session.get_decoded())


def test_pending_and_approved_code_have_distinct_expiries():
    actor = user()
    row = pending()
    McpOAuthPendingAuthorization.objects.filter(pk=row.id).update(expires_at=timezone.now() - timedelta(seconds=1))
    with pytest.raises(oauth.OAuthError):
        oauth.decide_authorization(actor, row.id, approved=True, expected_user_id=actor.pk, network=NETWORK)
    actor, row, code = approved(actor)
    McpOAuthPendingAuthorization.objects.filter(pk=row.id).update(code_expires_at=timezone.now() - timedelta(seconds=1))
    with pytest.raises(oauth.OAuthError, match="invalid_grant"):
        oauth.exchange_code(code_data(row, code), NETWORK)
    assert not McpOAuthGrant.objects.exists()


def test_actual_form_token_endpoint_rejects_bearer_credentials_and_duplicate_fields():
    _, row, code = approved()
    client = Client(enforce_csrf_checks=True)
    assert post(client, "/oauth/token", code_data(row, code), HTTP_AUTHORIZATION="Basic synthetic").status_code == 400
    assert post(client, "/oauth/token", {**code_data(row, code), "client_secret": "synthetic"}).status_code == 400
    assert post(client, "/oauth/token", code_data(row, code), json_body=True).status_code == 400
    assert client.post("/oauth/token", data=urlencode(code_data(row, code)) + "&client_id=duplicate", content_type="application/x-www-form-urlencoded").status_code == 400
    response = post(client, "/oauth/token", code_data(row, code))
    assert response.status_code == 200 and response["Cache-Control"] == "no-store"
    assert response.json()["token_type"] == "Bearer"


def test_refresh_rotates_old_access_and_replay_commits_entire_family_revocation():
    _, row, tokens = granted()
    original_expiry = McpOAuthGrant.objects.get().refresh_expires_at
    new = refreshed(row, tokens)
    assert McpOAuthRefreshDigest.objects.count() == 1
    assert not oauth.authenticate_access_token(tokens["access_token"])
    assert oauth.authenticate_access_token(new["access_token"])
    with pytest.raises(oauth.OAuthError, match="invalid_grant"):
        refreshed(row, tokens)
    assert McpOAuthGrant.objects.get().revoked_at
    assert not oauth.authenticate_access_token(new["access_token"])
    with pytest.raises(oauth.OAuthError):
        refreshed(row, new)
    assert McpOAuthGrant.objects.get().refresh_expires_at == original_expiry


def test_refresh_wrong_client_resource_scope_cannot_rotate_or_revoke_and_lifetime_never_slides():
    _, row, tokens = granted()
    for update in [{"client_id": registered()["client_id"]}, {"resource": "https://attacker.example.invalid/mcp"}, {"scope": "admin"}]:
        with pytest.raises(oauth.OAuthError):
            refreshed(row, tokens, **update)
        assert not McpOAuthGrant.objects.get().revoked_at
    cutoff = timezone.now() + timedelta(minutes=15)
    McpOAuthGrant.objects.update(refresh_expires_at=cutoff)
    new = refreshed(row, tokens)
    grant = McpOAuthGrant.objects.get()
    assert grant.refresh_expires_at == cutoff and grant.access_expires_at == cutoff
    assert 899 <= new["expires_in"] <= 900
    McpOAuthGrant.objects.update(refresh_expires_at=timezone.now() - timedelta(seconds=1))
    assert not oauth.authenticate_access_token(new["access_token"])
    with pytest.raises(oauth.OAuthError):
        refreshed(row, new)


def test_revocation_is_client_bound_and_old_refresh_can_revoke_current_family():
    _, row, tokens = granted()
    new = refreshed(row, tokens)
    other = registered()["client_id"]
    client = Client(enforce_csrf_checks=True)
    assert post(client, "/oauth/revoke", {"client_id": other, "token": tokens["refresh_token"]}).status_code == 200
    assert oauth.authenticate_access_token(new["access_token"])
    assert post(client, "/oauth/revoke", {"client_id": str(row.client_id), "token": tokens["refresh_token"]}).status_code == 200
    assert not oauth.authenticate_access_token(new["access_token"])
    assert post(client, "/oauth/revoke", {"client_id": str(row.client_id), "token": "unknown"}).status_code == 200


def test_connected_clients_are_owner_scoped_and_disconnect_revokes_both_tokens():
    actor, row, tokens = granted()
    outsider = user()
    assert oauth.connected_agents(outsider) == {"connections": []}
    assert oauth.disconnect_agent(outsider, McpOAuthGrant.objects.get().id) == {"revoked": True}
    assert oauth.authenticate_access_token(tokens["access_token"])
    data = oauth.connected_agents(actor)["connections"]
    assert len(data) == 1 and set(data[0]) == {"id", "client_name", "created_at", "last_used_at"}
    assert oauth.disconnect_agent(actor, data[0]["id"]) == {"revoked": True}
    assert oauth.disconnect_agent(actor, data[0]["id"]) == {"revoked": True}
    assert not oauth.authenticate_access_token(tokens["access_token"])
    with pytest.raises(oauth.OAuthError):
        refreshed(row, tokens)
    assert oauth.connected_agents(actor) == {"connections": []}


def test_inactive_account_rejected_each_request_and_account_delete_cascades_credentials():
    actor, row, tokens = granted()
    current_tokens = refreshed(row, tokens)
    assert oauth.authenticate_access_token(current_tokens["access_token"])
    get_user_model().objects.filter(pk=actor.pk).update(is_active=False)
    with pytest.raises(oauth.OAuthError):
        oauth.connected_agents(actor)
    assert not oauth.authenticate_access_token(current_tokens["access_token"])
    actor.delete()
    assert not McpOAuthGrant.objects.exists() and not McpOAuthRefreshDigest.objects.exists()
    assert not McpOAuthPendingAuthorization.objects.filter(pk=row.id).exists()


def test_public_limits_are_shared_database_buckets_and_failed_requests_do_not_reset_budget():
    for _ in range(20):
        registered()
    with pytest.raises(oauth.OAuthError) as error:
        registered()
    assert error.value.status == 429
    assert McpOAuthClient.objects.count() == 20 and EmailRateBucket.objects.exists()
    for _ in range(60):
        with pytest.raises(oauth.OAuthError):
            oauth.exchange_code({"client_id": "invalid"}, NETWORK)
    with pytest.raises(oauth.OAuthError) as error:
        oauth.exchange_code({"client_id": "invalid"}, NETWORK)
    assert error.value.status == 429


def test_invalid_http_bodies_are_also_network_limited_without_creating_clients():
    client = Client()
    for _ in range(60):
        assert client.post("/oauth/register", data="[", content_type="application/json").status_code == 400
    response = client.post("/oauth/register", data="[", content_type="application/json")
    assert response.status_code == 429 and response["Retry-After"] == "60"
    assert not McpOAuthClient.objects.exists()


def test_tool_reauthentication_checks_each_time_without_double_charging_and_never_accepts_browser_session():
    actor, _, tokens = granted()
    cookie = browser(actor).session.session_key
    assert not oauth.authenticate_access_token(cookie)
    assert oauth.authenticate_access_token(tokens["access_token"], network=NETWORK)
    before = list(EmailRateBucket.objects.order_by("key").values_list("key", "count"))
    for _ in range(3):
        assert oauth.authenticate_access_token(tokens["access_token"], enforce_limits=False)[0].pk == actor.pk
    assert list(EmailRateBucket.objects.order_by("key").values_list("key", "count")) == before
    McpOAuthGrant.objects.update(revoked_at=timezone.now())
    assert not oauth.authenticate_access_token(tokens["access_token"], enforce_limits=False)


@pytest.mark.django_db(transaction=True)
def test_tool_grant_rate_is_durable_across_new_database_connections():
    _, _, tokens = granted()
    for _ in range(60):
        assert oauth.authenticate_access_token(tokens["access_token"], network=NETWORK)
    connections.close_all()
    with pytest.raises(oauth.OAuthError) as error:
        oauth.authenticate_access_token(tokens["access_token"], network=NETWORK)
    assert error.value.status == 429


def _parallel(function):
    barrier = Barrier(2)

    def run():
        close_old_connections()
        try:
            barrier.wait(timeout=10)
            try:
                return function()
            except oauth.OAuthError as error:
                return error.error
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        return list(pool.map(lambda _: run(), range(2)))


@pytest.mark.django_db(transaction=True)
def test_concurrent_code_exchange_one_winner_and_no_duplicate_connection():
    _, row, code = approved()
    results = _parallel(lambda: oauth.exchange_code(code_data(row, code), NETWORK))
    assert sum(isinstance(value, dict) for value in results) == 1
    assert results.count("invalid_grant") == 1 and McpOAuthGrant.objects.count() == 1


@pytest.mark.django_db(transaction=True)
def test_concurrent_refresh_rotation_detects_reuse_and_revokes_winners_tokens():
    _, row, tokens = granted()
    results = _parallel(lambda: refreshed(row, tokens))
    assert sum(isinstance(value, dict) for value in results) == 1 and results.count("invalid_grant") == 1
    assert McpOAuthGrant.objects.get().revoked_at and McpOAuthRefreshDigest.objects.count() == 1
    winning = next(value for value in results if isinstance(value, dict))
    assert not oauth.authenticate_access_token(winning["access_token"])


@pytest.mark.django_db(transaction=True)
def test_concurrent_consent_is_single_decision_and_code_remains_only_digest():
    actor, row = user(), pending()
    results = _parallel(lambda: oauth.decide_authorization(actor, row.id, approved=True, expected_user_id=actor.pk, network=NETWORK))
    assert sum(value.startswith(REDIRECT) for value in results) == 1 and results.count("invalid_request") == 1
    row.refresh_from_db()
    assert row.user_id == actor.pk and row.approved_at and row.code_digest
    assert not McpOAuthGrant.objects.exists()


@pytest.mark.django_db(transaction=True)
def test_refresh_reuse_error_response_revocation_is_committed_for_another_request():
    _, row, tokens = granted()
    current = refreshed(row, tokens)
    response = post(Client(), "/oauth/token", {"grant_type": "refresh_token", "client_id": str(row.client_id),
        "resource": RESOURCE, "refresh_token": tokens["refresh_token"]})
    assert response.status_code == 400 and response.json()["error"] == "invalid_grant"
    connections.close_all()
    assert McpOAuthGrant.objects.get().revoked_at
    assert not oauth.authenticate_access_token(current["access_token"])


def test_new_domain_keeps_exact_legacy_grant_rotation_sdk_resource_and_revocation(settings):
    actor, row, tokens = granted()
    settings.MCP_SERVER_URL = "https://merosplit.com/mcp"
    from .mcp_server import authenticate_request
    assert oauth.resource_url() == "https://merosplit.com/mcp"
    assert oauth.authenticate_access_token(tokens["access_token"])[0].pk == actor.pk
    assert authenticate_request(tokens["access_token"], NETWORK).resource == oauth.resource_url()
    rotated = refreshed(row, tokens)
    grant = McpOAuthGrant.objects.get(user=actor)
    assert grant.resource == RESOURCE  # Preserve persisted identity; no replacement grant.
    assert McpOAuthGrant.objects.filter(user=actor).count() == 1
    assert oauth.authenticate_access_token(rotated["access_token"])
    with pytest.raises(oauth.OAuthError):
        refreshed(row, tokens)  # Existing refresh-replay revocation still applies.
    assert oauth.authenticate_access_token(rotated["access_token"]) is None
    with pytest.raises(oauth.OAuthError):
        oauth._scope_resource({"resource": "https://merosplit.com.evil.invalid/mcp"})


def test_pending_legacy_authorization_survives_domain_change_without_accepting_other_hosts(settings):
    actor = user()
    row = pending()
    settings.MCP_SERVER_URL = "https://merosplit.com/mcp"
    url = oauth.decide_authorization(actor, row.id, approved=True, expected_user_id=actor.pk, network=NETWORK)
    code = parse_qs(urlsplit(url).query)["code"][0]
    tokens = oauth.exchange_code(code_data(row, code), NETWORK)
    assert oauth.authenticate_access_token(tokens["access_token"])[0].pk == actor.pk
    settings.MCP_SERVER_URL = "https://unrelated.example.invalid/mcp"
    assert oauth.authenticate_access_token(tokens["access_token"]) is None

@pytest.mark.parametrize('host', ['merosplit.com', 'merosplit.omshejul.com'])
@pytest.mark.parametrize('decision', ['allow', 'cancel'])
def test_https_consent_uses_hidden_form_csrf_without_header(settings, host, decision):
    import re
    settings.ALLOWED_HOSTS = [host, 'testserver']
    client = browser(csrf=True)
    response, request_id = authorize_browser(client)
    page = client.get(response['Location'], HTTP_HOST=host, HTTP_X_FORWARDED_PROTO='https')
    assert page.status_code == 200
    assert page['Referrer-Policy'] == 'same-origin'
    policy = {part.split()[0]: part.split()[1:] for part in page["Content-Security-Policy"].split(";") if part.strip()}
    # Chromium applies form-action to the validated cross-origin callback redirect too.
    assert "form-action" not in policy
    assert "'self'" in policy["style-src"] and "'self'" in policy["font-src"]
    assert policy["default-src"] == ["'none'"]
    assert policy["img-src"] == ["'self'"]
    assert policy["frame-ancestors"] == ["'none'"] and policy["base-uri"] == ["'none'"]
    assert b'action="/oauth/authorize"' in page.content
    assert b'name="referrer" content="same-origin"' in page.content
    hidden = re.search(r'name="csrfmiddlewaretoken" value="([^"]+)"', page.content.decode()).group(1)
    data = {'request': request_id, 'expected_user_id': client.session['_auth_user_id'], 'decision': decision, 'csrfmiddlewaretoken': hidden}
    result = post(client, '/oauth/authorize', data, HTTP_HOST=host, HTTP_X_FORWARDED_PROTO='https', HTTP_ORIGIN='https://' + host, HTTP_REFERER='https://' + host + response['Location'])
    assert result.status_code == 302
    assert result['Referrer-Policy'] == 'no-referrer'  # No selector/code Referer to the external client.
    assert not McpOAuthGrant.objects.exists()

@pytest.mark.parametrize('failure', ['missing', 'mismatch', 'null_origin', 'untrusted_origin', 'wrong_account', 'wrong_request', 'other_browser'])
def test_hidden_consent_form_keeps_csrf_account_and_request_fences(settings, failure):
    import re
    settings.ALLOWED_HOSTS = ['merosplit.com', 'testserver']
    client = browser(csrf=True)
    response, request_id = authorize_browser(client)
    page = client.get(response['Location'], HTTP_HOST='merosplit.com', HTTP_X_FORWARDED_PROTO='https')
    token = re.search(r'name="csrfmiddlewaretoken" value="([^"]+)"', page.content.decode()).group(1)
    data = {'request': request_id, 'expected_user_id': client.session['_auth_user_id'], 'decision': 'allow', 'csrfmiddlewaretoken': token}
    origin = 'https://merosplit.com'
    if failure == 'missing':
        data.pop('csrfmiddlewaretoken')
    if failure == 'mismatch':
        data['csrfmiddlewaretoken'] = 'x' * 64
    if failure == 'null_origin':
        origin = 'null'
    if failure == 'untrusted_origin':
        origin = 'https://evil.example.invalid'
    if failure == 'wrong_account':
        data['expected_user_id'] = str(int(data['expected_user_id']) + 1)
    if failure == 'wrong_request':
        data['request'] = str(uuid4())
    if failure == 'other_browser':
        client = browser(csrf=True)
    result = post(client, '/oauth/authorize', data, HTTP_HOST='merosplit.com', HTTP_X_FORWARDED_PROTO='https', HTTP_ORIGIN=origin)
    assert result.status_code in {400, 403}
    row = McpOAuthPendingAuthorization.objects.get(pk=request_id)
    assert row.approved_at is None and row.denied_at is None and not row.code_digest
    assert not McpOAuthGrant.objects.exists()


def test_public_setup_verifies_without_financial_reads_or_manual_keys():
    response = Client().get('/mcp/setup')
    assert response.status_code == 200
    text = response.content.decode()
    assert 'get_account_context</code> with <code>{}</code>' in text
    assert 'No group or transaction lookup is needed.' in text
    assert 'claude mcp add --transport http --scope user merosplit' in text
    assert 'claude mcp login' not in text
    assert '"mcpServers":{"merosplit":{"url":' in text
    assert 'Other Streamable HTTP clients' in text
    assert 'config/mcpServer/reload' in text and 'mcpServerStatus/list' in text
    assert 'Authenticated; tool loading pending' in text
    assert 'start a new chat to load the tools' not in text
    assert 'Muse Code' in text and 'muse mcp login merosplit' in text and 'muse resume' in text
    assert 'VS Code and Copilot' in text and 'MCP: List Servers' in text
    assert 'complete browser OAuth if needed' in text
    assert 'Report success only after the account check succeeds' in text
    assert 'Settings → MCP servers → merosplit → Restart' in text
    assert 'Return here and reply <strong>done</strong>' in text
    assert 'after their reply, rediscover the tools' in text
    assert 'A status message alone is not a complete handoff.' in text
