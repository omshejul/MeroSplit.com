"""Exact INR allocations and repayment proposals. Positive balances are receivable."""

import re
from collections.abc import Mapping, Sequence
from typing import Any

MAX_AMOUNT = 1_000_000_000  # Paise: ₹1,00,00,000 per posted expense.


class AccountingError(ValueError):
    pass


def _integer(value: str, *, signed: bool = False, maximum: int | None = None) -> int:
    pattern = r"(?:0|-?[1-9][0-9]*)" if signed else r"(?:0|[1-9][0-9]*)"
    if not isinstance(value, str) or len(value) > 40 or re.fullmatch(pattern, value) is None:
        raise AccountingError("Amounts must be canonical decimal integer strings.")
    amount = int(value)
    if maximum is not None and amount > maximum:
        raise AccountingError(f"Amount exceeds {maximum} paise.")
    return amount


def _weight(value: str, places: int) -> int:
    pattern = rf"(?:0|[1-9][0-9]*)(?:\.[0-9]{{1,{places}}})?"
    if not isinstance(value, str) or len(value) > 40 or re.fullmatch(pattern, value) is None:
        raise AccountingError(f"Weights require nonnegative decimal strings with at most {places} decimal places.")
    whole, _, fraction = value.partition(".")
    return int(whole) * 10**places + int(fraction.ljust(places, "0"))


def _allocate(total: int, weights: Mapping[str, int]) -> dict[str, int]:
    denominator = sum(weights.values())
    if denominator <= 0:
        raise AccountingError("Select at least one positive share.")
    divisions = {person: divmod(total * weight, denominator) for person, weight in weights.items()}
    amounts = {person: quotient for person, (quotient, _) in divisions.items()}
    remaining = total - sum(amounts.values())
    order = sorted(weights, key=lambda person: (-divisions[person][1], person))
    for person in order[:remaining]:
        amounts[person] += 1
    return amounts


def validate_expense(
    total: str,
    paid: Mapping[str, str],
    split: Mapping[str, Any],
    participant_ids: Sequence[str],
) -> tuple[dict[str, str], dict[str, str]]:
    """Return paid and resolved-share vectors for every supplied group participant."""
    if not isinstance(participant_ids, Sequence) or isinstance(participant_ids, (str, bytes)):
        raise AccountingError("Participants must be a sequence of IDs.")
    people = list(participant_ids)
    if not people or any(not isinstance(person, str) or not person for person in people):
        raise AccountingError("Provide nonempty participant IDs.")
    if len(set(people)) != len(people):
        raise AccountingError("Participant IDs must be unique.")
    people.sort()
    amount = _integer(total, maximum=MAX_AMOUNT)
    if amount <= 0:
        raise AccountingError("A posted expense must have a positive total.")
    if not isinstance(paid, Mapping) or not isinstance(split, Mapping):
        raise AccountingError("Paid and split must be objects.")
    values = split.get("values")
    if not isinstance(values, Mapping) or not values:
        raise AccountingError("Select at least one beneficiary.")
    if set(paid) - set(people) or set(values) - set(people):
        raise AccountingError("Every payer and beneficiary must belong to the group.")
    contributions = {person: _integer(paid.get(person, "0"), maximum=MAX_AMOUNT) for person in people}
    if sum(contributions.values()) != amount:
        raise AccountingError("Payer contributions must equal the expense total.")

    mode = split.get("mode")
    if mode == "equal":
        if any(value != "1" for value in values.values()):
            raise AccountingError("Equal split selections must have value '1'.")
        shares = _allocate(amount, {person: 1 for person in values})
    elif mode == "exact":
        shares = {person: _integer(value, maximum=MAX_AMOUNT) for person, value in values.items()}
        if sum(shares.values()) != amount:
            raise AccountingError("Exact shares must equal the expense total.")
    elif mode == "percent":
        weights = {person: _weight(value, 2) for person, value in values.items()}
        if sum(weights.values()) != 10_000:
            raise AccountingError("Percentages must total exactly 100.00%.")
        shares = _allocate(amount, weights)
    elif mode == "shares":
        shares = _allocate(amount, {person: _weight(value, 4) for person, value in values.items()})
    else:
        raise AccountingError("Split mode must be equal, exact, percent, or shares.")
    return (
        {person: str(contributions[person]) for person in people},
        {person: str(shares.get(person, 0)) for person in people},
    )


def propose_transfers(balances: Mapping[str, str]) -> list[dict[str, str]]:
    """Match the largest remaining debt/credit, with immutable-ID ties; no ledger writes."""
    if not isinstance(balances, Mapping):
        raise AccountingError("Balances must be an object.")
    if any(not isinstance(person, str) or not person for person in balances):
        raise AccountingError("Provide nonempty participant IDs.")
    amounts = {person: _integer(value, signed=True) for person, value in balances.items()}
    if sum(amounts.values()) != 0:
        raise AccountingError("Group balances must sum to zero.")
    debtors = {person: -amount for person, amount in amounts.items() if amount < 0}
    creditors = {person: amount for person, amount in amounts.items() if amount > 0}
    transfers = []
    while debtors:
        sender = min(debtors, key=lambda person: (-debtors[person], person))
        recipient = min(creditors, key=lambda person: (-creditors[person], person))
        amount = min(debtors[sender], creditors[recipient])
        transfers.append({"sender": sender, "recipient": recipient, "amount": str(amount)})
        debtors[sender] -= amount
        creditors[recipient] -= amount
        if debtors[sender] == 0:
            del debtors[sender]
        if creditors[recipient] == 0:
            del creditors[recipient]
    return transfers
