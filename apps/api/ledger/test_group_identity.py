import io

import pytest
from botocore.exceptions import EndpointConnectionError
from django.db import IntegrityError, transaction
from PIL import Image

from . import media
from .history_reads import account_activity
from .models import Group, Participant, UploadedFile
from .test_api import client as client
from .test_api import group as group
from .test_api import send, uid
from .test_collaboration import account, link
from .test_media import post_file
from .test_media import storage as storage

pytestmark = pytest.mark.django_db


def photo(color="navy"):
    data = io.BytesIO()
    Image.new("RGB", (700, 600), color).save(data, format="PNG", pnginfo=None)
    return data.getvalue()


def version(group_id):
    return Group.objects.get(id=group_id).version


def rename(client, group_id, name, *, person=None, command=None, revision=None):
    return send(client, "post", f"/groups/{group_id}" + (f"/participants/{person}/nickname" if person else "/name"),
                {"command_id": command or uid(), "version": version(group_id) if revision is None else revision, "name": name})


def test_member_edits_shared_identity_and_activity_visible_to_every_member(client, group, storage):
    group_id, ids, _ = group
    member = account()
    link(client, member, group_id, ids[1])
    before = send(client, "get", f"/groups/{group_id}").json()
    renamed = rename(member, group_id, "Goa trip", command=(command := uid()))
    assert renamed.status_code == 200
    retry = rename(member, group_id, "Goa trip", command=command, revision=renamed.json()["version"] - 1)
    assert retry.json() == renamed.json()
    upload_id = uid()
    uploaded = post_file(member, f"/groups/{group_id}/photo", data=photo(), file_id=upload_id)
    assert uploaded.status_code == 200, uploaded.content
    assert post_file(member, f"/groups/{group_id}/photo", data=photo(), file_id=upload_id).json() == uploaded.json()
    assert len(storage.puts) == 1
    for path in (f"/groups/{group_id}", f"/groups/{group_id}/summary", f"/groups/{group_id}/photo"):
        assert send(client, "get", path).json()["group_photo"]["id"] == upload_id
    assert send(client, "get", "/groups").json()["groups"][0]["group_photo"]["id"] == upload_id
    nick = rename(member, group_id, "Captain", person=ids[0])
    assert nick.status_code == 200
    assert Participant.objects.get(pk=ids[0]).name == "A"
    assert Participant.objects.get(pk=ids[0]).display_name_override == "Captain"
    for actor in (client.actor, member.actor):
        items = account_activity(actor)["items"]
        names = next(item for item in items if item["kind"] == "member_nickname_changed")
        assert names["name_change"] == {"before": "A", "after": "Captain"}
        assert names["person"]["id"] == ids[0]
        assert next(item for item in items if item["kind"] == "group_renamed")["name_change"] == {"before": before["name"], "after": "Goa trip"}
        assert sum(item["kind"] == "group_photo_changed" for item in items) == 1
    assert account_activity(account().actor)["items"] == []
    after = send(member, "get", f"/groups/{group_id}").json()
    assert (after["balances"], after["transfers"], after["expenses"], after["settlements"]) == (before["balances"], before["transfers"], before["expenses"], before["settlements"])
    assert send(client, "delete", f"/groups/{group_id}/photo/{upload_id}").status_code == 200
    assert send(member, "delete", f"/groups/{group_id}/photo/{upload_id}").status_code == 200
    assert send(member, "get", f"/media/{upload_id}/url").status_code == 404
    assert send(client, "get", f"/groups/{group_id}/photo").json()["group_photo"] is None
    assert sum(item["kind"] == "group_photo_removed" for item in account_activity(member.actor)["items"]) == 1


def test_group_nickname_never_changes_account_other_groups_or_recorded_label(client, group):
    group_id, ids, _ = group
    client.actor.first_name = "Om"
    client.actor.save(update_fields=["first_name"])
    other = Group.objects.create(name="Other", owner=client.actor)
    other_person = Participant.objects.create(group=other, user=client.actor, name="Recorded")
    assert rename(client, group_id, "Omi", person=ids[0]).status_code == 200
    client.actor.refresh_from_db()
    other_person.refresh_from_db()
    assert client.actor.first_name == "Om" and other_person.display_name_override == ""
    assert rename(client, group_id, "", person=ids[0]).status_code == 200
    state = send(client, "get", f"/groups/{group_id}/summary").json()
    person = next(person for person in state["participants"] if person["id"] == ids[0])
    assert person["name"] == "Om" and person["recorded_name"] == "A" and person["default_name"] == "Om"
    # Unclaimed members can have group-only nicknames as well.
    assert rename(client, group_id, "Guest", person=ids[2]).status_code == 200
    assert Participant.objects.get(pk=ids[2]).name == "C"


@pytest.mark.parametrize("state,status", [("outsider", 404), ("removed", 404), ("archived", 409), ("direct", 422)])
def test_identity_writes_enforce_group_access_before_upload(client, group, storage, state, status):
    group_id, ids, _ = group
    actor = client
    if state == "outsider":
        actor = account()
    elif state == "removed":
        Participant.objects.filter(pk=ids[0]).update(removed=True)
    elif state == "archived":
        Group.objects.filter(pk=group_id).update(archived=True)
    else:
        Group.objects.filter(pk=group_id).update(is_direct=True)
    assert rename(actor, group_id, "Changed").status_code == status
    assert rename(actor, group_id, "Changed", person=ids[1]).status_code == status
    assert post_file(actor, f"/groups/{group_id}/photo", data=photo()).status_code == status
    assert send(actor, "delete", f"/groups/{group_id}/photo/{uid()}").status_code == status
    assert not storage.puts


