import csv
import io
import json
from datetime import timedelta
from uuid import uuid4

import pytest
from django.contrib.auth import get_user_model
from django.test import Client
from django.utils import timezone

from .models import Group, PaymentAttempt
from .test_api import authenticated_client, expense, send, uid
from .test_api import client as client
from .test_api import group as group

pytestmark = pytest.mark.django_db


def account():
    email = f"{uuid4().hex}@splitdumb.invalid"
    user = get_user_model().objects.create_user(username=email, email=email)
    return authenticated_client(user)


def state(client, group_id):
    response = send(client, "get", f"/groups/{group_id}")
    assert response.status_code == 200, response.content
    return response.json()


def invite(owner, group_id, participant_id):
    body = {"command_id": uid(), "participant_id": participant_id}
    response = send(owner, "post", f"/groups/{group_id}/invites", body)
    assert response.status_code == 200, response.content
    return body["command_id"], response.json()["token"]


def link(owner, member, group_id, participant_id):
    invitation, token = invite(owner, group_id, participant_id)
    response = send(member, "post", f"/invites/{token}/claim", {"command_id": uid()})
    assert response.status_code == 200, response.content
    response = send(owner, "post", f"/groups/{group_id}/invites/{invitation}/approve", {"command_id": uid()})
    assert response.status_code == 200, response.content
    return invitation, token


def prepare(owner, recipient, group_id, ids):
    link(owner, recipient, group_id, ids[1])
    profile = send(recipient, "put", "/me/payment-profile", {"vpa": "receiver@upi"})
    assert profile.status_code == 200, profile.content
    debt = expense(ids, payer=1, beneficiaries=[0], total="50000")
    assert send(owner, "post", f"/groups/{group_id}/expenses", debt).status_code == 200
    snapshot = state(owner, group_id)
    attempt = {
        "command_id": uid(),
        "id": uid(),
        "sender": ids[0],
        "recipient": ids[1],
        "amount": "50000",
        "group_version": snapshot["version"],
        "payee_version": profile.json()["version"],
    }
    response = send(owner, "post", f"/groups/{group_id}/payment-attempts", attempt)
    assert response.status_code == 200, response.content
    return attempt


def test_guest_scope_requires_explicit_claim_approval_and_revocation(client, group):
    group_id, ids, _ = group
    relevant = expense(ids, payer=0, beneficiaries=[1], total="10000")
    private = expense(ids, payer=2, beneficiaries=[0, 2], total="7000")
    private["description"] = "Unrelated private bill"
    for body in [relevant, private]:
        assert send(client, "post", f"/groups/{group_id}/expenses", body).status_code == 200
    invitation, token = invite(client, group_id, ids[1])
    guest = send(Client(), "get", f"/invites/{token}")
    assert guest.status_code == 200, guest.content
    view = guest.json()
    assert view["balance"] == "-10000"
    assert [record["id"] for record in view["expenses"]] == [relevant["id"]]
    assert {person["id"] for person in view["participants"]} == {ids[0], ids[1]}
    assert "Unrelated private bill" not in guest.content.decode()
    for record in view["expenses"]:
        assert set(record["paid"]) <= {ids[0], ids[1]}
        assert set(record["shares"]) <= {ids[0], ids[1]}
    member, stranger = account(), account()
    assert send(member, "get", f"/groups/{group_id}").status_code == 404
    assert send(member, "post", f"/groups/{group_id}/expenses", expense(ids)).status_code == 404
    assert send(Client(), "post", f"/invites/{token}/claim", {"command_id": uid()}).status_code == 401
    claim = {"command_id": uid()}
    assert send(member, "post", f"/invites/{token}/claim", claim).status_code == 200
    assert send(member, "post", f"/invites/{token}/claim", claim).status_code == 200
    assert send(stranger, "post", f"/invites/{token}/claim", {"command_id": uid()}).status_code == 409
    assert send(member, "get", f"/groups/{group_id}").status_code == 404
    owner_invite = next(row for row in state(client, group_id)["invites"] if row["id"] == invitation)
    assert owner_invite["claimant_email"] == member.actor.email
    assert owner_invite["claimant_id"] == member.actor.pk
    assert (
        send(
            member, "post", f"/groups/{group_id}/invites/{invitation}/approve", {"command_id": uid()}
        ).status_code
        == 404
    )
    approval = {"command_id": uid()}
    assert (
        send(client, "post", f"/groups/{group_id}/invites/{invitation}/approve", approval).status_code == 200
    )
    assert (
        send(client, "post", f"/groups/{group_id}/invites/{invitation}/approve", approval).status_code == 200
    )
    member_state = state(member, group_id)
    assert next(p for p in member_state["participants"] if p["id"] == ids[1])["user_id"] == member.actor.pk
    assert member_state["invites"] == []
    assert (
        send(
            member, "post", f"/groups/{group_id}/invites", {"command_id": uid(), "participant_id": ids[2]}
        ).status_code
        == 403
    )
    assert (
        send(
            member, "post", f"/groups/{group_id}/invites/{invitation}/revoke", {"command_id": uid()}
        ).status_code
        == 403
    )
    assert (
        send(
            client, "post", f"/groups/{group_id}/invites/{invitation}/revoke", {"command_id": uid()}
        ).status_code
        == 200
    )
    assert send(Client(), "get", f"/invites/{token}").status_code == 404
    assert send(stranger, "post", f"/invites/{token}/claim", {"command_id": uid()}).status_code == 404
    assert send(member, "get", f"/groups/{group_id}").status_code == 200


