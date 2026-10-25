from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Event, Lock

import pytest
from django.contrib.auth import get_user_model
from django.db import close_old_connections, connection, transaction
from django.utils import timezone

from . import expense_categories as categories
from .category_gateway import CategoryUnavailable
from .models import (
    Change,
    Expense,
    ExpenseCategoryCache,
    ExpenseCategoryDecision,
    ExpenseNotice,
    Group,
    Participant,
)
from .services import expense_dict
from .test_api import authenticated_client, expense, send, uid
from .test_api import client as client
from .test_api import group as group

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture(autouse=True)
def gateway_key(settings):
    settings.AI_GATEWAY_API_KEY = "synthetic-only"


def bill(client, group, **fields):
    body = (
        expense(group[1])
        | {"category": "general", "category_auto": True, "description": "Synthetic dinner"}
        | fields
    )
    assert send(client, "post", f"/groups/{group[0]}/expenses", body).status_code == 200
    return body


def icons(client, body):
    return send(client, "get", "/expense-icons?ids=" + body["id"])


def edit(client, group, body, **fields):
    data = expense_dict(Expense.objects.get(pk=body["id"])) | {"command_id": uid()} | fields
    data.pop("deleted")
    data.pop("shares")
    response = send(client, "put", f"/groups/{group[0]}/expenses/{body['id']}", data)
    assert response.status_code == 200, response.content


def test_read_queues_once_and_cached_decision_never_changes_financial_or_notice_state(client, group):
    peer = get_user_model().objects.create_user(username=uid())
    Participant.objects.filter(pk=group[1][1]).update(user=peer)
    body = bill(client, group)
    notice_count = ExpenseNotice.objects.count()
    before = send(client, "get", f"/groups/{group[0]}").json()
    changes = list(Change.objects.values("pk", "sequence", "data"))
    for _ in range(4):
        assert icons(client, body).json()["items"][0]["state"] == "pending"
    assert ExpenseCategoryDecision.objects.count() == 1
    calls = []

    def evaluate(title, key):
        assert not connection.in_atomic_block
        calls.append((title, key))
        return "food"

    assert categories.process_category_decisions(evaluate=evaluate) == 1
    assert calls == [("Synthetic dinner", "synthetic-only")]
    assert icons(client, body).json()["items"][0]["category"] == "food"
    assert categories.process_category_decisions(evaluate=evaluate) == 0
    assert send(client, "get", f"/groups/{group[0]}").json() == before
    assert list(Change.objects.values("pk", "sequence", "data")) == changes
    assert Expense.objects.get(pk=body["id"]).category == "general"
    assert ExpenseNotice.objects.count() == notice_count


@pytest.mark.parametrize(
    "category,automatic,expected",
    [
        ("food", True, "food"),
        ("General", False, "general"),
        ("Other", False, "general"),
        ("Electricity", False, "utilities"),
        ("A custom manual category", False, "general"),
    ],
)
def test_explicit_manual_and_specific_categories_win_without_provider_work(
    client, group, category, automatic, expected
):
    body = bill(client, group, category=category, category_auto=automatic)
    row = icons(client, body).json()["items"][0]
    assert row["state"] == "manual" and row["category"] == expected
    assert not ExpenseCategoryDecision.objects.exists()


def test_approved_legacy_unknown_generic_can_infer_without_modifying_its_category(client, group):
    body = bill(client, group)
    Expense.objects.filter(pk=body["id"]).update(category="Other", category_auto=None)
    assert icons(client, body).json()["items"][0]["state"] == "pending"
    categories.process_category_decisions(evaluate=lambda *args: "water")
    assert icons(client, body).json()["items"][0]["category"] == "water"
    record = Expense.objects.get(pk=body["id"])
    assert record.category == "Other" and record.category_auto is None


def test_future_omitted_default_and_explicit_general_have_distinct_provenance(client, group):
    default = expense(group[1])
    default.pop("category")
    explicit = expense(group[1]) | {"category": "general"}
    assert send(client, "post", f"/groups/{group[0]}/expenses", default).status_code == 200
    assert send(client, "post", f"/groups/{group[0]}/expenses", explicit).status_code == 200
    assert icons(client, default).json()["items"][0]["state"] == "pending"
    assert icons(client, explicit).json()["items"][0]["state"] == "manual"
    # Frozen-client replay is still the same command, without an added default flag in its fingerprint.
    assert send(client, "post", f"/groups/{group[0]}/expenses", default).status_code == 200


