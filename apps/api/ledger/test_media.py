import hashlib
import io
import struct
import threading
import zlib
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from pathlib import Path

import pytest
from botocore.exceptions import EndpointConnectionError
from django.core.files.uploadedfile import SimpleUploadedFile, TemporaryUploadedFile
from django.core.management import call_command
from django.db import DatabaseError, close_old_connections, connection, connections
from django.test import Client
from django.utils import timezone
from ninja.errors import HttpError
from PIL import Image
from pypdf import PdfReader, PdfWriter
from pypdf.actions import JavaScript
from pypdf.generic import ArrayObject, DecodedStreamObject, DictionaryObject, NameObject

from . import media
from .accounting import AccountingError
from .models import Change, Group, UploadedFile
from .services import snapshot
from .test_api import client as client
from .test_api import expense, send, uid
from .test_api import group as group
from .test_collaboration import account, link

pytestmark = pytest.mark.django_db


class FakeS3:
    def __init__(self):
        self.objects, self.puts, self.deletes, self.signatures = {}, [], [], []
        self.fail_put = self.fail_delete = self.after_put = None

    def put_object(self, **data):
        self.puts.append(data)
        self.objects[data["Key"]] = data["Body"]
        if self.after_put:
            self.after_put()
        if self.fail_put:
            raise self.fail_put

    def delete_object(self, **data):
        self.deletes.append(data)
        if self.fail_delete:
            raise self.fail_delete
        self.objects.pop(data["Key"], None)

    def generate_presigned_url(self, method, **data):
        self.signatures.append((method, data))
        return f"https://private.example.invalid/{data['Params']['Key']}?temporary=signature"


@pytest.fixture
def storage(monkeypatch, settings):
    settings.R2_BUCKET = "synthetic-private-media"
    storage = FakeS3()
    monkeypatch.setattr(media, "_storage", lambda: storage)
    return storage


def image_bytes(*, size=(1000, 600), kind="JPEG", orientation=None, alpha=False):
    with Image.new("RGBA" if alpha else "RGB", size, (220, 30, 10, 0) if alpha else (220, 30, 10)) as image:
        output = io.BytesIO()
        exif = Image.Exif()
        exif[270] = "Private camera description that must be stripped"
        if orientation:
            exif[274] = orientation
        image.save(output, kind, exif=exif, icc_profile=b"Synthetic source ICC profile")
        return output.getvalue()


def pdf_bytes(*, pages=1, encrypted=False, javascript=False, signed=False, embedded=False):
    writer = PdfWriter()
    for _ in range(pages):
        page = writer.add_blank_page(width=300, height=200)
        font = DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"), NameObject("/BaseFont"): NameObject("/Helvetica")})
        page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): writer._add_object(font)})})
        stream = DecodedStreamObject()
        stream.set_data(b"BT /F1 12 Tf 20 100 Td (Readable synthetic receipt text) Tj ET\n")
        page[NameObject("/Contents")] = writer._add_object(stream)
        if signed:
            page[NameObject("/Annots")] = ArrayObject([DictionaryObject({NameObject("/FT"): NameObject("/Sig")})])
    writer.add_metadata({"/Title": "Private original metadata"})
    if encrypted:
        writer.encrypt("test-password")
    if javascript:
        writer.add_open_action(JavaScript("app.alert('active')"))
    if embedded:
        writer.add_attachment("embedded.txt", b"not permitted")
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


def upload(data=None, name="Camera original.png", content_type="image/png"):
    return SimpleUploadedFile(name, data if data is not None else image_bytes(), content_type=content_type)


def post_file(client, path="/me/avatar", *, data=None, file_id=None, name="Camera original.png", content_type="image/png"):
    return client.post(f"/api/v1{path}", {"id": file_id or uid(), "file": upload(data, name, content_type)})


@pytest.fixture
def bill(client, group):
    group_id, ids, _ = group
    payload = expense(ids)
    assert send(client, "post", f"/groups/{group_id}/expenses", payload).status_code == 200
    return group_id, payload["id"], f"/groups/{group_id}/expenses/{payload['id']}/attachments"


