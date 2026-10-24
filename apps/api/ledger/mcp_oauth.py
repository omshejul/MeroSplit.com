"""Public-client OAuth for MCP, using the existing User and PostgreSQL locks."""

import base64
import hashlib
import ipaddress
import math
import re
import secrets
from datetime import timedelta
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from uuid import UUID

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.exceptions import ImproperlyConfigured
from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from django.views.decorators.debug import sensitive_variables

from .mcp_models import McpOAuthClient, McpOAuthGrant, McpOAuthPendingAuthorization, McpOAuthRefreshDigest
from .otp import EmailCodeLimited, consume_limits

MCP_SCOPE = "merosplit:mcp"
MCP_PENDING_SESSION_KEY = "mcp_pending_authorization"
PKCE_CHALLENGE = re.compile(r"[A-Za-z0-9_-]{43}")
PKCE_VERIFIER = re.compile(r"[A-Za-z0-9._~-]{43,128}")
NATIVE_SCHEMES = {"codex", "cursor", "vscode", "vscode-insiders", "claude"}


class OAuthError(Exception):
    def __init__(self, error="invalid_request", status=400):
        self.error, self.status = error, status
        super().__init__(error)


def resource_url():
    value = settings.MCP_SERVER_URL
    parsed = urlsplit(value)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.query or parsed.fragment or parsed.path != "/mcp"):
        raise ImproperlyConfigured("MCP_SERVER_URL must be a canonical HTTPS /mcp URL")
    return value


def trusted_resources():
    canonical = resource_url()
    # Exact former production resource only; never trust Host or a supplied URL.
    return (canonical, "https://merosplit.omshejul.com/mcp") if canonical == "https://merosplit.com/mcp" else (canonical,)


def issuer_url():
    parsed = urlsplit(resource_url())
    return f"{parsed.scheme}://{parsed.netloc}"


def _digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def _text(value, maximum, *, required=True):
    if not isinstance(value, str) or len(value) > maximum or (required and not value) or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise OAuthError()
    return value


def rate_limit(action, network, *, user_id=None, grant_id=None):
    """Persist abuse budgets separately, including when a later operation fails."""
    limits = [(f"mcp-{action}-global", "all", 60, 600), (f"mcp-{action}-network", network, 60, 60)]
    if action == "register":
        limits += [("mcp-register-hour", network, 3600, 20), ("mcp-register-global-hour", "all", 3600, 300)]
    if user_id is not None:
        limits.append((f"mcp-{action}-user", str(user_id), 60, 120))
    if grant_id is not None:
        limits.append((f"mcp-{action}-grant", str(grant_id), 60, 120))
    try:
        with transaction.atomic():
            consume_limits(limits)
    except EmailCodeLimited:
        raise OAuthError("temporarily_unavailable", 429) from None


def _validate_redirect(value, application_type):
    _text(value, 2048)
    try:
        parsed = urlsplit(value)
        host = parsed.hostname
        parsed.port  # Reject malformed port syntax before storing a callback.
    except ValueError:
        raise OAuthError("invalid_redirect_uri") from None
    if "#" in value or any(c.isspace() for c in value) or "*" in value or parsed.username or parsed.password or not parsed.scheme:
        raise OAuthError("invalid_redirect_uri")
    if parsed.scheme == "https" and host:
        return
    if application_type == "native":
        if parsed.scheme == "http" and host:
            try:
                loopback = ipaddress.ip_address(host).is_loopback
            except ValueError:
                loopback = host == "localhost"
            if loopback:
                return
        # Claimed reverse-domain schemes and the installed client callbacks only.
        if (parsed.scheme in NATIVE_SCHEMES or re.fullmatch(r"[a-z][a-z0-9+.-]*\.[a-z][a-z0-9+.-]*", parsed.scheme)) and (parsed.netloc or parsed.path):
            return
    raise OAuthError("invalid_redirect_uri")


