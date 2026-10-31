import json
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from uuid import UUID, uuid4

import pytest
from django.contrib.auth import get_user_model
from django.core import signing
from django.core.serializers.json import DjangoJSONEncoder
from django.db import close_old_connections, connection, connections
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from ninja.errors import HttpError
from pydantic import ValidationError

from .accounting import AccountingError
from .mcp_tools import (
    GROUP_CURSOR_SALT,
    create_group,
    get_account_context,
    get_bill,
    get_group,
    get_payment,
    list_groups,
    list_transactions,
    record_external_payment,
    reverse_expense,
    reverse_external_payment,
    save_expense,
)
from .models import (
    Change,
    CommandReceipt,
    Expense,
    ExpenseNotice,
    Group,
    Invite,
    NotificationPreference,
    OpeningBalance,
    Participant,
    PaymentAttempt,
    PaymentProfile,
    Settlement,
)

pytestmark = pytest.mark.django_db


def identifier(number):
    return UUID(int=number)


@pytest.fixture
def ledger():
    users = get_user_model()
    actor = users.objects.create_user(username="mcp-owner", email="owner@example.invalid", first_name="Canonical owner")
    peer = users.objects.create_user(username="mcp-peer", email="peer@example.invalid", first_name="Canonical peer")
    outsider = users.objects.create_user(username="mcp-outsider", email="outsider@example.invalid")
    group = Group.objects.create(id=identifier(1), owner=actor, name="MCP synthetic ledger", version=7)
    me = Participant.objects.create(id=identifier(11), group=group, user=actor, name="Stored owner", contact_email="private-owner@example.invalid")
    other = Participant.objects.create(id=identifier(12), group=group, user=peer, name="Stored peer")
    guest = Participant.objects.create(id=identifier(13), group=group, name="Manual guest", contact_email="private-guest@example.invalid")
    bill = Expense.objects.create(id=identifier(1000), group=group, description="Shared lunch", total=100,
                                  paid={str(me.id): "100"}, shares={str(me.id): "50", str(other.id): "50"},
                                  split={"mode": "equal", "values": {str(me.id): "1", str(other.id): "1"}},
                                  date=date(2026, 10, 18), notes="An intended ledger note")
    payment = Settlement.objects.create(id=identifier(2000), group=group, sender=other, recipient=me,
                                        amount=25, recorded_by=actor, method="manual_record", date=None)
    PaymentProfile.objects.create(user=peer, vpa="private-payee@bank")
    Invite.objects.create(id=identifier(3000), participant=guest, token_hash="f" * 64,
                          expires_at=timezone.now() + timedelta(days=1), intended_email=guest.contact_email,
                          claimant=peer)
    return actor, peer, outsider, group, me, other, guest, bill, payment


def fails(status, call):
    with pytest.raises(HttpError) as error:
        call()
    assert error.value.status_code == status


def test_group_catalog_is_bounded_current_and_account_cursor_scoped(ledger):
    actor, peer, outsider, group, *_ = ledger
    for i in range(2, 8):
        row = Group.objects.create(id=identifier(i), owner=actor, name=f"Ledger {i}", archived=i == 4, is_direct=i == 5)
        Participant.objects.create(group=row, user=actor, name="Owner", removed=i == 3)
    hidden = Group.objects.create(id=identifier(9), owner=outsider, name="No membership")
    Participant.objects.create(group=hidden, user=outsider, name="Outsider")
    page = list_groups(actor, limit=2)
    assert [row["id"] for row in page["groups"]] == [str(identifier(1)), str(identifier(2))]
    assert all(set(row) == {"id", "name", "version", "archived", "is_direct", "hidden"} for row in page["groups"])
    cursor = page["next_cursor"]
    fails(422, lambda: list_groups(peer, limit=2, cursor=cursor))
    fails(422, lambda: list_groups(actor, limit=3, cursor=cursor))
    fails(422, lambda: list_groups(actor, limit=2, cursor=cursor + "tampered"))
    ids = [row["id"] for row in page["groups"]]
    while cursor:
        page = list_groups(actor, limit=2, cursor=cursor)
        ids.extend(row["id"] for row in page["groups"])
        cursor = page["next_cursor"]
    assert ids == [str(identifier(i)) for i in (1, 2, 4, 5, 6, 7)]
    assert list_groups(outsider)["groups"][0]["id"] == str(hidden.id)
    assert get_group(actor, identifier(4))["archived"] is True