@pytest.mark.parametrize("kind", ["JPEG", "PNG", "WEBP"])
def test_avatar_optimized_color_orientation_metadata_and_raw_never_stored(client, storage, kind):
    original = image_bytes(kind=kind, orientation=6)
    response = post_file(client, data=original)
    assert response.status_code == 200, response.content
    file = UploadedFile.objects.get(state="active")
    assert file.object_key.startswith("avatars/") and file.object_key.endswith(".jpg")
    stored = storage.objects[file.object_key]
    assert stored != original
    assert file.source_hash == hashlib.sha256(original).hexdigest()
    assert file.size == len(stored) and file.name.endswith(".jpg") and file.content_type == "image/jpeg"
    with Image.open(io.BytesIO(stored)) as image:
        assert max(image.size) <= 512
        assert image.height > image.width
        assert image.getexif() == {} and "icc_profile" not in image.info
        pixel = image.getpixel((0, 0))
        assert pixel[0] > pixel[1] + 100  # Optimization must not desaturate user photos.
    assert response.json()["avatar"] == media.metadata(file)
    assert send(client, "get", "/me").json()["avatar"] == media.metadata(file)
    assert len(storage.objects) == len(storage.puts) == 1
    assert all(p["ContentType"] == "image/jpeg" and "ACL" not in p for p in storage.puts)


def test_bill_image_dimensions_transparency_and_financial_amounts_unchanged(client, bill, storage):
    group_id, expense_id, path = bill
    before = snapshot(Group.objects.get(id=group_id))
    original = image_bytes(size=(3200, 1800), kind="PNG", alpha=True)
    response = post_file(client, path, data=original)
    assert response.status_code == 200, response.content
    file = UploadedFile.objects.get()
    assert file.object_key.startswith(f"bills/{group_id}/{expense_id}/")
    with Image.open(io.BytesIO(storage.objects[file.object_key])) as image:
        assert image.size == (2400, 1350)
        assert all(channel >= 250 for channel in image.getpixel((0, 0)))
    after = snapshot(Group.objects.get(id=group_id))
    assert after["balances"] == before["balances"] and after["totals"] == before["totals"]
    assert after["expenses"][0]["version"] == before["expenses"][0]["version"]
    assert after["version"] == before["version"] + 1 == response.json()["version"]


def test_pdf_rewritten_compressed_and_searchable_text_retained(client, bill, storage):
    original = pdf_bytes(pages=2)
    response = post_file(client, bill[2], data=original, name="Receipt.pdf", content_type="application/pdf")
    assert response.status_code == 200, response.content
    file = UploadedFile.objects.get()
    stored = storage.objects[file.object_key]
    assert stored != original and file.content_type == "application/pdf" and file.name == "Receipt.pdf"
    reader = PdfReader(io.BytesIO(stored), strict=True)
    assert len(reader.pages) == 2
    assert all("Readable synthetic receipt text" in page.extract_text() for page in reader.pages)
    assert all(page["/Contents"].get_object()["/Filter"] == "/FlateDecode" for page in reader.pages)
    assert "/Title" not in reader.metadata
    assert all(key.startswith("bills/") for key in storage.objects)


@pytest.mark.parametrize("options", [{"encrypted": True}, {"signed": True}, {"javascript": True}, {"embedded": True}, {"pages": 101}])
def test_unsupported_pdfs_never_reach_storage(client, bill, storage, options):
    response = post_file(client, bill[2], data=pdf_bytes(**options), name="receipt.pdf", content_type="application/pdf")
    assert response.status_code == 422, response.content
    assert storage.puts == [] and UploadedFile.objects.count() == 0


@pytest.mark.parametrize("data,kind", [
    (b"<html><body>fake receipt</body></html>", "application/pdf"),
    (b'<svg xmlns="http://www.w3.org/2000/svg"></svg>', "image/png"),
    (b"%PDF-1.7\nmalformed\n%%EOF", "application/pdf"),
    (b"%PDF-1.7 incomplete", "application/pdf"),
    (b"", "image/jpeg"),
    (b"GIF89a invalid", "image/jpeg"),
])
def test_actual_bytes_validate_even_when_filename_or_mime_lies(client, bill, storage, data, kind):
    response = post_file(client, bill[2], data=data, name="looks-valid.jpg", content_type=kind)
    assert response.status_code == 422, response.content
    assert not storage.puts and UploadedFile.objects.count() == 0