def register_client(data, network):
    rate_limit("register", network)
    if not isinstance(data, dict) or "client_secret" in data:
        raise OAuthError("invalid_client_metadata")
    name = _text(data.get("client_name", "AI agent"), 120).strip()
    redirects = data.get("redirect_uris")
    application_type = data.get("application_type", "native")
    if (not name or not isinstance(application_type, str) or application_type not in {"web", "native"} or not isinstance(redirects, list)
            or not 1 <= len(redirects) <= 10 or data.get("token_endpoint_auth_method", "none") != "none"
            or data.get("scope", MCP_SCOPE) != MCP_SCOPE
            or data.get("grant_types", ["authorization_code", "refresh_token"]) != ["authorization_code", "refresh_token"]
            or data.get("response_types", ["code"]) != ["code"]):
        raise OAuthError("invalid_client_metadata")
    # Ignore decorative/extension metadata; never fetch client-controlled URLs.
    for value in redirects:
        _validate_redirect(value, application_type)
    row = McpOAuthClient.objects.create(name=name, redirect_uris=list(dict.fromkeys(redirects)), application_type=application_type)
    return {"client_id": str(row.id), "client_id_issued_at": int(row.created_at.timestamp()),
            "client_name": row.name, "redirect_uris": row.redirect_uris, "application_type": application_type,
            "token_endpoint_auth_method": "none", "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"], "scope": MCP_SCOPE}


def _client(value):
    try:
        row = McpOAuthClient.objects.filter(pk=UUID(str(value))).first()
    except (ValueError, TypeError):
        row = None
    if not row:
        raise OAuthError("invalid_client")
    return row


def _scope_resource(data):
    if data.get("scope", MCP_SCOPE) != MCP_SCOPE:
        raise OAuthError("invalid_scope")
    if data.get("resource", resource_url()) not in trusted_resources():
        raise OAuthError("invalid_target")


def begin_authorization(data, network):
    rate_limit("authorize", network)
    client = _client(data.get("client_id"))
    redirect = data.get("redirect_uri")
    if redirect not in client.redirect_uris:
        raise OAuthError()
    challenge = data.get("code_challenge", "")
    if (data.get("response_type") != "code" or data.get("code_challenge_method") != "S256"
            or not isinstance(challenge, str) or not PKCE_CHALLENGE.fullmatch(challenge)):
        raise OAuthError()
    _scope_resource(data)
    state = _text(data.get("state", ""), 1024, required=False)
    return McpOAuthPendingAuthorization.objects.create(client=client, redirect_uri=redirect, state=state,
        code_challenge=challenge, scope=MCP_SCOPE, resource=resource_url(), expires_at=timezone.now() + timedelta(minutes=10))


def get_pending(request_id):
    try:
        row = McpOAuthPendingAuthorization.objects.select_related("client").filter(
            pk=UUID(str(request_id)), approved_at__isnull=True, denied_at__isnull=True, expires_at__gt=timezone.now()).first()
    except (ValueError, TypeError):
        row = None
    if row is None:
        raise OAuthError()
    return row


def _redirect(row, **params):
    parsed = urlsplit(row.redirect_uri)
    # Reserved OAuth parameters cannot be supplied twice by a registered query.
    query = [(k, v) for k, v in parse_qsl(parsed.query, keep_blank_values=True) if k not in {"code", "error", "state", "iss"}]
    query += [(k, v) for k, v in {**params, "iss": issuer_url(), **({"state": row.state} if row.state else {})}.items()]
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(query), ""))


@sensitive_variables()
def decide_authorization(actor, request_id, *, approved, expected_user_id, network):
    if not actor.is_authenticated or str(actor.pk) != str(expected_user_id) or type(approved) is not bool:
        raise OAuthError("access_denied", 403)
    rate_limit("consent", network, user_id=actor.pk)
    with transaction.atomic():
        user = get_user_model().objects.select_for_update(no_key=True).filter(pk=actor.pk, is_active=True).first()
        if not user:
            raise OAuthError("access_denied", 403)
        try:
            row = McpOAuthPendingAuthorization.objects.select_for_update().get(pk=UUID(str(request_id)))
        except (ValueError, TypeError, McpOAuthPendingAuthorization.DoesNotExist):
            raise OAuthError() from None
        now = timezone.now()
        if row.approved_at or row.denied_at or row.expires_at <= now or row.resource not in trusted_resources():
            raise OAuthError()
        if not approved:
            row.denied_at = now
            row.save(update_fields=["denied_at"])
            return _redirect(row, error="access_denied")
        # User lock also serializes the per-account connection ceiling and deletion.
        if McpOAuthGrant.objects.filter(user=user, revoked_at__isnull=True, refresh_expires_at__gt=now).count() >= 50:
            raise OAuthError("access_denied", 403)
        code = "mero_code_" + secrets.token_urlsafe(32)
        row.user, row.approved_at, row.code_digest = user, now, _digest(code)
        row.code_expires_at = now + timedelta(minutes=2)
        row.save(update_fields=["user", "approved_at", "code_digest", "code_expires_at"])
        return _redirect(row, code=code)