def test_opening_vector_posts_only_after_every_nonzero_person_acknowledges(client, group):
    group_id, ids, _ = group
    borrower, creditor, outsider = account(), account(), account()
    link(client, borrower, group_id, ids[1])
    link(client, creditor, group_id, ids[2])
    body = {
        "command_id": uid(),
        "id": uid(),
        "balances": {ids[0]: "0", ids[1]: "-12345", ids[2]: "12345"},
        "source": "Agreed prior group balances",
        "cutoff": "2026-10-16",
    }
    assert send(borrower, "post", f"/groups/{group_id}/opening-balances", body).status_code == 403
    assert send(client, "post", f"/groups/{group_id}/opening-balances", body).status_code == 200
    before = state(client, group_id)
    assert before["opening_balance"]["accepted"] is False
    assert set(before["balances"].values()) == {"0"}
    endpoint = f"/groups/{group_id}/opening-balances/{body['id']}/acknowledge"
    assert send(outsider, "post", endpoint, {"command_id": uid()}).status_code == 404
    ack = {"command_id": uid()}
    assert send(borrower, "post", endpoint, ack).status_code == 200
    assert send(borrower, "post", endpoint, ack).status_code == 200
    partial = state(client, group_id)
    assert partial["opening_balance"]["accepted"] is False
    assert set(partial["balances"].values()) == {"0"}
    assert send(creditor, "post", endpoint, {"command_id": uid()}).status_code == 200
    accepted = state(client, group_id)
    assert accepted["opening_balance"]["accepted"] is True
    assert accepted["balances"] == body["balances"]
    assert set(accepted["opening_balance"]["acknowledgments"]) >= {ids[1], ids[2]}


def test_guest_can_reconcile_own_opening_without_other_people_balances(client, group):
    group_id, ids, _ = group
    borrower, creditor = account(), account()
    _, token = link(client, borrower, group_id, ids[1])
    link(client, creditor, group_id, ids[2])
    body = {
        "command_id": uid(),
        "id": uid(),
        "balances": {ids[0]: "0", ids[1]: "-1000", ids[2]: "1000"},
        "source": "Reviewed prior balance <source>",
        "cutoff": "2026-10-16",
    }
    assert send(client, "post", f"/groups/{group_id}/opening-balances", body).status_code == 200
    guest = Client()
    pending = send(guest, "get", f"/invites/{token}").json()
    assert pending["balance"] == "0"
    assert pending["opening_balance"] == {
        "amount": "-1000",
        "source": body["source"],
        "cutoff": body["cutoff"],
        "accepted": False,
    }
    assert pending["participants"] == [{"id": ids[1], "name": "B"}]
    assert ids[2] not in json.dumps(pending)
    page = guest.get(f"/invite/{token}")
    assert page.status_code == 302
    assert page["Location"].startswith("/app/invite/")
    assert body["source"].encode() not in page.content
    guest.force_login(borrower.actor)
    assert guest.get(f"/invite/{token}").status_code == 302
    endpoint = f"/groups/{group_id}/opening-balances/{body['id']}/acknowledge"
    for member in [borrower, creditor]:
        assert send(member, "post", endpoint, {"command_id": uid()}).status_code == 200
    accepted = send(guest, "get", f"/invites/{token}").json()
    assert accepted["balance"] == "-1000"
    assert accepted["opening_balance"] == {**pending["opening_balance"], "accepted": True}