@pytest.mark.parametrize("outcome", ["uncertain", "failed", "unexpected"])
def test_terminal_uncertainty_and_provider_failures_never_retry_on_visits(client, group, outcome):
    body = bill(client, group)
    icons(client, body)
    calls = []

    def evaluate(*args):
        calls.append(args)
        if outcome == "failed":
            raise CategoryUnavailable("gateway_http_503")
        if outcome == "unexpected":
            raise ValueError("Private response body must not be stored")
        return None

    categories.process_category_decisions(evaluate=evaluate)
    for _ in range(3):
        assert icons(client, body).json()["items"][0]["category"] is None
        assert categories.process_category_decisions(evaluate=evaluate) == 0
    assert len(calls) == 1
    assert "Private" not in ExpenseCategoryDecision.objects.get().last_error


def test_raw_title_binding_preserves_normalized_cache_and_definition_revision_identity(client, group, monkeypatch):
    body = bill(client, group)
    icons(client, body)
    categories.process_category_decisions(evaluate=lambda *args: "food")
    edit(client, group, body, description="  synthetic   DINNER  ")
    assert icons(client, body).json()["items"][0]["category"] == "food"
    assert ExpenseCategoryCache.objects.count() == 1
    assert ExpenseCategoryDecision.objects.count() == 2
    monkeypatch.setattr(categories, "DEFINITION_REVISION", "a" * 64)
    assert icons(client, body).json()["items"][0]["state"] == "pending"
    assert ExpenseCategoryDecision.objects.count() == 3


@pytest.mark.parametrize(
    "change", ["title", "title_case", "title_space", "manual", "removed", "hidden", "reversed"]
)
def test_late_result_cannot_overwrite_title_mode_or_access_changes(client, group, change):
    body = bill(client, group)
    icons(client, body)

    def evaluate(*args):
        if change == "title":
            edit(client, group, body, description="Another title")
        elif change == "title_case":
            edit(client, group, body, description="SYNTHETIC DINNER")
        elif change == "title_space":
            edit(client, group, body, description="Synthetic dinner ")
        elif change == "manual":
            edit(client, group, body, category_auto=False)
        elif change in {"removed", "hidden"}:
            Participant.objects.filter(user=client.actor).update(**{change: True})
        else:
            assert (
                send(
                    client,
                    "post",
                    f"/groups/{group[0]}/expenses/{body['id']}/reverse",
                    {"command_id": uid(), "version": 1},
                ).status_code
                == 200
            )
        return "food"

    categories.process_category_decisions(evaluate=evaluate)
    cached = ExpenseCategoryDecision.objects.get()
    assert cached.state == "uncertain" and not cached.category
    assert cached.last_error == "scope_changed"


def test_missing_runtime_key_does_not_claim_or_send_and_abandoned_claim_is_not_retried(
    client, group, settings
):
    body = bill(client, group)
    icons(client, body)
    settings.AI_GATEWAY_API_KEY = ""
    assert categories.process_category_decisions(evaluate=lambda *args: pytest.fail("No provider call")) == 0
    cached = ExpenseCategoryDecision.objects.get()
    assert cached.state == "pending"
    settings.AI_GATEWAY_API_KEY = "synthetic-only"
    cached.state = "claimed"
    cached.lease_until = timezone.now() - timedelta(seconds=1)
    cached.save()
    assert (
        categories.process_category_decisions(
            evaluate=lambda *args: pytest.fail("Unknown accepted request must not repeat")
        )
        == 0
    )
    cached.refresh_from_db()
    assert cached.state == "uncertain"
    assert icons(client, body).json()["items"][0]["state"] == "uncertain"


def test_batch_visibility_and_limits_do_not_disclose_or_queue_inaccessible_ids(client, group):
    body = bill(client, group)
    other = authenticated_client(get_user_model().objects.create_user(username=uid()))
    assert icons(other, body).status_code == 404
    assert icons(client, {"id": uid()}).status_code == 404
    assert send(client, "get", "/expense-icons?ids=" + body["id"] + "," + uid()).status_code == 404
    Participant.objects.filter(user=client.actor).update(hidden=True)
    assert icons(client, body).status_code == 404
    assert not ExpenseCategoryDecision.objects.exists()
    assert send(client, "get", "/expense-icons?ids=" + ",".join(uid() for _ in range(21))).status_code == 422
    assert send(client, "get", "/expense-icons?ids=bad").status_code == 422


