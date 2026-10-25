"""Allauth Google code redirect plus the in-flight legacy GIS response bridge."""
import json
import secrets
import time
from urllib.parse import parse_qs, urlencode, urlsplit

import jwt
from allauth.headless.internal.decorators import browser_view
from allauth.socialaccount.adapter import get_adapter
from allauth.socialaccount.providers.google.views import GoogleOAuth2Adapter, _verify_and_decode
from allauth.socialaccount.providers.oauth2.client import OAuth2Error
from allauth.socialaccount.providers.oauth2.views import OAuth2CallbackView
from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import transaction
from django.http import HttpResponseBadRequest, HttpResponseRedirect
from django.shortcuts import render
from django.views.decorators.csrf import csrf_exempt, ensure_csrf_cookie
from django.views.decorators.debug import sensitive_post_parameters, sensitive_variables
from django.views.decorators.http import require_http_methods, require_POST

from .google_signin import CHALLENGE, TTL, consume_challenge, prepare_google_identity, valid_process
from .otp import EmailCodeLimited, client_network, consume_limits
from .store_review import entry_for_email


def page(request, data):
    nonce = secrets.token_hex(16)
    response = render(request, "ledger/google_signin.html", {"data": data, "script_nonce": nonce})
    response["Cache-Control"] = "no-store"
    response["Referrer-Policy"] = "no-referrer" if "credential" in data else "strict-origin-when-cross-origin"
    response["X-Frame-Options"] = "DENY"
    # This small auth document has no SQLite/SharedArrayBuffer. App headers stay intact.
    response["Content-Security-Policy"] = (
        f"default-src 'none'; script-src 'nonce-{nonce}' https://accounts.google.com/gsi/client; "
        "connect-src 'self' https://accounts.google.com/gsi/; frame-src https://accounts.google.com/gsi/; "
        "style-src 'unsafe-inline' https://accounts.google.com/gsi/style; img-src https://accounts.google.com; "
        "base-uri 'none'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'"
    )
    return response


@require_POST
@csrf_exempt
@ensure_csrf_cookie
@sensitive_post_parameters("credential", "g_csrf_token")
@sensitive_variables()
def legacy_callback(request):
    # Google's redirect POST cannot depend on a Lax session cookie. It only renders
    # a no-store bridge; a subsequent same-origin CSRF-protected request uses the
    # original session and atomically consumes its signed-token nonce.
    data = request.POST
    if request.content_type == "application/json":
        try:
            data = json.loads(request.body) if len(request.body) <= 32768 else None
        except ValueError:
            data = None
    if not isinstance(data, dict):
        return HttpResponseBadRequest("Invalid Google sign-in response.")
    cookie = request.COOKIES.get("g_csrf_token", "")
    proof, credential, process = data.get("g_csrf_token", ""), data.get("credential", ""), data.get("state")
    if (not all(isinstance(value, str) for value in [proof, credential, process])
            or not settings.GOOGLE_SIGN_IN_ENABLED or not cookie or len(cookie) > 1024
            or len(proof) > 1024 or not secrets.compare_digest(cookie.encode(), proof.encode()) or process not in {"login", "connect"}
            or not 1 <= len(credential) <= 16384):
        return HttpResponseBadRequest("Could not confirm Google sign-in. Return to MeroSplit and try again.")
    return page(request, {"process": process, "credential": credential})


def browser_origin_allowed(request):
    return request.build_absolute_uri("/").rstrip("/") in {
        settings.PUBLIC_WEB_URL.rstrip("/"), "https://merosplit.com", "https://merosplit.omshejul.com",
    }


def returned(error=None, account=False):
    query = {**({"google_error": error} if error else {}), **({"google_return": "connect"} if account else {})}
    response = HttpResponseRedirect("/app/" + ("?" + urlencode(query) if query else ""))
    response["Cache-Control"] = "no-store"
    response["Referrer-Policy"] = "no-referrer"
    return response


