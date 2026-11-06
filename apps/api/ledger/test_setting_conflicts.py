import pytest

from .models import Group
from .test_api import client as client
from .test_api import expense, send, uid
from .test_api import group as group

pytestmark = pytest.mark.django_db


@pytest.mark.parametrize('setting', ['name', 'nickname', 'simplify'])
def test_unrelated_bill_does_not_conflict_with_saved_setting_but_same_field_does(client, group, setting):
    gid, people, _ = group
    version = Group.objects.get(pk=gid).version
    path = f'/groups/{gid}/' + (f'participants/{people[1]}/nickname' if setting == 'nickname' else setting)

    def change(command_id, revision, other=False):
        return send(client, 'post', path, {'command_id': command_id, 'version': revision, **({'simplify_debts': other} if setting == 'simplify' else {'name': 'Other' if other else 'My change'})})

    assert send(client, 'post', f'/groups/{gid}/expenses', expense(people)).status_code == 200
    command = uid()
    first = change(command, version)
    assert first.status_code == 200, first.content
    assert change(command, version).json() == first.json()
    assert change(uid(), version, True).status_code == 409
    assert change(uid(), Group.objects.get(pk=gid).version + 1, True).status_code == 409


def test_nickname_of_another_person_is_independent(client, group):
    gid, people, _ = group
    version = Group.objects.get(pk=gid).version
    for person in people[1:]:
        result = send(client, 'post', f'/groups/{gid}/participants/{person}/nickname', {'command_id': uid(), 'version': version, 'name': 'Trip name'})
        assert result.status_code == 200, result.content
