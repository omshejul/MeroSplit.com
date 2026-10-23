"""Private, processed profile photos and bill attachments; no raw object uploads."""

import base64
import hashlib
import io
import logging
import subprocess
import sys
import tempfile
import threading
import warnings
from contextlib import contextmanager
from datetime import timedelta
from pathlib import Path, PurePath
from urllib.parse import quote

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError
from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import connection, transaction
from django.db.models import Q
from django.utils import timezone
from ninja.errors import HttpError
from PIL import Image, ImageOps, UnidentifiedImageError
from pypdf import PdfReader, PdfWriter, apply_configuration
from pypdf.errors import PyPdfError
from pypdf.generic import IndirectObject

from .accounting import AccountingError
from .models import Change, UploadedFile
from .services import visible_group, writable

MIB = 1024 * 1024
URL_SECONDS = 300
logger = logging.getLogger(__name__)
_thumbnail_slots = threading.BoundedSemaphore(1)  # At most one child per API worker.
_THUMBNAIL_WAIT = 0.25
_THUMBNAIL_DEADLINE = 5
_THUMBNAIL_MAX_OUTPUT = 64 * 1024
_THUMBNAIL_RENDERER = Path(__file__).with_name("pdf_thumbnail_renderer.py")


class _Output(io.BytesIO):
    def write(self, data):
        if self.tell() + len(data) > 20 * MIB:
            raise AccountingError("Processed file exceeds 20 MiB; choose a smaller file")
        return super().write(data)


@apply_configuration(
    zlib_maximum_output_length=8 * MIB, lzw_maximum_output_length=8 * MIB,
    jbig2_maximum_output_length=8 * MIB, run_length_maximum_output_length=8 * MIB,
    maximum_declared_stream_length=20 * MIB, array_based_stream_maximum_output_length=8 * MIB,
    stream_decoding_work_maximum_length=40 * MIB, page_tree_maximum_entries=1000,
    page_tree_maximum_depth=60, array_maximum_element_count=20_000,
    dictionary_maximum_element_count=20_000, jbig2dec_binary=None,
)
def _pdf(data: bytes) -> bytes:
    if not data.startswith(b"%PDF-") or not data.rstrip().endswith(b"%%EOF"):
        raise AccountingError("Choose a complete, valid PDF")
    try:
        reader = PdfReader(io.BytesIO(data), strict=True, root_object_recovery_limit=1000)
        if reader.is_encrypted:
            raise AccountingError("Encrypted PDFs cannot be optimized; export an unencrypted copy")
        if sum(len(entries) for entries in reader.xref.values()) + len(reader.xref_objStm) > 20_000:
            raise AccountingError("PDF contains too many objects")
        if not 1 <= len(reader.pages) <= 100:
            raise AccountingError("Choose a PDF with 1–100 pages")
        pending, seen, visited = [(reader.trailer["/Root"], 0)], set(), 0
        while pending:
            value, depth = pending.pop()
            if isinstance(value, IndirectObject):
                key = (value.idnum, value.generation)
                if key in seen:
                    continue
                seen.add(key)
                value = value.get_object()
            if not isinstance(value, (dict, list)):
                continue
            visited += 1
            if visited > 20_000 or depth > 60:
                raise AccountingError("PDF structure exceeds supported resource limits")
            if isinstance(value, dict):
                if (
                    value.get("/FT") == "/Sig" or value.get("/Type") == "/Sig"
                    or any(key in value for key in ("/ByteRange", "/JS", "/JavaScript", "/AA", "/EmbeddedFiles", "/XFA", "/AcroForm"))
                    or value.get("/S") in ("/JavaScript", "/Launch", "/RichMediaExecute", "/SubmitForm", "/ImportData")
                ):
                    raise AccountingError("Signed, interactive or embedded-file PDFs cannot be safely optimized; export a plain PDF")
                pending.extend((child, depth + 1) for child in value.values())
            else:
                pending.extend((child, depth + 1) for child in value)
        writer, content_size = PdfWriter(), 0
        for page in reader.pages:
            contents = page.get_contents()
            content_size += len(contents.get_data()) if contents else 0
            if content_size > 40 * MIB:
                raise AccountingError("PDF content exceeds supported resource limits")
            writer.add_page(page).compress_content_streams(level=6)
        writer.compress_identical_objects(remove_duplicates=True, remove_unreferenced=True)
        writer.add_metadata({"/Producer": "MeroSplit"})
        with _Output() as output:
            writer.write(output)
            return output.getvalue()
    except (PyPdfError, ValueError, KeyError, TypeError, RecursionError, NotImplementedError) as exc:
        if isinstance(exc, AccountingError):
            raise
        raise AccountingError("PDF cannot be safely optimized; export a plain, readable PDF") from exc


