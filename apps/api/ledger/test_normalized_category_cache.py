"""Real PostgreSQL/API coverage. Provider results are always injected fakes."""

from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier, Event, Lock, get_ident

import pytest
from django.contrib.auth import get_user_model
from django.db import close_old_connections, connection, connections
from django.db.migrations.executor import MigrationExecutor
from django.utils import timezone

from . import expense_categories as categories
from .models import Change, Expense, ExpenseCategoryCache, ExpenseCategoryDecision, ExpenseNotice, Participant
from .test_api import authenticated_client, send, uid
from .test_api import client as client
from .test_api import group as group
from .test_expense_categories import bill, edit, icons
from .test_expense_categories import gateway_key as gateway_key

pytestmark = pytest.mark.django_db(transaction=True)


def another_group(client):
    ids = [uid(), uid(), uid()]
    payload = {"command_id": uid(), "id": uid(), "name": "Second test group", "self_participant_id": ids[0],
               "participants": [{"id": identifier, "name": name} for identifier, name in zip(ids, ["A", "B", "C"])]}
    response = send(client, "post", "/groups", payload)
    assert response.status_code == 200, response.content
    return payload["id"], ids, payload


def isolated(call):
    close_old_connections()
    try:
        return call()
    finally:
        connections.close_all()


@pytest.mark.parametrize("left,right", [
    ("  DINNER\twith\u00a0friends\n", "dinner with friends"),
    ("CAFÉ", "cafe\u0301"), ("Straße", "STRASSE"),
])
def test_normalization_reuses_only_equivalent_case_unicode_and_spacing(left, right):
    assert categories.normalized_digest(left) == categories.normalized_digest(right)
    assert categories.title_digest(left) != categories.title_digest(right)


@pytest.mark.parametrize("left,right", [
    ("cafe", "café"), ("Room 2", "Room 3"), ("x²", "x2"), ("½ lunch", "1/2 lunch"),
    ("taxi-airport", "taxi airport"), ("a+b", "ab"), ("bill ①", "bill 1"),
])
def test_normalization_keeps_accents_digits_punctuation_and_compatibility_symbols(left, right):
    assert categories.normalized_digest(left) != categories.normalized_digest(right)


def test_cross_expense_reuse_is_read_only_and_manual_choices_win(client, group):
    first = bill(client, group, description="Café lunch")
    second_group = another_group(client)
    second = bill(client, second_group, description="  CAFE\u0301  LUNCH ")
    specific = bill(client, group, description="Café lunch", category="travel", category_auto=True)
    manual = bill(client, group, description="Café lunch", category="Other", category_auto=False)
    before = list(Expense.objects.values()), list(Change.objects.values()), list(ExpenseNotice.objects.values())
    icons(client, first)
    assert categories.process_category_decisions(evaluate=lambda *args: "food") == 1
    assert icons(client, second).json()["items"][0]["category"] == "food"
    assert icons(client, manual).json()["items"][0]["state"] == "manual"
    assert icons(client, specific).json()["items"][0]["category"] == "travel"
    assert categories.process_category_decisions(evaluate=lambda *args: pytest.fail("Must reuse cache")) == 0
    assert ExpenseCategoryCache.objects.count() == 1 and ExpenseCategoryDecision.objects.count() == 2
    assert before == (list(Expense.objects.values()), list(Change.objects.values()), list(ExpenseNotice.objects.values()))


def test_two_readers_of_the_same_shared_bill_never_share_a_cache_or_result(client, group):
    peer = get_user_model().objects.create_user(username=uid())
    Participant.objects.filter(pk=group[1][1]).update(user=peer)
    peer_client = authenticated_client(peer)
    body = bill(client, group)
    icons(client, body)
    categories.process_category_decisions(evaluate=lambda *args: "food")
    assert icons(peer_client, body).json()["items"][0] | {} == {
        "id": body["id"], "group_id": group[0], "title": body["description"], "category": None, "state": "pending"}
    categories.process_category_decisions(evaluate=lambda *args: "water")
    assert icons(client, body).json()["items"][0]["category"] == "food"
    assert icons(peer_client, body).json()["items"][0]["category"] == "water"
    assert ExpenseCategoryCache.objects.count() == ExpenseCategoryDecision.objects.count() == 2
    assert set(ExpenseCategoryDecision.objects.values_list("requested_by_id", "cache__owner_id")) == {
        (client.actor.pk, client.actor.pk), (peer.pk, peer.pk)}


