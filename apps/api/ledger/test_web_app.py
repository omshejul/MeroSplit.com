import io
from uuid import uuid4

import pytest
from config import web
from django.contrib.auth import get_user_model
from django.test import Client

from ledger.models import UploadedFile

pytestmark = pytest.mark.django_db


@pytest.fixture
def exported_app(tmp_path, monkeypatch):
    root = tmp_path / "web-dist"
    root.mkdir()
    (root / "index.html").write_text("<!doctype html><title>MeroSplit</title><div id='root'></div>")
    (root / "bundle-0123456789abcdef.js").write_text("globalThis.appStarted=true;")
    (root / "sqlite.wasm").write_bytes(b"\x00asm")
    (root / "sw.js").write_text("// private API records are never cached")
    monkeypatch.setenv("MEROSPLIT_WEB_ROOT", str(root))
    return root


def body(response):
    return b"".join(response.streaming_content) if response.streaming else response.content


def test_same_origin_shell_deep_links_csrf_and_isolated_sqlite_assets(exported_app):
    browser = Client(enforce_csrf_checks=True)
    for path in ["/app/", f"/app/groups/{uuid4()}/bills/{uuid4()}"]:
        response = browser.get(path)
        assert response.status_code == 200 and b"MeroSplit" in body(response)
        assert response["Cross-Origin-Opener-Policy"] == "same-origin"
        assert response["Cross-Origin-Embedder-Policy"] == "require-corp"
        assert response["Cache-Control"] == "no-cache"
    assert "csrftoken" in browser.cookies
    script = browser.get("/app/bundle-0123456789abcdef.js")
    assert script.status_code == 200 and script["Cache-Control"].endswith("immutable")
    assert browser.get("/app/sqlite.wasm")["Content-Type"] == "application/wasm"
    assert browser.get("/app/sw.js")["Cache-Control"] == "no-cache"
    assert browser.get("/app/missing.js").status_code == 404
    assert browser.get("/app/../../config/settings.py").status_code == 404
    assert browser.get("/api/v1/groups").status_code == 401
    assert browser.post("/_allauth/browser/v1/auth/code/request", data='{"email":"synthetic@example.test"}', content_type="application/json").status_code == 403


def test_browser_media_is_authorized_same_origin_no_store_and_never_redirects(exported_app, monkeypatch):
    user = get_user_model().objects.create_user(username=str(uuid4()), email="media@example.test")
    other = get_user_model().objects.create_user(username=str(uuid4()), email="other@example.test")
    file = UploadedFile.objects.create(avatar_owner=user, uploaded_by=user, object_key="synthetic/avatar.jpg", source_hash="a" * 64, name="Avatar.jpg", content_type="image/jpeg", size=4, state="active")
    calls = []

    class Storage:
        def generate_presigned_url(self, *args, **kwargs):
            return "https://private.example.invalid/synthetic"

    monkeypatch.setattr("ledger.media._storage", lambda: Storage())
    monkeypatch.setattr(web, "urlopen", lambda url, timeout: calls.append(url) or io.BytesIO(b"jpeg"))
    browser = Client()
    assert browser.get(f"/app/media/{file.id}").status_code == 401
    browser.force_login(other)
    assert browser.get(f"/app/media/{file.id}").status_code == 404
    assert not calls
    browser.force_login(user)
    response = browser.get(f"/app/media/{file.id}")
    assert response.status_code == 200 and body(response) == b"jpeg"
    assert response["Cache-Control"] == "private, no-store"
    assert response["Cross-Origin-Resource-Policy"] == "same-origin"
    assert response["Content-Type"] == "image/jpeg"
    assert "Location" not in response
    file.state = "deleted"
    file.save(update_fields=["state"])
    assert browser.get(f"/app/media/{file.id}").status_code == 404
    assert len(calls) == 1


@pytest.mark.parametrize("path", ["auth/login", "auth/signup", "auth/password/request", "account/password/change", "account/email", "auth/reauthenticate"])
def test_old_password_and_alternate_identity_mutations_are_blocked(path):
    response = Client().post(f"/_allauth/app/v1/{path}", data="{}", content_type="application/json")
    assert response.status_code == 403
    assert response.json()["errors"][0]["message"] == "Use an email code to sign in."


