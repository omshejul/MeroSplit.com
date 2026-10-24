from hashlib import sha256

from config.web import public_asset
from django.conf import settings
from django.test import Client, RequestFactory


def test_public_font_is_offline_bundled_and_matches_the_native_asset():
    response = Client().get("/assets/fonts/StackSansText.ttf")
    data = b"".join(response.streaming_content)
    native = settings.BASE_DIR.parent / "mobile/assets/fonts/StackSansText.ttf"
    assert response.status_code == 200 and response["Content-Type"] == "font/ttf"
    assert response["Cross-Origin-Resource-Policy"] == "same-origin"
    assert response["Cache-Control"] == "no-cache"
    assert data == native.read_bytes()
    assert sha256(data).hexdigest() == "6a9be24c1371f9344d5b1f243a08928e6324a6426e9f3b3716a7936ae4751256"
    license_text = (settings.BASE_DIR / "ledger/assets/OFL-StackSansText.txt").read_text()
    assert "SIL OPEN FONT LICENSE Version 1.1" in license_text


def test_public_asset_has_only_local_urls_and_keeps_glyph_fallbacks():
    response = Client().get("/assets/typography.css")
    css = b"".join(response.streaming_content).decode()
    assert response.status_code == 200 and response["Content-Type"].startswith("text/css")
    assert 'url("/assets/fonts/StackSansText.ttf")' in css
    assert 'font-weight: 200 700' in css and 'system-ui, sans-serif' in css
    assert "http" not in css and "* {" not in css
    for template in (settings.BASE_DIR / "ledger/templates/ledger").glob("*.html"):
        assert 'href="/assets/typography.css"' in template.read_text(), template.name
    assert public_asset(RequestFactory().get("/"), "../../config/settings.py").status_code == 404
    assert Client().get("/assets/fonts/OFL-StackSansText.txt").status_code == 404
