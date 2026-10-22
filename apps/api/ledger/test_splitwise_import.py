import csv
import io
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy

import pytest
from django.contrib.auth import get_user_model
from django.db import IntegrityError, close_old_connections, connections, transaction
from django.test import Client

from .accounting import AccountingError
from .models import Change, CommandReceipt, Expense, Group, Participant, Settlement
from .portability import delete_account
from .services import snapshot
from .splitwise_import import import_splitwise, parse_splitwise
from .test_api import client as client
from .test_api import send, uid

pytestmark = pytest.mark.django_db
MEMBERS = ["Alpha", "Beta", "Gamma", "Delta (removed)"]
HEADER = ["Date", "Description", "Category", "Cost", "Currency", *MEMBERS]


def csv_text(rows, *, footer=None, blank=False, quoting=csv.QUOTE_MINIMAL, newline="\n"):
    output = io.StringIO(newline="")
    writer = csv.writer(output, lineterminator=newline, quoting=quoting)
    writer.writerow(HEADER)
    if blank:
        writer.writerow([])
    writer.writerows(rows)
    if footer is not None:
        writer.writerow([])
        writer.writerow(["2026-10-17", "Total balance", " ", " ", "INR", *footer])
        writer.writerow([])
    return output.getvalue()


def bill(*, description="Synthetic groceries", cost="20.00", nets=None):
    return ["2026-10-10", description, "Groceries", cost, "INR", *(nets or ["0.00", "10.00", "-10.00", "0.00"])]


def payment():
    return ["2026-10-11", "Synthetic historical payment", "Payment", "6.00", "INR", "0", "6", "-6", "0"]


def neutral():
    return ["2026-10-12", "Balance-neutral bill", "General", "1.00", "INR", "0", "0", "0", "0"]


def full_export():
    # Same row counts, ambiguous source line and balance vector as the private reference;
    # all names, descriptions, dates and transaction values here are synthetic.
    rows = [bill(description=f"Synthetic bill {i + 1}") for i in range(98)]
    rows += [payment() for _ in range(7)] + [neutral()] + [payment(), payment()]
    return csv_text(rows, footer=["0.00", "1034.00", "-1034.00", "0.00"], blank=True)


def payload(text=None, **updates):
    text = text or csv_text([bill()], footer=["0", "10", "-10", "0"])
    return {
        "command_id": uid(), "id": uid(), "csv": text, "name": "Imported household",
        "self_index": 1, "payers": {}, **updates,
    }


def test_preview_read_only_full_structure_and_footer(client):
    response = send(client, "post", "/imports/splitwise/preview", {"csv": full_export()})
    assert response.status_code == 200, response.content
    preview = response.json()
    assert preview["members"] == MEMBERS
    assert preview["expense_count"] == 99 and preview["payment_count"] == 9
    assert preview["balances"] == ["0", "103400", "-103400", "0"]
    assert preview["unresolved"] == [{
        "row": 108, "date": "2026-10-12", "description": "Balance-neutral bill",
        "category": "General", "amount": "100",
    }]
    assert "not original contributions" in preview["warnings"][0]
    assert preview["duplicate_group"] is None
    assert "records" not in preview
    assert Group.objects.count() == CommandReceipt.objects.count() == 0


def test_import_full_ledger_balances_history_and_exact_shares(client):
    data = payload(full_export(), payers={"108": 3})
    response = send(client, "post", "/imports/splitwise", data)
    assert response.status_code == 200, response.content
    assert response.json() == {"id": data["id"], "version": 109, "already_imported": False}
    state = send(client, "get", f"/groups/{data['id']}").json()
    people = {p["name"]: p for p in state["participants"]}
    assert [state["balances"][people[name]["id"]] for name in MEMBERS] == ["0", "103400", "-103400", "0"]
    assert people["Beta"]["user_id"] == client.actor.pk
    assert all(people[name]["user_id"] is None for name in ["Alpha", "Gamma", "Delta (removed)"])
    assert len(state["expenses"]) == 99 and len(state["settlements"]) == 9
    assert state["totals"]["spending"] == "196100"
    assert len(state["activity"]) == 109
    assert [a["sequence"] for a in state["activity"]] == list(range(1, 110))
    original = next(e for e in state["expenses"] if e["description"] == "Synthetic bill 1")
    assert original["category"] == "Groceries" and original["date"] == "2026-10-10"
    assert original["paid"][people["Beta"]["id"]] == "2000"
    assert original["shares"][people["Beta"]["id"]] == "1000"
    assert original["shares"][people["Gamma"]["id"]] == "1000"
    zero = next(e for e in state["expenses"] if e["description"] == "Balance-neutral bill")
    assert zero["paid"][people["Delta (removed)"]["id"]] == "100"
    assert zero["shares"][people["Delta (removed)"]["id"]] == "100"
    assert all(p["sender"] == people["Beta"]["id"] and p["recipient"] == people["Gamma"]["id"] for p in state["settlements"])
    assert all(p["method"] == "splitwise_import" and p["date"] == "2026-10-11" for p in state["settlements"])
    payments = [a for a in state["activity"] if a["kind"] == "manual_settlement"]
    assert all(a["data"]["description"] == "Synthetic historical payment" for a in payments)