def test_size_dimensions_avatar_pdf_and_upload_tempfile_cleanup(client, bill, storage):
    for path, count in [("/me/avatar", 5), (bill[2], 20)]:
        response = post_file(client, path, data=b"x" * (count * media.MIB + 1))
        assert response.status_code == 422
    assert post_file(client, data=pdf_bytes(), name="photo.pdf", content_type="application/pdf").status_code == 422
    png = bytearray(image_bytes(size=(10, 10), kind="PNG"))
    png[16:24] = struct.pack(">II", 8000, 6000)
    png[29:33] = struct.pack(">I", zlib.crc32(png[12:29]))
    assert post_file(client, data=bytes(png)).status_code == 422
    temporary = TemporaryUploadedFile("invalid.jpg", "image/jpeg", 10, None)
    temporary.write(b"not-image")
    temporary.seek(0)
    path = Path(temporary.temporary_file_path())
    with pytest.raises(AccountingError):
        media.process_file(temporary, avatar=True)
    assert temporary.closed and not path.exists()
    valid = image_bytes()
    temporary = TemporaryUploadedFile("valid.jpg", "image/jpeg", len(valid), None)
    temporary.write(valid)
    temporary.seek(0)
    path = Path(temporary.temporary_file_path())
    assert media.process_file(temporary, avatar=True)["content_type"] == "image/jpeg"
    assert temporary.closed and not path.exists()
    assert not storage.puts


def test_upload_retry_identity_remove_idempotency_and_deleted_id_cannot_revive(client, bill, storage):
    group_id, _, path = bill
    original, file_id = image_bytes(), uid()
    first = post_file(client, path, data=original, file_id=file_id)
    assert first.status_code == 200
    assert post_file(client, path, data=original, file_id=file_id).json() == first.json()
    assert len(storage.puts) == 1
    assert post_file(client, path, data=image_bytes(size=(30, 30)), file_id=file_id).status_code == 409
    first_remove = send(client, "delete", f"{path}/{file_id}")
    assert first_remove.status_code == 200 and first_remove.json()["cleanup_pending"] is False
    assert send(client, "delete", f"{path}/{file_id}").json() == first_remove.json()
    assert UploadedFile.objects.get().state == "deleted" and not storage.objects
    assert Group.objects.get(id=group_id).version == first.json()["version"] + 1
    assert post_file(client, path, data=original, file_id=file_id).status_code == 409
    assert send(client, "get", f"/media/{file_id}/url").status_code == 404


def test_failed_replacement_retains_old_photo_and_cleans_uncertain_uploaded_bytes(client, storage):
    first = post_file(client)
    old = UploadedFile.objects.get(state="active")
    storage.fail_put = EndpointConnectionError(endpoint_url="https://storage.invalid")
    file_id, original = uid(), image_bytes(size=(120, 120))
    failed = post_file(client, data=original, file_id=file_id)
    assert failed.status_code == 503
    assert send(client, "get", "/me").json()["avatar"] == first.json()["avatar"]
    assert list(storage.objects) == [old.object_key]
    pending = UploadedFile.objects.get(id=file_id)
    assert pending.state == "pending" and pending.purged
    storage.fail_put = None
    retried = post_file(client, data=original, file_id=file_id)
    assert retried.status_code == 200
    old.refresh_from_db()
    assert old.state == "deleted" and old.purged and old.object_key not in storage.objects
    assert len(storage.objects) == 1


@pytest.mark.django_db(transaction=True)
def test_database_commit_failure_cleans_new_artifact_and_same_upload_retries(client, storage, monkeypatch):
    old_response = post_file(client)
    original, file_id = image_bytes(size=(90, 90)), uid()
    real_commit, commits = connection.commit, []

    def fail_second_commit():
        commits.append(True)
        if len(commits) == 2:
            raise DatabaseError("Injected activation commit failure")
        return real_commit()

    storage.after_put = lambda: not connection.in_atomic_block or pytest.fail("R2 PUT was inside a transaction")
    with monkeypatch.context() as patch:
        patch.setattr(connection, "commit", fail_second_commit)
        with pytest.raises(DatabaseError, match="activation commit"):
            post_file(client, data=original, file_id=file_id)
    assert len(storage.objects) == 1
    assert send(client, "get", "/me").json()["avatar"] == old_response.json()["avatar"]
    assert UploadedFile.objects.get(id=file_id).state == "pending"
    assert post_file(client, data=original, file_id=file_id).status_code == 200
    assert len(storage.objects) == 1


