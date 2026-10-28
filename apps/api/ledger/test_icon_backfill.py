import importlib

import pytest
from django.apps import apps
from django.contrib.auth import get_user_model
from django.db import connection

from . import expense_categories as categories
from .models import Change, Expense, ExpenseCategoryCache, ExpenseCategoryDecision, ExpenseNotice
from .test_api import authenticated_client, uid
from .test_api import client as client
from .test_api import group as group
from .test_expense_categories import bill, icons
from .test_expense_categories import gateway_key as gateway_key
from .test_normalized_category_cache import another_group

pytestmark = pytest.mark.django_db(transaction=True)


def run():
    migration = importlib.import_module("ledger.migrations.0036_icon_name_choices")
    assert migration.REVISION == categories.cache_revision()
    with connection.schema_editor() as editor:
        migration.backfill_icon_names(apps, editor)


def test_backfill_queues_once_across_unrelated_accounts_without_changing_bills(client, group, monkeypatch):
    other = authenticated_client(get_user_model().objects.create_user(username=uid()))
    second_group = another_group(other)
    first = bill(client, group, description="Lunch")
    second = bill(other, second_group, description="  LUNCH  ")
    bill(client, group, description="Unclear")
    bill(client, group, description="Manual", category="Other", category_auto=False)
    bill(client, group, description="Known category", category="travel")
    before = list(Expense.objects.values()), list(Change.objects.values()), list(ExpenseNotice.objects.values())
    calls = []
    monkeypatch.setattr(categories, "evaluate_title", lambda title, key: calls.append(title) or ("food" if title.strip().casefold() == "lunch" else "general"))
    run()
    assert len(calls) == 0, "Migration must never call a provider inside its transaction"
    assert ExpenseCategoryCache.objects.count() == 2
    assert all(cache.state == "pending" for cache in ExpenseCategoryCache.objects.all())
    assert not ExpenseCategoryCache.objects.filter(owner__isnull=False).exists()
    assert categories.process_category_decisions() == 1
    assert categories.process_category_decisions() == 1
    assert categories.process_category_decisions() == 0
    assert len(calls) == 2
    assert ExpenseCategoryCache.objects.filter(owner=None, definition_revision=categories.cache_revision(), state="ready", category="general").exists()
    assert icons(client, first).json()["items"][0]["category"] == icons(other, second).json()["items"][0]["category"] == "food"
    run()
    assert categories.process_category_decisions() == 0
    assert len(calls) == 2, "Repeated deployment must reuse completed or uncertain outcomes"
    assert before == (list(Expense.objects.values()), list(Change.objects.values()), list(ExpenseNotice.objects.values()))


@pytest.mark.parametrize("read_first", [False, True])
def test_new_prompt_rechecks_previous_ready_results_in_backfill_and_on_read(client, group, read_first):
    body = bill(client, group, description="Coffee")
    previous_owner = get_user_model().objects.create_user(username=uid())
    previous = importlib.import_module("ledger.migrations.0035_top_category_icons")
    ExpenseCategoryCache.objects.create(owner=previous_owner, title_digest=categories.normalized_digest("coffee"),
        definition_revision=previous.REVISION, state="ready", category="coffee")
    if read_first:
        assert icons(client, body).json()["items"][0]["state"] == "pending"
    run()
    assert icons(client, body).json()["items"][0]["category"] is None
    shared = ExpenseCategoryCache.objects.get(owner=None)
    previous_owner.delete()
    assert ExpenseCategoryCache.objects.filter(pk=shared.pk, state="pending", category="").exists()
    assert categories.process_category_decisions(evaluate=lambda *args: "tea") == 1
    assert icons(client, body).json()["items"][0]["category"] == "tea"


@pytest.mark.parametrize("old_state", ["pending", "claimed", "uncertain", "failed", "ready"])
def test_policy_refresh_is_separate_from_old_jobs_and_does_not_repeat_new_calls(client, group, old_state):
    body = bill(client, group, description="Garbage man")
    previous = importlib.import_module("ledger.migrations.0035_top_category_icons")
    old_cache = ExpenseCategoryCache.objects.create(owner=None, title_digest=categories.normalized_digest(body["description"]),
        definition_revision=previous.REVISION, state=old_state, category="utilities" if old_state == "ready" else "")
    old_binding = ExpenseCategoryDecision.objects.create(expense_id=body["id"], requested_by=client.actor, cache=old_cache,
        title_digest=categories.title_digest(body["description"]), definition_revision=previous.REVISION, state=old_state)
    run()
    old_cache.refresh_from_db()
    old_binding.refresh_from_db()
    assert old_cache.state == ("uncertain" if old_state == "pending" else old_state)
    assert old_binding.state == ("stale" if old_state == "pending" else old_state)
    assert categories.process_category_decisions(evaluate=lambda *args: "wastecollection") == 1
    assert icons(client, body).json()["items"][0]["category"] == "wastecollection"
    run()
    assert categories.process_category_decisions(evaluate=lambda *args: pytest.fail("Already checked with new prompt")) == 0