def test_complete_catalog_exposes_only_callers_personal_hidden_metadata(ledger):
    actor, peer, _, group, me, *_ = ledger
    me.hidden = True
    me.save(update_fields=["hidden"])
    own = list_groups(actor)["groups"]
    peers = list_groups(peer)["groups"]
    assert own[0]["id"] == peers[0]["id"] == str(group.id)
    assert own[0]["hidden"] is True and peers[0]["hidden"] is False
    assert "hidden" not in json.dumps(get_group(peer, group.id))
    assert get_group(actor, group.id)["id"] == str(group.id)


def test_group_finance_is_complete_and_projection_does_not_export_private_metadata(ledger):
    actor, peer, _, group, me, other, _, bill, _ = ledger
    Expense.objects.bulk_create([Expense(id=identifier(1001 + i), group=group, description=f"Bill {i}", total=100,
                                         paid=bill.paid, shares=bill.shares, split=bill.split, date=bill.date) for i in range(120)])
    Expense.objects.create(id=identifier(1500), group=group, description="Deleted", total=1000,
                           paid={str(me.id): "1000"}, shares={str(other.id): "1000"}, split=bill.split, date=bill.date, deleted=True)
    Settlement.objects.create(group=group, sender=me, recipient=other, amount=400, reversed=True)
    OpeningBalance.objects.create(group=group, balances={str(me.id): "100", str(other.id): "-100"},
                                  source="Private imported source", cutoff=bill.date, accepted=True)
    with CaptureQueriesContext(connection) as queries:
        result = get_group(actor, str(group.id))
    assert len(queries) <= 8
    assert result["balances"][str(me.id)] == "6125"
    assert result["balances"][str(other.id)] == "-6125"
    assert result["totals"]["spending"] == "12100"
    assert result["currency"] == "INR"
    assert [person["name"] for person in result["participants"]] == ["Canonical owner", "Canonical peer", "Manual guest"]
    assert [person["is_self"] for person in result["participants"]] == [True, False, False]
    assert all(set(person) == {"id", "name", "is_self", "removed"} for person in result["participants"])
    assert set(result) == {"id", "name", "version", "archived", "is_direct", "currency", "participants", "balances", "transfers", "totals", "simplify_debts"}
    encoded = json.dumps(result)
    for secret in (actor.email, peer.email, "private-guest@example.invalid", "private-payee@bank", "Private imported source", "f" * 64):
        assert secret not in encoded


def test_canonical_transactions_are_bounded_and_payment_auth_metadata_is_removed(ledger):
    actor, _, _, group, me, other, _, bill, payment = ledger
    Expense.objects.bulk_create([Expense(id=identifier(1001 + i), group=group, description=f"Lunch {i}", total=100,
                                         paid=bill.paid, shares=bill.shares, split=bill.split, date=bill.date) for i in range(11)])
    Settlement.objects.create(id=identifier(2001), group=group, sender=me, recipient=other, amount=5, date=bill.date)
    ids, cursor = [], None
    while True:
        result = list_transactions(actor, group.id, limit=3, cursor=cursor, version=group.version)
        assert len(result["items"]) <= 3
        for item in result["items"]:
            record = item[item["kind"]]
            ids.append(record["id"])
            assert not {"recorded_by", "attempt_id", "payee", "user_id"} & record.keys()
        cursor = result["next_cursor"]
        if not cursor:
            break
    assert len(ids) == len(set(ids)) == 14
    assert ids[0] == str(identifier(2001))  # Payment wins a date tie.
    assert ids[-1] == str(payment.id)  # Unknown dates remain last.
    searched = list_transactions(actor, group.id, q="Lunch", limit=100)
    assert len(searched["items"]) == 12 and all(item["kind"] == "bill" for item in searched["items"])
    detail = get_bill(actor, group.id, bill.id)
    assert detail["notes"] == bill.notes and detail["split"] == bill.split
    assert get_payment(actor, group.id, payment.id) == {
        "id": str(payment.id), "sender": str(other.id), "recipient": str(me.id), "amount": "25",
        "method": "manual_record", "date": None, "reversed": False,
        "group_id": str(group.id), "group_version": 7, "currency": "INR",
    }


