import json
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from uuid import uuid4

import pytest
from django.contrib.auth import get_user_model
from django.db import close_old_connections, connections
from django.test import Client

from .models import CommandReceipt, Expense, Group, Participant, Settlement
from .services import save_expense

pytestmark = pytest.mark.django_db


def uid():
    return str(uuid4())


def send(client, method, path, data=None):
    return getattr(client, method)(
        f"/api/v1{path}", data=json.dumps(data) if data is not None else None, content_type="application/json"
    )


@pytest.fixture
def client():
    email = f"{uuid4().hex}@splitdumb.invalid"
    user = get_user_model().objects.create_user(username=email, email=email)
    return authenticated_client(user)


def authenticated_client(user):
    """A normal Django test session; dedicated OTP tests cover production sign-in."""
    result = Client()
    result.force_login(user, backend="allauth.account.auth_backends.AuthenticationBackend")
    result.defaults["HTTP_X_SESSION_TOKEN"] = result.session.session_key
    result.cookies.clear()
    result.actor = user
    return result


@pytest.fixture
def group(client):
    ids = [uid() for _ in range(3)]
    payload = {
        "command_id": uid(),
        "id": uid(),
        "name": "Functional test",
        "self_participant_id": ids[0],
        "participants": [{"id": p, "name": name} for p, name in zip(ids, ["A", "B", "C"])],
    }
    response = send(client, "post", "/groups", payload)
    assert response.status_code == 200, response.content
    return payload["id"], ids, payload


def expense(ids, *, payer=0, beneficiaries=None, total="10000"):
    return {
        "command_id": uid(),
        "id": uid(),
        "description": "Test expense",
        "total": total,
        "paid": {ids[payer]: total},
        "split": {
            "mode": "equal",
            "values": {ids[i]: "1" for i in (beneficiaries if beneficiaries is not None else range(3))},
        },
        "date": date.today().isoformat(),
        "category": "food",
        "notes": "",
    }


def test_auth_and_visibility(client, group):
    group_id, ids, payload = group
    assert send(Client(), "get", f"/groups/{group_id}").status_code == 401
    outsider = get_user_model().objects.create_user(username=uid(), email=f"{uid()}@splitdumb.invalid")
    assert Group.objects.filter(participants__user=outsider).count() == 0
    assert send(client, "get", f"/groups/{uid()}").status_code == 404
    assert send(client, "get", "/groups").json()["groups"][0]["id"] == group_id
    duplicate = send(client, "post", "/groups", payload)
    assert duplicate.status_code == 200 and Group.objects.count() == 1


def test_chain_rounding_multiple_payers_and_payment(client, group):
    group_id, ids, _ = group
    for payer, beneficiaries in [(1, [0]), (2, [1])]:
        response = send(
            client,
            "post",
            f"/groups/{group_id}/expenses",
            expense(ids, payer=payer, beneficiaries=beneficiaries, total="50000"),
        )
        assert response.status_code == 200, response.content
    state = send(client, "get", f"/groups/{group_id}").json()
    assert state["transfers"] == [{"sender": ids[0], "recipient": ids[2], "amount": "50000"}]
    payment = {"command_id": uid(), "id": uid(), "sender": ids[0], "recipient": ids[2], "amount": "20000"}
    assert send(client, "post", f"/groups/{group_id}/settlements", payment).status_code == 200
    assert send(client, "post", f"/groups/{group_id}/settlements", payment).status_code == 200
    assert Settlement.objects.count() == 1
    assert send(client, "post", f"/groups/{group_id}/expenses", expense(ids)).status_code == 200
    multiple = expense(ids, total="120000")
    multiple["paid"] = {ids[0]: "90000", ids[1]: "30000"}
    assert send(client, "post", f"/groups/{group_id}/expenses", multiple).status_code == 200
    state = send(client, "get", f"/groups/{group_id}").json()
    # The extra paise goes to the lexically first immutable participant ID.
    extra = min(ids)
    expected = {ids[0]: 26667, ids[1]: -13333, ids[2]: -13333}
    expected[extra] -= 1
    assert state["balances"] == {p: str(n) for p, n in expected.items()}
    assert sum(map(int, state["balances"].values())) == 0


