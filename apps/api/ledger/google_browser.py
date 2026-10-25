"""Top-level GIS redirect pages; no SQLite, account cache, or new session owner."""
import json
import secrets

from django.conf import settings
from django.http import HttpResponseBadRequest
from django.shortcuts import render
from django.views.decorators.csrf import csrf_exempt, ensure_csrf_cookie
from django.views.decorators.debug import sensitive_post_parameters, sensitive_variables
from django.views.decorators.http import require_GET, require_POST

from .google_signin import valid_process


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


@require_GET
@ensure_csrf_cookie
def start(request):
    process = request.GET.get("process")
    account = request.GET.get("account", "")
    if (not settings.GOOGLE_SIGN_IN_ENABLED or not valid_process(request, process)
            or (process == "connect" and account != str(request.user.pk)) or (process == "login" and account)):
        return HttpResponseBadRequest("Google sign-in is unavailable. Return to MeroSplit and use email.")
    return page(request, {"process": process, "account": account, "clientId": settings.GOOGLE_OAUTH_WEB_CLIENT_ID})


@require_POST
@csrf_exempt
@ensure_csrf_cookie
@sensitive_post_parameters("credential", "g_csrf_token")
@sensitive_variables()
def callback(request):
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