def test_every_group_read_rechecks_membership_and_child_belongs_to_requested_group(ledger):
    actor, peer, outsider, group, me, _, _, bill, payment = ledger
    readers = [lambda who: get_group(who, group.id), lambda who: list_transactions(who, group.id),
               lambda who: get_bill(who, group.id, bill.id), lambda who: get_payment(who, group.id, payment.id)]
    for read in readers:
        fails(404, lambda read=read: read(outsider))
        assert read(peer)
    second = Group.objects.create(owner=actor, name="Second ledger")
    Participant.objects.create(group=second, user=actor, name="Owner")
    fails(404, lambda: get_bill(actor, second.id, bill.id))
    fails(404, lambda: get_payment(actor, second.id, payment.id))
    me.removed = True
    me.save(update_fields=["removed"])
    for read in readers:
        fails(404, lambda read=read: read(actor))
    assert [row["id"] for row in list_groups(actor)["groups"]] == [str(second.id)]


def test_cursors_preserve_actor_version_and_filter_context(ledger):
    actor, peer, _, group, _, _, _, bill, _ = ledger
    page = list_transactions(actor, group.id, limit=1)
    cursor = page["next_cursor"]
    assert cursor
    fails(422, lambda: list_transactions(peer, group.id, limit=1, cursor=cursor))
    fails(422, lambda: list_transactions(actor, group.id, limit=1, cursor=cursor, q="lunch"))
    group.version += 1
    group.save(update_fields=["version"])
    fails(409, lambda: list_transactions(actor, group.id, limit=1, cursor=cursor))
    fails(409, lambda: get_bill(actor, group.id, bill.id, version=7))


@pytest.mark.parametrize("limit", [True, False, 0, -1, 101, 1.5, "1", None])
def test_page_limits_reject_non_integer_or_unbounded_inputs(ledger, limit):
    actor, _, _, group, *_ = ledger
    fails(422, lambda: list_groups(actor, limit=limit))
    fails(422, lambda: list_transactions(actor, group.id, limit=limit))


@pytest.mark.parametrize("cursor", [[], {}, 1, "x" * 4097])
def test_cursor_shape_is_bounded(ledger, cursor):
    actor, _, _, group, *_ = ledger
    fails(422, lambda: list_groups(actor, cursor=cursor))
    fails(422, lambda: list_transactions(actor, group.id, cursor=cursor))


@pytest.mark.parametrize("after", [None, [], {}, 123, "not-a-uuid"])
def test_signed_invalid_group_positions_do_not_raise_internal_errors(ledger, after):
    actor = ledger[0]
    cursor = signing.dumps({"actor": actor.pk, "limit": 2, "after": after}, salt=GROUP_CURSOR_SALT)
    fails(422, lambda: list_groups(actor, limit=2, cursor=cursor))


def test_group_cursor_expiry_is_explicit(ledger, monkeypatch):
    actor = ledger[0]
    def expired(*args, **kwargs):
        raise signing.SignatureExpired()
    monkeypatch.setattr("ledger.mcp_tools.signing.loads", expired)
    fails(409, lambda: list_groups(actor, cursor="expired"))


def test_read_tools_do_not_touch_seen_engagement_or_any_ledger_record(ledger):
    actor, _, _, group, *_rest, bill, payment = ledger
    NotificationPreference.objects.create(user=actor, expense_updates=True, email_reminders=False)
    ExpenseNotice.objects.create(expense=bill, recipient=actor, expense_version=1,
                                 created_at=timezone.now(), push_due_at=timezone.now() + timedelta(seconds=30))
    watched = (Group, Participant, Expense, Settlement, Invite, Change, CommandReceipt, NotificationPreference, ExpenseNotice)
    def state():
        return json.dumps({model._meta.label: list(model.objects.order_by("pk").values()) for model in watched}, cls=DjangoJSONEncoder, sort_keys=True)
    before = state()
    list_groups(actor)
    get_group(actor, group.id)
    list_transactions(actor, group.id)
    get_bill(actor, group.id, bill.id)
    get_payment(actor, group.id, payment.id)
    assert state() == before