def test_stale_browser_account_cannot_write_or_sign_out_another_account():
    first = get_user_model().objects.create_user(username=str(uuid4()), email="first@example.test")
    second = get_user_model().objects.create_user(username=str(uuid4()), email="second@example.test")
    browser = Client()
    browser.force_login(second)
    stale = {"HTTP_X_MEROSPLIT_ACCOUNT": str(first.pk)}
    assert browser.post("/api/v1/groups", data="{}", content_type="application/json", **stale).status_code == 401
    assert browser.delete("/_allauth/browser/v1/auth/session", **stale).status_code == 401
    assert browser.get("/api/v1/me", HTTP_X_MEROSPLIT_ACCOUNT=str(second.pk)).json()["id"] == second.pk


def test_cookie_authenticated_mutations_require_current_csrf(exported_app):
    user = get_user_model().objects.create_user(username=str(uuid4()), email="csrf@example.test")
    browser = Client(enforce_csrf_checks=True)
    browser.force_login(user)
    browser.get("/app/")
    assert browser.post("/api/v1/groups", data="{}", content_type="application/json").status_code == 403
    csrf = browser.cookies["csrftoken"].value
    # Validation is reached only with the valid same-origin CSRF token.
    assert browser.post("/api/v1/groups", data="{}", content_type="application/json", HTTP_X_CSRFTOKEN=csrf).status_code == 422
    assert browser.delete("/_allauth/browser/v1/auth/session").status_code == 403
    assert browser.get("/api/v1/me").status_code == 200


def test_email_entry_get_head_and_prefetch_only_serve_uncached_private_shell(exported_app):
    browser = Client(enforce_csrf_checks=True)
    path = f"/app/sign-in/{uuid4()}"
    for method in ["get", "head"]:
        response = getattr(browser, method)(path, HTTP_PURPOSE="prefetch", HTTP_SEC_PURPOSE="prefetch")
        assert response.status_code == 200
        assert response["Content-Type"] == "text/html; charset=utf-8"
        assert response["Cache-Control"] == "no-store"
        assert response["Referrer-Policy"] == "no-referrer"
        assert "Location" not in response
        response.close()
    assert "csrftoken" in browser.cookies
    assert "sessionid" not in browser.cookies
    assert browser.get("/api/v1/me").status_code == 401


@pytest.mark.parametrize("path", ["/.well-known/apple-app-site-association", "/.well-known/assetlinks.json"])
def test_verified_app_associations_are_direct_public_json_for_get_and_head(path):
    browser = Client(enforce_csrf_checks=True)
    response = browser.get(path)
    assert response.status_code == 200
    assert response["Content-Type"] == "application/json"
    assert response["Cache-Control"] == "public, max-age=300, must-revalidate"
    assert response["X-Content-Type-Options"] == "nosniff"
    assert "Location" not in response and "sessionid" not in browser.cookies
    if path.endswith("assetlinks.json"):
        target = response.json()[0]["target"]
        assert target["package_name"] == "com.omshejul.splitdumb"
        assert len(target["sha256_cert_fingerprints"]) == 3
        assert target["sha256_cert_fingerprints"][0].startswith("56:1A:")
        assert all(not fingerprint.startswith("A3:D5:") for fingerprint in target["sha256_cert_fingerprints"])
    else:
        details = response.json()["applinks"]["details"]
        assert details == [{"appIDs": ["M4K84L4TKR.com.omshejul.splitdumb"], "components": [
            {"/": "/app/sign-in/*"}, {"/": "/app/groups/*"},
            {"/": "/app/invite/*"}, {"/": "/invite/*"}, {"/": "/j/*"},
        ]}]
    head = browser.head(path)
    assert head.status_code == 200 and head.content == b""
    assert head["Content-Type"] == response["Content-Type"]
    assert browser.post(path, data="{}", content_type="application/json").status_code in [403, 405]
