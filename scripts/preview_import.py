"""Private synthetic-net-v1 CSV feasibility preview; no persistence or publish operation.

This is NOT a verified Splitwise export format. The only supported fixture schema is
Date,Description,Category,Cost,Currency followed by explicitly mapped participant
net columns. Cost and nets use ungrouped INR decimals (100, 100.5 or 100.50); dates
use YYYY-MM-DD from 2000 through 2099 and cannot exceed the requested cutoff.
Cost is positive, each row's nets balance, and total positive net cannot exceed Cost.
UTF-8/BOM, quoted commas and multiline descriptions are supported. Formula-like
text, extra fields and ambiguous names/number formats are rejected deliberately.

Independent balances are supplied separately, keyed by the source column names,
as INR decimal strings at balance_cutoff. Missing/mismatching evidence never
reconciles. Even a reconciled synthetic preview remains blocked from publishing:
real export fixtures, compatibility testing and a production importer do not exist.
Net history cannot establish original paid/share allocations, comments or receipts.
"""

import csv
import hashlib
import io
import re
import unicodedata
from collections.abc import Mapping
from datetime import date
from uuid import UUID

MAX_BYTES = 1_048_576
MAX_ROWS = 10_000
MAX_AMOUNT = 1_000_000_000
BASE_HEADERS = ["Date", "Description", "Category", "Cost", "Currency"]


def _date(value: str) -> date:
    if not isinstance(value, str) or re.fullmatch(r"20[0-9]{2}-[0-9]{2}-[0-9]{2}", value) is None:
        raise ValueError("Dates must be ISO YYYY-MM-DD between 2000 and 2099")
    return date.fromisoformat(value)