def test_store_review_scope_is_preserved(ledger, settings):
    actor, _, _, group, _, _, _, bill, _ = ledger
    demo = get_user_model().objects.create_user(username="mcp-demo", email="demo@example.invalid")
    settings.STORE_REVIEW_AUTH = [{"store": "apple", "user_id": demo.pk, "email": demo.email, "pin_hash": ""}]
    synthetic = Group.objects.create(owner=demo, name="Reserved demo ledger")
    Participant.objects.create(group=synthetic, user=demo, name="Demo")
    contaminated = Group.objects.create(owner=demo, name="Cross boundary")
    Participant.objects.create(group=contaminated, user=demo, name="Demo")
    Participant.objects.create(group=contaminated, user=actor, name="Real account")
    assert [row["id"] for row in list_groups(demo)["groups"]] == [str(synthetic.id)]
    assert [row["id"] for row in list_groups(actor)["groups"]] == [str(group.id)]
    fails(404, lambda: get_group(actor, contaminated.id))
    fails(404, lambda: get_bill(demo, group.id, bill.id))


def expense_payload(ledger, **overrides):
    me, other = ledger[4:6]
    return {"id": str(uuid4()), "command_id": str(uuid4()), "description": "MCP lunch", "total": "101",
            "paid": {str(me.id): "101"}, "split": {"mode": "equal", "values": {str(me.id): "1", str(other.id): "1"}},
            "date": "2026-10-18", **overrides}


def payment_payload(ledger, **overrides):
    me, other = ledger[4:6]
    return {"id": str(uuid4()), "command_id": str(uuid4()), "sender": str(other.id), "recipient": str(me.id),
            "amount": "10", "date": None, **overrides}


