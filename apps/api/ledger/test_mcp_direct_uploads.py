import asyncio
import hashlib
from datetime import timedelta
from uuid import uuid4

import pytest
from asgiref.sync import sync_to_async
from botocore.exceptions import EndpointConnectionError
from config.asgi import MeroSplitApplication
from django.core import signing
from django.utils import timezone
from ninja.errors import HttpError

from . import mcp_uploads, media
from .models import Change, UploadedFile
from .test_mcp_tools import ledger as ledger
from .test_mcp_transport import bearer as bearer
from .test_mcp_transport import canonical_settings as canonical_settings
from .test_mcp_transport import running_app, sdk
from .test_media import image_bytes, pdf_bytes
from .test_media import storage as storage

pytestmark = pytest.mark.django_db(transaction=True)


def prepare(ledger, bearer, data, **overrides):
    args = dict(group_id=ledger[3].pk, bill_id=ledger[7].pk, id=uuid4(), file_name="Receipt.png",
                size=len(data), sha256=hashlib.sha256(data).hexdigest(), mime_type="image/png", access_token=bearer[0])
    args.update(overrides)
    return mcp_uploads.prepare_upload(ledger[0], **args)


def put(ticket, data, **kwargs):
    async def check():
        async with running_app(MeroSplitApplication()) as http:
            return await http.put(ticket["upload_url"], content=data, headers=ticket["headers"], **kwargs)
    return asyncio.run(check())


@pytest.mark.parametrize("data,kind", [(image_bytes(kind="JPEG"), "image/jpeg"),
    (image_bytes(kind="PNG"), "image/jpeg"), (image_bytes(kind="WEBP"), "image/jpeg"), (pdf_bytes(), "application/pdf")])
