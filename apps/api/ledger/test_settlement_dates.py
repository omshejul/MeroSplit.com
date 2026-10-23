import csv
import hashlib
import io
import json

import pytest
from django.utils import timezone

from .models import CommandReceipt, Settlement
from .test_api import client as client
from .test_api import group as group
from .test_api import send, uid

pytestmark = pytest.mark.django_db


@pytest.mark.parametrize("date_input,expected", [
    ({}, "today"), ({"date": None}, None), ({"date": "2025-04-02"}, "2025-04-02"),
])
def test_settlement_date_omission_is_today_but_explicit_null_stays_unknown(client, group, date_input, expected):
    group_id, ids, _ = group
    body = {
        "command_id": uid(), "id": uid(), "sender": ids[0], "recipient": ids[1], "amount": "5000",
        **date_input,
    }
    response = send(client, "post", f"/groups/{group_id}/settlements", body)
    assert response.status_code == 200, response.content
    assert send(client, "post", f"/groups/{group_id}/settlements", body).status_code == 200
    expected = timezone.localdate().isoformat() if expected == "today" else expected
    saved = Settlement.objects.get(pk=body["id"])
    assert (saved.date.isoformat() if saved.date else None) == expected
    snapshot = send(client, "get", f"/groups/{group_id}").json()
    assert snapshot["settlements"][0]["date"] == expected
    assert snapshot["activity"][-1]["data"]["date"] == expected
    exported = send(client, "get", f"/groups/{group_id}/export").json()
    assert exported["group"]["settlements"][0]["date"] == expected
    csv_response = send(client, "get", f"/groups/{group_id}/export?format=csv")
    rows = list(csv.DictReader(io.StringIO(csv_response.content.decode())))
    assert {row["date"] for row in rows if row["kind"] == "settlement"} == {expected or ""}
    assert Settlement.objects.count() == 1


def test_unknown_and_omitted_dates_are_different_command_inputs(client, group):
    group_id, ids, _ = group
    body = {"command_id": uid(), "id": uid(), "sender": ids[0], "recipient": ids[1], "amount": "5000", "date": None}
    assert send(client, "post", f"/groups/{group_id}/settlements", body).status_code == 200
    del body["date"]
    assert send(client, "post", f"/groups/{group_id}/settlements", body).status_code == 409
    assert Settlement.objects.get(pk=body["id"]).date is None


def test_existing_dated_receipts_replay_after_nullable_date_change(client, group):
    group_id, ids, _ = group
    body = {"command_id": uid(), "id": uid(), "sender": ids[0], "recipient": ids[1], "amount": "5000"}
    assert send(client, "post", f"/groups/{group_id}/settlements", body).status_code == 200
    old_payload = {**body, "date": None, "attempt_id": None}
    old_fingerprint = hashlib.sha256(json.dumps(
        [f"settlement:{group_id}", old_payload], sort_keys=True, separators=(",", ":"),
    ).encode()).hexdigest()
    CommandReceipt.objects.filter(command_id=body["command_id"]).update(fingerprint=old_fingerprint)
    assert send(client, "post", f"/groups/{group_id}/settlements", body).status_code == 200
    assert Settlement.objects.count() == 1
    assert Settlement.objects.get().date == timezone.localdate()