def test_payment_profiles_are_caller_owned_and_never_bank_verified(client, group):
    group_id, ids, _ = group
    member = account()
    link(client, member, group_id, ids[1])
    assert send(member, "put", "/me/payment-profile", {"vpa": "receiver@upi"}).status_code == 200
    response = send(client, "put", "/me/payment-profile", {"vpa": "attacker@upi", "user_id": member.actor.pk})
    assert response.status_code == 422
    assert send(member, "get", "/me").json()["payment_profile"]["vpa"] == "receiver@upi"
    assert send(client, "get", "/me").json()["payment_profile"] is None
    assert send(client, "put", "/me/payment-profile", {"vpa": "payer@upi"}).status_code == 200
    assert send(member, "put", "/me/payment-profile", {"vpa": "not a UPI address"}).status_code == 422
    participants = {p["id"]: p for p in state(client, group_id)["participants"]}
    assert participants[ids[1]]["payment_profile"] == {
        "vpa": "receiver@upi",
        "version": 1,
        "bank_verified": False,
    }
    assert send(member, "get", "/me").json()["email_verified"] is False


def test_stale_quote_report_and_recipient_confirmation_post_once(client, group):
    group_id, ids, _ = group
    recipient = account()
    attempt = prepare(client, recipient, group_id, ids)
    path = f"/groups/{group_id}/payment-attempts/{attempt['id']}"
    launch = send(client, "get", f"{path}/launch")
    assert launch.status_code == 200, launch.content
    assert launch.json()["bank_verified"] is False
    assert launch.json()["direct_launch_supported"] is True
    assert launch.json()["group_version"] == state(client, group_id)["version"]
    assert launch.json()["expires_at"]
    assert send(recipient, "get", f"{path}/launch").status_code == 403
    assert send(client, "post", f"{path}/confirm", {"command_id": uid()}).status_code == 403
    assert send(recipient, "post", f"{path}/confirm", {"command_id": uid()}).status_code == 409
    reused = {**attempt, "command_id": uid(), "id": uid()}
    assert send(client, "post", f"/groups/{group_id}/payment-attempts", reused).status_code == 200
    assert [a["id"] for a in state(client, group_id)["payment_attempts"]] == [attempt["id"]]
    balances = state(client, group_id)["balances"]
    assert send(recipient, "put", "/me/payment-profile", {"vpa": "changed@upi"}).status_code == 200
    assert send(client, "get", f"{path}/launch").status_code == 409
    assert send(recipient, "post", f"{path}/report", {"command_id": uid()}).status_code == 403
    report = {"command_id": uid()}
    assert send(client, "post", f"{path}/report", report).status_code == 200
    assert send(client, "post", f"{path}/report", report).status_code == 200
    pending = state(client, group_id)
    assert pending["balances"] == balances
    assert pending["settlements"] == []
    assert pending["payment_attempts"][0]["state"] == "reported"
    assert send(client, "post", f"{path}/cancel", {"command_id": uid()}).status_code == 409
    confirm = {"command_id": uid()}
    assert send(recipient, "post", f"{path}/confirm", confirm).status_code == 200
    assert send(recipient, "post", f"{path}/confirm", confirm).status_code == 200
    assert send(recipient, "post", f"{path}/confirm", {"command_id": uid()}).status_code == 200
    confirmed = state(client, group_id)
    assert len(confirmed["settlements"]) == 1
    assert confirmed["settlements"][0]["method"] == "recipient_confirmed"
    assert set(confirmed["balances"].values()) == {"0"}


