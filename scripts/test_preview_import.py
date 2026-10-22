"""Only the explicit synthetic-net-v1 fixture is tested; no real export compatibility."""

import csv
import hashlib
import io
from uuid import UUID

import pytest

from scripts.preview_import import BASE_HEADERS, preview_import

ASHA = str(UUID(int=1))
BALA = str(UUID(int=2))
CHARU = str(UUID(int=3))
MAPPING = {"Asha": ASHA, "Bala": BALA, "Charu": CHARU}
CUTOFF = "2026-10-16"


def fixture(rows=None, headers=None):
    """Small synthetic CSV, deliberately not represented as a Splitwise export."""
    stream = io.StringIO(newline="")
    writer = csv.writer(stream)
    writer.writerow(headers if headers is not None else BASE_HEADERS + list(MAPPING))
    writer.writerows(
        rows
        if rows is not None
        else [
            ["2026-10-15", "Dinner, Friday", "Food", "100.00", "INR", "66.67", "-33.33", "-33.34"],
            ["2026-10-16", "Partial repayment", "Payment", "10.00", "INR", "-10", "10", "0"],
        ]
    )
    return stream.getvalue().encode()


def preview(data=None, balances=None, **kwargs):
    return preview_import(
        fixture() if data is None else data,
        kwargs.pop("participant_columns", MAPPING),
        {"Asha": "56.67", "Bala": "-23.33", "Charu": "-33.34"} if balances is None else balances,
        cutoff=kwargs.pop("cutoff", CUTOFF),
        balance_cutoff=kwargs.pop("balance_cutoff", CUTOFF),
        **kwargs,
    )


def test_synthetic_nets_reconcile_but_remain_private_and_preserve_provenance():
    data = fixture()
    result = preview(data)
    assert result["reconciled"] is True
    assert result["publish_blocked"] is True
    assert result["blockers"] == ["real_export_unvalidated"]
    assert result["parsed_balances"] == {ASHA: "5667", BALA: "-2333", CHARU: "-3334"}
    assert result["independent_balances"] == result["parsed_balances"]
    assert set(result["balance_differences"].values()) == {"0"}
    assert result["source_hash"] == hashlib.sha256(data).hexdigest()
    assert result["original_headers"] == BASE_HEADERS + list(MAPPING)
    assert result["row_count"] == 2
    first = result["rows"][0]
    assert first["kind"] == "historical_net"
    assert first["description"] == "Dinner, Friday"
    assert first["provenance"]["source_fields"]["Asha"] == "66.67"
    assert first["provenance"]["row_id"] == result["source_hash"] + ":1"
    assert first["provenance"]["source_line_end"] == 2
    assert "paid" not in first and "shares" not in first and "split" not in first
    assert preview(data) == result


def test_one_paise_independent_discrepancy_blocks_reconciliation():
    result = preview(balances={"Asha": "56.68", "Bala": "-23.34", "Charu": "-33.34"})
    assert result["reconciled"] is False
    assert result["balance_differences"] == {ASHA: "-1", BALA: "1", CHARU: "0"}
    assert "independent_balance_mismatch" in result["blockers"]
    assert result["publish_blocked"] is True


def test_missing_independent_evidence_never_reconciles():
    result = preview_import(fixture(), MAPPING, None, cutoff=CUTOFF, balance_cutoff=None)
    assert result["reconciled"] is False
    assert result["independent_balances"] is None
    assert result["balance_differences"] is None
    assert {"independent_balances_missing", "independent_cutoff_missing"} <= set(result["blockers"])


def test_different_snapshot_cutoff_never_reconciles():
    result = preview(balance_cutoff="2026-10-15")
    assert result["reconciled"] is False
    assert "independent_cutoff_mismatch" in result["blockers"]