def test_mcp_prepare_http_upload_confirmation_and_lost_response_retry(ledger, bearer, storage, data, kind):
    file_id = uuid4()
    async def check():
        async with running_app(MeroSplitApplication(), bearer[0]) as http:
            async with sdk(http) as client:
                ids = {"group_id": str(ledger[3].pk), "bill_id": str(ledger[7].pk), "id": str(file_id)}
                args = {**ids, "file_name": "Receipt.png", "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                prepared = await client.call_tool("prepare_attachment_upload", args)
                assert not prepared.is_error, prepared
                ticket = prepared.structured_content
                assert bearer[0] not in str(ticket) and ticket["method"] == "PUT"
                initial = await client.call_tool("get_attachment_upload", ids)
                assert initial.structured_content == {"status": "not_uploaded"}
                result = await http.put(ticket["upload_url"], headers=ticket["headers"], content=data)
                assert result.status_code == 200, result.text
                assert result.headers["cache-control"] == "no-store"
                assert result.json()["attachment"]["content_type"] == kind
                confirmed = await client.call_tool("get_attachment_upload", ids)
                assert confirmed.structured_content == {"status": "complete", **result.json()}
                # A lost response must never create another file or ledger event.
                replay = await http.put(ticket["upload_url"], headers=ticket["headers"], content=data)
                assert replay.json() == result.json()
                fresh = await client.call_tool("prepare_attachment_upload", args)
                assert not fresh.is_error
                replay = await http.put(fresh.structured_content["upload_url"], headers=fresh.structured_content["headers"], content=data)
                assert replay.json() == result.json()
    asyncio.run(check())
    assert len(storage.puts) == UploadedFile.objects.count() == 1
    assert Change.objects.filter(kind="attachment_added").count() == 1
    assert media.list_attachments(ledger[0], ledger[3].pk, ledger[7].pk)["attachments"][0]["id"] == str(file_id)
    if kind == "image/jpeg":
        import io

        from PIL import Image
        with Image.open(io.BytesIO(storage.puts[0]["Body"])) as image:
            assert not image.getexif() and "icc_profile" not in image.info


@pytest.mark.parametrize("state", ["revoked", "expired_grant", "inactive", "removed_member", "archived", "deleted_bill"])
def test_ticket_rechecks_connection_and_bill_permissions(ledger, bearer, storage, state):
    data = image_bytes()
    ticket = prepare(ledger, bearer, data)
    if state == "revoked":
        bearer[1].revoked_at = timezone.now()
        bearer[1].save()
    elif state == "expired_grant":
        bearer[1].refresh_expires_at = timezone.now() - timedelta(seconds=1)
        bearer[1].save()
    elif state == "inactive":
        ledger[0].is_active = False
        ledger[0].save()
    elif state == "removed_member":
        ledger[4].removed = True
        ledger[4].save()
    elif state == "archived":
        ledger[3].archived = True
        ledger[3].save()
    else:
        ledger[7].deleted = True
        ledger[7].save()
    response = put(ticket, data)
    assert response.status_code in {401, 403, 404, 409}, response.text
    assert not storage.puts and not UploadedFile.objects.exists()


def test_expired_and_tampered_tickets_do_not_accept_browser_or_oauth_credentials(ledger, bearer, storage, monkeypatch):
    data = image_bytes()
    ticket = prepare(ledger, bearer, data)
    for token in ["", "Bearer " + bearer[0], ticket["headers"]["Authorization"] + "tampered"]:
        bad = {**ticket, "headers": {"Authorization": token}}
        assert put(bad, data).status_code == 401
    signer_time = signing.time.time
    monkeypatch.setattr(signing.time, "time", lambda: signer_time() + 601)
    result = put(ticket, data)
    assert result.status_code == 401 and "expired" in result.text
    assert not storage.puts


def test_size_hash_and_format_fail_before_storage(ledger, bearer, storage):
    data = image_bytes()
    ticket = prepare(ledger, bearer, data)
    for body in [data[:-1], data + b"x", b"x" * len(data)]:
        result = put(ticket, body)
        assert result.status_code == 422, result.text
    bad = b"invalid image"
    result = put(prepare(ledger, bearer, bad), bad)
    assert result.status_code == 422 and not storage.puts and not UploadedFile.objects.exists()


def test_stream_limits_disconnect_and_revocation_during_transfer(ledger, bearer, storage):
    data = image_bytes()
    ticket = prepare(ledger, bearer, data)
    async def check():
        async with running_app(MeroSplitApplication()) as http:
            async def overflow():
                yield data
                yield b"x"
            headers = {**ticket["headers"], "Content-Length": str(len(data))}
            result = await http.put(ticket["upload_url"], headers=headers, content=overflow())
            assert result.status_code == 413
            async def truncated():
                yield data[:-1]
            result = await http.put(ticket["upload_url"], headers=headers, content=truncated())
            assert result.status_code == 422
            async def revoked():
                yield data[:10]
                await sync_to_async(lambda: type(bearer[1]).objects.filter(pk=bearer[1].pk).update(revoked_at=timezone.now()))()
                yield data[10:]
            result = await http.put(ticket["upload_url"], headers=headers, content=revoked())
            assert result.status_code == 401
    asyncio.run(check())
    assert not storage.puts and not UploadedFile.objects.exists()


def test_retry_recovers_storage_failure_and_deleted_upload_is_not_resurrected(ledger, bearer, storage):
    data = image_bytes()
    ticket = prepare(ledger, bearer, data)
    storage.fail_put = EndpointConnectionError(endpoint_url="https://private.example.invalid")
    assert put(ticket, data).status_code == 503
    ids = (ledger[0], ledger[3].pk, ledger[7].pk, ticket["id"])
    assert mcp_uploads.get_upload(*ids) == {"status": "retry_required"}
    storage.fail_put = None
    assert put(ticket, data).status_code == 200
    media.remove_attachment(*ids)
    assert mcp_uploads.get_upload(*ids) == {"status": "removed"}
    assert put(ticket, data).status_code == 409
    with pytest.raises(HttpError, match="removed"):
        prepare(ledger, bearer, data, id=ticket["id"])


def test_preparation_denies_outsiders_wrong_scope_reused_ids_and_full_bills(ledger, bearer, storage):
    data = image_bytes()
    with pytest.raises(HttpError):
        mcp_uploads.prepare_upload(ledger[2], ledger[3].pk, ledger[7].pk, uuid4(), "Receipt.png", len(data), hashlib.sha256(data).hexdigest(), "image/png", access_token=bearer[0])
    with pytest.raises(HttpError):
        prepare(ledger, bearer, data, bill_id=uuid4())
    ticket = prepare(ledger, bearer, data)
    assert put(ticket, data).status_code == 200
    with pytest.raises(HttpError, match="different input"):
        prepare(ledger, bearer, b"different", id=ticket["id"])
    for _ in range(9):
        assert put(prepare(ledger, bearer, data), data).status_code == 200
    with pytest.raises(HttpError, match="at most 10"):
        prepare(ledger, bearer, data)
    assert put(ticket, data).status_code == 200
    assert len(storage.puts) == 10
    assert mcp_uploads.get_upload(ledger[1], ledger[3].pk, ledger[7].pk, ticket["id"]) == {"status": "not_uploaded"}
    with pytest.raises(HttpError):
        mcp_uploads.get_upload(ledger[2], ledger[3].pk, ledger[7].pk, ticket["id"])


def test_upload_host_origin_method_and_missing_content_length(ledger, bearer, storage):
    data = image_bytes()
    ticket = prepare(ledger, bearer, data)
    async def check():
        async with running_app(MeroSplitApplication()) as http:
            for extra, expected in [({"Host": "evil.example.invalid"}, 421), ({"Origin": "https://evil.example.invalid"}, 403), ({"Content-Length": "0"}, 422)]:
                response = await http.put(ticket["upload_url"], content=data, headers={**ticket["headers"], **extra})
                assert response.status_code == expected
            response = await http.get(ticket["upload_url"])
            assert response.status_code == 405 and response.headers["allow"] == "PUT"
            async def chunks():
                yield data
            response = await http.put(ticket["upload_url"], content=chunks(), headers=ticket["headers"])
            assert response.status_code == 422
    asyncio.run(check())
    assert not storage.puts


@pytest.mark.parametrize("invalid", [{"size": 0}, {"size": 20 * 1024 * 1024 + 1}, {"size": True},
    {"sha256": "not-a-hash"}, {"sha256": "F" * 64}, {"file_name": ""}, {"actor": "another-user"}])
def test_prepare_tool_rejects_invalid_metadata_without_saving(ledger, bearer, storage, invalid):
    async def check():
        async with running_app(MeroSplitApplication(), bearer[0]) as http:
            async with sdk(http) as client:
                args = {"group_id": str(ledger[3].pk), "bill_id": str(ledger[7].pk), "id": str(uuid4()),
                    "file_name": "Receipt.png", "size": 10, "sha256": "a" * 64, **invalid}
                result = await client.call_tool("prepare_attachment_upload", args)
                assert result.is_error
    asyncio.run(check())
    assert not storage.puts and not UploadedFile.objects.exists()


def test_rejected_requests_do_not_read_bytes_and_disconnect_cannot_save(ledger, bearer, storage):
    data = image_bytes()
    ticket = prepare(ledger, bearer, data)
    async def check():
        base = {"type": "http", "method": "PUT", "path": mcp_uploads.UPLOAD_PATH, "client": ("127.0.0.1", 1)}
        headers = [(b"host", b"merosplit.omshejul.com"), (b"authorization", ticket["headers"]["Authorization"].encode()),
                   (b"content-length", str(len(data)).encode())]
        async def forbidden_receive():
            pytest.fail("Rejected uploads must not read source bytes")
        for bad_headers in [headers[:1], headers + [(b"authorization", b"Bearer other")],
                            [*headers[:2], (b"content-length", b"9" * 5000)]]:
            messages = []
            async def send(message):
                messages.append(message)
            await mcp_uploads.upload_app({**base, "headers": bad_headers}, forbidden_receive, send)
            assert messages[0]["status"] in {401, 422}
        incoming = iter([{"type": "http.request", "body": data[:10], "more_body": True}, {"type": "http.disconnect"}])
        async def disconnected_receive():
            return next(incoming)
        messages = []
        await mcp_uploads.upload_app({**base, "headers": headers}, disconnected_receive, send)
        assert messages[0]["status"] == 422
    asyncio.run(check())
    assert not storage.puts and not UploadedFile.objects.exists()