@pytest.mark.parametrize("cause", ["balance_change", "expiry", "cancelled"])
def test_unlaunchable_quote_preserves_late_actual_receipt(client, group, cause):
    group_id, ids, _ = group
    recipient = account()
    attempt = prepare(client, recipient, group_id, ids)
    path = f"/groups/{group_id}/payment-attempts/{attempt['id']}"
    if cause == "balance_change":
        changed = expense(ids, payer=0, beneficiaries=[1], total="1000")
        assert send(client, "post", f"/groups/{group_id}/expenses", changed).status_code == 200
    elif cause == "expiry":
        PaymentAttempt.objects.filter(id=attempt["id"]).update(
            expires_at=timezone.now() - timedelta(seconds=1)
        )
    else:
        assert send(client, "post", f"{path}/cancel", {"command_id": uid()}).status_code == 200
    assert send(client, "get", f"{path}/launch").status_code == 409
    before = state(client, group_id)["balances"]
    if cause != "cancelled":
        assert send(client, "post", f"{path}/report", {"command_id": uid()}).status_code == 200
    assert state(client, group_id)["balances"] == before
    assert send(recipient, "post", f"{path}/confirm", {"command_id": uid()}).status_code == 200
    assert send(recipient, "post", f"{path}/confirm", {"command_id": uid()}).status_code == 200
    confirmed = state(client, group_id)
    assert len(confirmed["settlements"]) == 1
    assert confirmed["balances"] == {
        ids[0]: str(int(before[ids[0]]) + 50000),
        ids[1]: str(int(before[ids[1]]) - 50000),
        ids[2]: "0",
    }


@pytest.mark.parametrize("actual", ["50000", "20000"])
def test_manual_record_then_confirmation_changes_provenance_without_double_posting(client, group, actual):
    group_id, ids, _ = group
    recipient = account()
    attempt = prepare(client, recipient, group_id, ids)
    path = f"/groups/{group_id}/payment-attempts/{attempt['id']}"
    manual = {
        "command_id": uid(),
        "id": uid(),
        "sender": ids[0],
        "recipient": ids[1],
        "amount": actual,
        "attempt_id": attempt["id"],
    }
    unlinked = {key: value for key, value in manual.items() if key != "attempt_id"}
    rejected = send(client, "post", f"/groups/{group_id}/settlements", unlinked)
    assert rejected.status_code == 409, rejected.content
    assert state(client, group_id)["settlements"] == []
    assert send(client, "post", f"/groups/{group_id}/settlements", manual).status_code == 200
    assert send(client, "post", f"/groups/{group_id}/settlements", manual).status_code == 200
    expected = {ids[0]: str(int(actual) - 50000), ids[1]: str(50000 - int(actual)), ids[2]: "0"}
    assert state(client, group_id)["balances"] == expected
    assert send(recipient, "post", f"{path}/confirm", {"command_id": uid()}).status_code == 200
    after = state(client, group_id)
    assert [row["id"] for row in after["settlements"]] == [manual["id"]]
    assert after["settlements"][0]["amount"] == actual
    assert after["settlements"][0]["method"] == "manual_then_confirmed"
    assert after["payment_attempts"][0]["state"] == "confirmed"
    assert after["balances"] == expected


def test_csv_export_reconciles_and_escapes_user_formula_fields(client, group):
    group_id, ids, _ = group
    member = account()
    link(client, member, group_id, ids[1])
    bill = expense(ids, payer=0, beneficiaries=[1], total="10000")
    bill["description"] = "\t=2+2"
    assert send(client, "post", f"/groups/{group_id}/expenses", bill).status_code == 200
    deleted = expense(ids, payer=2, beneficiaries=[0], total="7777")
    assert send(client, "post", f"/groups/{group_id}/expenses", deleted).status_code == 200
    assert (
        send(
            client,
            "delete",
            f"/groups/{group_id}/expenses/{deleted['id']}",
            {"command_id": uid(), "version": 1},
        ).status_code
        == 200
    )
    opening = {
        "command_id": uid(),
        "id": uid(),
        "balances": {ids[0]: "123", ids[1]: "-123", ids[2]: "0"},
        "source": '=HYPERLINK("https://example.invalid")',
        "cutoff": "2026-10-16",
    }
    assert send(client, "post", f"/groups/{group_id}/opening-balances", opening).status_code == 200
    assert (
        send(
            member,
            "post",
            f"/groups/{group_id}/opening-balances/{opening['id']}/acknowledge",
            {"command_id": uid()},
        ).status_code
        == 200
    )
    repayment = {"command_id": uid(), "id": uid(), "sender": ids[1], "recipient": ids[0], "amount": "2500"}
    assert send(client, "post", f"/groups/{group_id}/settlements", repayment).status_code == 200
    response = send(member, "get", f"/groups/{group_id}/export?format=csv")
    assert response.status_code == 200, response.content
    rows = list(csv.DictReader(io.StringIO(response.content.decode())))
    totals = dict.fromkeys(ids, 0)
    for row in rows:
        totals[row["participant_id"]] += int(row["net_paise"])
    snapshot = state(member, group_id)
    assert {p: str(amount) for p, amount in totals.items()} == snapshot["balances"]
    assert any(row["id"] == bill["id"] and row["description"] == "'\t=2+2" for row in rows)
    assert all(row["description"].startswith("'") for row in rows if row["kind"] == "opening_balance")
    assert all(row["net_paise"] == "0" for row in rows if row["id"] == deleted["id"])
    exported = send(member, "get", f"/groups/{group_id}/export?format=json").json()
    assert exported["schema_version"] == 1
    assert exported["scope"] == "accepted_server_records"
    assert exported["group"]["balances"] == snapshot["balances"]
    assert exported["group"]["invites"] == []
    assert next(e for e in exported["group"]["expenses"] if e["id"] == bill["id"])["description"] == "\t=2+2"