def test_storage_delete_failure_hides_metadata_and_repeated_remove_retries(client, storage):
    file_id = post_file(client).json()["avatar"]["id"]
    storage.fail_delete = EndpointConnectionError(endpoint_url="https://storage.invalid")
    response = send(client, "delete", "/me/avatar")
    assert response.status_code == 200 and response.json() == {"removed": True, "cleanup_pending": True}
    assert send(client, "get", "/me").json()["avatar"] is None
    assert send(client, "get", f"/media/{file_id}/url").status_code == 404
    assert not UploadedFile.objects.get().purged
    storage.fail_delete = None
    assert send(client, "delete", "/me/avatar").json()["cleanup_pending"] is False
    assert UploadedFile.objects.get().purged and not storage.objects


def test_replaced_photo_cleanup_failure_is_reported_and_manual_cleanup_retries(client, storage):
    old = post_file(client).json()["avatar"]["id"]
    storage.fail_delete = EndpointConnectionError(endpoint_url="https://storage.invalid")
    file_id, original = uid(), image_bytes(size=(200, 200))
    response = post_file(client, file_id=file_id, data=original)
    assert response.status_code == 200 and response.json()["cleanup_pending"]
    assert len(storage.objects) == 2
    assert UploadedFile.objects.get(id=old).state == "deleted"
    assert send(client, "get", f"/media/{old}/url").status_code == 404
    assert post_file(client, file_id=file_id, data=original).json()["cleanup_pending"]
    storage.fail_delete = None
    assert media.purge_stale_files() == {"cleaned": 1, "pending": 0}
    assert len(storage.objects) == 1


@pytest.mark.django_db(transaction=True)
def test_remove_commit_failure_keeps_photo_and_object_until_retry(client, storage, monkeypatch):
    accepted = post_file(client).json()["avatar"]
    real_commit = connection.commit
    with monkeypatch.context() as patch:
        patch.setattr(connection, "commit", lambda: (_ for _ in ()).throw(DatabaseError("Injected remove commit failure")))
        with pytest.raises(DatabaseError, match="remove commit"):
            send(client, "delete", "/me/avatar")
    assert connection.commit == real_commit
    assert send(client, "get", "/me").json()["avatar"] == accepted
    assert len(storage.objects) == 1 and not storage.deletes
    assert send(client, "delete", "/me/avatar").json()["removed"]
    assert not storage.objects


def test_group_scope_avatar_scope_fresh_urls_archive_and_reversed_bill_guards(client, bill, group, storage):
    group_id, bill_id, path = bill
    other = account()
    avatar_id = post_file(client).json()["avatar"]["id"]
    file_id = post_file(client, path).json()["attachment"]["id"]
    assert send(other, "get", f"/media/{avatar_id}/url").status_code == 404
    assert send(other, "get", f"/media/{file_id}/url").status_code == 404
    assert send(other, "get", path).status_code == 404
    puts = len(storage.puts)
    assert post_file(other, path).status_code == 404
    assert len(storage.puts) == puts
    assert send(Client(), "get", f"/media/{file_id}/url").status_code == 401
    link(client, other, group_id, group[1][1])
    result = send(other, "get", f"/media/{file_id}/url")
    assert result.status_code == 200
    expires = timezone.datetime.fromisoformat(result.json()["expires_at"])
    assert timedelta(seconds=295) <= expires - timezone.now() <= timedelta(seconds=300)
    method, signature = storage.signatures[-1]
    assert method == "get_object" and signature["ExpiresIn"] == 300
    assert signature["Params"]["ResponseCacheControl"] == "private, no-store"
    assert send(client, "post", f"/groups/{group_id}/archive", {"command_id": uid(), "archived": True}).status_code == 200
    assert send(other, "get", path).json()["can_modify"] is False
    assert send(other, "get", f"/media/{file_id}/url").status_code == 200
    assert post_file(other, path).status_code == 409
    assert send(other, "delete", f"{path}/{file_id}").status_code == 409
    Group.objects.filter(id=group_id).update(archived=False)
    assert send(client, "post", f"/groups/{group_id}/expenses/{bill_id}/reverse", {"command_id": uid(), "version": 1}).status_code == 200
    assert send(other, "get", path).status_code == 404
    assert send(other, "get", f"/media/{file_id}/url").status_code == 404
    assert post_file(other, path).status_code == 404


