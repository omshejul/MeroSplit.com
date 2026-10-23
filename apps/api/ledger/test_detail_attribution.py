"""Detail actor labels come from saved actions, never from the money direction."""

import pytest
from django.contrib.auth import get_user_model

from .models import Change, Participant, Settlement
from .test_api import authenticated_client, expense, send, uid
from .test_api import client as client
from .test_api import group as group

pytestmark = pytest.mark.django_db(transaction=True)


def records(client, group):
    client.actor.first_name = "Recorder"
    client.actor.save(update_fields=["first_name"])
    bill = expense(group[1], payer=1)
    payment = {"id": uid(), "command_id": uid(), "sender": group[1][1], "recipient": group[1][2], "amount": "100", "date": None}
    assert send(client, "post", f"/groups/{group[0]}/expenses", bill).status_code == 200
    assert send(client, "post", f"/groups/{group[0]}/settlements", payment).status_code == 200
    return bill, payment


def details(client, group, bill, payment):
    return (send(client, "get", f"/groups/{group[0]}/expenses/{bill['id']}").json(),
            send(client, "get", f"/groups/{group[0]}/settlements/{payment['id']}").json())


def test_actual_creator_and_recorder_differ_from_payer_and_recipient(client, group):
    bill, payment = records(client, group)
    bill_detail, payment_detail = details(client, group, bill, payment)
    assert bill_detail["added_by"] == payment_detail["recorded_by_name"] == "Recorder"
    assert group[1][0] not in bill["paid"]
    assert group[1][0] not in (payment["sender"], payment["recipient"])


def test_actual_reversal_actor_is_independent_of_original_creator(client, group):
    bill, payment = records(client, group)
    actor = get_user_model().objects.create_user(username=uid(), first_name="Reverser")
    Participant.objects.filter(pk=group[1][1]).update(user=actor)
    member = authenticated_client(actor)
    assert send(member, "post", f"/groups/{group[0]}/expenses/{bill['id']}/reverse", {"command_id": uid(), "version": 1}).status_code == 200
    assert send(member, "post", f"/groups/{group[0]}/settlements/{payment['id']}/reverse", {"command_id": uid()}).status_code == 200
    bill_detail, payment_detail = details(client, group, bill, payment)
    assert bill_detail["added_by"] == payment_detail["recorded_by_name"] == "Recorder"
    for value in (bill_detail, payment_detail):
        assert value["reversal"]["actor_name"] == "Reverser"
        assert not {"actor_id", "email", "token"} & value["reversal"].keys()


@pytest.mark.parametrize("unknown", ["missing_event", "deleted_actor", "imported"])
def test_unknown_imported_and_anonymized_details_never_infer_an_actor(client, group, unknown):
    bill, payment = records(client, group)
    creation = Change.objects.get(kind="expense_saved", data__id=bill["id"])
    if unknown == "missing_event":
        creation.delete()
        Settlement.objects.filter(pk=payment["id"]).update(recorded_by=None)
    elif unknown == "deleted_actor":
        creation.actor = None
        creation.save(update_fields=["actor"])
        Settlement.objects.filter(pk=payment["id"]).update(recorded_by=None)
    else:
        creation.data["source"] = "splitwise_csv"
        creation.save(update_fields=["data"])
        Settlement.objects.filter(pk=payment["id"]).update(method="splitwise_import")
    bill_detail, payment_detail = details(client, group, bill, payment)
    assert bill_detail["added_by"] is None and payment_detail["recorded_by_name"] is None


def test_anonymized_reversal_and_unauthorized_details(client, group):
    bill, payment = records(client, group)
    assert send(client, "post", f"/groups/{group[0]}/expenses/{bill['id']}/reverse", {"command_id": uid(), "version": 1}).status_code == 200
    Change.objects.filter(kind="expense_reversed").update(actor=None)
    bill_detail, _ = details(client, group, bill, payment)
    assert bill_detail["reversal"]["actor_name"] is None
    outsider = authenticated_client(get_user_model().objects.create_user(username=uid()))
    for path in (f"expenses/{bill['id']}", f"settlements/{payment['id']}"):
        assert send(outsider, "get", f"/groups/{group[0]}/{path}").status_code == 404
