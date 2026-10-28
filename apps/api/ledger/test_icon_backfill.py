import importlib

import pytest
from django.apps import apps
from django.contrib.auth import get_user_model
from django.db import connection

from . import expense_categories as categories
from .category_gateway import PREVIOUS_DEFINITION_REVISION
from .models import Change, Expense, ExpenseCategoryCache, ExpenseNotice
from .test_api import authenticated_client, uid
from .test_api import client as client
from .test_api import group as group
from .test_expense_categories import bill, icons
from .test_expense_categories import gateway_key as gateway_key
from .test_normalized_category_cache import another_group

pytestmark = pytest.mark.django_db(transaction=True)


def run():
    migration = importlib.import_module("ledger.migrations.0035_top_category_icons")
    assert migration.REVISION == categories.cache_revision()
    with connection.schema_editor() as editor:
        migration.backfill_top_choice(apps, editor)


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


def test_shared_cache_carries_forward_a_valid_previous_result_and_survives_its_owner(client, group):
    body = bill(client, group, description="Coffee")
    previous_owner = get_user_model().objects.create_user(username=uid())
    ExpenseCategoryCache.objects.create(owner=previous_owner, title_digest=categories.normalized_digest("coffee"),
        definition_revision=categories.cache_revision(PREVIOUS_DEFINITION_REVISION), state="ready", category="coffee")
    run()
    assert icons(client, body).json()["items"][0]["category"] == "coffee"
    shared = ExpenseCategoryCache.objects.get(owner=None)
    previous_owner.delete()
    assert ExpenseCategoryCache.objects.filter(pk=shared.pk, state="ready", category="coffee").exists()
    assert categories.process_category_decisions(evaluate=lambda *args: pytest.fail("Must reuse existing successful result")) == 0
