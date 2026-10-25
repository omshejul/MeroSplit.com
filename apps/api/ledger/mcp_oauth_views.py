"""Django-owned OAuth HTTP parsing and cookie-authenticated consent."""

import json

from django.core.exceptions import RequestDataTooBig
from django.http import HttpResponse, JsonResponse
from django.shortcuts import render
from django.utils.encoding import iri_to_uri
from django.views.decorators.csrf import csrf_exempt, csrf_protect
from django.views.decorators.debug import sensitive_post_parameters, sensitive_variables
from django.views.decorators.http import require_GET

from . import mcp_oauth as oauth
from .otp import client_network

MAX_BODY = 16384


def _response(data, status=200, *, public=False):
    response = JsonResponse(data, status=status)
    response["Cache-Control"] = "public, max-age=3600" if public else "no-store"
    response["Pragma"] = "no-cache"
    response["Access-Control-Allow-Origin"] = "*"
    return response


def _error(exc):
    response = _response({"error": exc.error, "error_description": "Unable to complete this OAuth request. Connect again from your client."}, exc.status)
    if exc.status == 429:
        response["Retry-After"] = "60"
    return response


def _options():
    response = _response({}, 200)
    response["Access-Control-Allow-Methods"] = "POST, OPTIONS"
    response["Access-Control-Allow-Headers"] = "Content-Type"
    return response


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise oauth.OAuthError()
        result[key] = value
    return result


@sensitive_variables()
def _body(request, *, json_body=False):
    try:
        if int(request.META.get("CONTENT_LENGTH") or 0) > MAX_BODY or len(request.body) > MAX_BODY:
            raise oauth.OAuthError()
        if json_body:
            if request.content_type != "application/json":
                raise oauth.OAuthError()
            data = json.loads(request.body, object_pairs_hook=_pairs)
            if not isinstance(data, dict):
                raise oauth.OAuthError()
            return data
        if request.content_type != "application/x-www-form-urlencoded":
            raise oauth.OAuthError()
        return _query(request.POST)
    except (ValueError, UnicodeError, RecursionError, RequestDataTooBig):
        raise oauth.OAuthError() from None


def _query(params):
    if any(len(values) != 1 for _, values in params.lists()):
        raise oauth.OAuthError()
    return params.dict()


@require_GET
def metadata(request):
    origin = oauth.issuer_url()
    return _response({"issuer": origin, "authorization_endpoint": f"{origin}/oauth/authorize",
        "token_endpoint": f"{origin}/oauth/token", "registration_endpoint": f"{origin}/oauth/register",
        "revocation_endpoint": f"{origin}/oauth/revoke", "scopes_supported": [oauth.MCP_SCOPE],
        "response_types_supported": ["code"], "grant_types_supported": ["authorization_code", "refresh_token"],
        "token_endpoint_auth_methods_supported": ["none"], "code_challenge_methods_supported": ["S256"],
        "authorization_response_iss_parameter_supported": True, "client_id_metadata_document_supported": False,
        "service_documentation": f"{origin}/mcp/setup"}, public=True)


@require_GET
def resource_metadata(request):
    return _response({"resource": oauth.resource_url(), "authorization_servers": [oauth.issuer_url()],
        "scopes_supported": [oauth.MCP_SCOPE], "bearer_methods_supported": ["header"],
        "resource_documentation": f"{oauth.issuer_url()}/mcp/setup"}, public=True)


@csrf_exempt
@sensitive_post_parameters()
def register(request):
    if request.method == "OPTIONS":
        return _options()
    if request.method != "POST":
        return _error(oauth.OAuthError(status=405))
    try:
        oauth.rate_limit("oauth-http", client_network(request))
        return _response(oauth.register_client(_body(request, json_body=True), client_network(request)), 201)
    except oauth.OAuthError as exc:
        return _error(exc)


def _redirect(url):
    response = HttpResponse(status=302)
    response["Location"] = iri_to_uri(url)
    response["Cache-Control"] = "no-store"
    response["Referrer-Policy"] = "no-referrer"
    return response


@csrf_protect
@sensitive_post_parameters()
def authorize(request):
    try:
        oauth.rate_limit("oauth-http", client_network(request))
        if request.method == "GET":
            if len(request.META.get("QUERY_STRING", "")) > MAX_BODY:
                raise oauth.OAuthError()
            data = _query(request.GET)
            if "request" not in data:
                row = oauth.begin_authorization(data, client_network(request))
                request.session[oauth.MCP_PENDING_SESSION_KEY] = str(row.id)
                return _redirect(f"/oauth/authorize?request={row.id}" if request.user.is_authenticated else "/app/")
            if set(data) != {"request"} or data["request"] != request.session.get(oauth.MCP_PENDING_SESSION_KEY):
                raise oauth.OAuthError()
            row = oauth.get_pending(data["request"])
            if not request.user.is_authenticated:
                return _redirect("/app/")
            if not request.user.is_active:
                raise oauth.OAuthError("access_denied", 403)
            if not request.user.first_name.strip():
                return _redirect("/app/")
            response = render(request, "ledger/mcp_authorize.html", {"authorization": row,
                "client_name": row.client.name, "account_name": request.user.first_name.strip() or request.user.email,
                "account_email": request.user.email, "expected_user_id": str(request.user.pk)})
            response["Cache-Control"] = "no-store"
            response["Referrer-Policy"] = "same-origin"
            response["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
            return response
        if request.method != "POST":
            raise oauth.OAuthError(status=405)
        data = _body(request)
        if (set(data) - {"request", "expected_user_id", "decision", "csrfmiddlewaretoken"}
                or data.get("request") != request.session.get(oauth.MCP_PENDING_SESSION_KEY)
                or data.get("decision") not in {"allow", "cancel"}):
            raise oauth.OAuthError()
        redirect = oauth.decide_authorization(request.user, data["request"], approved=data["decision"] == "allow",
            expected_user_id=data.get("expected_user_id"), network=client_network(request))
        request.session.pop(oauth.MCP_PENDING_SESSION_KEY, None)
        return _redirect(redirect)
    except oauth.OAuthError as exc:
        return _error(exc)


@csrf_exempt
@sensitive_post_parameters()
@sensitive_variables()
def token(request):
    if request.method == "OPTIONS":
        return _options()
    if request.method != "POST":
        return _error(oauth.OAuthError(status=405))
    try:
        oauth.rate_limit("oauth-http", client_network(request))
        data = _body(request)
        if "client_secret" in data or request.headers.get("Authorization"):
            raise oauth.OAuthError("invalid_client")
        kind = data.get("grant_type")
        if kind == "authorization_code":
            result = oauth.exchange_code(data, client_network(request))
        elif kind == "refresh_token":
            result = oauth.exchange_refresh(data, client_network(request))
        else:
            raise oauth.OAuthError("unsupported_grant_type")
        return _response(result)
    except oauth.OAuthError as exc:
        return _error(exc)


@csrf_exempt
@sensitive_post_parameters()
@sensitive_variables()
def revoke(request):
    if request.method == "OPTIONS":
        return _options()
    if request.method != "POST":
        return _error(oauth.OAuthError(status=405))
    try:
        oauth.rate_limit("oauth-http", client_network(request))
        data = _body(request)
        if "client_secret" in data or request.headers.get("Authorization"):
            raise oauth.OAuthError("invalid_client")
        oauth.revoke_token(data, client_network(request))
        return _response({})
    except oauth.OAuthError as exc:
        return _error(exc)