def _tokens(grant, access, refresh):
    return {"access_token": access, "refresh_token": refresh, "token_type": "Bearer", "scope": grant.scope,
            "expires_in": max(0, math.ceil((grant.access_expires_at - timezone.now()).total_seconds()))}


@sensitive_variables()
def exchange_code(data, network):
    rate_limit("token", network)
    client = _client(data.get("client_id"))
    _scope_resource(data)
    raw = _text(data.get("code"), 256)
    verifier = _text(data.get("code_verifier"), 128)
    if not PKCE_VERIFIER.fullmatch(verifier):
        raise OAuthError("invalid_grant")
    digest = _digest(raw)
    user_id = McpOAuthPendingAuthorization.objects.filter(code_digest=digest).values_list("user_id", flat=True).first()
    with transaction.atomic():
        user = get_user_model().objects.select_for_update(no_key=True).filter(pk=user_id, is_active=True).first()
        row = McpOAuthPendingAuthorization.objects.select_for_update().filter(code_digest=digest, client=client).first()
        now = timezone.now()
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
        if (not user or not row or row.user_id != user.pk or row.consumed_at or row.denied_at or not row.approved_at
                or not row.code_expires_at or row.code_expires_at <= now or row.resource not in trusted_resources()
                or data.get("redirect_uri") != row.redirect_uri or not secrets.compare_digest(row.code_challenge, challenge)):
            raise OAuthError("invalid_grant")
        if McpOAuthGrant.objects.filter(user=user, revoked_at__isnull=True, refresh_expires_at__gt=now).count() >= 50:
            raise OAuthError("invalid_grant")
        access, refresh = "mero_at_" + secrets.token_urlsafe(32), "mero_rt_" + secrets.token_urlsafe(32)
        grant = McpOAuthGrant.objects.create(user=user, client=client, scope=row.scope, resource=row.resource,
            access_token_digest=_digest(access), refresh_token_digest=_digest(refresh),
            access_expires_at=now + timedelta(hours=1), refresh_expires_at=now + timedelta(days=90))
        row.consumed_at = now
        row.save(update_fields=["consumed_at"])
    return _tokens(grant, access, refresh)


@sensitive_variables()
def exchange_refresh(data, network):
    rate_limit("token", network)
    client = _client(data.get("client_id"))
    _scope_resource(data)
    digest = _digest(_text(data.get("refresh_token"), 256))
    grant_id = McpOAuthGrant.objects.filter(refresh_token_digest=digest).values_list("pk", flat=True).first()
    if not grant_id:
        grant_id = McpOAuthRefreshDigest.objects.filter(pk=digest).values_list("grant_id", flat=True).first()
    user_id = McpOAuthGrant.objects.filter(pk=grant_id).values_list("user_id", flat=True).first()
    result = None
    with transaction.atomic():
        user = get_user_model().objects.select_for_update(no_key=True).filter(pk=user_id, is_active=True).first()
        grant = McpOAuthGrant.objects.select_for_update().filter(pk=grant_id, client=client).first()
        now = timezone.now()
        if user and grant and grant.user_id == user.pk and grant.resource in trusted_resources() and not grant.revoked_at and grant.refresh_expires_at > now:
            if not secrets.compare_digest(grant.refresh_token_digest, digest):
                # Commit revocation before returning invalid_grant, including races.
                if McpOAuthRefreshDigest.objects.filter(pk=digest, grant=grant).exists():
                    grant.revoked_at = now
                    grant.save(update_fields=["revoked_at"])
            else:
                McpOAuthRefreshDigest.objects.create(digest=digest, grant=grant, expires_at=grant.refresh_expires_at)
                access, refresh = "mero_at_" + secrets.token_urlsafe(32), "mero_rt_" + secrets.token_urlsafe(32)
                grant.access_token_digest, grant.refresh_token_digest = _digest(access), _digest(refresh)
                grant.access_expires_at = min(now + timedelta(hours=1), grant.refresh_expires_at)
                grant.save(update_fields=["access_token_digest", "refresh_token_digest", "access_expires_at"])
                result = _tokens(grant, access, refresh)
    if result is None:
        raise OAuthError("invalid_grant")
    return result