def test_attachment_limit_and_permission_recheck_after_object_upload(client, bill, storage):
    group_id, _, path = bill
    for _ in range(10):
        assert post_file(client, path).status_code == 200
    assert post_file(client, path).status_code == 409
    assert len(storage.puts) == 10
    first = UploadedFile.objects.filter(state="active").first()
    assert send(client, "delete", f"{path}/{first.id}").status_code == 200
    storage.after_put = lambda: Group.objects.filter(id=group_id).update(archived=True)
    response = post_file(client, path)
    assert response.status_code == 409
    assert UploadedFile.objects.filter(state="active").count() == 9
    assert len(storage.objects) == 9


def test_attachment_database_failure_preserves_bill_and_retry_posts_one_change(client, bill, storage, monkeypatch):
    group_id, _, path = bill
    before = snapshot(Group.objects.get(id=group_id))
    file_id, original = uid(), image_bytes()
    with monkeypatch.context() as patch:
        patch.setattr(Change.objects, "create", lambda **kwargs: (_ for _ in ()).throw(DatabaseError("Injected change failure")))
        with pytest.raises(DatabaseError, match="Injected change"):
            post_file(client, path, data=original, file_id=file_id)
    assert snapshot(Group.objects.get(id=group_id)) == before
    assert not storage.objects
    assert post_file(client, path, data=original, file_id=file_id).status_code == 200
    assert UploadedFile.objects.filter(state="active").count() == 1
    assert Group.objects.get(id=group_id).version == before["version"] + 1


@pytest.mark.django_db(transaction=True)
def test_same_scope_concurrent_upload_is_bounded_and_retries_without_orphan(client, storage):
    entered, release = threading.Event(), threading.Event()
    storage.after_put = lambda: (entered.set(), release.wait(5))
    first_id = uid()

    def run_first():
        close_old_connections()
        try:
            return media.upload_file(client.actor, first_id, upload())
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=1) as pool:
        first = pool.submit(run_first)
        assert entered.wait(5)
        assert post_file(client, file_id=uid()).status_code == 409
        assert send(client, "delete", "/me/avatar").status_code == 409
        release.set()
        assert first.result()["avatar"]["id"] == first_id
    assert len(storage.objects) == 1 and UploadedFile.objects.filter(state="active").count() == 1
    assert post_file(client, file_id=first_id).status_code == 200


def test_storage_missing_fails_safely_without_accepted_photo(client, settings):
    settings.R2_BUCKET = settings.R2_ENDPOINT_URL = settings.R2_ACCESS_KEY_ID = settings.R2_SECRET_ACCESS_KEY = ""
    response = post_file(client)
    assert response.status_code == 503
    assert UploadedFile.objects.filter(state="active").count() == 0


def test_account_deletion_removes_own_files_including_shared_receipts(client, bill, group, storage, django_capture_on_commit_callbacks):
    group_id, _, path = bill
    other = account()
    link(client, other, group_id, group[1][1])
    avatar_id = post_file(client).json()["avatar"]["id"]
    bill_file_id = post_file(client, path).json()["attachment"]["id"]
    with django_capture_on_commit_callbacks(execute=True):
        assert send(client, "delete", "/account").status_code == 200
    assert UploadedFile.objects.get(id=avatar_id).state == "deleted"
    assert UploadedFile.objects.get(id=avatar_id).purged
    assert UploadedFile.objects.get(id=bill_file_id).state == "deleted"
    assert UploadedFile.objects.get(id=bill_file_id).purged
    assert UploadedFile.objects.get(id=avatar_id).object_key == f"deleted/{avatar_id}"
    assert UploadedFile.objects.get(id=bill_file_id).object_key == f"deleted/{bill_file_id}"
    assert send(other, "get", f"/media/{bill_file_id}/url").status_code == 404
    with django_capture_on_commit_callbacks(execute=True):
        assert send(other, "delete", "/account").status_code == 200
    file = UploadedFile.objects.get(id=bill_file_id)
    assert file.state == "deleted" and file.purged and file.expense_id is None
    assert not storage.objects