def test_concurrent_reads_and_workers_are_single_flight(client, group):
    body = bill(client, group)
    actor_id = client.actor.pk

    def read():
        close_old_connections()
        try:
            return categories.expense_icons(get_user_model().objects.get(pk=actor_id), body["id"])
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert all(
            result["items"][0]["state"] == "pending" for result in pool.map(lambda _: read(), range(2))
        )
    assert ExpenseCategoryDecision.objects.count() == 1
    entered, release, guard = Event(), Event(), Lock()
    calls = []

    def evaluate(title, key):
        with guard:
            calls.append(title)
        entered.set()
        assert release.wait(5)
        return "food"

    def work():
        close_old_connections()
        try:
            return categories.process_category_decisions(evaluate=evaluate)
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(work)
        assert entered.wait(5)
        second = pool.submit(work)
        assert second.result(5) == 0
        release.set()
        assert first.result(5) == 1
    assert calls == ["Synthetic dinner"]


def test_deleted_account_purges_its_cosmetic_metadata_and_redacted_titles_do_not_queue(client, group):
    from .portability import delete_account

    body = bill(client, group)
    icons(client, body)
    peer = get_user_model().objects.create_user(username=uid())
    Participant.objects.filter(pk=group[1][1]).update(user=peer)
    delete_account(client.actor)
    assert not ExpenseCategoryCache.objects.exists()
    assert not ExpenseCategoryDecision.objects.exists()
    assert icons(authenticated_client(peer), body).json()["items"][0]["state"] == "manual"
    assert not ExpenseCategoryDecision.objects.exists()


def test_worker_processes_only_one_title_per_tick(client, group):
    first = bill(client, group)
    second = bill(client, group, description="Synthetic groceries")
    send(client, "get", "/expense-icons?ids=" + first["id"] + "," + second["id"])
    calls = []
    assert (
        categories.process_category_decisions(evaluate=lambda title, key: calls.append(title) or "food") == 1
    )
    assert len(calls) == 1 and ExpenseCategoryDecision.objects.filter(state="pending").count() == 1


@pytest.mark.parametrize("changed", ["title", "manual"])
def test_advisory_read_rereads_values_after_waiting_for_group_lock(client, group, monkeypatch, changed):
    body = bill(client, group)
    actor_id, waiting = client.actor.pk, Event()
    original = categories.visible_group

    def locking(*args, **kwargs):
        waiting.set()
        return original(*args, **kwargs)

    monkeypatch.setattr(categories, "visible_group", locking)

    def read():
        close_old_connections()
        try:
            return categories.expense_icons(get_user_model().objects.get(pk=actor_id), body["id"])
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=1) as pool:
        with transaction.atomic():
            Group.objects.select_for_update().get(pk=group[0])
            pending = pool.submit(read)
            assert waiting.wait(5)
            edit(
                client,
                group,
                body,
                **(
                    {"description": "Changed while waiting"}
                    if changed == "title"
                    else {"category_auto": False}
                ),
            )
        result = pending.result(5)["items"][0]
    assert result["title"] == ("Changed while waiting" if changed == "title" else "Synthetic dinner")
    assert result["state"] == ("pending" if changed == "title" else "manual")
    if changed == "manual":
        assert not ExpenseCategoryDecision.objects.exists()
    else:
        assert ExpenseCategoryDecision.objects.get().title_digest == categories.title_digest(result["title"])


@pytest.mark.parametrize("category", ["general", "Other"])
def test_explicit_same_generic_edit_without_auto_flag_overrides_cached_inference(client, group, category):
    body = bill(client, group, category=category)
    icons(client, body)
    categories.process_category_decisions(evaluate=lambda *args: "food")
    data = expense_dict(Expense.objects.get(pk=body["id"])) | {"command_id": uid(), "category": category}
    data.pop("category_auto")
    data.pop("deleted")
    data.pop("shares")
    response = send(client, "put", f"/groups/{group[0]}/expenses/{body['id']}", data)
    assert response.status_code == 200
    assert Expense.objects.get(pk=body["id"]).category_auto is False
    assert icons(client, body).json()["items"][0] | {} == {
        "id": body["id"], "group_id": str(group[0]), "title": "Synthetic dinner", "category": "general", "state": "manual"
    }


@pytest.mark.parametrize("category,automatic", [("general", True), ("other", False), ("water", False)])
def test_unrelated_edit_without_category_keeps_category_and_choice(client, group, category, automatic):
    body = bill(client, group, category=category, category_auto=automatic)
    data = expense_dict(Expense.objects.get(pk=body["id"])) | {"command_id": uid(), "notes": "Updated note"}
    data.pop("category_auto")
    data.pop("deleted")
    data.pop("shares")
    data.pop("category")
    assert send(client, "put", f"/groups/{group[0]}/expenses/{body['id']}", data).status_code == 200
    record = Expense.objects.get(pk=body["id"])
    assert record.category == category and record.category_auto is automatic
    assert icons(client, body).json()["items"][0]["state"] == ("pending" if automatic else "manual")