@pytest.fixture(autouse=True)
def no_external_provider(monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail("MCP commands must not call an email or payment provider")
    monkeypatch.setattr("ledger.email_delivery.send_email", forbidden)
    monkeypatch.setattr("ledger.push_provider.send_bill_notification", forbidden)


def test_account_context_is_minimal_and_uses_configured_links(ledger, settings):
    actor = ledger[0]
    settings.MCP_SERVER_URL = "https://merosplit.example.invalid/mcp"
    context = get_account_context(actor)
    choices = context.pop("icon_options")
    from .expense_icon_catalog import OPTIONS
    assert {item["value"] for item in choices} == {"auto", *OPTIONS}
    assert all(item["label"] and item["description"] for item in choices)
    assert context == {"account": {"id": actor.pk, "display_name": "Canonical owner"}, "currency": "INR",
                       "minor_unit": "paise", "minor_units_per_unit": 100, "amount_format": "integer string",
                       "app_url": "https://merosplit.example.invalid/app/", "setup_url": "https://merosplit.example.invalid/mcp/setup"}
    assert actor.email not in json.dumps(context)


def test_group_creation_is_idempotent_silent_and_does_not_link_contacts(ledger):
    actor, peer = ledger[:2]
    group_id, self_id, other_id = (str(uuid4()) for _ in range(3))
    payload = {"id": group_id, "command_id": str(uuid4()), "name": "New MCP group", "self_participant_id": self_id,
               "participants": [{"id": self_id, "name": "Me"}, {"id": other_id, "name": peer.first_name}], "is_direct": True}
    result = create_group(actor, payload)
    assert create_group(actor, payload) == result == {"id": group_id, "version": 1, "linked_participant_ids": []}
    assert Participant.objects.get(pk=other_id).user_id is None
    assert Participant.objects.get(pk=other_id).contact_email == ""
    assert not Invite.objects.filter(participant__group_id=group_id).exists()
    assert Change.objects.filter(group_id=group_id).count() == 1
    fails(409, lambda: create_group(actor, {**payload, "name": "Different under same command"}))
    for email in ("", peer.email):
        with_email = {**payload, "participants": [payload["participants"][0], {**payload["participants"][1], "email": email}]}
        fails(422, lambda: create_group(actor, with_email))


def test_write_payloads_reject_actor_and_unknown_fields(ledger):
    actor, _, _, group, _, _, _, bill, payment = ledger
    calls = [lambda: save_expense(actor, group.id, expense_payload(ledger, actor_id=actor.pk)),
             lambda: record_external_payment(actor, group.id, payment_payload(ledger, actor=actor.pk)),
             lambda: reverse_external_payment(actor, group.id, payment.id, {"command_id": str(uuid4()), "version": 7}),
             lambda: reverse_expense(actor, group.id, bill.id, {"command_id": str(uuid4()), "version": 1, "user_id": actor.pk})]
    for call in calls:
        with pytest.raises(ValidationError):
            call()
    assert not CommandReceipt.objects.exists()


def test_expense_creation_queues_once_and_edit_uses_exact_revision(ledger):
    actor, _, _, group, me, other, *_ = ledger
    payload = expense_payload(ledger)
    result = save_expense(actor, group.id, payload)
    assert save_expense(actor, group.id, payload) == result
    expense = Expense.objects.get(pk=payload["id"])
    assert sum(map(int, expense.shares.values())) == 101
    assert sorted(int(expense.shares[key]) for key in (str(me.id), str(other.id))) == [50, 51]
    assert ExpenseNotice.objects.filter(expense=expense).count() == 1
    edit = {**payload, "command_id": str(uuid4()), "description": "Edited", "version": 1}
    fails(422, lambda: save_expense(actor, group.id, {**edit, "id": str(uuid4())}, expense_id=expense.id))
    fails(422, lambda: save_expense(actor, group.id, {**edit, "version": None}, expense_id=expense.id))
    fails(422, lambda: save_expense(actor, group.id, edit))
    save_expense(actor, group.id, edit, expense_id=expense.id)
    fails(409, lambda: save_expense(actor, group.id, {**edit, "command_id": str(uuid4())}, expense_id=expense.id))
    fails(409, lambda: save_expense(actor, group.id, {**payload, "description": "Changed retry"}))
    assert ExpenseNotice.objects.filter(expense=expense).count() == 1
    assert Change.objects.filter(group=group).count() == CommandReceipt.objects.count() == 2


@pytest.mark.parametrize("deleted", [0, 1, "true", None])
def test_reversal_rejects_legacy_deletion_toggle(ledger, deleted):
    actor, _, _, group, *_, bill, _ = ledger
    with pytest.raises(ValidationError):
        reverse_expense(actor, group.id, bill.id, {"command_id": str(uuid4()), "version": 1, "deleted": deleted})


def test_bill_reversal_exact_revision_and_replay(ledger):
    actor, _, _, group, *_, bill, _ = ledger
    payload = {"command_id": str(uuid4()), "version": 1}
    result = reverse_expense(actor, group.id, bill.id, payload)
    assert reverse_expense(actor, group.id, bill.id, payload) == result
    fails(409, lambda: reverse_expense(actor, group.id, bill.id, {**payload, "command_id": str(uuid4())}))
    fails(409, lambda: reverse_expense(actor, group.id, bill.id, {"command_id": str(uuid4()), "version": 2}))
    bill.refresh_from_db()
    assert bill.deleted and bill.version == 2
    assert not ExpenseNotice.objects.exists()
    assert Change.objects.filter(group=group, kind="expense_reversed").count() == 1


@pytest.mark.parametrize("field,value", [("attempt_id", None), ("attempt_id", str(identifier(900))),
                                        ("expected_group_version", None), ("expected_group_version", 7)])
def test_manual_payment_rejects_both_upi_guard_fields_even_null(ledger, field, value):
    actor, _, _, group, *_ = ledger
    fails(422, lambda: record_external_payment(actor, group.id, payment_payload(ledger, **{field: value})))
    assert not CommandReceipt.objects.exists()


@pytest.mark.parametrize("payment_date", [None, "2026-10-17"])
def test_manual_payment_keeps_explicit_known_or_unknown_date_and_replays(ledger, payment_date):
    actor, _, _, group, *_ = ledger
    payload = payment_payload(ledger, date=payment_date)
    result = record_external_payment(actor, group.id, payload)
    assert record_external_payment(actor, group.id, payload) == result
    payment = Settlement.objects.get(pk=payload["id"])
    assert (payment.date.isoformat() if payment.date else None) == payment_date
    assert payment.method == "manual_record" and payment.attempt_id is None
    assert not PaymentAttempt.objects.exists()
    assert Change.objects.filter(group=group).count() == CommandReceipt.objects.count() == 1
    fails(409, lambda: record_external_payment(actor, group.id, {**payload, "amount": "11"}))


def test_manual_payment_requires_explicit_date_and_exact_decimal_amount(ledger):
    actor, _, _, group, *_ = ledger
    payload = payment_payload(ledger)
    del payload["date"]
    fails(422, lambda: record_external_payment(actor, group.id, payload))
    with pytest.raises(ValidationError):
        record_external_payment(actor, group.id, payment_payload(ledger, amount=1.5))
    with pytest.raises(AccountingError):
        record_external_payment(actor, group.id, payment_payload(ledger, amount="01"))
    assert not CommandReceipt.objects.exists()


@pytest.mark.parametrize("state", ["prepared", "reported"])
def test_manual_payment_preserves_existing_pending_attempt_conflict(ledger, state):
    actor, _, _, group, me, other, *_ = ledger
    PaymentAttempt.objects.create(group=group, sender=other, recipient=me, amount=10, payee="synthetic@bank",
                                  payee_version=1, group_version=group.version, state=state,
                                  expires_at=timezone.now() + timedelta(minutes=1))
    fails(409, lambda: record_external_payment(actor, group.id, payment_payload(ledger)))
    assert not CommandReceipt.objects.exists()
    assert Settlement.objects.count() == 1


def test_reversal_permissions_and_same_command_replay_are_existing_rules(ledger):
    actor, _, outsider, group, _, _, guest, _, payment = ledger
    guest.user = outsider
    guest.save(update_fields=["user"])
    payload = {"command_id": str(uuid4())}
    fails(403, lambda: reverse_external_payment(outsider, group.id, payment.id, payload))
    result = reverse_external_payment(actor, group.id, payment.id, payload)
    assert reverse_external_payment(actor, group.id, payment.id, payload) == result
    payment.refresh_from_db()
    assert payment.reversed
    assert CommandReceipt.objects.count() == 1
    fails(409, lambda: reverse_external_payment(actor, group.id, payment.id, {"command_id": str(uuid4())}))


def test_all_group_writes_reject_archived_outsider_and_removed_members(ledger):
    actor, _, outsider, group, me, _, _, bill, payment = ledger
    def calls(who):
        return [lambda: save_expense(who, group.id, expense_payload(ledger)),
                lambda: reverse_expense(who, group.id, bill.id, {"command_id": str(uuid4()), "version": 1}),
                lambda: record_external_payment(who, group.id, payment_payload(ledger)),
                lambda: reverse_external_payment(who, group.id, payment.id, {"command_id": str(uuid4())})]
    for call in calls(outsider):
        fails(404, call)
    group.archived = True
    group.save(update_fields=["archived"])
    for call in calls(actor):
        fails(409, call)
    group.archived = False
    group.save(update_fields=["archived"])
    me.removed = True
    me.save(update_fields=["removed"])
    for call in calls(actor):
        fails(404, call)
    assert not CommandReceipt.objects.exists()
    assert not Change.objects.exists()


def test_failed_removed_balance_change_rolls_back_record_and_receipt(ledger):
    actor, _, _, group, me, other, _, bill, _ = ledger
    Settlement.objects.create(group=group, sender=other, recipient=me, amount=25, date=None)
    other.removed = True
    other.save(update_fields=["removed"])
    assert get_group(actor, group.id)["balances"][str(other.id)] == "0"
    fails(409, lambda: reverse_expense(actor, group.id, bill.id, {"command_id": str(uuid4()), "version": 1}))
    bill.refresh_from_db()
    group.refresh_from_db()
    assert not bill.deleted and bill.version == 1 and group.version == 7
    assert not CommandReceipt.objects.exists()


@pytest.mark.django_db(transaction=True)
def test_concurrent_same_command_creates_one_bill_receipt_and_notice(ledger):
    actor, _, _, group, *_ = ledger
    payload = expense_payload(ledger)
    def save(_):
        close_old_connections()
        try:
            who = get_user_model().objects.get(pk=actor.pk)
            return save_expense(who, group.id, payload)
        finally:
            connections.close_all()
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(save, range(2)))
    assert results[0] == results[1]
    assert Expense.objects.filter(pk=payload["id"]).count() == 1
    assert CommandReceipt.objects.count() == ExpenseNotice.objects.count() == 1
    assert Change.objects.filter(group=group).count() == 1