def process_file(upload, *, avatar: bool) -> dict:
    """Validate bounded input, then discard it after producing one optimized artifact."""
    limit = (5 if avatar else 20) * MIB
    try:
        if upload.size > limit:
            raise AccountingError(f"Choose a file no larger than {5 if avatar else 20} MiB")
        data = upload.read(limit + 1)
        if not data or len(data) > limit:
            raise AccountingError(f"Choose a nonempty file no larger than {5 if avatar else 20} MiB")
        source_hash = hashlib.sha256(data).hexdigest()
        filename = PurePath(upload.name.replace("\\", "/")).stem
        filename = "".join(c for c in filename if ord(c) >= 32 and c not in ('"', "/"))[:190] or "file"
        if data.startswith(b"%PDF-"):
            if avatar:
                raise AccountingError("Profile photos must be JPEG, PNG or WebP images")
            body, content_type, extension = _pdf(data), "application/pdf", ".pdf"
        else:
            try:
                with warnings.catch_warnings():
                    warnings.simplefilter("error", Image.DecompressionBombWarning)
                    with Image.open(io.BytesIO(data)) as original:
                        if original.format not in {"JPEG", "PNG", "WEBP"} or getattr(original, "n_frames", 1) != 1:
                            raise AccountingError("Choose a single JPEG, PNG or WebP image, or a plain PDF for a bill")
                        if original.width * original.height > 40_000_000:
                            raise AccountingError("Image exceeds 40 megapixels; choose a smaller photo")
                        edge = 512 if avatar else 2400
                        original.draft("RGB", (edge, edge))
                        original.load()
                        image = ImageOps.exif_transpose(original)
                        try:
                            image.thumbnail((edge, edge), Image.Resampling.LANCZOS)
                            # Start a fresh RGB image to discard EXIF, GPS, ICC and text metadata.
                            with Image.new("RGB", image.size, "white") as clean:
                                with image.convert("RGBA") as rgba:
                                    clean.paste(rgba, mask=rgba.getchannel("A"))
                                with _Output() as output:
                                    clean.save(output, "JPEG", quality=82, optimize=True)
                                    body = output.getvalue()
                        finally:
                            image.close()
                content_type, extension = "image/jpeg", ".jpg"
            except (UnidentifiedImageError, OSError, SyntaxError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
                raise AccountingError("File is not a readable JPEG, PNG or WebP image; convert HEIC to JPEG first") from exc
        return {
            "body": body, "source_hash": source_hash, "name": filename + extension,
            "content_type": content_type, "size": len(body),
        }
    finally:
        upload.close()  # Also removes Django's on-disk temporary upload, including failed validation.


def _storage():
    names = ("R2_ENDPOINT_URL", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET")
    if any(not getattr(settings, name, "") for name in names):
        raise HttpError(503, "Private file storage is not configured")
    return boto3.client(
        "s3", endpoint_url=settings.R2_ENDPOINT_URL, region_name=settings.R2_REGION,
        aws_access_key_id=settings.R2_ACCESS_KEY_ID, aws_secret_access_key=settings.R2_SECRET_ACCESS_KEY,
        config=Config(signature_version="s3v4", connect_timeout=3, read_timeout=15, retries={"max_attempts": 2}),
    )


def metadata(file: UploadedFile) -> dict:
    return {"id": str(file.id), "name": file.name, "content_type": file.content_type, "size": file.size}


def avatar_for(actor) -> dict | None:
    file = UploadedFile.objects.filter(avatar_owner=actor, state="active").first()
    return metadata(file) if file else None


def _bill(actor, group_id, expense_id, *, lock=False, modify=False):
    group = visible_group(actor, group_id, lock=lock)
    if modify:
        writable(group)
    expense = group.expenses.filter(id=expense_id, deleted=False).first()
    if not expense:
        raise HttpError(404, "Bill not found")
    return group, expense


def list_attachments(actor, group_id, expense_id) -> dict:
    group, expense = _bill(actor, group_id, expense_id)
    return {
        "attachments": [metadata(f) for f in expense.attachments.filter(state="active").order_by("created_at", "id")],
        "can_modify": not group.archived,
    }


def purge_files(ids) -> bool:
    """Keep failed cleanup keys as tombstones; a repeated remove retries them."""
    pending = False
    for file in UploadedFile.objects.filter(id__in=ids, purged=False).exclude(state="active"):
        try:
            parts = file.object_key.split("/")
            scope = f"avatar:{parts[1]}" if parts[0] == "avatars" else f"bill:{parts[2]}"
            with _media_lock(scope):
                current = UploadedFile.objects.filter(id=file.id, purged=False).exclude(state="active").first()
                if not current:
                    continue
                _storage().delete_object(Bucket=settings.R2_BUCKET, Key=current.object_key)
                fields = {"purged": True}
                if current.state == "deleted" and current.uploaded_by_id is None and current.avatar_owner_id is None:
                    # No in-flight PUT can now recreate this key. Remove the old
                    # avatar user ID/path association after confirmed cleanup.
                    fields.update(object_key=f"deleted/{current.id}", expense=None)
                UploadedFile.objects.filter(id=current.id).exclude(state="active").update(**fields)
        except (BotoCoreError, ClientError, HttpError):
            pending = True
            logger.warning("Private media cleanup pending", extra={"file_id": str(file.id)})
    return pending


def purge_stale_files() -> dict:
    candidates = UploadedFile.objects.filter(purged=False).filter(
        Q(state="deleted") | Q(state="pending", created_at__lt=timezone.now() - timedelta(days=1))
    ).order_by("created_at")[:100]
    cleaned, pending = 0, 0
    for file in candidates:
        parts = file.object_key.split("/")
        scope = f"avatar:{parts[1]}" if parts[0] == "avatars" else f"bill:{parts[2]}"
        try:
            with _media_lock(scope):
                current = UploadedFile.objects.filter(id=file.id, purged=False).exclude(state="active").first()
                if current:
                    current.state = "deleted"
                    current.save(update_fields=["state"])
                    waiting = purge_files([file.id])
                    pending += waiting
                    cleaned += not waiting
        except HttpError as exc:
            if exc.status_code != 409:
                raise
            pending += 1
    return {"cleaned": cleaned, "pending": pending}


def _attachment_change(group, actor, file, removed=False):
    group.version += 1
    group.save(update_fields=["version"])
    Change.objects.create(
        group=group, sequence=group.version, actor=actor,
        kind="attachment_removed" if removed else "attachment_added",
        data={"id": str(file.id), "expense_id": str(file.expense_id)},
    )


@contextmanager
def _media_lock(scope):
    # Serialize retries and cleanup without holding a transaction across R2 calls.
    key = int.from_bytes(hashlib.sha256(scope.encode()).digest()[:8], signed=True)
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_try_advisory_lock(%s)", [key])
        if not cursor.fetchone()[0]:
            raise HttpError(409, "A file update is already in progress; try again shortly")
    try:
        yield
    finally:
        with connection.cursor() as cursor:
            cursor.execute("SELECT pg_advisory_unlock(%s)", [key])


def _lock_actor(actor):
    if not get_user_model().objects.select_for_update().filter(pk=actor.pk, is_active=True).exists():
        raise HttpError(401, "Sign in again before uploading a photo")


def upload_file(actor, file_id, upload, *, group_id=None, expense_id=None) -> dict:
    try:
        with _media_lock(f"avatar:{actor.pk}" if group_id is None else f"bill:{expense_id}"):
            return _upload_file(actor, file_id, upload, group_id=group_id, expense_id=expense_id)
    finally:
        upload.close()


def _upload_file(actor, file_id, upload, *, group_id=None, expense_id=None) -> dict:
    avatar = group_id is None
    try:
        # Deny unauthorized files before decoding or contacting R2.
        if not avatar:
            _bill(actor, group_id, expense_id, modify=True)
        processed = process_file(upload, avatar=avatar)
        with transaction.atomic():
            if avatar:
                _lock_actor(actor)
                group, expense = None, None
            else:
                group, expense = _bill(actor, group_id, expense_id, lock=True, modify=True)
            file = UploadedFile.objects.filter(id=file_id).first()
            if file:
                if (
                    file.uploaded_by_id != actor.pk or file.source_hash != processed["source_hash"]
                    or file.avatar_owner_id != (actor.pk if avatar else None)
                    or file.expense_id != (expense.id if expense else None)
                ):
                    raise HttpError(409, "Upload ID already used for different input")
                if file.state == "deleted":
                    raise HttpError(409, "This file was removed; choose the file again")
                if file.state == "active":
                    waiting = UploadedFile.objects.filter(avatar_owner=actor, state="deleted", purged=False).exists() if avatar else False
                    return {"avatar": metadata(file), "cleanup_pending": waiting} if avatar else {"attachment": metadata(file), "version": group.version}
            else:
                if expense and expense.attachments.filter(state="active").count() >= 10:
                    raise HttpError(409, "A bill can have at most 10 attachments")
                key = f"avatars/{actor.pk}/{file_id}.jpg" if avatar else f"bills/{group.id}/{expense.id}/{file_id}{PurePath(processed['name']).suffix}"
                file = UploadedFile.objects.create(
                    id=file_id, avatar_owner=actor if avatar else None, expense=expense,
                    uploaded_by=actor, object_key=key,
                    **{key: processed[key] for key in ("source_hash", "name", "content_type", "size")},
                )
            UploadedFile.objects.filter(id=file.id).update(purged=False)
        try:
            _storage().put_object(
                Bucket=settings.R2_BUCKET, Key=file.object_key, Body=processed["body"],
                ContentType=file.content_type, CacheControl="private, max-age=300",
            )
            UploadedFile.objects.filter(id=file.id).update(purged=False)
            with transaction.atomic():
                if avatar:
                    _lock_actor(actor)
                else:
                    group, expense = _bill(actor, group_id, expense_id, lock=True, modify=True)
                current = UploadedFile.objects.select_for_update().get(id=file.id)
                if current.state == "deleted":
                    raise HttpError(409, "This upload was removed before it finished")
                old_ids = []
                if current.state != "active":
                    if avatar:
                        old = UploadedFile.objects.filter(avatar_owner=actor, state="active").exclude(id=current.id)
                        old_ids = list(old.values_list("id", flat=True))
                        old.update(state="deleted")
                    elif expense.attachments.filter(state="active").count() >= 10:
                        raise HttpError(409, "A bill can have at most 10 attachments")
                    current.state = "active"
                    current.save(update_fields=["state"])
                    if not avatar:
                        _attachment_change(group, actor, current)
        except Exception as exc:
            UploadedFile.objects.filter(id=file.id).exclude(state="active").update(purged=False)
            purge_files([file.id])
            if isinstance(exc, (BotoCoreError, ClientError)):
                raise HttpError(503, "Upload could not finish; retry the same file") from exc
            raise
        cleanup_pending = purge_files(old_ids)
        return {"avatar": metadata(current), "cleanup_pending": cleanup_pending} if avatar else {"attachment": metadata(current), "version": group.version}
    finally:
        upload.close()


def remove_avatar(actor) -> dict:
    with _media_lock(f"avatar:{actor.pk}"):
        with transaction.atomic():
            _lock_actor(actor)
            files = UploadedFile.objects.filter(avatar_owner=actor)
            ids = list(files.values_list("id", flat=True))
            files.update(state="deleted")
        return {"removed": True, "cleanup_pending": purge_files(ids)}


def remove_attachment(actor, group_id, expense_id, file_id) -> dict:
    with _media_lock(f"bill:{expense_id}"):
        return _remove_attachment(actor, group_id, expense_id, file_id)


def _remove_attachment(actor, group_id, expense_id, file_id) -> dict:
    with transaction.atomic():
        group, expense = _bill(actor, group_id, expense_id, lock=True, modify=True)
        file = UploadedFile.objects.filter(id=file_id, expense=expense).first()
        if file:
            if file.state == "active":
                _attachment_change(group, actor, file, removed=True)
            file.state = "deleted"
            file.save(update_fields=["state"])
    return {"removed": True, "cleanup_pending": purge_files([file_id]) if file else False, "version": group.version}


def _visible_file(actor, file_id) -> UploadedFile:
    file = UploadedFile.objects.select_related("expense").filter(id=file_id, state="active").first()
    if not file:
        raise HttpError(404, "File not found")
    if file.avatar_owner_id:
        if file.avatar_owner_id != actor.pk:
            raise HttpError(404, "File not found")
    elif file.expense_id:
        _bill(actor, file.expense.group_id, file.expense_id)
    else:
        raise HttpError(404, "File not found")
    return file


def _render_pdf_thumbnail(data: bytes) -> bytes:
    # Anonymous output is unlinked immediately; the child caps its file size.
    with tempfile.TemporaryFile() as output:
        # run() kills and reaps on timeout instead of abandoning native work.
        subprocess.run(
            [sys.executable, "-I", "-B", str(_THUMBNAIL_RENDERER)],
            stdout=output, stderr=subprocess.DEVNULL, env={}, close_fds=True, start_new_session=True,
            input=data, timeout=_THUMBNAIL_DEADLINE, check=True,
        )
        output.seek(0)
        result = output.read(_THUMBNAIL_MAX_OUTPUT + 1)
    if not result or len(result) > _THUMBNAIL_MAX_OUTPUT or not result.endswith(b"\xff\xd9"):
        raise ValueError("Invalid preview output")
    with Image.open(io.BytesIO(result)) as image:
        if image.format != "JPEG" or not all(0 < value <= 224 for value in image.size):
            raise ValueError("Invalid preview image")
        image.verify()
    return result


def pdf_thumbnail(actor, file_id) -> dict:
    file = _visible_file(actor, file_id)
    if file.content_type != "application/pdf":
        raise HttpError(404, "PDF not found")
    unavailable = "Preview unavailable; tap the file to open it or retry the preview"
    if not _thumbnail_slots.acquire(timeout=_THUMBNAIL_WAIT):
        raise HttpError(503, unavailable)
    try:
        with _storage().get_object(Bucket=settings.R2_BUCKET, Key=file.object_key)["Body"] as body:
            data = body.read(20 * MIB + 1)
        if len(data) > 20 * MIB:
            raise ValueError("PDF exceeds the attachment limit")
        image_data = base64.b64encode(_render_pdf_thumbnail(data)).decode("ascii")
        return {"data_url": f"data:image/jpeg;base64,{image_data}"}
    except (BotoCoreError, ClientError, subprocess.SubprocessError, ValueError, OSError) as exc:
        raise HttpError(503, unavailable) from exc
    finally:
        _thumbnail_slots.release()


def download_url(actor, file_id) -> dict:
    file = _visible_file(actor, file_id)
    try:
        url = _storage().generate_presigned_url(
            "get_object", Params={
                "Bucket": settings.R2_BUCKET, "Key": file.object_key,
                "ResponseContentType": file.content_type,
                "ResponseContentDisposition": f"inline; filename=\"file{PurePath(file.name).suffix}\"; filename*=UTF-8''{quote(file.name, safe='')}",
                "ResponseCacheControl": "private, no-store",
            }, ExpiresIn=URL_SECONDS,
        )
    except (BotoCoreError, ClientError) as exc:
        raise HttpError(503, "File could not be opened; try again") from exc
    return {"url": url, "expires_at": (timezone.now() + timedelta(seconds=URL_SECONDS)).isoformat()}
