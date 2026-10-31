"""Django-owned OAuth HTTP parsing and cookie-authenticated consent."""

import json
from pathlib import Path

from django.core.exceptions import RequestDataTooBig
from django.http import FileResponse, HttpResponse, JsonResponse
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


def _device_user_code(request, row):
    if not row.device_secret_digest:
        return None
    code = request.session.get("mcp_device_user_code", "")
    if oauth._user_code_digest(code) != row.user_code_digest:
        raise oauth.OAuthError()
    return code


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
            device_user_code = _device_user_code(request, row)
            if not request.user.is_authenticated:
                return _redirect("/app/")
            if not request.user.is_active:
                raise oauth.OAuthError("access_denied", 403)
            if not request.user.first_name.strip() and not row.device_secret_digest:
                return _redirect("/app/")
            response = render(request, "ledger/mcp_authorize.html", {"authorization": row,
                "client_name": row.client.name, "account_name": request.user.first_name.strip() or request.user.email,
                "account_email": request.user.email, "expected_user_id": str(request.user.pk),
                "device_user_code": device_user_code})
            response["Cache-Control"] = "no-store"
            response["Referrer-Policy"] = "same-origin"
            response["Content-Security-Policy"] = "default-src 'none'; img-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'"
            return response
        if request.method != "POST":
            raise oauth.OAuthError(status=405)
        data = _body(request)
        if (set(data) - {"request", "expected_user_id", "decision", "csrfmiddlewaretoken"}
                or data.get("request") != request.session.get(oauth.MCP_PENDING_SESSION_KEY)
                or data.get("decision") not in {"allow", "cancel"}):
            raise oauth.OAuthError()
        _device_user_code(request, oauth.get_pending(data["request"]))
        redirect = oauth.decide_authorization(request.user, data["request"], approved=data["decision"] == "allow",
            expected_user_id=data.get("expected_user_id"), network=client_network(request))
        request.session.pop(oauth.MCP_PENDING_SESSION_KEY, None)
        request.session.pop("mcp_device_user_code", None)
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


@csrf_exempt
@sensitive_post_parameters()
@sensitive_variables()
def device_start(request):
    if request.method != "POST":
        return _error(oauth.OAuthError(status=405))
    try:
        oauth.rate_limit("oauth-http", client_network(request))
        return _response(oauth.begin_device_authorization(_body(request), client_network(request)))
    except oauth.OAuthError as exc:
        return _error(exc)


@csrf_exempt
@sensitive_post_parameters()
@sensitive_variables()
def device_poll(request):
    if request.method != "POST":
        return _error(oauth.OAuthError(status=405))
    try:
        oauth.rate_limit("oauth-http", client_network(request))
        return _response(oauth.poll_device_authorization(_body(request), client_network(request)))
    except oauth.OAuthError as exc:
        return _error(exc)


@csrf_protect
@sensitive_post_parameters()
def device_page(request):
    if request.method not in {"GET", "POST"}:
        return _error(oauth.OAuthError(status=405))
    context, status = {}, 200
    try:
        oauth.rate_limit("oauth-http", client_network(request))
        if request.method == "POST":
            data = _body(request)
            code = data.get("user_code", "")
            context["user_code"] = code
            row = oauth.pending_device_code(code, client_network(request))
            request.session[oauth.MCP_PENDING_SESSION_KEY] = str(row.id)
            compact = code.replace("-", "").replace(" ", "").upper()
            request.session["mcp_device_user_code"] = compact[:4] + "-" + compact[4:]
            return _redirect("/mcp/device")
        if request.GET.get("done") == "1" or request.GET.get("cancelled") == "1":
            context["done"] = request.GET.get("done") == "1"
            context["cancelled"] = not context["done"]
        elif request.session.get("mcp_device_user_code"):
            row = oauth.get_pending(request.session.get(oauth.MCP_PENDING_SESSION_KEY))
            if not row.device_secret_digest:
                raise oauth.OAuthError()
            if request.user.is_authenticated:
                return _redirect(f"/oauth/authorize?request={row.id}")
            context["sign_in"] = True
    except oauth.OAuthError as exc:
        status = exc.status
        context["error"] = ("Too many attempts. Wait a few minutes before trying again." if status == 429 else
                            "This code is invalid or expired. Check it and try again, or start login again on your server.")
        request.session.pop("mcp_device_user_code", None)
        request.session.pop(oauth.MCP_PENDING_SESSION_KEY, None)
    response = render(request, "ledger/mcp_device.html", context, status=status)
    response["Cache-Control"] = "no-store"
    response["Referrer-Policy"] = "same-origin"
    response["Content-Security-Policy"] = "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
    return response


@require_GET
def device_asset(request, asset):
    files = {"login.py": ("mcp_remote_login.py", "text/x-python"),
             "device.js": ("assets/mcp-device.js", "text/javascript")}
    filename, content_type = files[asset]
    response = FileResponse((Path(__file__).parent / filename).open("rb"), content_type=content_type)
    response["Cache-Control"] = "no-cache"
    response["X-Content-Type-Options"] = "nosniff"
    return response