@sensitive_variables()
def authenticate_access_token(raw, *, network=None, enforce_limits=True):
    if not isinstance(raw, str) or not raw.startswith("mero_at_") or len(raw) > 256:
        return None
    now = timezone.now()
    grant = McpOAuthGrant.objects.select_related("user", "client").filter(access_token_digest=_digest(raw),
        revoked_at__isnull=True, access_expires_at__gt=now, refresh_expires_at__gt=now,
        scope=MCP_SCOPE, resource__in=trusted_resources(), user__is_active=True).first()
    if grant is None:
        return None
    # SDK ingress supplies its trusted network when available; account/grant
    # budgets always apply even when called independently of that adapter.
    if enforce_limits:
        rate_limit("tool", network or f"grant:{grant.id}", user_id=grant.user_id, grant_id=grant.id)
    McpOAuthGrant.objects.filter(pk=grant.pk).filter(Q(last_used_at__isnull=True) | Q(last_used_at__lt=now - timedelta(minutes=5))).update(last_used_at=now)
    return grant.user, grant


@sensitive_variables()
def revoke_token(data, network):
    rate_limit("revoke", network)
    client = _client(data.get("client_id"))
    digest = _digest(_text(data.get("token"), 256))
    # Unknown tokens succeed without revealing another client's connection.
    query = Q(access_token_digest=digest) | Q(refresh_token_digest=digest) | Q(mcpoauthrefreshdigest__digest=digest)
    McpOAuthGrant.objects.filter(query, client=client, revoked_at__isnull=True).update(revoked_at=timezone.now())


def connected_agents(actor):
    if not actor.is_authenticated or not get_user_model().objects.filter(pk=actor.pk, is_active=True).exists():
        raise OAuthError("access_denied", 401)
    return {"connections": [{"id": str(row.id), "client_name": row.client.name, "created_at": row.created_at.isoformat(),
                             "last_used_at": row.last_used_at.isoformat() if row.last_used_at else None}
                            for row in McpOAuthGrant.objects.filter(user=actor, revoked_at__isnull=True, refresh_expires_at__gt=timezone.now())
                            .select_related("client").order_by("-created_at", "-id")[:50]]}


def disconnect_agent(actor, grant_id):
    if not actor.is_authenticated:
        raise OAuthError("access_denied", 401)
    with transaction.atomic():
        user = get_user_model().objects.select_for_update(no_key=True).filter(pk=actor.pk, is_active=True).first()
        if not user:
            raise OAuthError("access_denied", 401)
        # Owner-scoped update is deliberately idempotent, including an unknown ID.
        McpOAuthGrant.objects.filter(pk=grant_id, user=user, revoked_at__isnull=True).update(revoked_at=timezone.now())
    return {"revoked": True}


def pending_authorization(request):
    actor = getattr(request, "auth", None) or request.user
    if not actor.is_authenticated or not actor.is_active:
        raise OAuthError("access_denied", 401)
    value = request.session.get(MCP_PENDING_SESSION_KEY)
    try:
        row = get_pending(value)
    except OAuthError:
        request.session.pop(MCP_PENDING_SESSION_KEY, None)
        return {"authorization_url": None}
    return {"authorization_url": f"/oauth/authorize?request={row.id}"}
