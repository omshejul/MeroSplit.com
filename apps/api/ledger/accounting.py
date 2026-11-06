"""Exact INR allocations and repayment proposals. Positive balances are receivable."""

import re
from collections.abc import Mapping, Sequence
from typing import Any

MAX_AMOUNT = 1_000_000_000  # Paise: ₹1,00,00,000 per posted expense.


class AccountingError(ValueError):
    pass


def _integer(value: str, *, signed: bool = False, maximum: int | None = None, max_length: int | None = 40) -> int:
    pattern = r"(?:0|-?[1-9][0-9]*)" if signed else r"(?:0|[1-9][0-9]*)"
    if not isinstance(value, str) or (max_length is not None and len(value) > max_length) or re.fullmatch(pattern, value) is None:
        raise AccountingError("Amounts must be canonical decimal integer strings.")
    amount = int(value)
    if maximum is not None and abs(amount) > maximum:
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
    elif mode == "adjustment":
        adjustments = {person: _integer(value, signed=True) for person, value in values.items()}
        if any(abs(value) > MAX_AMOUNT for value in adjustments.values()):
            raise AccountingError("Adjustment is outside the supported range.")
        remainder = amount - sum(adjustments.values())
        if remainder < 0:
            raise AccountingError("Adjustments cannot exceed the bill total.")
        shares = _allocate(remainder, dict.fromkeys(values, 1))
        shares = {person: shares[person] + value for person, value in adjustments.items()}
        if any(value < 0 for value in shares.values()):
            raise AccountingError("An adjustment makes someone's share negative. Reduce the subtraction.")
    elif mode == "percent":
        weights = {person: _weight(value, 2) for person, value in values.items()}
        if sum(weights.values()) != 10_000:
            raise AccountingError("Percentages must total exactly 100.00%.")
        shares = _allocate(amount, weights)
    elif mode == "shares":
        shares = _allocate(amount, {person: _weight(value, 4) for person, value in values.items()})
    else:
        raise AccountingError("Split mode must be equal, exact, percent, shares, or adjustment.")
    return (
        {person: str(contributions[person]) for person in people},
        {person: str(shares.get(person, 0)) for person in people},
    )


def propose_transfers(balances: Mapping[str, str], *, maximum: int | None = None, max_length: int | None = 40) -> list[dict[str, str]]:
    """Match the largest remaining debt/credit, with immutable-ID ties; no ledger writes."""
    if not isinstance(balances, Mapping):
        raise AccountingError("Balances must be an object.")
    if any(not isinstance(person, str) or not person for person in balances):
        raise AccountingError("Provide nonempty participant IDs.")
    # Calculated balances can exceed input lengths, including historical openings.
    amounts = {person: _integer(value, signed=True, maximum=maximum, max_length=max_length)
               for person, value in balances.items()}
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


def combine_transfers(transfers):
    """Offset only mutual debts between the same two people. Preserve chains/cycles."""
    pairs = {}
    for row in transfers:
        sender, recipient, amount = row["sender"], row["recipient"], int(row["amount"])
        if sender == recipient:
            raise AccountingError("Choose different participants")
        pair = tuple(sorted((sender, recipient)))
        pairs[pair] = pairs.get(pair, 0) + (amount if sender == pair[0] else -amount)
    return [
        {"sender": left if amount > 0 else right, "recipient": right if amount > 0 else left, "amount": str(abs(amount))}
        for (left, right), amount in sorted(pairs.items()) if amount
    ]


def direct_transfers(expense_rows, settlement_rows, opening_balances=None, checkpoint=()):
    """Allocate each bill independently, then subtract actual payments and a settled checkpoint."""
    rows = []
    for _, paid, shares in expense_rows:
        nets = {person: str(int(paid.get(person, "0")) - int(shares.get(person, "0")))
                for person in paid.keys() | shares.keys()}
        rows.extend(propose_transfers(nets, max_length=None))
    if opening_balances:
        rows.extend(propose_transfers(opening_balances, max_length=None))
    rows.extend({"sender": str(recipient), "recipient": str(sender), "amount": str(amount)}
                for sender, recipient, amount in settlement_rows)
    rows.extend({"sender": row["recipient"], "recipient": row["sender"], "amount": row["amount"]} for row in checkpoint)
    return combine_transfers(rows)


def credit_routed_payments(transfers, payments):
    """Credit simplified payments through direct obligations without asking for refunds.

    A pays C against A -> B -> C by reducing both debts. For separate
    A -> B and D -> C debts, the same payment leaves D owing B instead.
    The result changes routing only, never anyone's net balance.
    """
    payments = [(str(sender), str(recipient), int(amount)) for sender, recipient, amount in payments]
    # The supplied direct plan already subtracts payments. Undo those deductions
    # before allocating each payment to the debts it discharges.
    rows = combine_transfers([*transfers, *(
        {"sender": sender, "recipient": recipient, "amount": str(amount)}
        for sender, recipient, amount in payments
    )])
    edges = {(row["sender"], row["recipient"]): int(row["amount"]) for row in rows}

    def add(sender, recipient, amount):
        if sender == recipient:
            return
        value = edges.pop((sender, recipient), 0) + amount - edges.pop((recipient, sender), 0)
        if value:
            edges[(sender, recipient) if value > 0 else (recipient, sender)] = abs(value)

    for sender, recipient, amount in payments:
        own = min(amount, edges.get((sender, recipient), 0))
        add(sender, recipient, -own)
        amount -= own
        while amount:
            outgoing = next(((s, r, n) for (s, r), n in sorted(edges.items()) if s == sender), None)
            incoming = next(((s, r, n) for (s, r), n in sorted(edges.items()) if r == recipient), None)
            portion = min(amount, outgoing[2] if outgoing else amount, incoming[2] if incoming else amount)
            if outgoing:
                add(outgoing[0], outgoing[1], -portion)
            if incoming:
                add(incoming[0], incoming[1], -portion)
            add(incoming[0] if incoming else recipient, outgoing[1] if outgoing else sender, portion)
            amount -= portion
    return combine_transfers([
        {"sender": sender, "recipient": recipient, "amount": str(amount)}
        for (sender, recipient), amount in edges.items()
    ])