@require_POST
@sensitive_variables()
def start(request):
    process, account = request.POST.get("process"), request.POST.get("account", "")
    if (not settings.GOOGLE_SIGN_IN_ENABLED or not settings.GOOGLE_OAUTH_WEB_CLIENT_SECRET
            or not browser_origin_allowed(request) or not valid_process(request, process)
            or (process == "connect" and (account != str(request.user.pk) or entry_for_email(request.user.email)))
            or (process == "login" and account)
            or set(request.POST) - {"process", "account", "csrfmiddlewaretoken"}):
        return returned("unavailable")
    try:
        with transaction.atomic():
            consume_limits([("google-challenge-network", client_network(request), 60, 10),
                            ("google-challenge-network", client_network(request), 3600, 100)])
    except EmailCodeLimited:
        return returned("unavailable")
    nonce = secrets.token_hex(32)
    actor = request.user.pk if request.user.is_authenticated else None
    request.session[CHALLENGE] = {"nonce": nonce, "expires_at": int(time.time()) + TTL, "process": process, "actor": actor}
    request.session.save()
    provider = get_adapter(request).get_provider(request, "google", client_id=settings.GOOGLE_OAUTH_WEB_CLIENT_ID)
    # Supported allauth owns OAuth state, PKCE, code exchange and final session.
    return provider.redirect(request, process, next_url="/app/?google_return=connect" if process == "connect" else "/app/", headless=True,
                             data={"actor": actor, "nonce": nonce},
                             auth_params={"nonce": nonce, "prompt": "select_account", "access_type": "online"})


class GoogleCodeAdapter(GoogleOAuth2Adapter):
    def _decode_id_token(self, app, id_token):
        # Retain signature verification even for the server-to-server code flow.
        return _verify_and_decode(app, id_token, verify_signature=True)

    @sensitive_variables()
    def complete_login(self, request, app, token, **kwargs):
        try:
            credential = kwargs["response"].get("id_token")
            if (not isinstance(credential, str) or not 1 <= len(credential) <= 16384
                    or jwt.get_unverified_header(credential).get("alg") != "RS256"):
                raise ValidationError("Invalid Google credential")
            login = super().complete_login(request, app, token, **kwargs)
            prepare_google_identity(request, login, request.google_browser_process)
            return login
        except (ValidationError, jwt.PyJWTError, KeyError, TypeError, ValueError) as exc:
            raise OAuth2Error("Invalid Google identity") from exc


class GoogleCodeCallbackView(OAuth2CallbackView):
    @sensitive_variables()
    def _get_state(self, request, provider):
        state, response = super()._get_state(request, provider)
        if response:
            return state, response
        data, challenge = state.get("data"), request.session.get(CHALLENGE, {})
        if (not isinstance(data, dict) or not browser_origin_allowed(request)
                or not valid_process(request, state.get("process"))
                or data.get("actor") != (request.user.pk if request.user.is_authenticated else None)
                or data.get("nonce") != challenge.get("nonce")):
            return None, returned("account_changed")
        try:
            # Atomic one-use DB fence before exchanging a code, including cancel.
            consume_challenge(request, {"nonce": data.get("nonce")}, state["process"])
        except ValidationError:
            return None, returned("unavailable")
        request.google_browser_nonce = data["nonce"]
        request.google_browser_process = state["process"]
        return state, None


@require_http_methods(["GET", "POST"])
@csrf_exempt
@browser_view
@sensitive_variables()
def callback(request):
    if request.method == "POST":
        # Keep already-issued legacy GIS responses usable during rollout. New
        # browser initiation never renders that page or requests a second click.
        return legacy_callback(request)
    if (not settings.GOOGLE_SIGN_IN_ENABLED or not browser_origin_allowed(request)
            or len(request.GET.get("code", "")) > 4096 or len(request.GET.get("state", "")) > 256):
        return returned("unavailable")
    response = GoogleCodeCallbackView.adapter_view(GoogleCodeAdapter)(request)
    if response.status_code >= 400:
        try:
            code = json.loads(response.content).get("errors", [{}])[0].get("code")
        except (ValueError, IndexError, AttributeError):
            code = None
        return returned("conflict" if code == "google_email_conflict" else "unavailable", getattr(request, "google_browser_process", None) == "connect")
    error = parse_qs(urlsplit(response.get("Location", "")).query).get("error", [None])[0]
    if response.get("Location", "").startswith("/app/?google_error="):
        return response
    return returned("cancelled" if error == "cancelled" else "unavailable" if error else None, getattr(request, "google_browser_process", None) == "connect")
