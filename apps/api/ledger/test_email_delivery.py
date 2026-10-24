import base64
import hashlib
import json
import re
from urllib.error import URLError

import pytest

from . import email_delivery
from .otp import TTL


def test_html_autoescapes_names_but_plaintext_remains_readable():
    name = '<script>alert("synthetic")</script> & Friends'
    url = "https://example.invalid/invite/opaque?first=1&second=2"
    text, html = email_delivery.render_message("invitation", {"inviter_name": name, "invite_url": url})
    assert name in text and "&lt;script&gt;" in html and name not in html
    assert url in text and "first=1&amp;second=2" in html
    assert re.findall(r'<img[^>]+src="([^"]+)"', html) == ["cid:merosplit-logo"]
    assert "<script" not in html and "{{" not in html


def test_code_template_uses_exact_four_digits_and_real_expiry():
    # Fresh generated values exercise rendering; there is no fixed login code.
    import secrets
    code = f"{secrets.randbelow(10000):04d}"
    text, html = email_delivery.render_message("sign_in", {"code": code, "expires_minutes": TTL // 60})
    assert re.findall(r"\b[0-9]{4}\b", text) == [code]
    assert code in html and f"{TTL // 60} minutes" in text and f"{TTL // 60} minutes" in html
    assert "works only once" in text and "{{" not in html


def test_resend_boundary_sends_both_parts_inline_logo_headers_and_final_sender(settings, monkeypatch):
    settings.RESEND_API_KEY = "synthetic-provider-key"
    settings.DEFAULT_FROM_EMAIL = "MeroSplit <configured-sender@example.invalid>"
    settings.EMAIL_REPLY_TO = "configured-reply@example.invalid"
    captured = []

    class Response:
        status = 200
        def __enter__(self):
            return self
        def __exit__(self, *args):
            return False
        def read(self, limit):
            assert limit == 65536
            return b'{"id":"synthetic-provider-delivery"}'

    def deliver(request, timeout):
        assert timeout == 10
        captured.append(request)
        return Response()

    monkeypatch.setattr(email_delivery, "urlopen", deliver)
    text, html = email_delivery.render_message("sign_in", {"code": "0007", "expires_minutes": TTL // 60})
    assert email_delivery.send_email("synthetic@example.invalid", "Sign in", text, "otp/synthetic", html=html) == "synthetic-provider-delivery"
    request = captured[0]
    headers = {key.lower(): value for key, value in request.header_items()}
    assert request.full_url == "https://api.resend.com/emails" and request.get_method() == "POST"
    assert headers["authorization"] == "Bearer synthetic-provider-key"
    assert headers["idempotency-key"] == "otp/synthetic" and headers["user-agent"].startswith("MeroSplit/")
    payload = json.loads(request.data)
    assert payload["text"] == text and payload["html"] == html
    assert payload["from"] == settings.DEFAULT_FROM_EMAIL and payload["reply_to"] == settings.EMAIL_REPLY_TO
    logo, = payload["attachments"]
    assert logo["content_id"] == "merosplit-logo" and logo["content_type"] == "image/png"
    assert hashlib.sha256(base64.b64decode(logo["content"])).hexdigest() == "3c922faa7b6c6768dbe7d505c872ab9e12c7edd1457b3b4521900c0293f09493"


def test_provider_errors_never_expose_provider_body_key_or_recipient(settings, monkeypatch):
    settings.RESEND_API_KEY = "synthetic-provider-key"
    monkeypatch.setattr(email_delivery, "urlopen", lambda *args, **kwargs: (_ for _ in ()).throw(URLError("sensitive provider details")))
    with pytest.raises(email_delivery.EmailDeliveryUnavailable) as failure:
        email_delivery.send_email("synthetic@example.invalid", "Sign in", "Synthetic text", "otp/synthetic")
    assert str(failure.value) == ""


def test_unconfigured_provider_cannot_silently_succeed(settings, monkeypatch):
    settings.RESEND_API_KEY = ""
    monkeypatch.setattr(email_delivery, "urlopen", lambda *args, **kwargs: pytest.fail("No outbound request expected"))
    with pytest.raises(email_delivery.EmailDeliveryUnavailable):
        email_delivery.send_email("synthetic@example.invalid", "Sign in", "Synthetic text", "otp/synthetic")


def test_login_template_keeps_one_click_cta_and_code_fallback():
    from .email_links import CODE_PLACEHOLDER, EXPIRY_PLACEHOLDER, LINK_PLACEHOLDER
    text, html = email_delivery.render_message("sign_in", {
        "login_url": LINK_PLACEHOLDER, "expires_at": EXPIRY_PLACEHOLDER,
        "code": CODE_PLACEHOLDER, "expires_minutes": TTL // 60,
    })
    assert LINK_PLACEHOLDER in text and f'href="{LINK_PLACEHOLDER}"' in html
    assert ">Sign in</a>" in html and "Or enter this code" in text and "Or enter this code" in html
    assert f"This link works until {EXPIRY_PLACEHOLDER}." in text and EXPIRY_PLACEHOLDER in html
    assert f"\n{CODE_PLACEHOLDER}\n" in text and CODE_PLACEHOLDER in html


@pytest.mark.parametrize("template,url_name,label", [
    ("invitation", "invite_url", "View ledger"), ("expense_digest", "app_url", "Open MeroSplit"),
])
def test_invitation_and_digest_ctas_have_actual_expiry_and_keep_help_purpose(template, url_name, label):
    from .email_links import EXPIRY_PLACEHOLDER, LINK_PLACEHOLDER
    text, html = email_delivery.render_message(template, {
        url_name: LINK_PLACEHOLDER, "expires_at": EXPIRY_PLACEHOLDER, "inviter_name": "Synthetic organizer",
    })
    assert LINK_PLACEHOLDER in text and f'href="{LINK_PLACEHOLDER}"' in html and label in html
    assert f"This link works until {EXPIRY_PLACEHOLDER}." in text and EXPIRY_PLACEHOLDER in html
    if template == "invitation":
        assert "signs you in and joins this ledger" in text and "Opening the invitation does not accept" not in text
        assert 'href="mailto:mail@merosplit.com"' in html
    else:
        assert "turn off Email reminders in Me" in text