@pytest.mark.django_db(transaction=True)
def test_concurrent_edits_one_revision_accepts_only_one_command(ledger):
    actor, _, _, group, *_, bill, _ = ledger
    payloads = [expense_payload(ledger, id=str(bill.id), version=1, description=f"Revision {i}") for i in range(2)]
    def edit(payload):
        close_old_connections()
        try:
            who = get_user_model().objects.get(pk=actor.pk)
            try:
                save_expense(who, group.id, payload, expense_id=bill.id)
                return "accepted"
            except HttpError as error:
                return error.status_code
        finally:
            connections.close_all()
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(edit, payloads))
    assert sorted(results, key=str) == [409, "accepted"]
    bill.refresh_from_db()
    assert bill.version == 2 and CommandReceipt.objects.count() == 1


@pytest.mark.parametrize("icon", ["auto", "general", "drinks", "food", "home", "waste"])
def test_optional_bill_icon_is_explicit_and_replay_safe(ledger, icon):
    from .expense_categories import expense_icons
    from .test_api import expense
    actor, _, _, group, me, peer, *_ = ledger
    body = expense([str(me.pk), str(peer.pk)], beneficiaries=[0, 1]) | {"description": "Coffee", "category": "other"}
    result = save_expense(actor, group.pk, body, icon=icon)
    assert save_expense(actor, group.pk, body, icon=icon) == result
    record = Expense.objects.get(pk=body["id"])
    assert record.category == ("general" if icon == "auto" else icon)
    assert record.category_auto is (icon == "auto")
    hint = expense_icons(actor, body["id"])["items"][0]
    assert hint["state"] == ("pending" if icon == "auto" else "manual")
    if icon != "auto":
        assert hint["category"] == icon
    fails(409, lambda: save_expense(actor, group.pk, body, icon="shopping"))