def test_neutral_row_requires_explicit_valid_payer_without_writes(client):
    data = payload(csv_text([neutral()]))
    for choices in [{}, {"2": -1}, {"2": 4}, {"9": 0}, {"2": True}, {"2": "0"}]:
        response = send(client, "post", "/imports/splitwise", {**data, "payers": choices})
        assert response.status_code == 422, response.content
    assert Group.objects.count() == Expense.objects.count() == 0
    response = send(client, "post", "/imports/splitwise", {**data, "payers": {"2": 0}})
    assert response.status_code == 200
    assert set(snapshot(Group.objects.get(id=data["id"]))["balances"].values()) == {"0"}


def test_quotes_bom_multiline_removed_member_and_semantic_duplicates(client):
    rows = [bill(description='Dinner, "shared"\nwith friends'), payment()]
    text = csv_text(rows, footer=["0", "16", "-16", "0"])
    data = payload(text)
    first = send(client, "post", "/imports/splitwise", data).json()
    equivalent = "\ufeff" + csv_text(rows, footer=["0.00", "16.00", "-16.00", "0.00"], blank=True, quoting=csv.QUOTE_ALL, newline="\r\n")
    preview = send(client, "post", "/imports/splitwise/preview", {"csv": equivalent}).json()
    assert preview["source_hash"] == parse_splitwise(text)["source_hash"]
    assert preview["duplicate_group"] == {"id": first["id"], "name": data["name"]}
    duplicate = send(client, "post", "/imports/splitwise", payload(equivalent)).json()
    assert duplicate == {**first, "already_imported": True}
    assert Group.objects.count() == Expense.objects.count() == Settlement.objects.count() == 1
    expense = Expense.objects.get()
    assert expense.description == rows[0][1]
    assert Participant.objects.filter(name="Delta (removed)").exists()


def test_same_command_replay_and_payload_identity(client):
    data = payload()
    first = send(client, "post", "/imports/splitwise", data)
    assert first.status_code == 200
    assert send(client, "post", "/imports/splitwise", data).json() == first.json()
    changed = send(client, "post", "/imports/splitwise", {**data, "name": "Another name"})
    assert changed.status_code == 409
    assert Group.objects.count() == CommandReceipt.objects.count() == 1
    Participant.objects.filter(group_id=data["id"], user=client.actor).update(user=None)
    assert send(client, "post", "/imports/splitwise", data).status_code == 404
    assert send(client, "post", "/imports/splitwise", payload(data["csv"])).status_code == 404
    assert send(client, "post", "/imports/splitwise/preview", {"csv": data["csv"]}).status_code == 404


def test_duplicate_hash_is_database_invariant_and_owner_scoped(client):
    data = payload()
    result = import_splitwise(client.actor, data)
    group = Group.objects.get(id=result["id"])
    with pytest.raises(IntegrityError), transaction.atomic():
        Group.objects.create(owner=client.actor, name="Duplicate", import_source_hash=group.import_source_hash)
    other = get_user_model().objects.create_user(username=uid(), email=f"{uid()}@splitdumb.invalid")
    other_result = import_splitwise(other, payload())
    assert other_result["id"] != result["id"]
    assert Group.objects.count() == 2
    assert send(Client(), "post", "/imports/splitwise/preview", {"csv": data["csv"]}).status_code == 401
    assert send(Client(), "post", "/imports/splitwise", payload()).status_code == 401


def test_original_importer_account_deletion_can_transfer_group(client):
    data = payload()
    first = import_splitwise(client.actor, data)
    successor = get_user_model().objects.create_user(username=uid(), email=f"{uid()}@splitdumb.invalid")
    second = import_splitwise(successor, payload())
    Participant.objects.filter(group_id=first["id"], name="Gamma").update(user=successor)
    delete_account(client.actor)
    group = Group.objects.get(id=first["id"])
    assert group.owner_id == successor.pk and group.import_source_hash == ""
    assert Group.objects.get(id=second["id"]).import_source_hash
    assert group.expenses.count() == 1