def test_name_validation_conflicts_cross_group_target_and_retry(client, group):
    group_id, ids, _ = group
    assert rename(client, group_id, "   ").status_code == 422
    assert rename(client, group_id, "x" * 121).status_code == 422
    assert rename(client, group_id, "No", revision=0).status_code == 409
    other = Group.objects.create(name="Other", owner=client.actor)
    person = Participant.objects.create(group=other, name="Unrelated")
    assert rename(client, group_id, "No", person=str(person.pk)).status_code == 404
    Participant.objects.filter(pk=ids[2]).update(removed=True)
    assert rename(client, group_id, "No", person=ids[2]).status_code == 404
    command = uid()
    old_version = version(group_id)
    assert rename(client, group_id, "Name", person=ids[1], command=command).status_code == 200
    assert rename(client, group_id, "Name", person=ids[1], command=command, revision=old_version).status_code == 200
    assert rename(client, group_id, "Different", person=ids[1], command=command).status_code == 409
    assert rename(client, group_id, "Stale", person=ids[1], revision=old_version).status_code == 409


def test_group_photo_replacement_cleanup_retry_and_stale_remove(client, group, storage):
    group_id = group[0]
    path = f"/groups/{group_id}/photo"
    first = post_file(client, path, data=photo()).json()["group_photo"]
    with Image.open(io.BytesIO(next(iter(storage.objects.values())))) as image:
        assert max(image.size) == 512 and image.format == "JPEG" and not image.getexif()
    second = post_file(client, path, data=photo("red")).json()["group_photo"]
    assert first["id"] != second["id"]
    assert UploadedFile.objects.get(pk=first["id"]).purged
    assert send(client, "delete", f"{path}/{first['id']}").status_code == 200
    assert send(client, "get", path).json()["group_photo"]["id"] == second["id"]
    assert send(account(), "get", f"/media/{second['id']}/url").status_code == 404
    storage.fail_delete = EndpointConnectionError(endpoint_url="https://storage.invalid")
    removed = send(client, "delete", f"{path}/{second['id']}")
    assert removed.json()["cleanup_pending"] is True
    assert not UploadedFile.objects.get(pk=second["id"]).purged
    storage.fail_delete = None
    assert media.purge_stale_files()["pending"] == 0
    assert UploadedFile.objects.get(pk=second["id"]).purged
    assert post_file(client, path, data=photo("red"), file_id=second["id"]).status_code == 409
    assert post_file(client, path, data=b"%PDF-invalid").status_code == 422
    assert post_file(client, path, data=b"x" * (5 * media.MIB + 1)).status_code == 422


def test_revoked_after_put_cannot_publish_photo(client, group, storage):
    group_id, ids, _ = group
    storage.after_put = lambda: Participant.objects.filter(pk=ids[0]).update(removed=True)
    response = post_file(client, f"/groups/{group_id}/photo", data=photo())
    assert response.status_code == 404
    assert not UploadedFile.objects.filter(icon_group_id=group_id, state="active").exists()
    assert not storage.objects


def test_group_photo_scope_constraints(client, group, storage):
    group_id = group[0]
    file_id = post_file(client, f"/groups/{group_id}/photo", data=photo()).json()["group_photo"]["id"]
    with pytest.raises(IntegrityError), transaction.atomic():
        UploadedFile.objects.filter(pk=file_id).update(avatar_owner=client.actor)
    with pytest.raises(IntegrityError), transaction.atomic():
        UploadedFile.objects.create(icon_group_id=group_id, state="active", object_key="synthetic/duplicate", size=1)


def test_account_deletion_removes_group_photos_and_scrubs_name_activity(client, group, storage):
    group_id, ids, _ = group
    member = account()
    link(client, member, group_id, ids[1])
    rename(client, group_id, "Private group title")
    rename(member, group_id, "Private nickname", person=ids[0])
    rename(client, group_id, "Authored nickname", person=ids[1])
    file_id = post_file(client, f"/groups/{group_id}/photo", data=photo()).json()["group_photo"]["id"]
    assert send(client, "delete", "/account").status_code == 200
    assert send(member, "get", f"/media/{file_id}/url").status_code == 404
    assert Participant.objects.get(pk=ids[1]).display_name_override == ""
    names = [item["name_change"] for item in account_activity(member.actor)["items"] if "name_change" in item]
    assert all(row == {"before": "Removed name", "after": "Removed name"} for row in names)


def test_deleting_a_name_editor_preserves_import_identity_and_other_members_edits(client, group):
    group_id, ids, _ = group
    member = account()
    link(client, member, group_id, ids[1])
    Group.objects.filter(pk=group_id).update(import_source_hash="f" * 64)
    assert rename(member, group_id, "Authored group name").status_code == 200
    assert rename(member, group_id, "First nickname", person=ids[2]).status_code == 200
    assert rename(client, group_id, "Later nickname", person=ids[2]).status_code == 200
    assert send(member, "delete", "/account").status_code == 200
    current = Group.objects.get(pk=group_id)
    assert current.name == "Shared group" and current.import_source_hash == "f" * 64
    assert Participant.objects.get(pk=ids[2]).display_name_override == "Later nickname"