def test_conflict_and_delete_restore(client, group):
    group_id, ids, _ = group
    data = expense(ids)
    assert send(client, "post", f"/groups/{group_id}/expenses", data).status_code == 200
    assert send(client, "post", f"/groups/{group_id}/expenses", data).status_code == 200
    assert Expense.objects.count() == 1
    changed = {**data, "description": "Different payload"}
    assert send(client, "post", f"/groups/{group_id}/expenses", changed).status_code == 409
    changed.update(command_id=uid(), version=1)
    assert send(client, "put", f"/groups/{group_id}/expenses/{data['id']}", changed).status_code == 200
    changed["command_id"] = uid()
    assert send(client, "put", f"/groups/{group_id}/expenses/{data['id']}", changed).status_code == 409
    assert (
        send(
            client, "delete", f"/groups/{group_id}/expenses/{data['id']}", {"command_id": uid(), "version": 2}
        ).status_code
        == 200
    )
    assert all(n == "0" for n in send(client, "get", f"/groups/{group_id}").json()["balances"].values())
    restore = {"command_id": uid(), "version": 3}
    assert (
        send(client, "post", f"/groups/{group_id}/expenses/{data['id']}/restore", restore).status_code == 200
    )
    assert (
        send(client, "post", f"/groups/{group_id}/expenses/{data['id']}/restore", restore).status_code == 200
    )
    assert Expense.objects.get().version == 4


def test_invalid_expense_rolls_back(client, group):
    group_id, ids, _ = group
    data = expense(ids)
    data["paid"] = {ids[0]: "9000"}
    before = Group.objects.get().version
    response = send(client, "post", f"/groups/{group_id}/expenses", data)
    assert response.status_code == 422, response.content
    assert Expense.objects.count() == 0 and Group.objects.get().version == before
    assert not CommandReceipt.objects.filter(command_id=data["command_id"]).exists()
    data["paid"] = {uid(): "10000"}
    assert send(client, "post", f"/groups/{group_id}/expenses", data).status_code == 422


def test_manual_reversal_once(client, group):
    group_id, ids, _ = group
    payment = {"command_id": uid(), "id": uid(), "sender": ids[0], "recipient": ids[2], "amount": "20000"}
    assert send(client, "post", f"/groups/{group_id}/settlements", payment).status_code == 200
    body = {"command_id": uid()}
    path = f"/groups/{group_id}/settlements/{payment['id']}/reverse"
    assert send(client, "post", path, body).status_code == 200
    assert send(client, "post", path, body).status_code == 200
    assert send(client, "post", path, {"command_id": uid()}).status_code == 409
    assert all(n == "0" for n in send(client, "get", f"/groups/{group_id}").json()["balances"].values())


def test_replay_rechecks_membership(client, group):
    group_id, ids, _ = group
    data = expense(ids)
    assert send(client, "post", f"/groups/{group_id}/expenses", data).status_code == 200
    Participant.objects.filter(id=ids[0]).update(user=None)
    assert send(client, "post", f"/groups/{group_id}/expenses", data).status_code == 404


@pytest.mark.django_db(transaction=True)
def test_simultaneous_replay_posts_once(client, group):
    group_id, ids, _ = group
    payload = expense(ids)

    def save():
        close_old_connections()
        try:
            return save_expense(get_user_model().objects.get(pk=client.actor.pk), group_id, payload)
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: save(), range(2)))
    assert results[0] == results[1]
    assert Expense.objects.count() == 1


def test_authenticated_outsider_cannot_read_or_change(client, group):
    group_id, ids, _ = group
    email = f"{uid()}@splitdumb.invalid"
    outsider = authenticated_client(get_user_model().objects.create_user(username=email, email=email))
    assert send(outsider, "get", f"/groups/{group_id}").status_code == 404
    assert send(outsider, "post", f"/groups/{group_id}/expenses", expense(ids)).status_code == 404
    assert send(outsider, "get", "/groups").json() == {"groups": []}
    assert Expense.objects.count() == 0


