import json

import pytest
from allauth.account.models import EmailAddress
from django.contrib.auth import SESSION_KEY, get_user_model
from django.contrib.sessions.models import Session

from .models import Change, CommandReceipt, Expense, OpeningBalance, PaymentProfile
from .test_api import client as client
from .test_api import expense, send, uid
from .test_api import group as group
from .test_collaboration import account, link, state

pytestmark = pytest.mark.django_db


def test_deletion_erases_account_auth_and_inherited_text_without_changing_money(client, group):
    group_id, ids, _ = group
    other = account()
    link(client, other, group_id, ids[1])
    EmailAddress.objects.create(user=client.actor, email=client.actor.email)
    assert send(client, "put", "/me/payment-profile", {"vpa": "private@upi"}).status_code == 200
    body = expense(ids)
    body.update(description="My private bill", notes="Private medical notes", category="Private category")
    assert send(client, "post", f"/groups/{group_id}/expenses", body).status_code == 200
    # A second member changes only the title; inherited notes still belong to the creator.
    body.update(command_id=uid(), version=1, description="Other member title")
    assert send(other, "put", f"/groups/{group_id}/expenses/{body['id']}", body).status_code == 200
    opening = {"command_id": uid(), "id": uid(), "source": "My private source", "cutoff": "2026-10-16",
               "balances": {ids[0]: "100", ids[1]: "-100", ids[2]: "0"}}
    assert send(client, "post", f"/groups/{group_id}/opening-balances", opening).status_code == 200
    before = state(other, group_id)
    actor_id, old_email = client.actor.pk, client.actor.email
    own_sessions = [s.pk for s in Session.objects.all() if str(s.get_decoded().get(SESSION_KEY)) == str(actor_id)]
    assert own_sessions
    assert send(client, "delete", "/account").status_code == 200
    assert not get_user_model().objects.filter(pk=actor_id).exists()
    assert not EmailAddress.objects.filter(user_id=actor_id).exists()
    assert not PaymentProfile.objects.filter(user_id=actor_id).exists()
    assert not CommandReceipt.objects.filter(actor_id=actor_id).exists()
    assert not Session.objects.filter(pk__in=own_sessions).exists()
    assert send(client, "get", "/me").status_code == 401
    after = state(other, group_id)
    assert after["name"] == "Shared group"
    names = {p["id"]: p["name"] for p in after["participants"]}
    assert names[ids[0]] == "Deleted participant"
    assert names[ids[1]] == next(p["name"] for p in before["participants"] if p["id"] == ids[1])
    assert names[ids[2]] == "Participant"
    assert after["balances"] == before["balances"]
    assert after["totals"] == before["totals"]
    assert after["expenses"][0]["description"] == "Other member title"
    assert after["expenses"][0]["notes"] == ""
    assert after["expenses"][0]["category"] == "other"
    assert Expense.objects.get(pk=body["id"]).version == 3
    body.update(command_id=uid(), version=2)
    assert send(other, "put", f"/groups/{group_id}/expenses/{body['id']}", body).status_code == 409
    assert after["opening_balance"]["source"] == "Removed source"
    assert after["opening_balance"]["accepted"] == before["opening_balance"]["accepted"]
    acknowledgment = OpeningBalance.objects.get(pk=opening["id"]).acknowledgments[ids[0]]
    assert "user_id" not in acknowledgment
    history = json.dumps(list(Change.objects.filter(group_id=group_id).values("actor_id", "data")))
    for text in ("My private bill", "Private medical notes", "Private category", "My private source", old_email):
        assert text not in history and text not in json.dumps(after)
    assert "Other member title" in history
    assert not Change.objects.filter(actor_id=actor_id).exists()


def test_non_owner_authored_bill_is_redacted_and_other_members_text_remains(client, group):
    group_id, ids, _ = group
    other = account()
    link(client, other, group_id, ids[1])
    owner_bill = expense(ids)
    owner_bill.update(description="Keep owner title", notes="Keep owner notes")
    member_bill = expense(ids, payer=1)
    member_bill.update(description="Erase member title", notes="Erase member notes")
    assert send(client, "post", f"/groups/{group_id}/expenses", owner_bill).status_code == 200
    assert send(other, "post", f"/groups/{group_id}/expenses", member_bill).status_code == 200
    before = state(client, group_id)
    assert send(other, "delete", "/account").status_code == 200
    after = state(client, group_id)
    assert after["name"] == before["name"]
    assert after["balances"] == before["balances"]
    bills = {e["id"]: e for e in after["expenses"]}
    assert bills[owner_bill["id"]]["notes"] == "Keep owner notes"
    assert bills[owner_bill["id"]]["description"] == "Keep owner title"
    assert bills[member_bill["id"]]["description"] == "Deleted bill"
    assert bills[member_bill["id"]]["notes"] == ""
    assert "Erase member" not in json.dumps(after)


def test_imported_payment_text_and_source_hash_are_erased_on_deletion(client):
    from .splitwise_import import import_splitwise
    from .test_splitwise_import import full_export, payload

    result = import_splitwise(client.actor, payload(full_export(), payers={"108": 0}))
    from .models import Participant
    other = account()
    person = Participant.objects.filter(group_id=result["id"]).exclude(user=client.actor).first()
    person.user = other.actor
    person.save(update_fields=["user"])
    before = state(other, result["id"])
    assert send(client, "delete", "/account").status_code == 200
    after = state(other, result["id"])
    assert after["balances"] == before["balances"]
    for change in Change.objects.filter(group_id=result["id"]):
        if change.kind == "manual_settlement":
            assert change.data.get("description", "Deleted bill") == "Deleted bill"
            assert change.data.get("category", "other") == "other"
        assert not change.data.get("source_hash")