@pytest.mark.parametrize(
    "field,value",
    [
        (0, "15/10/2026"),
        (0, "2026-02-30"),
        (0, "2026-10-17"),
        (0, "1999-12-31"),
        (0, "20261015"),
        (3, "1,000.00"),
        (3, "₹100"),
        (3, "1e2"),
        (3, "100.001"),
        (3, " 100"),
        (3, "0100"),
        (3, "0"),
        (3, "10000000.01"),
        (3, "１００"),
        (4, "USD"),
        (4, "inr"),
        (5, "=SUM(1)"),
        (5, "66.68"),
        (5, "-0.00"),
        (1, " \t=HYPERLINK(1)"),
        (2, "+SUM(1)"),
        (1, "＝SUM(1)"),
    ],
)
def test_invalid_row_is_rejected(field, value):
    row = ["2026-10-15", "Dinner", "Food", "100.00", "INR", "66.67", "-33.33", "-33.34"]
    row[field] = value
    with pytest.raises(ValueError):
        preview(fixture([row]))


def test_balanced_nets_cannot_exceed_the_stated_cost():
    row = ["2026-10-15", "Dinner", "Food", "100", "INR", "101", "-50", "-51"]
    with pytest.raises(ValueError, match="cannot exceed Cost"):
        preview(fixture([row]))


@pytest.mark.parametrize(
    "headers",
    [
        BASE_HEADERS + ["Asha", "Asha", "Charu"],
        BASE_HEADERS + ["Asha", "Bala", "Unknown"],
        BASE_HEADERS + list(MAPPING) + ["Receipts"],
        ["Date", "Description", "Cost", "Category", "Currency"] + list(MAPPING),
    ],
)
def test_duplicate_unknown_or_unexpected_columns_are_rejected(headers):
    with pytest.raises(ValueError, match="schema"):
        preview(fixture(headers=headers))


@pytest.mark.parametrize(
    "mapping",
    [
        {"Asha": ASHA, "Bala": ASHA, "Charu": CHARU},
        {"Asha": ASHA, "asha": BALA, "Charu": CHARU},
        {"Asha": ASHA, "Bala ": BALA, "Charu": CHARU},
        {"=Asha": ASHA, "Bala": BALA, "Charu": CHARU},
        {"Asha": ASHA, "Bala": "not-a-uuid", "Charu": CHARU},
        {"Asha": ASHA, "Bala": BALA},
    ],
)
def test_mapping_must_be_explicit_unambiguous_and_one_to_one(mapping):
    with pytest.raises(ValueError):
        preview(participant_columns=mapping)


@pytest.mark.parametrize(
    "balances",
    [
        {"Asha": "56.67", "Bala": "-23.33"},
        {"Asha": "56.67", "Bala": "-23.33", "Charu": "-33.33"},
        {"Asha": "56,67", "Bala": "-23.33", "Charu": "-33.34"},
    ],
)
def test_independent_snapshot_requires_full_balanced_decimal_vector(balances):
    with pytest.raises(ValueError):
        preview(balances=balances)


def test_bom_quoted_multiline_and_column_order_preserve_source_identity():
    row = ["2026-10-16", "Dinner,\nFriday", "Food", "100", "INR", "-33.33", "-33.34", "66.67"]
    data = b"\xef\xbb\xbf" + fixture([row], BASE_HEADERS + ["Bala", "Charu", "Asha"])
    result = preview(data, balances={"Asha": "66.67", "Bala": "-33.33", "Charu": "-33.34"})
    assert result["reconciled"] is True
    assert result["encoding"] == "utf-8-sig"
    assert result["source_hash"] == hashlib.sha256(data).hexdigest()
    assert result["rows"][0]["description"] == "Dinner,\nFriday"
    assert result["rows"][0]["provenance"]["source_line_end"] == 3


@pytest.mark.parametrize("data", [b"", b"\xff\xfe", b"\x00", fixture(rows=[]), fixture() + b"extra,fields\n"])
def test_invalid_encoding_empty_or_irregular_input_is_rejected(data):
    with pytest.raises(ValueError):
        preview(data)


def test_size_and_locale_are_bounded():
    with pytest.raises(ValueError, match="1 MiB"):
        preview(b"x" * 1_048_577)
    with pytest.raises(ValueError, match="locale|en-IN"):
        preview(locale="de-DE")
