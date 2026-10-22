import hashlib
import json

import pytest
from django.test import Client

from .models import CommandReceipt, Group, Participant
from .test_api import client as client
from .test_api import group as group
from .test_api import send, uid

pytestmark = pytest.mark.django_db


def direct_payload(size=2):
    ids = [uid() for _ in range(size)]
    return {
        "command_id": uid(),
        "id": uid(),
        "name": "Direct friend ledger",
        "self_participant_id": ids[0],
        "is_direct": True,
        "participants": [{"id": person, "name": f"Person {index}"} for index, person in enumerate(ids)],
    }


def test_direct_roundtrip_uses_the_existing_expense_and_settlement_ledger(client):
    body = direct_payload()
    first = send(client, "post", "/groups", body)
    assert first.status_code == 200, first.content
    assert send(client, "post", "/groups", body).json() == first.json()
    group_id = body["id"]
    ids = [person["id"] for person in body["participants"]]
    assert Group.objects.get(id=group_id).is_direct is True
    assert send(client, "get", f"/groups/{group_id}").json()["is_direct"] is True
    assert send(client, "get", "/groups").json()["groups"][0]["is_direct"] is True
    assert send(client, "get", f"/groups/{group_id}/export").json()["group"]["is_direct"] is True
    bill = {
        "command_id": uid(),
        "id": uid(),
        "description": "Direct dinner",
        "total": "1501",
        "paid": {ids[0]: "1501"},
        "split": {"mode": "exact", "values": {ids[0]: "500", ids[1]: "1001"}},
        "date": "2026-10-16",
    }
    assert send(client, "post", f"/groups/{group_id}/expenses", bill).status_code == 200
    snapshot = send(client, "get", f"/groups/{group_id}").json()
    assert snapshot["balances"] == {ids[0]: "1001", ids[1]: "-1001"}
    assert snapshot["transfers"] == [{"sender": ids[1], "recipient": ids[0], "amount": "1001"}]
    payment = {
        "command_id": uid(),
        "id": uid(),
        "sender": ids[1],
        "recipient": ids[0],
        "amount": "251",
    }
    assert send(client, "post", f"/groups/{group_id}/settlements", payment).status_code == 200
    assert send(client, "get", f"/groups/{group_id}").json()["balances"] == {
        ids[0]: "750",
        ids[1]: "-750",
    }
    assert send(Client(), "get", f"/groups/{group_id}").status_code == 401
    assert send(client, "post", "/groups", {**body, "is_direct": False}).status_code == 409


def test_groups_without_the_flag_keep_the_existing_default_and_participant_flow(client, group):
    group_id, _, original = group
    assert "is_direct" not in original
    assert Group.objects.get(id=group_id).is_direct is False
    assert send(client, "get", f"/groups/{group_id}").json()["is_direct"] is False
    assert send(client, "get", "/groups").json()["groups"][0]["is_direct"] is False
    legacy_fingerprint = hashlib.sha256(
        json.dumps(["create_group", original], sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    CommandReceipt.objects.filter(command_id=original["command_id"]).update(fingerprint=legacy_fingerprint)
    assert send(client, "post", "/groups", original).status_code == 200
    assert send(client, "post", "/groups", {**original, "is_direct": False}).status_code == 200
    new_person = {"command_id": uid(), "id": uid(), "name": "Another group member"}
    assert send(client, "post", f"/groups/{group_id}/participants", new_person).status_code == 200
    assert send(client, "post", f"/groups/{group_id}/participants", new_person).status_code == 200
    assert Group.objects.get(id=group_id).participants.count() == 4


@pytest.mark.parametrize("size", [1, 3])
def test_direct_group_requires_exactly_two_participants_and_rolls_back(client, size):
    body = direct_payload(size)
    response = send(client, "post", "/groups", body)
    assert response.status_code == 422, response.content
    assert not Group.objects.filter(id=body["id"]).exists()
    assert not Participant.objects.filter(id__in=[person["id"] for person in body["participants"]]).exists()
    assert not CommandReceipt.objects.filter(command_id=body["command_id"]).exists()


def test_direct_group_denies_a_third_participant_without_creating_a_receipt(client):
    body = direct_payload()
    assert send(client, "post", "/groups", body).status_code == 200
    group_id = body["id"]
    before = send(client, "get", f"/groups/{group_id}").json()
    third = {"command_id": uid(), "id": uid(), "name": "Third person"}
    for _ in range(2):
        response = send(client, "post", f"/groups/{group_id}/participants", third)
        assert response.status_code == 409, response.content
    after = send(client, "get", f"/groups/{group_id}").json()
    assert after["participants"] == before["participants"]
    assert after["version"] == before["version"]
    assert not Participant.objects.filter(id=third["id"]).exists()
    assert not CommandReceipt.objects.filter(command_id=third["command_id"]).exists()
