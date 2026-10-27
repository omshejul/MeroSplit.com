import pytest
from allauth.socialaccount.models import SocialAccount
from django.contrib.auth import get_user_model
from ninja.errors import HttpError

from .media import _visible_file, profile_photos
from .models import Group, Participant, UploadedFile

pytestmark = pytest.mark.django_db


def test_photo_precedence_and_current_group_member_visibility():
    owner = get_user_model().objects.create_user(username="photo-owner")
    viewer = get_user_model().objects.create_user(username="photo-viewer")
    social = SocialAccount.objects.create(user=owner, provider="google", uid="photo-sub", extra_data={"picture": "https://lh3.googleusercontent.com/photo-v1"})
    assert profile_photos([owner.pk])[owner.pk] == {"url": social.extra_data["picture"]}
    file = UploadedFile.objects.create(avatar_owner=owner, uploaded_by=owner, object_key="photo-test", source_hash="a" * 64, name="Photo", content_type="image/jpeg", size=20, state="active")
    assert profile_photos([owner.pk])[owner.pk]["id"] == str(file.pk)
    with pytest.raises(HttpError):
        _visible_file(viewer, file.pk)
    group = Group.objects.create(owner=owner, name="Shared")
    Participant.objects.create(group=group, user=owner, name="Owner")
    member = Participant.objects.create(group=group, user=viewer, name="Viewer")
    assert _visible_file(viewer, file.pk).pk == file.pk
    member.removed = True
    member.save()
    with pytest.raises(HttpError):
        _visible_file(viewer, file.pk)
    file.state = "deleted"
    file.save()
    assert profile_photos([owner.pk])[owner.pk] == {"url": social.extra_data["picture"]}


@pytest.mark.parametrize("url", ["http://lh3.googleusercontent.com/a", "https://googleusercontent.com.evil.test/a", "https://evil.test/a", "file:///photo", "https://user@lh3.googleusercontent.com/a"])
def test_untrusted_provider_photo_urls_are_not_exposed(url):
    owner = get_user_model().objects.create_user(username="invalid-photo")
    SocialAccount.objects.create(user=owner, provider="google", uid="invalid-photo-sub", extra_data={"picture": url})
    assert profile_photos([owner.pk]) == {}


def test_group_index_refreshes_current_member_photos_without_changing_ledger_version():
    from .test_api import authenticated_client, send

    owner = get_user_model().objects.create_user(username="index-photo-owner")
    viewer = get_user_model().objects.create_user(username="index-photo-viewer")
    outsider = get_user_model().objects.create_user(username="index-photo-outsider")
    group = Group.objects.create(owner=owner, name="Shared")
    Participant.objects.create(group=group, user=owner, name="Owner")
    member = Participant.objects.create(group=group, user=viewer, name="Viewer")
    social = SocialAccount.objects.create(user=owner, provider="google", uid="index-photo-sub", extra_data={"picture": "https://lh3.googleusercontent.com/v1"})
    client = authenticated_client(viewer)
    before = group.version
    result = send(client, "get", "/groups").json()
    assert result["profile_photos"][str(owner.pk)]["url"].endswith("v1")
    social.extra_data["picture"] = "https://lh3.googleusercontent.com/v2"
    social.save()
    result = send(client, "get", "/groups").json()
    assert result["profile_photos"][str(owner.pk)]["url"].endswith("v2")
    group.refresh_from_db()
    assert group.version == before
    assert send(authenticated_client(outsider), "get", "/groups").json() == {"groups": []}
    member.removed = True
    member.save()
    assert send(client, "get", "/groups").json() == {"groups": []}
