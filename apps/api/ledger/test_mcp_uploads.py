import io
import socket
from uuid import uuid4

import pytest
import urllib3
from ninja.errors import HttpError

from . import mcp_files, mcp_tools
from .models import UploadedFile
from .test_mcp_tools import ledger as ledger
from .test_media import image_bytes, pdf_bytes
from .test_media import storage as storage

pytestmark = pytest.mark.django_db
SOURCE = "https://files.example.invalid/receipt?signature=private"


@pytest.fixture
def remote(monkeypatch):
    class Remote:
        body = image_bytes()
        status = 200
        headers = {}
        calls = []
        addresses = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443))]

        def __init__(self, address, **options):
            self.calls.append((address, options))

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def request(self, method, path, **options):
            self.request_options = options
            self.stream = io.BytesIO(self.body)
            return self

        def read1(self, size):
            return self.stream.read(size)

    monkeypatch.setattr(mcp_files.socket, "getaddrinfo", lambda *a, **k: Remote.addresses)
    monkeypatch.setattr(mcp_files.urllib3, "HTTPSConnectionPool", Remote)
    return Remote


def reference():
    return {"download_url": SOURCE, "file_id": "file-synthetic", "file_name": "Receipt.png", "mime_type": "image/png"}


@pytest.mark.parametrize("body,expected", [(image_bytes(kind="JPEG"), "image/jpeg"),
    (image_bytes(kind="PNG"), "image/jpeg"), (image_bytes(kind="WEBP"), "image/jpeg"), (pdf_bytes(), "application/pdf")])
def test_upload_uses_existing_processing_storage_and_retry_rules(ledger, storage, remote, body, expected):
    actor, _, _, group, _, _, _, bill, _ = ledger
    remote.body = body
    file_id, version = uuid4(), group.version
    first = mcp_tools.upload_attachment(actor, group.id, bill.id, file_id, reference())
    second = mcp_tools.upload_attachment(actor, group.id, bill.id, file_id, reference())
    assert first == second and first["version"] == version + 1
    assert first["attachment"]["content_type"] == expected
    assert len(storage.puts) == UploadedFile.objects.count() == 1
    bill.refresh_from_db()
    assert bill.total == 100 and bill.paid == {str(ledger[4].id): "100"}
    assert SOURCE not in str(first) and "file-synthetic" not in str(first)
    if expected == "image/jpeg":
        from PIL import Image
        with Image.open(io.BytesIO(storage.puts[0]["Body"])) as image:
            assert image.getexif() == {} and "icc_profile" not in image.info
    remote.body = image_bytes(size=(30, 40))
    with pytest.raises(HttpError, match="already used"):
        mcp_tools.upload_attachment(actor, group.id, bill.id, file_id, reference())
    assert len(storage.puts) == 1


@pytest.mark.parametrize("denied", ["outsider", "removed", "archived", "deleted", "wrong_bill"])
def test_authorization_precedes_source_download(ledger, storage, remote, denied):
    actor, _, outsider, group, me, _, _, bill, _ = ledger
    if denied == "outsider":
        actor = outsider
    if denied == "removed":
        me.removed = True
        me.save()
    if denied == "archived":
        group.archived = True
        group.save()
    if denied == "deleted":
        bill.deleted = True
        bill.save()
    bill_id = uuid4() if denied == "wrong_bill" else bill.id
    with pytest.raises(HttpError):
        mcp_tools.upload_attachment(actor, group.id, bill_id, uuid4(), reference())
    assert remote.calls == [] and storage.puts == [] and not UploadedFile.objects.exists()


def test_invalid_content_and_attachment_limit_use_app_validation(ledger, storage, remote):
    actor, _, _, group, _, _, _, bill, _ = ledger
    remote.body = b"not an image or PDF"
    from .accounting import AccountingError
    with pytest.raises(AccountingError):
        mcp_tools.upload_attachment(actor, group.id, bill.id, uuid4(), reference())
    assert not UploadedFile.objects.exists()
    remote.body = image_bytes()
    for _ in range(10):
        mcp_tools.upload_attachment(actor, group.id, bill.id, uuid4(), reference())
    with pytest.raises(HttpError, match="at most 10"):
        mcp_tools.upload_attachment(actor, group.id, bill.id, uuid4(), reference())
    assert len(storage.puts) == 10


@pytest.mark.parametrize("url", ["http://files.example.invalid/a", "file:///etc/passwd", "https://user:secret@files.example.invalid/a", "https://files.example.invalid:8443/a", "https://files.example.invalid/a#fragment"])
def test_download_rejects_unsafe_url_forms_without_connecting(remote, url):
    with pytest.raises(HttpError):
        mcp_files.download_file(url)
    assert remote.calls == []


@pytest.mark.parametrize("ip", ["127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.0.1", "::1", "::ffff:127.0.0.1"])
def test_private_and_mixed_dns_results_never_connect(remote, ip):
    remote.addresses.append((socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 443)))
    with pytest.raises(HttpError):
        mcp_files.download_file(SOURCE)
    assert remote.calls == []


def test_download_pins_public_ip_and_checks_original_tls_hostname(remote):
    assert mcp_files.download_file(SOURCE) == remote.body
    address, options = remote.calls[0]
    assert address == "8.8.8.8"
    assert options["server_hostname"] == options["assert_hostname"] == "files.example.invalid"
    assert options["cert_reqs"] == "CERT_REQUIRED"


@pytest.mark.parametrize("status,headers,body", [(302, {"Location": "http://127.0.0.1"}, b"x"),
    (404, {}, b"x"), (200, {"Content-Encoding": "gzip"}, b"x"),
    (200, {"Content-Length": str(21 * 1024 * 1024)}, b"x"),
    (200, {"Content-Length": "100"}, b"short"), (200, {}, b"")])
def test_bad_downloads_do_not_redirect_or_accept_invalid_bytes(remote, status, headers, body):
    remote.status, remote.headers, remote.body = status, headers, body
    with pytest.raises(HttpError):
        mcp_files.download_file(SOURCE)
    assert len(remote.calls) == 1


def test_stream_size_and_time_limits_and_network_errors_hide_source_urls(remote, monkeypatch):
    monkeypatch.setattr(mcp_files, "MAX_FILE_SIZE", 100)
    remote.body = b"x" * 101
    with pytest.raises(HttpError, match="20 MiB"):
        mcp_files.download_file(SOURCE)
    monkeypatch.setattr(mcp_files.time, "monotonic", iter([0, 21]).__next__)
    with pytest.raises(HttpError, match="timed out"):
        mcp_files.download_file(SOURCE)


def test_provider_errors_never_echo_signed_urls(remote, monkeypatch):
    def fail(*a, **k):
        raise urllib3.exceptions.HTTPError(SOURCE)
    monkeypatch.setattr(remote, "request", fail)
    with pytest.raises(HttpError) as error:
        mcp_files.download_file(SOURCE)
    assert "signature" not in str(error.value)
