import pytest
from django.contrib.auth import get_user_model

from .models import Change, Participant
from .test_api import authenticated_client, expense, send, uid
from .test_api import client as client
from .test_api import group as group

pytestmark = pytest.mark.django_db


def rename(client, group, name="  Correct name  ", command=None):
    group_id, people, _ = group
    return send(client, "post", f"/groups/{group_id}/participants/{people[1]}/name", {"command_id": command or uid(), "name": name})


def test_guest_name_save_is_idempotent_and_preserves_contact_and_balances(client, group):
    group_id, people, _ = group
    person = Participant.objects.get(pk=people[1])
    person.contact_email = "guest@example.invalid"
    person.save(update_fields=["contact_email"])
    assert send(client, "post", f"/groups/{group_id}/expenses", expense(people)).status_code == 200
    before = send(client, "get", f"/groups/{group_id}").json()
    command = uid()
    result = rename(client, group, command=command)
    assert result.status_code == 200, result.content
    assert rename(client, group, command=command).json() == result.json()
    person.refresh_from_db()
    assert person.name == "Correct name" and person.contact_email == "guest@example.invalid" and person.user_id is None
    after = send(client, "get", f"/groups/{group_id}").json()
    assert after["balances"] == before["balances"]
    assert after["expenses"] == before["expenses"] and after["settlements"] == before["settlements"]
    assert next(p for p in after["participants"] if p["id"] == people[1])["name"] == "Correct name"
    assert Change.objects.filter(group_id=group_id, kind="participant_renamed").count() == 1
    assert rename(client, group, name="Different", command=command).status_code == 409


@pytest.mark.parametrize("name", ["", "   ", "x" * 121])
def test_invalid_names_are_rejected(client, group, name):
    assert rename(client, group, name).status_code == 422


@pytest.mark.parametrize("blocked", ["joined", "removed", "archived", "other_group"])
def test_registered_removed_archived_and_wrong_group_people_are_not_editable(client, group, blocked):
    group_id, people, _ = group
    person = Participant.objects.get(pk=people[1])
    if blocked == "joined":
        person.user = get_user_model().objects.create_user(username=uid())
        person.save(update_fields=["user"])
    elif blocked == "removed":
        person.removed = True
        person.save(update_fields=["removed"])
    elif blocked == "archived":
        person.group.archived = True
        person.group.save(update_fields=["archived"])
    else:
        group = (uid(), people, {})
    assert rename(client, group).status_code in [404, 409]


def test_only_organizer_can_rename_a_guest(client, group):
    _, people, _ = group
    user = get_user_model().objects.create_user(username=uid())
    person = Participant.objects.get(pk=people[2])
    person.user = user
    person.save(update_fields=["user"])
    assert rename(authenticated_client(user), group).status_code == 403
