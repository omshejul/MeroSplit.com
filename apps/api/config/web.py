"""Same-origin Expo shell, immutable build assets and authorized browser media."""

import mimetypes
import os
import re
from pathlib import Path
from urllib.error import URLError
from urllib.parse import quote
from urllib.request import urlopen

from django.conf import settings
from django.http import FileResponse, HttpResponse, HttpResponseRedirect, JsonResponse, StreamingHttpResponse
from django.views.decorators.csrf import ensure_csrf_cookie
from django.views.decorators.http import require_safe
from ledger.media import download_url
from ledger.models import UploadedFile
from ninja.errors import HttpError


def _headers(response):
    response["Cross-Origin-Opener-Policy"] = "same-origin"
    response["Cross-Origin-Embedder-Policy"] = "require-corp"
    response["Cross-Origin-Resource-Policy"] = "same-origin"
    response["X-Content-Type-Options"] = "nosniff"
    return response


@ensure_csrf_cookie
def _shell(request, index):
    response = FileResponse(index.open("rb"), content_type="text/html; charset=utf-8")
    response["Cache-Control"] = "no-store" if request.path.startswith("/app/sign-in/") else "no-cache"
    response["Referrer-Policy"] = "same-origin"
    return _headers(response)


def web_app(request, path=""):
    root = Path(os.environ.get("MEROSPLIT_WEB_ROOT", settings.BASE_DIR / "web-dist")).resolve()
    requested = (root / path).resolve()
    if not requested.is_relative_to(root):
        return HttpResponse(status=404)
    if requested.is_file() and requested.name != "index.html":
        kind = "application/wasm" if requested.suffix == ".wasm" else mimetypes.guess_type(requested.name)[0] or "application/octet-stream"
        response = FileResponse(requested.open("rb"), content_type=kind)
        hashed = bool(re.search(r"[a-f0-9]{16,}", requested.name))
        response["Cache-Control"] = "public, max-age=31536000, immutable" if hashed else "no-cache"
        return _headers(response)
    if Path(path).suffix and not path.endswith("index.html"):
        return HttpResponse(status=404)
    index = root / "index.html"
    if not index.is_file():
        return HttpResponse("MeroSplit web is being prepared. Please try again shortly.", status=503)
    return _shell(request, index)


def web_media(request, file_id):
    if not request.user.is_authenticated:
        return JsonResponse({"detail": "Sign in to open this file."}, status=401)
    try:
        link = download_url(request.user, file_id)
    except HttpError as error:
        return JsonResponse({"detail": str(error)}, status=error.status_code)
    metadata = UploadedFile.objects.filter(id=file_id, state="active").first()
    if not metadata:
        return HttpResponse(status=404)
    try:
        upstream = urlopen(link["url"], timeout=20)
    except (OSError, URLError):
        return JsonResponse({"detail": "Could not open this file. Try again."}, status=503)

    def chunks():
        remaining = 20 * 1024 * 1024
        try:
            while remaining:
                chunk = upstream.read(min(65536, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk
        finally:
            upstream.close()

    response = StreamingHttpResponse(chunks(), content_type=metadata.content_type)
    response["Content-Disposition"] = f"inline; filename=\"file{Path(metadata.name).suffix}\"; filename*=UTF-8''{quote(metadata.name, safe='')}"
    response["Cache-Control"] = "private, no-store"
    return _headers(response)


def invite_app(request, token):
    response = HttpResponseRedirect("/app/invite/" + quote(token, safe=""))
    response["Cache-Control"] = "no-store"
    response["Referrer-Policy"] = "no-referrer"
    return response


APP_STORE_URL = "https://apps.apple.com/app/merosplit/id6823916128"
GOOGLE_PLAY_URL = "https://play.google.com/store/apps/details?id=com.omshejul.splitdumb"


@require_safe
def install(request):
    """Send a phone to its store. iPadOS in desktop mode, computers and crawlers get the home page's install
    choices, as does Android until the Play listing is public, so its testing steps stay reachable."""
    agent = request.headers.get("User-Agent", "")
    if re.search(r"iPhone|iPad|iPod", agent):
        target = APP_STORE_URL
    elif "Android" in agent and settings.GOOGLE_PLAY_PUBLIC:
        target = GOOGLE_PLAY_URL
    else:
        target = "/?install=1#install"
    response = HttpResponseRedirect(target)
    response["Cache-Control"] = "no-store"
    response["Vary"] = "User-Agent"
    return response


def public_asset(request, asset):
    files = {"group-join.png": "image/png", "play-become-tester.png": "image/png", "install.js": "text/javascript; charset=utf-8", "install-qr.svg": "image/svg+xml", "download-on-the-app-store.svg": "image/svg+xml", "get-it-on-google-play.png": "image/png", "try-on-iphone.svg": "image/svg+xml", "try-on-android.svg": "image/svg+xml", "typography.css": "text/css; charset=utf-8", "StackSansText.ttf": "font/ttf", "home.css": "text/css; charset=utf-8", "landing.css": "text/css; charset=utf-8", "landing.js": "text/javascript; charset=utf-8", "mascot.png": "image/png", "icons.svg": "image/svg+xml", "merosplit-icon.png": "image/png", "merosplit-logo.svg": "image/svg+xml", "favicon.png": "image/png", "apple-touch-icon.png": "image/png"}
    if asset not in files:
        return HttpResponse(status=404)
    path = settings.BASE_DIR / "ledger" / "assets" / asset
    if not path.is_file():
        return HttpResponse(status=404)
    response = FileResponse(path.open("rb"), content_type=files[asset])
    response["Cache-Control"] = "no-cache"
    return _headers(response)
