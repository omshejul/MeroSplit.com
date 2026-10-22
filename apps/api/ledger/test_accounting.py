"""Shared golden examples, native observations and conservation regressions."""

import copy
import json
import random
from fractions import Fraction
from pathlib import Path

import pytest

from .accounting import MAX_AMOUNT, AccountingError, propose_transfers, validate_expense

FIXTURES = json.loads((Path(__file__).resolve().parents[3] / "fixtures/accounting.json").read_text())


@pytest.mark.parametrize("case", FIXTURES["valid_expenses"], ids=lambda case: case["id"])
def test_shared_expenses(case):
    paid, shares = validate_expense(case["total"], case["paid"], case["split"], case["participant_ids"])
    assert paid == case["expected_paid"]
    assert shares == case["expected_shares"]
    assert sum(map(int, paid.values())) == sum(map(int, shares.values())) == int(case["total"])


@pytest.mark.parametrize("case", FIXTURES["invalid_expenses"], ids=lambda case: case["id"])
def test_reject_invalid_expenses(case):
    with pytest.raises(AccountingError):
        validate_expense(case["total"], case["paid"], case["split"], case["participant_ids"])


@pytest.mark.parametrize("case", FIXTURES["transfers"], ids=lambda case: case["id"])
def test_shared_transfers(case):
    original = copy.deepcopy(case["balances"])
    transfers = propose_transfers(case["balances"])
    assert transfers == case["expected_transfers"]
    assert case["balances"] == original
    remaining = {person: int(amount) for person, amount in original.items()}
    for transfer in transfers:
        amount = int(transfer["amount"])
        assert amount > 0
        assert transfer["sender"] != transfer["recipient"]
        remaining[transfer["sender"]] += amount
        remaining[transfer["recipient"]] -= amount
    assert all(amount == 0 for amount in remaining.values())
    assert len(transfers) <= max(0, sum(int(amount) != 0 for amount in original.values()) - 1)


@pytest.mark.parametrize("case", FIXTURES["invalid_transfers"], ids=lambda case: case["id"])
def test_reject_invalid_transfers(case):
    with pytest.raises(AccountingError):
        propose_transfers(case["balances"])


@pytest.mark.parametrize("case", FIXTURES["ledger_scenarios"], ids=lambda case: case["id"])
def test_chain_cycle_partial_payment_and_edited_obligation(case):
    balances = dict.fromkeys(case["participants"], 0)
    for expense in case["expenses"]:
        paid, shares = validate_expense(
            expense["total"], expense["paid"], expense["split"], case["participants"]
        )
        for person in balances:
            balances[person] += int(paid[person]) - int(shares[person])
    for payment in case["settlements"]:
        balances[payment["sender"]] += int(payment["amount"])
        balances[payment["recipient"]] -= int(payment["amount"])
    assert {person: str(amount) for person, amount in balances.items()} == case["expected_balances"]
    expected = next(row for row in FIXTURES["transfers"] if row["id"] == case["id"])
    assert propose_transfers(case["expected_balances"]) == expected["expected_transfers"]


def test_native_observation_replay():
    replay = FIXTURES["native_replay"]
    balances = dict.fromkeys(replay["participants"], 0)
    for event in replay["events"]:
        if event["type"] == "expense":
            paid, shares = validate_expense(
                event["total"], event["paid"], {"mode": "exact", "values": event["share"]}, replay["participants"]
            )
            for person in balances:
                balances[person] += int(paid[person]) - int(shares[person])
        else:
            assert event["type"] == "manual_bookkeeping_payment"
            balances[event["sender"]] += int(event["amount"])
            balances[event["recipient"]] -= int(event["amount"])
        assert {person: str(amount) for person, amount in balances.items()} == event["expected_net_after"]
    assert {person: str(amount) for person, amount in balances.items()} == replay["expected_final_net"]
    assert propose_transfers(replay["expected_final_net"]) == [
        {"sender": "B", "recipient": "A", "amount": "13333"},
        {"sender": "C", "recipient": "A", "amount": "13333"},
    ]


def test_native_remainder_and_multiple_payer_cases_use_our_allocator():
    replay = FIXTURES["native_replay"]
    for event in replay["events"]:
        if event["id"] not in {"E3", "E4"}:
            continue
        _, shares = validate_expense(
            event["total"], event["paid"], {"mode": "equal", "values": dict.fromkeys(replay["participants"], "1")},
            replay["participants"],
        )
        assert shares == event["share"]


def test_fixture_replay_preserves_the_recorded_native_evidence():
    replay = FIXTURES["native_replay"]
    source = json.loads((Path(__file__).resolve().parents[3] / replay["source_path"]).read_text())
    assert replay["events"] == source["events"]
    assert replay["expected_final_net"] == source["expected_final_net"]


def test_rounding_uses_fraction_before_id_and_does_not_mutate_inputs():
    people = ["C", "A", "B"]
    paid = {"A": "2"}
    split = {"mode": "shares", "values": {"A": "1", "B": "3", "C": "3"}}
    original = copy.deepcopy((people, paid, split))
    assert validate_expense("2", paid, split, people)[1] == {"A": "0", "B": "1", "C": "1"}
    assert (people, paid, split) == original
    assert validate_expense("2", paid, split, list(reversed(people)))[1] == {"A": "0", "B": "1", "C": "1"}


def test_seeded_allocations_and_proposals_conserve_every_paise():
    rng = random.Random(5607)
    for count in range(2, 9):
        people = [f"participant-{index:03}" for index in range(count)]
        for _ in range(12):
            total = rng.randint(1, MAX_AMOUNT)
            first_paid = rng.randint(0, total)
            paid = {people[0]: str(first_paid), people[1]: str(total - first_paid)}
            weights = {person: rng.randint(1, 100) for person in people}
            shuffled = rng.sample(people, count)
            split = {"mode": "shares", "values": {person: str(weights[person]) for person in shuffled}}
            contributions, shares = validate_expense(str(total), paid, split, shuffled)
            assert sum(map(int, shares.values())) == total
            for person in people:
                ideal = Fraction(total * weights[person], sum(weights.values()))
                assert abs(int(shares[person]) - ideal) < 1
            assert validate_expense(str(total), paid, split, people) == (contributions, shares)
            balances = {person: str(int(contributions[person]) - int(shares[person])) for person in people}
            for transfer in propose_transfers(balances):
                sender, recipient = transfer["sender"], transfer["recipient"]
                balances[sender] = str(int(balances[sender]) + int(transfer["amount"]))
                balances[recipient] = str(int(balances[recipient]) - int(transfer["amount"]))
            assert set(balances.values()) == {"0"}


def test_bill_cap_does_not_limit_aggregate_group_balances():
    assert MAX_AMOUNT == int(FIXTURES["maximum_bill_amount"])
    assert propose_transfers({"A": "3000000000", "B": "-3000000000"}) == [
        {"sender": "B", "recipient": "A", "amount": "3000000000"}
    ]
