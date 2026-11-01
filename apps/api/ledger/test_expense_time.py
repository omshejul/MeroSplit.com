import csv
import io

import pytest

from .models import Group
from .portability import accepted_export, csv_export
from .services import snapshot
from .test_api import client as client
from .test_api import expense, send, uid
from .test_api import group as group

pytestmark = pytest.mark.django_db


def test_optional_time_survives_reads_legacy_edits_and_explicit_removal(client, group):
    group_id, ids, _ = group
    original = {**expense(ids), "time": "14:09"}
    path = f"/groups/{group_id}/expenses"
    assert send(client, "post", path, original).status_code == 200
    assert send(client, "post", path, original).status_code == 200
    current = Group.objects.get(pk=group_id)
    assert snapshot(current)["expenses"][0]["time"] == "14:09"
    exported = accepted_export(client.actor, group_id)
    assert list(csv.DictReader(io.StringIO(csv_export(exported))))[0]["time"] == "14:09"
    assert send(client, "get", f"/groups/{group_id}/summary").json()["transactions"][0]["bill"]["time"] == "14:09"
    assert send(client, "get", f"{path}/{original['id']}").json()["time"] == "14:09"
    edited = {**original, "command_id": uid(), "version": 1, "description": "Changed name"}
    del edited["time"]
    assert send(client, "put", f"{path}/{original['id']}", edited).status_code == 200
    assert snapshot(current)["expenses"][0]["time"] == "14:09"
    cleared = {**edited, "command_id": uid(), "version": 2, "time": None}
    assert send(client, "put", f"{path}/{original['id']}", cleared).status_code == 200
    assert snapshot(current)["expenses"][0]["time"] is None
    history = send(client, "get", f"{path}/{original['id']}/versions").json()
    assert any(c == {"field": "time", "before": "14:09", "after": None} for row in history["items"] for c in row["changes"])


@pytest.mark.parametrize("time", ["24:00", "14:60", "2:09", "14:09:00", "14:09Z", 1409])
def test_time_rejects_invalid_or_timezone_values(client, group, time):
    group_id, ids, _ = group
    assert send(client, "post", f"/groups/{group_id}/expenses", {**expense(ids), "time": time}).status_code == 422


def test_date_only_commands_keep_existing_idempotency(client, group):
    group_id, ids, _ = group
    payload = expense(ids)
    assert send(client, "post", f"/groups/{group_id}/expenses", payload).status_code == 200
    assert send(client, "post", f"/groups/{group_id}/expenses", payload).status_code == 200
    assert snapshot(Group.objects.get(pk=group_id))["expenses"][0]["time"] is None