def test_partial_failure_rolls_back_every_record_and_same_request_retries(client, monkeypatch):
    data = payload(full_export(), payers={"108": 0})
    with monkeypatch.context() as patch:
        def fail(*args, **kwargs):
            assert Expense.objects.count() == 99  # Failure occurs after bills have reached PostgreSQL.
            raise RuntimeError("Injected import interruption")
        patch.setattr(Settlement.objects, "bulk_create", fail)
        with pytest.raises(RuntimeError, match="Injected import interruption"):
            import_splitwise(client.actor, data)
    for model in [Group, Participant, Expense, Settlement, Change, CommandReceipt]:
        assert model.objects.count() == 0
    result = import_splitwise(client.actor, data)
    assert result["already_imported"] is False
    assert Expense.objects.count() == 99 and Settlement.objects.count() == 9


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("same_command", [True, False])
def test_concurrent_retries_and_duplicate_files_post_once(client, same_command):
    first = payload()
    second = deepcopy(first) if same_command else payload(first["csv"])

    def execute(data):
        close_old_connections()
        try:
            return import_splitwise(get_user_model().objects.get(pk=client.actor.pk), data)
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(execute, [first, second]))
    assert results[0]["id"] == results[1]["id"]
    assert [r["already_imported"] for r in results].count(True) == (0 if same_command else 1)
    assert Group.objects.count() == Expense.objects.count() == 1
    assert Change.objects.count() == 2


@pytest.mark.parametrize("mutate", [
    lambda rows: rows[0].__setitem__(4, "USD"),
    lambda rows: rows[0].__setitem__(3, "20.001"),
    lambda rows: rows[0].__setitem__(3, "1,000.00"),
    lambda rows: rows[0].__setitem__(3, "0"),
    lambda rows: rows[0].__setitem__(3, "10000000.01"),
    lambda rows: rows[0].__setitem__(0, "2026-02-30"),
    lambda rows: rows[0].__setitem__(0, "10/10/2026"),
    lambda rows: rows[0].__setitem__(1, ""),
    lambda rows: rows[0].__setitem__(1, "x" * 201),
    lambda rows: rows[0].__setitem__(2, "x" * 41),
    lambda rows: rows[0].__setitem__(5, "1.00"),
    lambda rows: rows[0].__setitem__(5, "-0.01"),
    lambda rows: rows[0].__setitem__(6, "21.00"),
    lambda rows: rows[0].pop(),
    lambda rows: rows[0].append("extra"),
])
def test_invalid_csv_never_mutates_existing_data(client, mutate):
    existing = import_splitwise(client.actor, payload())
    rows = [bill()]
    mutate(rows)
    response = send(client, "post", "/imports/splitwise", payload(csv_text(rows)))
    assert response.status_code == 422, response.content
    assert Group.objects.count() == Expense.objects.count() == 1
    assert Group.objects.get(id=existing["id"]).version == 2


@pytest.mark.parametrize("nets,cost,category", [
    (["5", "5", "-10", "0"], "20", "General"),
    (["5", "5", "-10", "0"], "10", "Payment"),
    (["0", "10", "-10", "0"], "20", "Payment"),
    (["0", "0", "0", "0"], "1", "Payment"),
])
def test_unsupported_payer_or_payment_ambiguity_is_explicit(nets, cost, category):
    row = bill(cost=cost, nets=nets)
    row[2] = category
    with pytest.raises(AccountingError):
        parse_splitwise(csv_text([row]))


def test_footer_mismatch_repeated_footer_and_post_footer_transaction(client):
    text = csv_text([bill()], footer=["0", "9", "-9", "0"])
    assert send(client, "post", "/imports/splitwise/preview", {"csv": text}).status_code == 422
    good = csv_text([bill()], footer=["0", "10", "-10", "0"])
    footer = good.splitlines()[-2] + "\n"
    for invalid in [good + footer, good + csv_text([bill()]).splitlines()[1] + "\n"]:
        assert send(client, "post", "/imports/splitwise", payload(invalid)).status_code == 422
    assert Group.objects.count() == 0


@pytest.mark.parametrize("text", [
    "", "\x00", "Date,Wrong,Header\n", csv_text([]),
    csv_text([bill()]).replace("Beta,Gamma", "Beta,Beta"),
    csv_text([bill()]).replace("Beta,Gamma", "Beta,beta"),
    csv_text([bill()]).replace("Beta,Gamma", "Beta, Beta "),
    csv_text([bill()]).replace("Beta,Gamma", "Beta, "),
    csv_text([bill()]).replace("Synthetic groceries", '"unterminated'),
    "x" * 1_048_577,
    "आ" * 400_000,
    "\ud800",
])
def test_schema_size_encoding_and_csv_validation(client, text):
    response = send(client, "post", "/imports/splitwise/preview", {"csv": text})
    assert response.status_code == 422, response.content
    assert Group.objects.count() == 0


def test_row_limit_and_unrecognized_choices(client):
    with pytest.raises(AccountingError, match="10000"):
        parse_splitwise(csv_text([bill()] * 10_001))
    for updates in [{"self_index": 4}, {"self_index": True}, {"payers": {"2": 0}}]:
        response = send(client, "post", "/imports/splitwise", payload(**updates))
        assert response.status_code == 422
    assert Group.objects.count() == 0
