"""Import the INR member-net CSV export into one new, atomic ledger."""

import csv
import hashlib
import io
import json
import re
import unicodedata
from datetime import date

from django.contrib.auth import get_user_model
from django.db import transaction
from ninja.errors import HttpError

from .accounting import MAX_AMOUNT, AccountingError, validate_expense
from .models import Change, CommandReceipt, Expense, Group, Participant, Settlement
from .services import expense_dict, previous_result, visible_group

MAX_BYTES = 1_048_576
MAX_ROWS = 10_000
HEADERS = ["Date", "Description", "Category", "Cost", "Currency"]
CONTRIBUTION_WARNING = (
    "Splitwise CSV contains net amounts, not original contributions. Bills are reconstructed "
    "with one payer and exact shares to preserve each member's balance. Original comments, "
    "receipts and edit history are not included."
)


def _paise(value: str, row: int, *, signed: bool = False) -> int:
    pattern = r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?" if signed else r"(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?"
    if len(value) > 40 or re.fullmatch(pattern, value) is None:
        raise AccountingError(f"Row {row}: use INR decimals with at most two places, without commas")
    whole, _, fraction = value.removeprefix("-").partition(".")
    amount = int(whole) * 100 + int(fraction.ljust(2, "0"))
    return -amount if value.startswith("-") else amount


def parse_splitwise(text: str) -> dict:
    """Validate every row before writes; retain source line numbers for payer choices."""
    try:
        size = len(text.encode("utf-8")) if isinstance(text, str) else 0
    except UnicodeEncodeError as exc:
        raise AccountingError("Choose a valid UTF-8 CSV") from exc
    if not 0 < size <= MAX_BYTES:
        raise AccountingError("Choose a nonempty UTF-8 CSV no larger than 1 MiB")
    if "\x00" in text:
        raise AccountingError("CSV contains an unsupported NUL character")
    # Normalize transport line endings, including quoted multiline descriptions.
    text = text.removeprefix("\ufeff").replace("\r\n", "\n").replace("\r", "\n")
    reader = csv.reader(io.StringIO(text, newline=""), strict=True)
    records, footer = [], None
    try:
        header = next(reader, [])
        members = header[5:]
        if header[:5] != HEADERS or not 1 <= len(members) <= 100:
            raise AccountingError("Use a Splitwise CSV with Date, Description, Category, Cost, Currency and member columns")
        normalized = [unicodedata.normalize("NFKC", name).strip().casefold() for name in members]
        if (
            any(not name.strip() or len(name) > 120 or any(ord(c) < 32 for c in name) for name in members)
            or len(set(normalized)) != len(members)
            or set(members) & set(HEADERS)
        ):
            raise AccountingError("CSV member names must be distinct, readable and at most 120 characters")
        balances = [0] * len(members)
        while True:
            number = reader.line_num + 1
            cells = next(reader, None)
            if cells is None:
                break
            if not cells or not any(cell.strip() for cell in cells):
                continue
            if len(cells) != len(header):
                raise AccountingError(f"Row {number}: missing or extra CSV fields")
            if cells[4] != "INR":
                raise AccountingError(f"Row {number}: only INR is supported; no currency conversion is applied")
            nets = [_paise(value, number, signed=True) for value in cells[5:]]
            if cells[1].strip() == "Total balance" and not cells[2].strip() and not cells[3].strip():
                if footer is not None:
                    raise AccountingError(f"Row {number}: repeated Total balance footer")
                footer = nets
                continue
            if footer is not None:
                raise AccountingError(f"Row {number}: a transaction appears after Total balance")
            if len(records) >= MAX_ROWS:
                raise AccountingError("CSV exceeds the 10000 transaction limit")
            if re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", cells[0]) is None:
                raise AccountingError(f"Row {number}: dates must use YYYY-MM-DD")
            try:
                date.fromisoformat(cells[0])
            except ValueError as exc:
                raise AccountingError(f"Row {number}: invalid calendar date") from exc
            if not cells[1].strip() or len(cells[1]) > 200 or len(cells[2]) > 40:
                raise AccountingError(f"Row {number}: description must be 1–200 characters and category at most 40")
            amount = _paise(cells[3], number)
            if not 0 < amount <= MAX_AMOUNT:
                raise AccountingError(f"Row {number}: Cost must be positive and at most {MAX_AMOUNT} paise")
            positive = [index for index, net in enumerate(nets) if net > 0]
            negative = [index for index, net in enumerate(nets) if net < 0]
            if sum(nets) != 0 or any(abs(net) > amount for net in nets):
                raise AccountingError(f"Row {number}: member net amounts must balance and fit within Cost")
            payment = cells[2] == "Payment"
            if payment and (
                len(positive) != 1 or len(negative) != 1 or nets[positive[0]] != amount
            ):
                raise AccountingError(f"Row {number}: Payment needs exactly one sender and one recipient matching Cost")
            if not payment and len(positive) > 1:
                raise AccountingError(f"Row {number}: multiple positive member nets cannot establish the original payers")
            records.append(
                {
                    "row": number,
                    "date": cells[0],
                    "description": cells[1],
                    "category": cells[2],
                    "amount": amount,
                    "nets": nets,
                    "payer": positive[0] if positive else None,
                    "recipient": negative[0] if payment else None,
                    "payment": payment,
                }
            )
            balances = [total + net for total, net in zip(balances, nets, strict=True)]
    except csv.Error as exc:
        raise AccountingError("Malformed CSV; check quoted fields and UTF-8 encoding") from exc
    if not records:
        raise AccountingError("CSV contains no transactions")
    if footer is not None and footer != balances:
        raise AccountingError("Total balance does not match the transaction rows; import was not saved")
    # Quoting, BOM, blank lines and line-ending changes must not import the same money twice.
    canonical_rows = sorted(
        json.dumps([r[key] for key in ("date", "description", "category", "amount", "nets")], ensure_ascii=False)
        for r in records
    )
    source_hash = hashlib.sha256(
        json.dumps([members, canonical_rows], ensure_ascii=False, separators=(",", ":")).encode()
    ).hexdigest()
    warnings = [CONTRIBUTION_WARNING]
    if footer is None:
        warnings.append("This file has no Total balance footer; check the preview balances against Splitwise before importing.")
    return {
        "source_hash": source_hash,
        "currency": "INR",
        "members": members,
        "expense_count": sum(not r["payment"] for r in records),
        "payment_count": sum(r["payment"] for r in records),
        "balances": [str(amount) for amount in balances],
        "unresolved": [
            {**{key: r[key] for key in ("row", "date", "description", "category")}, "amount": str(r["amount"])}
            for r in records if r["payer"] is None
        ],
        "warnings": warnings,
        "records": records,
    }


def preview_splitwise(actor, text: str) -> dict:
    parsed = parse_splitwise(text)
    parsed.pop("records")
    group = Group.objects.filter(owner=actor, import_source_hash=parsed["source_hash"]).first()
    if group:
        visible_group(actor, group.id)
    parsed["duplicate_group"] = {"id": str(group.id), "name": group.name} if group else None
    return parsed


def import_splitwise(actor, payload: dict) -> dict:
    parsed = parse_splitwise(payload["csv"])
    members, records = parsed["members"], parsed["records"]
    choices = payload["payers"]
    if not 0 <= payload["self_index"] < len(members):
        raise AccountingError("Choose which CSV member is you")
    required = {str(record["row"]) for record in records if record["payer"] is None}
    if set(choices) != required or any(not 0 <= choice < len(members) for choice in choices.values()):
        raise AccountingError("Choose a payer for every balance-neutral bill; do not add choices for other rows")

    with transaction.atomic():
        get_user_model().objects.select_for_update().get(pk=actor.pk)
        previous, fingerprint = previous_result(actor, payload["command_id"], "import_splitwise", payload)
        if previous:
            visible_group(actor, previous["id"])
            return previous
        duplicate = Group.objects.filter(owner=actor, import_source_hash=parsed["source_hash"]).first()
        if duplicate:
            visible_group(actor, duplicate.id)
            result = {"id": str(duplicate.id), "version": duplicate.version, "already_imported": True}
            CommandReceipt.objects.create(
                actor=actor, command_id=payload["command_id"], fingerprint=fingerprint, result=result
            )
            return result
        if Group.objects.filter(id=payload["id"]).exists():
            raise HttpError(409, "The new group ID is already in use")
        group = Group.objects.create(
            id=payload["id"], name=payload["name"].strip(), owner=actor,
            version=len(records) + 1, import_source_hash=parsed["source_hash"],
        )
        people = [
            Participant(group=group, name=name, user=actor if i == payload["self_index"] else None)
            for i, name in enumerate(members)
        ]
        Participant.objects.bulk_create(people)
        ids = [str(person.id) for person in people]
        expenses, settlements = [], []
        changes = [Change(group=group, sequence=1, actor=actor, kind="group_created", data={
            "name": group.name, "source": "splitwise_csv", "source_hash": parsed["source_hash"],
            "expense_count": parsed["expense_count"], "payment_count": parsed["payment_count"],
        })]
        for sequence, record in enumerate(records, 2):
            payer = record["payer"] if record["payer"] is not None else choices[str(record["row"])]
            if record["payment"]:
                payment = Settlement(
                    group=group, sender=people[payer], recipient=people[record["recipient"]],
                    amount=record["amount"], date=record["date"], method="splitwise_import", recorded_by=actor,
                )
                settlements.append(payment)
                kind, data = "manual_settlement", {
                    "id": str(payment.id), "sender": ids[payer], "recipient": ids[record["recipient"]],
                    "amount": str(payment.amount), "method": payment.method, "date": record["date"],
                    "description": record["description"], "category": record["category"],
                }
            else:
                shares = {
                    person: str((record["amount"] if i == payer else 0) - record["nets"][i])
                    for i, person in enumerate(ids)
                }
                split = {"mode": "exact", "values": shares}
                paid, shares = validate_expense(str(record["amount"]), {ids[payer]: str(record["amount"])}, split, ids)
                expense = Expense(
                    group=group, description=record["description"], total=record["amount"],
                    paid=paid, shares=shares, split=split, date=date.fromisoformat(record["date"]),
                    category=record["category"], category_auto=False, notes="Imported from Splitwise CSV; payer and exact shares reconstructed from net amounts.",
                )
                expenses.append(expense)
                kind, data = "expense_saved", expense_dict(expense)
            changes.append(Change(group=group, sequence=sequence, actor=actor, kind=kind, data={
                **data, "source_row": record["row"], "source": "splitwise_csv",
            }))
        Expense.objects.bulk_create(expenses)
        Settlement.objects.bulk_create(settlements)
        Change.objects.bulk_create(changes)
        result = {"id": str(group.id), "version": group.version, "already_imported": False}
        CommandReceipt.objects.create(
            actor=actor, command_id=payload["command_id"], fingerprint=fingerprint, result=result
        )
        return result