def test_account_deletion_blocks_shared_file_while_failed_physical_cleanup_retries(client, bill, group, storage, django_capture_on_commit_callbacks):
    other = account()
    link(client, other, bill[0], group[1][1])
    file_id = post_file(client, bill[2], name="Private receipt.png").json()["attachment"]["id"]
    storage.fail_delete = EndpointConnectionError(endpoint_url="https://storage.invalid")
    with django_capture_on_commit_callbacks(execute=True):
        assert send(client, "delete", "/account").status_code == 200
    file = UploadedFile.objects.get(pk=file_id)
    assert file.state == "deleted" and not file.purged
    assert file.name == file.source_hash == "" and file.uploaded_by_id is None
    assert send(other, "get", f"/media/{file_id}/url").status_code == 404
    storage.fail_delete = None
    assert media.purge_stale_files() == {"cleaned": 1, "pending": 0}
    file.refresh_from_db()
    assert file.purged and file.object_key == f"deleted/{file_id}" and file.expense_id is None
    assert not storage.objects


def test_account_deletion_clears_key_of_previously_removed_avatar(client, storage, django_capture_on_commit_callbacks):
    file_id = post_file(client).json()["avatar"]["id"]
    assert send(client, "delete", "/me/avatar").status_code == 200
    file = UploadedFile.objects.get(pk=file_id)
    assert file.purged and file.object_key.startswith("avatars/")
    with django_capture_on_commit_callbacks(execute=True):
        assert send(client, "delete", "/account").status_code == 200
    file.refresh_from_db()
    assert file.purged and file.object_key == f"deleted/{file_id}"
    assert not storage.objects


@pytest.mark.django_db(transaction=True)
def test_inflight_avatar_cannot_survive_account_deletion(client, storage):
    entered, release = threading.Event(), threading.Event()
    storage.after_put = lambda: (entered.set(), release.wait(5))

    def run_upload():
        close_old_connections()
        try:
            try:
                media.upload_file(client.actor, uid(), upload())
            except HttpError as exc:
                return exc.status_code
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(run_upload)
        assert entered.wait(5)
        assert send(client, "delete", "/account").status_code == 200
        release.set()
        assert future.result() == 401
    assert UploadedFile.objects.filter(state="active").count() == 0
    assert not storage.objects
    assert all(file.purged for file in UploadedFile.objects.all())
    assert all(file.object_key == f"deleted/{file.id}" for file in UploadedFile.objects.all())


def test_manual_cleanup_purges_old_pending_and_deleted_but_preserves_active_and_recent(client, storage):
    response = post_file(client)
    active_id = response.json()["avatar"]["id"]
    failed_id, failed_bytes = uid(), image_bytes(size=(40, 40))
    storage.fail_put = storage.fail_delete = EndpointConnectionError(endpoint_url="https://storage.invalid")
    assert post_file(client, data=failed_bytes, file_id=failed_id).status_code == 503
    recent_id = uid()
    assert post_file(client, data=image_bytes(size=(60, 60)), file_id=recent_id).status_code == 503
    UploadedFile.objects.filter(id=failed_id).update(created_at=timezone.now() - timedelta(days=2))
    storage.fail_put = storage.fail_delete = None
    output = io.StringIO()
    call_command("purge_media", stdout=output)
    assert "cleaned: 1" in output.getvalue()
    assert UploadedFile.objects.get(id=failed_id).state == "deleted"
    assert UploadedFile.objects.get(id=failed_id).purged
    assert UploadedFile.objects.get(id=recent_id).state == "pending"
    assert UploadedFile.objects.get(id=active_id).state == "active"


def test_json_exports_include_metadata_without_object_keys_or_signed_urls(client, bill, storage):
    group_id, bill_id, path = bill
    avatar = post_file(client).json()["avatar"]
    attachment = post_file(client, path).json()["attachment"]
    group_export = send(client, "get", f"/groups/{group_id}/export?format=json").json()
    assert group_export["group"]["attachments"] == [{"expense_id": bill_id, **attachment}]
    account_export = send(client, "get", "/account/export").json()
    assert account_export["account"]["avatar"] == avatar
    assert account_export["groups"][0]["group"]["attachments"] == group_export["group"]["attachments"]
    snapshot_response = send(client, "get", f"/groups/{group_id}")
    for response in [group_export, account_export, snapshot_response.json()]:
        serialized = str(response)
        assert "temporary=signature" not in serialized and "expires_at" not in serialized
        assert all(file.object_key not in serialized for file in UploadedFile.objects.all())
    assert not storage.signatures
