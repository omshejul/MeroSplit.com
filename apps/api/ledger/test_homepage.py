"""The public root must work for a crawler before the Expo app is exported."""

from html.parser import HTMLParser
from xml.etree import ElementTree

import pytest
from config.associations import ANDROID_ASSOCIATION, APPLE_ASSOCIATION
from config.web import public_asset
from django.conf import settings
from django.test import Client, RequestFactory


class Document(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.tags, self.links, self.meta, self.text, self.scripts = [], [], {}, [], []
        self.in_main = False
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        self.tags.append(tag)
        if tag == "main":
            self.in_main = True
        if tag == "a":
            self.links.append(attrs.get("href", ""))
        if tag == "link" and attrs.get("rel") == "canonical":
            self.meta.setdefault("canonical", []).append(attrs.get("href"))
        if tag == "meta":
            self.meta[attrs.get("property", attrs.get("name"))] = attrs.get("content", "")
        if tag == "script":
            self.scripts.append(attrs)

    def handle_endtag(self, tag):
        if tag == "main":
            self.in_main = False

    def handle_data(self, data):
        if self.in_main:
            self.text.append(data)


def test_crawler_gets_real_homepage_and_head_without_javascript_or_an_app_export(tmp_path, monkeypatch):
    monkeypatch.setenv("MEROSPLIT_WEB_ROOT", str(tmp_path / "absent-web-export"))
    browser = Client(HTTP_USER_AGENT="Googlebot")
    response = browser.get("/")
    assert response.status_code == 200 and "Location" not in response
    assert response["Content-Type"].startswith("text/html")
    page = Document(response.content.decode())
    assert page.tags.count("main") == 1 and page.tags.count("h1") == 1
    assert page.tags.count("figure") == 2 and "Shared bills." in " ".join(page.text)
    assert "Illustrative example" in " ".join(page.text)
    assert "table" not in page.tags
    assert len(" ".join(page.text).split()) <= 150
    assert "/app/" in page.links and {"/privacy", "/support"}.issubset(page.links)
    assert [script.get("src") for script in page.scripts if script.get("type") != "application/ld+json"] == []
    assert "<div id=\"root\"" not in response.content.decode()
    assert page.meta["canonical"] == ["https://merosplit.com/"]
    assert page.meta["og:url"] == "https://merosplit.com/"
    assert page.meta["og:type"] == "website" and "MeroSplit" in page.meta["og:title"]
    assert len(page.meta["description"]) >= 50
    assert page.meta["og:image"] == "https://merosplit.com/assets/merosplit-icon.png"
    assert browser.head("/").status_code == 200
    assert browser.post("/").status_code == 405
    assert browser.get("/app/").status_code == 503, "the public homepage does not depend on the app bundle"


def test_public_crawl_hints_list_canonical_pages_and_exclude_private_app_routes():
    browser = Client()
    robots = browser.get("/robots.txt")
    assert robots.status_code == 200 and robots["Content-Type"].startswith("text/plain")
    text = robots.content.decode()
    assert "Sitemap: https://merosplit.com/sitemap.xml" in text
    for private in ["/app/", "/api/", "/_allauth/", "/oauth/", "/invite/", "/bill-email/"]:
        assert f"Disallow: {private}" in text
    sitemap = browser.get("/sitemap.xml")
    assert sitemap.status_code == 200 and sitemap["Content-Type"].startswith("application/xml")
    urls = ElementTree.fromstring(sitemap.content)
    links = [node.text for node in urls.findall(".//{http://www.sitemaps.org/schemas/sitemap/0.9}loc")]
    assert "https://merosplit.com/" in links and len(links) == len(set(links))
    assert not any("/app/" in link or "_allauth" in link or "/oauth/" in link for link in links)
    for link in links:
        response = browser.get(link.removeprefix("https://merosplit.com"))
        assert response.status_code == 200


def test_brand_assets_are_exact_existing_images_and_unknown_paths_are_not_served():
    browser = Client()
    for public, native in [("merosplit-icon.png", "icon.png"), ("favicon.png", "favicon.png"), ("apple-touch-icon.png", None), ("merosplit-logo.svg", "brand/merosplit-logo.svg")]:
        response = browser.get(f"/assets/{public}")
        assert response.status_code == 200 and response["Content-Type"] == ("image/svg+xml" if public.endswith(".svg") else "image/png")
        assert response["X-Content-Type-Options"] == "nosniff"
        expected = settings.BASE_DIR.parent / "mobile/assets" / native if native else settings.BASE_DIR / "ledger/assets" / public
        assert b"".join(response.streaming_content) == expected.read_bytes()
    assert public_asset(RequestFactory().get("/"), "../config/settings.py").status_code == 404
    assert browser.get("/assets/missing.js").status_code == 404


@pytest.mark.django_db
def test_homepage_does_not_take_over_existing_app_legal_association_or_invitation_routes(tmp_path, monkeypatch):
    root = tmp_path / "web-dist"
    root.mkdir()
    (root / "index.html").write_text("<!doctype html><title>Existing MeroSplit app</title>")
    monkeypatch.setenv("MEROSPLIT_WEB_ROOT", str(root))
    browser = Client()
    for path in ["/app/", "/app/groups/example", "/app/sign-in/example", "/app/invite/example"]:
        response = browser.get(path)
        assert response.status_code == 200 and b"Existing MeroSplit app" in b"".join(response.streaming_content)
        assert response["Cross-Origin-Embedder-Policy"] == "require-corp"
        response.close()
    assert browser.get("/invite/example")["Location"] == "/app/invite/example"
    for path in ["/privacy", "/chat-policy", "/support", "/delete-account"]:
        assert browser.get(path).status_code == 200
    assert browser.get("/.well-known/apple-app-site-association").json() == APPLE_ASSOCIATION
    assert browser.get("/.well-known/assetlinks.json").json() == ANDROID_ASSOCIATION
    assert browser.get("/api/v1/groups").status_code == 401


def test_install_intent_is_manual_safe_and_android_group_precedes_play(monkeypatch):
    from django.urls import resolve
    monkeypatch.setitem(resolve("/").func.view_initkwargs["extra_context"], "testing_links_ready", True)
    browser = Client()
    for ua in ["Googlebot", "iPhone", "Android", "Macintosh"]:
        response = browser.get("/?install=1", HTTP_USER_AGENT=ua)
        assert response.status_code == 200 and "Location" not in response
        html = response.content.decode()
        assert "Continue on web" in html and "https://testflight.apple.com/join/7HrHqqnB" in html
        assert html.index("https://groups.google.com/g/merosplit-beta") < html.index("https://play.google.com/apps/testing/com.omshejul.splitdumb")
        assert "Use the same Google account" in html and "cannot verify group membership" in html
    from hashlib import sha256
    for name, digest in [("try-on-iphone.svg", "b01a3c83b8dcde78a3b6c66d733a87507d74db44eae84d8d0b84cd04e89cd253"), ("try-on-android.svg", "235dc98ced6141c589fc655e064479f6719935b90ad04c1a785890226c9ed6fc")]:
        response = browser.get("/assets/" + name)
        assert response.status_code == 200
        assert sha256(b"".join(response.streaming_content)).hexdigest() == digest


def test_home_header_is_logo_only_with_help_links_in_footer():
    browser = Client()
    html = browser.get("/").content.decode()
    header = html.split("<header", 1)[1].split("</header>", 1)[0]
    footer = html.split("<footer", 1)[1].split("</footer>", 1)[0]
    assert '<a class="brand" href="/"' in header and "<nav" not in header
    for url in ["/support", "/privacy", "/chat-policy", "/delete-account"]:
        assert f'href="{url}"' in footer
    for url in ["/support", "/privacy", "/chat-policy", "/delete-account"]:
        response = browser.get(url)
        assert response.status_code == 200
        help_header = response.content.decode().split("<header", 1)[1].split("</header>", 1)[0]
        assert '<nav aria-label="Help">' in help_header and 'href="/support"' in help_header


def test_pending_testing_links_never_emit_native_links_or_handoff_script():
    browser = Client()
    for url in ["/", "/?install=1", "/?install=1#install"]:
        for ua in ["Googlebot", "iPhone", "Android", "Macintosh"]:
            response = browser.get(url, HTTP_USER_AGENT=ua)
            assert response.status_code == 200 and "Location" not in response
            html = response.content.decode()
            assert 'href="/app/"' in html and 'src="/assets/install-qr.svg"' in html
            for withheld in ["testflight.apple.com", "play.google.com/apps/testing", "groups.google.com", '/assets/install.js', 'class="badges"', 'id="android-help"']:
                assert withheld not in html