def test_normalization_and_model_revision_both_invalidate(client, group, monkeypatch):
    body = bill(client, group)
    icons(client, body)
    categories.process_category_decisions(evaluate=lambda *args: "food")
    monkeypatch.setattr(categories, "NORMALIZATION_VERSION", "canonical-v-next")
    assert icons(client, body).json()["items"][0]["state"] == "pending"
    monkeypatch.setattr(categories, "DEFINITION_REVISION", "b" * 64)
    assert icons(client, body).json()["items"][0]["state"] == "pending"
    assert ExpenseCategoryCache.objects.count() == 3


def test_concurrent_different_bills_and_workers_use_one_normalized_dispatch(client, group):
    other = another_group(client)
    bills = [bill(client, group), bill(client, other, description="  synthetic   DINNER ")]
    start = Barrier(2)

    def read(body):
        start.wait(5)
        return categories.expense_icons(get_user_model().objects.get(pk=client.actor.pk), body["id"])

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda body: isolated(lambda: read(body)), bills))
    assert all(result["items"][0]["state"] == "pending" for result in results)
    assert ExpenseCategoryCache.objects.count() == 1 and ExpenseCategoryDecision.objects.count() == 2
    entered, release, lock, calls = Event(), Event(), Lock(), []

    def evaluate(title, key):
        assert not connection.in_atomic_block and key == "synthetic-only"
        with lock:
            calls.append(title)
        entered.set()
        assert release.wait(5)
        return "food"

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(isolated, lambda: categories.process_category_decisions(evaluate=evaluate))
        try:
            assert entered.wait(5)
            second = pool.submit(isolated, lambda: categories.process_category_decisions(evaluate=evaluate))
            assert second.result(5) == 0
            assert all(icons(client, body).json()["items"][0]["state"] == "pending" for body in bills)
        finally:
            release.set()
        assert first.result(5) == 1
    assert len(calls) == 1
    assert all(icons(client, body).json()["items"][0]["category"] == "food" for body in bills)


def test_disjoint_group_reverse_batches_acquire_cache_keys_in_one_order(client, group, monkeypatch):
    other = another_group(client)
    first = [bill(client, group, description=title) for title in ["Alpha lunch", "Beta taxi"]]
    second = [bill(client, other, description=title) for title in ["Beta taxi", "Alpha lunch"]]
    start, lock, visits, finished_first = Barrier(2), Lock(), {}, {}
    original = categories._binding

    def binding(actor, expense):
        thread = get_ident()
        with lock:
            keys = visits.setdefault(thread, [])
            keys.append(categories.normalized_digest(expense.description))
            first_call = len(keys) == 1
            done = finished_first.setdefault(thread, Event())
        if first_call:
            start.wait(5)
        result = original(actor, expense)
        if first_call:
            done.set()
            # Reverse cache locking deadlocks here; deterministic ordering only waits briefly.
            with lock:
                peers = [event for identifier, event in finished_first.items() if identifier != thread]
            for event in peers:
                event.wait(0.15)
        return result

    monkeypatch.setattr(categories, "_binding", binding)

    def read(batch):
        actor = get_user_model().objects.get(pk=client.actor.pk)
        return categories.expense_icons(actor, ",".join(body["id"] for body in batch))

    with ThreadPoolExecutor(max_workers=2) as pool:
        jobs = [pool.submit(isolated, lambda batch=batch: read(batch)) for batch in [first, second]]
        assert all(len(job.result(8)["items"]) == 2 for job in jobs)
    assert all(keys == sorted(keys) for keys in visits.values())
    assert ExpenseCategoryCache.objects.count() == 2 and ExpenseCategoryDecision.objects.count() == 4


@pytest.mark.parametrize("outcome", ["uncertain", "failed"])
def test_terminal_outcome_is_reused_by_other_bills_without_a_visit_retry(client, group, outcome):
    first, second = bill(client, group), bill(client, group, description=" SYNTHETIC dinner ")
    icons(client, first)

    def evaluate(*args):
        if outcome == "failed":
            raise TimeoutError("private")
        return None

    categories.process_category_decisions(evaluate=evaluate)
    assert icons(client, second).json()["items"][0]["state"] == outcome
    assert categories.process_category_decisions(evaluate=lambda *args: pytest.fail("No retry")) == 0