@pytest.mark.parametrize("invalid", ["10000\n", "10000\u00a0", " 10000", "１００００"])
def test_money_is_not_normalized_before_validation(client, group, invalid):
    group_id, ids, _ = group
    data = expense(ids)
    data["total"] = invalid
    data["paid"][ids[0]] = invalid
    assert send(client, "post", f"/groups/{group_id}/expenses", data).status_code == 422
    assert Expense.objects.count() == 0


def test_private_health_host_is_read_only():
    client = Client(HTTP_HOST="healthcheck.railway.app")
    assert send(client, "get", "/health").status_code == 200
    assert send(client, "get", "/ready").status_code == 200
    assert send(client, "get", "/groups").status_code == 400
    assert send(client, "post", "/health", {}).status_code == 400


def test_password_login_cannot_bypass_email_code_policy():
    email = f"{uid()}@splitdumb.invalid"
    password = "Rate-limit-functional-Password2026!"
    get_user_model().objects.create_user(username=email, email=email, password=password)
    browser = Client()
    statuses = []
    for _ in range(3):
        response = browser.post(
            "/_allauth/app/v1/auth/login",
            data=json.dumps({"email": email, "password": password}),
            content_type="application/json",
        )
        statuses.append(response.status_code)
    assert statuses == [403, 403, 403]


def test_wrong_group_objects_and_reused_command_target(client, group):
    first_id, ids, _ = group
    original = expense(ids)
    assert send(client, "post", f"/groups/{first_id}/expenses", original).status_code == 200
    second_ids = [uid(), uid()]
    second = {
        "command_id": uid(),
        "id": uid(),
        "name": "Other group",
        "self_participant_id": second_ids[0],
        "participants": [{"id": p, "name": p} for p in second_ids],
    }
    assert send(client, "post", "/groups", second).status_code == 200
    assert send(client, "post", f"/groups/{second['id']}/expenses", original).status_code == 409
    assert (
        send(
            client,
            "delete",
            f"/groups/{second['id']}/expenses/{original['id']}",
            {"command_id": uid(), "version": 1},
        ).status_code
        == 404
    )
    assert not Expense.objects.get(id=original["id"]).deleted


@pytest.mark.django_db(transaction=True)
def test_simultaneous_edits_accept_one_revision(client, group):
    from ninja.errors import HttpError

    group_id, ids, _ = group
    original = expense(ids)
    assert send(client, "post", f"/groups/{group_id}/expenses", original).status_code == 200

    def edit(description):
        close_old_connections()
        try:
            payload = {**original, "command_id": uid(), "version": 1, "description": description}
            save_expense(get_user_model().objects.get(pk=client.actor.pk), group_id, payload, original["id"])
            return 200
        except HttpError as error:
            return error.status_code
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(edit, ["First concurrent edit", "Second concurrent edit"]))
    assert sorted(results) == [200, 409]
    assert Expense.objects.get(id=original["id"]).version == 2


def test_new_participant_does_not_change_old_splits_or_spending(client, group):
    group_id, ids, _ = group
    original = expense(ids)
    assert send(client, "post", f"/groups/{group_id}/expenses", original).status_code == 200
    before = send(client, "get", f"/groups/{group_id}").json()
    person = {"command_id": uid(), "id": uid(), "name": "New guest"}
    assert send(client, "post", f"/groups/{group_id}/participants", person).status_code == 200
    assert send(client, "post", f"/groups/{group_id}/participants", person).status_code == 200
    after = send(client, "get", f"/groups/{group_id}").json()
    assert len(after["participants"]) == 4
    assert after["expenses"][0]["shares"] == before["expenses"][0]["shares"]
    assert after["balances"][person["id"]] == "0"
    assert after["totals"]["spending"] == "10000"
    assert after["totals"]["paid"][ids[0]] == "10000"
    assert sum(map(int, after["totals"]["shares"].values())) == 10000
    payment = {"command_id": uid(), "id": uid(), "sender": ids[1], "recipient": ids[0], "amount": "1000"}
    assert send(client, "post", f"/groups/{group_id}/settlements", payment).status_code == 200
    assert send(client, "get", f"/groups/{group_id}").json()["totals"]["spending"] == "10000"