def _paise(value: str, *, signed: bool = False) -> int:
    pattern = r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?" if signed else r"(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?"
    if not isinstance(value, str) or len(value) > 40 or re.fullmatch(pattern, value) is None:
        raise ValueError("INR amounts require ungrouped decimal strings with at most two places")
    whole, _, fraction = value.removeprefix("-").partition(".")
    amount = int(whole) * 100 + int(fraction.ljust(2, "0"))
    if value.startswith("-") and amount == 0:
        raise ValueError("Negative zero is ambiguous")
    return -amount if value.startswith("-") else amount


def preview_import(
    csv_bytes: bytes,
    participant_columns: Mapping[str, str],
    source_balances: Mapping[str, str] | None,
    *,
    cutoff: str,
    balance_cutoff: str | None,
    locale: str = "en-IN",
) -> dict:
    """Return immutable-source net rows and reconciliation evidence; never write a ledger."""
    cutoff_date = _date(cutoff)
    if locale != "en-IN":
        raise ValueError("Only the explicit en-IN decimal fixture is supported")
    if not isinstance(csv_bytes, bytes) or not 0 < len(csv_bytes) <= MAX_BYTES:
        raise ValueError("Provide nonempty CSV bytes no larger than 1 MiB")
    if not isinstance(participant_columns, Mapping) or not 2 <= len(participant_columns) <= 50:
        raise ValueError("Explicitly map between two and fifty source participant columns")
    normalized_names = []
    for name, person in participant_columns.items():
        if not isinstance(name, str) or not 1 <= len(name) <= 100 or name != name.strip():
            raise ValueError("Participant column names must be nonempty and have no outer whitespace")
        normalized = unicodedata.normalize("NFKC", name)
        if any(ord(char) < 32 for char in normalized) or normalized.startswith(("=", "+", "-", "@")):
            raise ValueError("Formula-like or control-character participant names are unsupported")
        normalized_names.append(normalized.casefold())
        if not isinstance(person, str):
            raise ValueError("Map each participant to a canonical UUID string")
        try:
            canonical = str(UUID(person))
        except ValueError as exc:
            raise ValueError("Map each participant to a canonical UUID string") from exc
        if canonical != person:
            raise ValueError("Map each participant to a canonical UUID string")
    if len(set(normalized_names)) != len(normalized_names) or set(participant_columns) & set(BASE_HEADERS):
        raise ValueError("Source participant names must be distinct and cannot reuse metadata headers")
    if len(set(participant_columns.values())) != len(participant_columns):
        raise ValueError("Each source participant must map to a distinct UUID")

    try:
        decoded = csv_bytes.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ValueError("Only UTF-8 CSV input is supported") from exc
    if "\x00" in decoded:
        raise ValueError("NUL bytes are unsupported")
    reader = csv.reader(io.StringIO(decoded, newline=""), strict=True)
    source_hash = hashlib.sha256(csv_bytes).hexdigest()
    rows = []
    totals = dict.fromkeys(participant_columns.values(), 0)
    try:
        headers = next(reader, [])
        if (
            headers[:5] != BASE_HEADERS
            or len(headers) != 5 + len(participant_columns)
            or len(set(headers)) != len(headers)
            or set(headers[5:]) != set(participant_columns)
        ):
            raise ValueError("Unknown or ambiguous schema; use only the documented synthetic-net-v1 headers")
        for number, cells in enumerate(reader, start=1):
            if number > MAX_ROWS or len(cells) != len(headers):
                raise ValueError("CSV exceeds 10000 rows or contains missing/extra fields")
            record = dict(zip(headers, cells, strict=True))
            if _date(record["Date"]) > cutoff_date:
                raise ValueError(f"Row {number} is later than the requested cutoff")
            if record["Currency"] != "INR":
                raise ValueError(
                    f"Row {number}: non-INR or unknown currency is unsupported; no FX conversion"
                )
            for field, maximum in [("Description", 2000), ("Category", 100)]:
                text = record[field]
                if len(text) > maximum or unicodedata.normalize("NFKC", text).lstrip().startswith(
                    ("=", "+", "-", "@")
                ):
                    raise ValueError(f"Row {number}: formula-like or oversized {field} is unsupported")
            cost = _paise(record["Cost"])
            if not 0 < cost <= MAX_AMOUNT:
                raise ValueError(f"Row {number}: Cost must be positive and at most {MAX_AMOUNT} paise")
            nets = {participant_columns[name]: _paise(record[name], signed=True) for name in headers[5:]}
            if sum(nets.values()) != 0 or sum(max(amount, 0) for amount in nets.values()) > cost:
                raise ValueError(f"Row {number}: participant nets must balance and cannot exceed Cost")
            for person, amount in nets.items():
                totals[person] += amount
            rows.append(
                {
                    "kind": "historical_net",
                    "date": record["Date"],
                    "description": record["Description"],
                    "category": record["Category"],
                    "cost_paise": str(cost),
                    "nets": {person: str(amount) for person, amount in nets.items()},
                    "provenance": {
                        "source_hash": source_hash,
                        "row_number": number,
                        "source_line_end": reader.line_num,
                        "row_id": f"{source_hash}:{number}",
                        "source_fields": record,
                    },
                }
            )
    except csv.Error as exc:
        raise ValueError("Malformed CSV input") from exc
    if not rows:
        raise ValueError("The synthetic schema requires at least one transaction row")

    blockers = ["real_export_unvalidated"]
    independent = None
    differences = None
    if source_balances is None:
        blockers.append("independent_balances_missing")
    else:
        if not isinstance(source_balances, Mapping) or set(source_balances) != set(participant_columns):
            raise ValueError("Independent balances must cover exactly the mapped source participant columns")
        independent = {
            participant_columns[name]: _paise(amount, signed=True) for name, amount in source_balances.items()
        }
        if sum(independent.values()) != 0:
            raise ValueError("Independent source balances must sum to zero")
        differences = {person: str(totals[person] - independent[person]) for person in totals}
        if any(value != "0" for value in differences.values()):
            blockers.append("independent_balance_mismatch")
    if balance_cutoff is None:
        blockers.append("independent_cutoff_missing")
    elif _date(balance_cutoff) != cutoff_date:
        blockers.append("independent_cutoff_mismatch")
    return {
        "schema": "synthetic-net-v1",
        "import_version": 1,
        "locale": locale,
        "currency": "INR",
        "money_unit": "paise",
        "source_hash": source_hash,
        "original_headers": headers,
        "encoding": "utf-8-sig" if csv_bytes.startswith(b"\xef\xbb\xbf") else "utf-8",
        "participant_columns": dict(participant_columns),
        "cutoff": cutoff,
        "balance_cutoff": balance_cutoff,
        "row_count": len(rows),
        "rows": rows,
        "parsed_balances": {person: str(amount) for person, amount in totals.items()},
        "independent_balances": independent
        and {person: str(amount) for person, amount in independent.items()},
        "balance_differences": differences,
        "reconciled": blockers == ["real_export_unvalidated"],
        "publish_blocked": True,
        "blockers": blockers,
        "warnings": [
            "No genuine Splitwise export has been validated; this is a private synthetic preview only.",
            "Net effects do not establish original payers/shares; receipts, comments and edit history are unavailable.",
        ],
    }
