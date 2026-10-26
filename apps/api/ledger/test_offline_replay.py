"""Local contract for the mobile ordered outbox, no provider or payment calls."""
import json

import pytest
from django.contrib.auth import get_user_model

from .models import Expense, Group, Participant, Settlement
from .test_api import authenticated_client, expense, send, uid

pytestmark = pytest.mark.django_db


def test_ordered_offline_commands_replay_same_ids_without_duplicate_financial_history():
    actor = get_user_model().objects.create_user(username=uid(), email="offline-owner@example.invalid")
    client = authenticated_client(actor)
    group_id, self_id, person_id = uid(), uid(), uid()
    bill = expense([self_id, person_id], beneficiaries=[0, 1])
    actions = [
        ("post", "/groups", {"command_id": uid(), "id": group_id, "name": "Local offline trip", "self_participant_id": self_id, "participants": [{"id": self_id, "name": "You"}]}),
        ("post", f"/groups/{group_id}/participants", {"command_id": uid(), "id": person_id, "name": "John", "email": ""}),
        ("post", f"/groups/{group_id}/participants/{person_id}/name", {"command_id": uid(), "name": "John Doe"}),
        ("post", f"/groups/{group_id}/expenses", bill),
        ("post", f"/groups/{group_id}/settlements", {"command_id": uid(), "id": uid(), "sender": person_id, "recipient": self_id, "amount": "1000", "date": "2026-10-24"}),
    ]
    receipts = []
    for method, path, body in actions:
        response = send(client, method, path, body)
        assert response.status_code == 200
        receipts.append(response.json())
    before = send(client, "get", f"/groups/{group_id}").json()
    for (method, path, body), receipt in zip(actions, receipts):
        response = send(client, method, path, body)
        assert response.status_code == 200 and response.json() == receipt
    after = send(client, "get", f"/groups/{group_id}").json()
    assert json.dumps(before, sort_keys=True) == json.dumps(after, sort_keys=True)
    assert Group.objects.get(pk=group_id).owner_id == actor.pk
    person = Participant.objects.get(pk=person_id)
    assert person.name == "John Doe" and person.user_id is None
    assert Expense.objects.filter(group_id=group_id).count() == 1
    assert Settlement.objects.filter(group_id=group_id).count() == 1
    assert set(after["balances"]) == {self_id, person_id}
    assert after["balances"][self_id] == "4000" and after["balances"][person_id] == "-4000"
