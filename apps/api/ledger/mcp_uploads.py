"""Short-lived, bill-bound direct uploads for agents with local file access."""

import asyncio
import hashlib
from datetime import timedelta

from asgiref.sync import sync_to_async
from django.core import signing
from django.core.files.uploadedfile import SimpleUploadedFile
from django.utils import timezone
from django.views.decorators.debug import sensitive_variables
from ninja.errors import HttpError
from starlette.requests import ClientDisconnect, Request
from starlette.responses import JSONResponse

from . import mcp_oauth, media
from .accounting import AccountingError
from .mcp_files import MAX_FILE_SIZE
from .mcp_models import McpOAuthGrant
from .models import UploadedFile

UPLOAD_PATH = "/mcp/attachments/upload"
TICKET_SALT = "merosplit.mcp.attachment-upload.v1"
TICKET_SECONDS = 600


@sensitive_variables()
def prepare_upload(actor, group_id, bill_id, id, file_name, size, sha256, mime_type, *, access_token):
    identity = mcp_oauth.authenticate_access_token(access_token, enforce_limits=False)
    if identity is None or identity[0].pk != actor.pk:
        raise HttpError(401, "Reconnect MeroSplit to this client")
    _, bill = media._bill(actor, group_id, bill_id, modify=True)
    existing = UploadedFile.objects.filter(id=id).first()
    if existing:
        if existing.uploaded_by_id != actor.pk or existing.expense_id != bill.id or existing.source_hash != sha256:
            raise HttpError(409, "Upload ID already used for different input")
        if existing.state == "deleted":
            raise HttpError(409, "This file was removed; choose the file again")
    elif bill.attachments.filter(state="active").count() >= 10:
        raise HttpError(409, "A bill can have at most 10 attachments")
    payload = {"grant": str(identity[1].pk), "actor": str(actor.pk), "group": str(group_id),
               "bill": str(bill_id), "id": str(id), "name": file_name, "size": size,
               "sha256": sha256, "mime_type": mime_type}
    ticket = signing.dumps(payload, salt=TICKET_SALT, compress=True)
    return {"id": str(id), "upload_url": mcp_oauth.issuer_url() + UPLOAD_PATH, "method": "PUT",
            "headers": {"Authorization": "Bearer " + ticket, "Content-Type": "application/octet-stream"},
            "expires_at": (timezone.now() + timedelta(seconds=TICKET_SECONDS)).isoformat(),
            "size": size, "sha256": sha256}


def get_upload(actor, group_id, bill_id, id):
    group, _ = media._bill(actor, group_id, bill_id)
    file = UploadedFile.objects.filter(id=id, expense_id=bill_id, uploaded_by=actor).first()
    if file is None:
        return {"status": "not_uploaded"}
    if file.state == "active":
        return {"status": "complete", "attachment": media.metadata(file), "version": group.version}
    return {"status": "removed" if file.state == "deleted" else "retry_required"}


@sensitive_variables()
def authorize_upload(ticket, network):
    mcp_oauth.rate_limit("upload-ingress", network)
    try:
        payload = signing.loads(ticket, salt=TICKET_SALT, max_age=TICKET_SECONDS)
    except signing.BadSignature:
        raise HttpError(401, "Upload ticket is invalid or expired; prepare the upload again") from None
    grant = McpOAuthGrant.objects.select_related("user").filter(pk=payload["grant"], user_id=payload["actor"],
        revoked_at__isnull=True, refresh_expires_at__gt=timezone.now(), user__is_active=True,
        scope=mcp_oauth.MCP_SCOPE, resource__in=mcp_oauth.trusted_resources()).first()
    if grant is None:
        raise HttpError(401, "Reconnect MeroSplit to this client")
    mcp_oauth.rate_limit("upload", network, user_id=grant.user_id, grant_id=grant.pk)
    media._bill(grant.user, payload["group"], payload["bill"], modify=True)
    return grant.user, payload


@sensitive_variables()
def save_upload(ticket, network, data):
    # Recheck the connection and membership after the file transfer, before storage.
    actor, payload = authorize_upload(ticket, network)
    upload = SimpleUploadedFile(payload["name"], data, content_type=payload["mime_type"])
    return media.upload_file(actor, payload["id"], upload, group_id=payload["group"], expense_id=payload["bill"])


async def upload_app(scope, receive, send):
    # This route streams directly instead of buffering an unbounded body in Django.
    from django.conf import settings

    from .mcp_server import database_call

    request = Request(scope, receive)
    try:
        hosts, origins = request.headers.getlist("host"), request.headers.getlist("origin")
        if len(hosts) != 1 or hosts[0].lower() not in settings.MCP_ALLOWED_HOSTS:
            raise HttpError(421, "Use the upload URL returned by prepare_attachment_upload")
        if len(origins) > 1 or (origins and origins[0] not in settings.MCP_ALLOWED_ORIGINS):
            raise HttpError(403, "Origin is not allowed")
        if request.method != "PUT":
            raise HttpError(405, "Use PUT with the original file bytes")
        authorization = request.headers.get("authorization", "")
        if len(request.headers.getlist("authorization")) != 1 or not authorization.startswith("Bearer ") or len(authorization) > 4096:
            raise HttpError(401, "Use the upload authorization returned by prepare_attachment_upload")
        ticket = authorization[7:]
        network = (scope.get("client") or ("unknown",))[0]
        _, payload = await sync_to_async(database_call, thread_sensitive=False)(authorize_upload, ticket, network)
        lengths = request.headers.getlist("content-length")
        if lengths != [str(payload["size"])]:
            raise HttpError(422, "Content-Length must match the prepared file size")
        if not 0 < payload["size"] <= MAX_FILE_SIZE:
            raise HttpError(413, "Choose a nonempty file no larger than 20 MiB")
        data, digest = bytearray(), hashlib.sha256()
        async with asyncio.timeout(120):
            async for chunk in request.stream():
                if len(data) + len(chunk) > payload["size"]:
                    raise HttpError(413, "File exceeds the prepared size")
                data.extend(chunk)
                digest.update(chunk)
        if len(data) != payload["size"] or digest.hexdigest() != payload["sha256"]:
            raise HttpError(422, "File size or SHA-256 does not match; retry the original file")
        result = await sync_to_async(database_call, thread_sensitive=False)(save_upload, ticket, network, bytes(data))
        response = JSONResponse(result)
    except HttpError as exc:
        response = JSONResponse({"error": {"status": exc.status_code, "detail": str(exc)}}, status_code=exc.status_code)
    except mcp_oauth.OAuthError as exc:
        response = JSONResponse({"error": {"status": exc.status, "detail": "Too many requests; retry shortly"}},
                                status_code=exc.status, headers={"Retry-After": str(exc.retry_after_seconds)})
    except (AccountingError, ClientDisconnect) as exc:
        response = JSONResponse({"error": {"status": 422, "detail": str(exc) if isinstance(exc, AccountingError) else "Upload interrupted; retry the original file"}}, status_code=422)
    except TimeoutError:
        response = JSONResponse({"error": {"status": 408, "detail": "Upload timed out; retry the original file"}}, status_code=408)
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    if response.status_code == 405:
        response.headers["Allow"] = "PUT"
    await response(scope, receive, send)