@pytest.mark.parametrize("invalid", ["Coffee01Icon", "tea", "invented", "", False, {}])
def test_new_icon_parameter_rejects_unlisted_values_without_a_bill_write(ledger, invalid):
    from .test_api import expense
    actor, _, _, group, me, peer, *_ = ledger
    body = expense([str(me.pk), str(peer.pk)], beneficiaries=[0, 1])
    before = Expense.objects.count(), Change.objects.count()
    fails(422, lambda: save_expense(actor, group.pk, body, icon=invalid))
    assert (Expense.objects.count(), Change.objects.count()) == before


def test_omitted_edit_keeps_manual_icon_and_auto_explicitly_restores_inference(ledger):
    from .expense_categories import expense_icons
    from .test_api import expense
    actor, _, _, group, me, peer, *_ = ledger
    body = expense([str(me.pk), str(peer.pk)], beneficiaries=[0, 1]) | {"description": "Coffee", "category": "other"}
    save_expense(actor, group.pk, body, icon="drinks")
    edit = body | {"command_id": str(uuid4()), "version": 1, "notes": "Updated note"}
    save_expense(actor, group.pk, edit, expense_id=body["id"])
    record = Expense.objects.get(pk=body["id"])
    assert record.category == "drinks" and record.category_auto is False
    save_expense(actor, group.pk, edit | {"command_id": str(uuid4()), "version": 2}, expense_id=body["id"], icon="auto")
    record.refresh_from_db()
    assert record.category == "general" and record.category_auto is True
    assert expense_icons(actor, body["id"])["items"][0]["state"] == "pending"
