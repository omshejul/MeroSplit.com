import json

import pytest
from django.contrib.auth import get_user_model
from django.contrib.sessions.models import Session
from django.test import Client, RequestFactory

from .api import ledger_heads
from .models import Change, CommandReceipt, Group, Participant
from .test_api import authenticated_client, expense, send, uid

pytestmark = pytest.mark.django_db


def test_heads_use_current_authorized_membership_without_ledger_or_profile_content():
    owner = get_user_model().objects.create_user(username="heads-owner")
    viewer = get_user_model().objects.create_user(username="heads-viewer")
    outsider = get_user_model().objects.create_user(username="heads-outsider")
    group = Group.objects.create(owner=owner, name="Private bill titles stay out", version=9, archived=True)
    Participant.objects.create(group=group, user=owner, name="Owner")
    membership = Participant.objects.create(group=group, user=viewer, name="Viewer", hidden=True)
    client = authenticated_client(viewer)
    response = send(client, "get", "/me/ledger-heads")
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    assert response.json() == {"groups": [{"id": str(group.pk), "version": 9, "hidden": True}]}
    assert send(authenticated_client(outsider), "get", "/me/ledger-heads").json() == {"groups": []}
    membership.removed = True
    membership.save(update_fields=["removed"])
    assert send(client, "get", "/me/ledger-heads").json() == {"groups": []}
    assert not Change.objects.exists() and not CommandReceipt.objects.exists()


def test_heads_require_current_session_and_enforce_browser_account_binding():
    owner = get_user_model().objects.create_user(username="heads-session")
    assert send(Client(), "get", "/me/ledger-heads").status_code == 401
    browser = Client()
    browser.force_login(owner, backend="allauth.account.auth_backends.AuthenticationBackend")
    assert browser.get("/api/v1/me/ledger-heads", HTTP_X_MEROSPLIT_ACCOUNT=str(owner.pk)).status_code == 200
    assert browser.get("/api/v1/me/ledger-heads", HTTP_X_MEROSPLIT_ACCOUNT=str(owner.pk + 1)).status_code == 401
    native = authenticated_client(owner)
    Session.objects.filter(session_key=native.defaults["HTTP_X_SESSION_TOKEN"]).delete()
    assert send(native, "get", "/me/ledger-heads").status_code == 401


def test_heads_are_one_data_query_and_preserve_store_demo_isolation(settings, django_assert_num_queries):
    real = get_user_model().objects.create_user(username="heads-real")
    demo = get_user_model().objects.create_user(username="heads-demo", email="heads-demo@example.invalid")
    normal = Group.objects.create(owner=real, name="Normal", version=1)
    mixed = Group.objects.create(owner=real, name="Mixed", version=2)
    demo_group = Group.objects.create(owner=demo, name="Demo", version=3)
    for group, people in [(normal, [real]), (mixed, [real, demo]), (demo_group, [demo])]:
        for person in people:
            Participant.objects.create(group=group, user=person, name=person.username)
    settings.STORE_REVIEW_AUTH = [{"user_id": demo.pk, "email": demo.email}]
    request = RequestFactory().get("/api/v1/me/ledger-heads")
    request.auth = real
    with django_assert_num_queries(1):
        data = json.loads(ledger_heads(request).content)
    assert data == {"groups": [{"id": str(normal.pk), "version": 1, "hidden": False}]}
    assert send(authenticated_client(demo), "get", "/me/ledger-heads").json() == {"groups": [{"id": str(demo_group.pk), "version": 3, "hidden": False}]}


def test_another_member_observes_bill_creation_edit_and_payment_versions():
    owner = get_user_model().objects.create_user(username="heads-writer")
    viewer = get_user_model().objects.create_user(username="heads-reader")
    writer = authenticated_client(owner)
    reader = authenticated_client(viewer)
    group_id, ids = uid(), [uid(), uid()]
    created = send(writer, "post", "/groups", {"command_id": uid(), "id": group_id, "name": "Live shared ledger", "self_participant_id": ids[0], "participants": [{"id": ids[0], "name": "Owner"}, {"id": ids[1], "name": "Viewer"}]})
    assert created.status_code == 200, created.content
    Participant.objects.filter(pk=ids[1]).update(user=viewer)
    previous = send(reader, "get", "/me/ledger-heads").json()["groups"][0]
    bill = expense(ids, total="1200", beneficiaries=[1])
    operations = [
        ("post", f"/groups/{group_id}/expenses", bill),
        ("put", f"/groups/{group_id}/expenses/{bill['id']}", {**bill, "command_id": uid(), "version": 1, "description": "Edited live bill"}),
        ("post", f"/groups/{group_id}/settlements", {"command_id": uid(), "id": uid(), "sender": ids[1], "recipient": ids[0], "amount": "600"}),
    ]
    for method, path, body in operations:
        saved = send(writer, method, path, body)
        assert saved.status_code == 200, saved.content
        current = send(reader, "get", "/me/ledger-heads").json()["groups"][0]
        assert current == {**previous, "version": previous["version"] + 1}
        previous = current