def test_expired_or_deleted_dispatch_binding_keeps_shared_uncertainty(client, group):
    first, second = bill(client, group), bill(client, group, description=" SYNTHETIC dinner ")
    icons(client, first)

    def evaluate(*args):
        ExpenseCategoryDecision.objects.all().delete()
        return "food"

    categories.process_category_decisions(evaluate=evaluate)
    assert icons(client, second).json()["items"][0]["state"] == "uncertain"
    assert ExpenseCategoryCache.objects.get().last_error == "scope_changed"
    assert categories.process_category_decisions(evaluate=lambda *args: pytest.fail("No retry")) == 0


@pytest.mark.parametrize("missing_lease", [False, True])
def test_actual_expired_shared_claim_never_resends_even_after_read(client, group, missing_lease):
    body = bill(client, group)
    icons(client, body)
    expired = None if missing_lease else timezone.now() - timedelta(seconds=1)
    ExpenseCategoryCache.objects.update(state="claimed", lease_until=expired)
    ExpenseCategoryDecision.objects.update(state="claimed", lease_until=expired)
    assert categories.process_category_decisions(evaluate=lambda *args: pytest.fail("No retry")) == 0
    assert icons(client, body).json()["items"][0]["state"] == "uncertain"
    assert ExpenseCategoryDecision.objects.get().last_error == "abandoned_claim"
    assert categories.process_category_decisions(evaluate=lambda *args: pytest.fail("No retry")) == 0


def test_legacy_ready_and_claimed_rows_survive_migration_without_backfill(client, group):
    ready, claimed = bill(client, group), bill(client, group, description="Legacy taxi")
    before = list(Expense.objects.values()), list(Change.objects.values())
    executor = MigrationExecutor(connection)
    try:
        executor.migrate([("ledger", "0028_expense_category_decisions")])
        old = executor.loader.project_state([("ledger", "0028_expense_category_decisions")]).apps.get_model("ledger", "ExpenseCategoryDecision")
        for body, state, category in [(ready, "ready", "food"), (claimed, "claimed", "")]:
            old.objects.create(expense_id=body["id"], requested_by_id=client.actor.pk,
                               title_digest=categories.title_digest(body["description"]), definition_revision=categories.DEFINITION_REVISION,
                               state=state, category=category, lease_until=timezone.now() - timedelta(days=100))
    finally:
        MigrationExecutor(connection).migrate([("ledger", "0029_normalized_category_cache")])
    assert not ExpenseCategoryCache.objects.exists()
    assert ExpenseCategoryDecision.objects.filter(cache__isnull=True).count() == 2
    assert before == (list(Expense.objects.values()), list(Change.objects.values()))
    assert icons(client, ready).json()["items"][0]["category"] == "food"
    assert icons(client, claimed).json()["items"][0]["state"] == "uncertain"
    assert categories.process_category_decisions(evaluate=lambda *args: pytest.fail("No legacy resend")) == 0


def cache(owner, title, **fields):
    return ExpenseCategoryCache.objects.create(owner=owner, title_digest=categories.normalized_digest(title),
                                              definition_revision=categories.cache_revision(), **fields)


def test_cleanup_is_90_days_bounded_and_keeps_pending_claimed_and_unresolved(client):
    old, recent = timezone.now() - timedelta(days=91), timezone.now() - timedelta(days=89)
    preserved = [cache(client.actor, "recent", state="ready", last_used_at=recent)]
    preserved.append(cache(client.actor, "claimed", state="claimed", last_used_at=old))
    for error in categories.UNRESOLVED:
        preserved.append(cache(client.actor, error, state="uncertain", last_error=error, last_used_at=old))
    for i in range(105):
        cache(client.actor, f"Unused resolved {i}", state="failed", last_used_at=old)
    assert categories.cleanup_category_cache(limit=1000) == 100
    assert ExpenseCategoryCache.objects.filter(pk__in=[row.pk for row in preserved]).count() == len(preserved)
    assert categories.cleanup_category_cache() == 5
    assert categories.cleanup_category_cache() == 0


