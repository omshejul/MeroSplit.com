import base64
import io

import pytest
from botocore.exceptions import EndpointConnectionError
from django.test import Client
from PIL import Image

from .models import Change, Group, UploadedFile
from .services import snapshot
from .test_api import client as client
from .test_api import group as group
from .test_api import send, uid
from .test_collaboration import account, link
from .test_media import bill as bill
from .test_media import pdf_bytes, post_file
from .test_media import storage as storage

pytestmark = pytest.mark.django_db


def attach_pdf(client, bill):
    result = post_file(client, bill[2], data=pdf_bytes(pages=2), name="Receipt.pdf", content_type="application/pdf")
    assert result.status_code == 200, result.content
    return result.json()["attachment"]["id"]


def test_real_pdf_thumbnail_is_small_private_first_page_without_storage_or_ledger_writes(client, bill, storage):
    file_id = attach_pdf(client, bill)
    before = snapshot(Group.objects.get(id=bill[0]))
    changes, objects = Change.objects.count(), dict(storage.objects)
    response = send(client, "get", f"/media/{file_id}/thumbnail")
    assert response.status_code == 200, response.content
    assert response["Cache-Control"] == "private, no-store"
    assert set(response.json()) == {"data_url"}
    prefix, encoded = response.json()["data_url"].split(",", 1)
    assert prefix == "data:image/jpeg;base64"
    with Image.open(io.BytesIO(base64.b64decode(encoded))) as image:
        assert image.format == "JPEG" and image.size == (224, 150)
        assert image.convert("L").getextrema()[0] < 100  # Actual rendered receipt text, not a blank icon.
    assert len(response.content) < 100_000
    assert storage.objects == objects and len(storage.puts) == 1 and storage.deletes == []
    assert UploadedFile.objects.count() == 1 and Change.objects.count() == changes
    assert snapshot(Group.objects.get(id=bill[0])) == before


def test_browser_thumbnail_uses_cookie_auth_and_current_account_scope(client, bill, storage):
    file_id = attach_pdf(client, bill)
    browser = Client()
    browser.force_login(client.actor, backend="allauth.account.auth_backends.AuthenticationBackend")
    path = f"/api/v1/media/{file_id}/thumbnail"
    assert browser.get(path, HTTP_X_MEROSPLIT_ACCOUNT=str(client.actor.pk)).status_code == 200
    storage.reads.clear()
    assert browser.get(path, HTTP_X_MEROSPLIT_ACCOUNT=str(client.actor.pk + 1)).status_code == 401
    assert storage.reads == []


def test_thumbnail_rechecks_membership_archive_reversal_and_removal_before_storage(client, bill, group, storage):
    file_id = attach_pdf(client, bill)
    path = f"/media/{file_id}/thumbnail"
    outsider = account()
    assert send(Client(), "get", path).status_code == 401
    assert send(outsider, "get", path).status_code == 404
    assert storage.reads == []
    link(client, outsider, bill[0], group[1][1])
    assert send(outsider, "get", path).status_code == 200
    Group.objects.filter(id=bill[0]).update(archived=True)
    assert send(outsider, "get", path).status_code == 200
    Group.objects.filter(id=bill[0]).update(archived=False)
    group_record = Group.objects.get(id=bill[0])
    group_record.participants.filter(id=group[1][1]).update(removed=True)
    storage.reads.clear()
    assert send(outsider, "get", path).status_code == 404 and storage.reads == []
    assert send(client, "post", f"/groups/{bill[0]}/expenses/{bill[1]}/reverse", {"command_id": uid(), "version": 1}).status_code == 200
    assert send(client, "get", path).status_code == 404 and storage.reads == []


def test_removed_and_non_pdf_files_do_not_reach_thumbnail_storage(client, bill, storage):
    image_id = post_file(client, bill[2]).json()["attachment"]["id"]
    assert send(client, "get", f"/media/{image_id}/thumbnail").status_code == 404
    file_id = attach_pdf(client, bill)
    assert send(client, "delete", f"{bill[2]}/{file_id}").status_code == 200
    assert send(client, "get", f"/media/{file_id}/thumbnail").status_code == 404
    assert storage.reads == []


def test_preview_failure_is_retryable_and_full_file_url_still_works(client, bill, storage, monkeypatch):
    file_id = attach_pdf(client, bill)
    path = f"/media/{file_id}/thumbnail"
    key = UploadedFile.objects.get(id=file_id).object_key
    original = storage.objects[key]
    for corrupt in [b"invalid PDF", b"x" * (20 * 1024 * 1024 + 1)]:
        storage.objects[key] = corrupt
        response = send(client, "get", path)
        assert response.status_code == 503 and "tap the file" in response.json()["detail"]
    storage.objects[key] = original
    with monkeypatch.context() as patch:
        patch.setattr(storage, "get_object", lambda **kw: (_ for _ in ()).throw(EndpointConnectionError(endpoint_url="https://synthetic.invalid")))
        assert send(client, "get", path).status_code == 503
        assert send(client, "get", f"/media/{file_id}/url").status_code == 200
    assert send(client, "get", path).status_code == 200