def test_account_deletion_revokes_tokens_and_preserves_other_members_history(client, group):
    group_id, ids, _ = group
    member = account()
    link(client, member, group_id, ids[1])
    bill = expense(ids, payer=0, beneficiaries=[1], total="10000")
    assert send(client, "post", f"/groups/{group_id}/expenses", bill).status_code == 200
    assert send(client, "put", "/me/payment-profile", {"vpa": "deleted-user@upi"}).status_code == 200
    before = state(member, group_id)
    own_export = send(client, "get", "/account/export")
    assert own_export.status_code == 200
    assert own_export.json()["groups"][0]["group"]["id"] == group_id
    result = send(client, "delete", "/account")
    assert result.status_code == 200, result.content
    assert result.json() == {"deleted": True}
    assert send(client, "get", "/me").status_code == 401
    assert send(client, "get", f"/groups/{group_id}").status_code == 401
    assert send(client, "get", "/account/export").status_code == 401
    retained = state(member, group_id)
    assert retained["owner_id"] == member.actor.pk
    assert retained["balances"] == before["balances"]
    assert [e["id"] for e in retained["expenses"]] == [bill["id"]]
    erased = next(p for p in retained["participants"] if p["id"] == ids[0])
    assert erased["name"] == "Deleted participant"
    assert erased["user_id"] is None
    assert erased["payment_profile"] is None
    assert client.actor.email not in json.dumps(retained)
    assert not get_user_model().objects.filter(pk=client.actor.pk).exists()


def test_last_linked_account_deletion_removes_group_with_payment_history(client, group):
    group_id, ids, _ = group
    recipient = account()
    attempt = prepare(client, recipient, group_id, ids)
    manual = {
        "command_id": uid(),
        "id": uid(),
        "sender": ids[0],
        "recipient": ids[1],
        "amount": "20000",
        "attempt_id": attempt["id"],
    }
    assert send(client, "post", f"/groups/{group_id}/settlements", manual).status_code == 200
    assert send(recipient, "delete", "/account").status_code == 200
    assert len(state(client, group_id)["settlements"]) == 1
    result = send(client, "delete", "/account")
    assert result.status_code == 200, result.content
    assert not Group.objects.filter(id=group_id).exists()


def test_browser_session_claim_requires_csrf_while_native_token_does_not(client, group):
    group_id, ids, _ = group
    _, token = invite(client, group_id, ids[1])
    member = account()
    browser = Client(enforce_csrf_checks=True)
    assert browser.get("/_allauth/browser/v1/config").status_code == 200
    browser.force_login(member.actor, backend="allauth.account.auth_backends.AuthenticationBackend")
    assert send(browser, "get", "/me").status_code == 200
    claim = {"command_id": uid()}
    assert send(browser, "post", f"/invites/{token}/claim", claim).status_code == 403
    accepted = browser.post(
        f"/api/v1/invites/{token}/claim",
        data=json.dumps(claim),
        content_type="application/json",
        HTTP_X_CSRFTOKEN=browser.cookies["csrftoken"].value,
    )
    assert accepted.status_code == 200, accepted.content
    native = Client(enforce_csrf_checks=True)
    native.defaults["HTTP_X_SESSION_TOKEN"] = client.defaults["HTTP_X_SESSION_TOKEN"]
    response = send(native, "put", "/me/payment-profile", {"vpa": "native@upi"})
    assert response.status_code == 200, response.content