def test_cleanup_keeps_active_metadata_and_only_purges_unused_metadata(client, group):
    active, inactive = bill(client, group), bill(client, group, description="Different obsolete title")
    for body in [active, inactive]:
        icons(client, body)
        categories.process_category_decisions(evaluate=lambda *args: "food")
    edit(client, group, inactive, description="A new title")
    old = timezone.now() - timedelta(days=91)
    ExpenseCategoryCache.objects.update(last_used_at=old)
    ExpenseCategoryDecision.objects.update(last_used_at=old)
    before = list(Expense.objects.values()), list(Change.objects.values()), list(ExpenseNotice.objects.values())
    assert categories.cleanup_category_cache() == 2
    active_binding = ExpenseCategoryDecision.objects.get()
    assert str(active_binding.expense_id) == active["id"] and active_binding.last_used_at > old
    assert ExpenseCategoryCache.objects.count() == 1
    assert before == (list(Expense.objects.values()), list(Change.objects.values()), list(ExpenseNotice.objects.values()))


@pytest.mark.parametrize("error", sorted(categories.UNRESOLVED))
@pytest.mark.parametrize("state", ["uncertain", "stale"])
def test_old_unresolved_binding_survives_cache_deletion_and_cleanup(client, group, error, state):
    body = bill(client, group)
    icons(client, body)
    ExpenseCategoryCache.objects.update(state="uncertain", last_error=error)
    ExpenseCategoryDecision.objects.update(state=state, last_error=error)
    ExpenseCategoryCache.objects.all().delete()
    row = ExpenseCategoryDecision.objects.get()
    assert row.cache_id is None
    edit(client, group, body, description="No longer the same raw title")
    ExpenseCategoryDecision.objects.update(last_used_at=timezone.now() - timedelta(days=100))
    assert categories.cleanup_category_cache() == 0
    assert ExpenseCategoryDecision.objects.get().last_error == error
    edit(client, group, body, description=body["description"])
    assert icons(client, body).json()["items"][0]["state"] == "uncertain"
    assert categories.process_category_decisions(evaluate=lambda *args: pytest.fail("Fence must survive")) == 0


def test_old_stale_raw_binding_and_unreferenced_never_dispatched_cache_are_reclaimed(client, group):
    body = bill(client, group)
    icons(client, body)
    old_binding = ExpenseCategoryDecision.objects.get()
    edit(client, group, body, description="A different new title")
    icons(client, body)
    old_binding.refresh_from_db()
    assert old_binding.state == "stale"
    old = timezone.now() - timedelta(days=91)
    ExpenseCategoryDecision.objects.filter(pk=old_binding.pk).update(last_used_at=old)
    ExpenseCategoryCache.objects.filter(pk=old_binding.cache_id).update(last_used_at=old)
    unused = cache(client.actor, "Unreferenced never dispatched", last_used_at=old)
    leased = cache(client.actor, "Unreferenced but dispatch uncertain", last_used_at=old, lease_until=old)
    before = list(Expense.objects.values()), list(Change.objects.values())
    assert categories.cleanup_category_cache() == 3
    assert not ExpenseCategoryDecision.objects.filter(pk=old_binding.pk).exists()
    assert not ExpenseCategoryCache.objects.filter(pk=unused.pk).exists()
    assert ExpenseCategoryCache.objects.filter(pk=leased.pk).exists()
    assert ExpenseCategoryDecision.objects.get().state == "pending"
    assert before == (list(Expense.objects.values()), list(Change.objects.values()))


def test_old_genuinely_queued_pending_binding_and_cache_are_kept(client, group):
    body = bill(client, group)
    icons(client, body)
    old = timezone.now() - timedelta(days=100)
    ExpenseCategoryCache.objects.update(last_used_at=old)
    ExpenseCategoryDecision.objects.update(last_used_at=old)
    assert categories.cleanup_category_cache() == 0
    assert ExpenseCategoryCache.objects.get().state == ExpenseCategoryDecision.objects.get().state == "pending"


def test_finish_uses_immutable_claim_raw_title_even_if_binding_was_changed(client, group):
    body = bill(client, group)
    icons(client, body)

    def evaluate(*args):
        changed = body["description"].upper()
        edit(client, group, body, description=changed)
        ExpenseCategoryDecision.objects.update(title_digest=categories.title_digest(changed))
        return "food"

    categories.process_category_decisions(evaluate=evaluate)
    assert ExpenseCategoryCache.objects.get().state == "uncertain"
    assert ExpenseCategoryDecision.objects.get().last_error == "scope_changed"
