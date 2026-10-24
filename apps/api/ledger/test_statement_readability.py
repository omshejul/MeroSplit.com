import base64
import csv
import io
from decimal import Decimal

import pytest
from django.db import transaction

from . import balance_statements as statements
from . import statement_csv
from .models import Expense, Group, OpeningBalance, Participant, Settlement
from .test_api import client as client
from .test_balance_statements import cloudflare as cloudflare
from .test_balance_statements import manual
from .test_balance_statements import verified as verified

pytestmark = pytest.mark.django_db(transaction=True)


def test_readable_statement_example_has_names_directions_shares_and_retained_reversals(client, tmp_path, monkeypatch):
    client.actor.first_name = "Riya"
    client.actor.save(update_fields=["first_name"])
    groups = []

    def group(name, names):
        value = Group.objects.create(owner=client.actor, name=name)
        people = [Participant.objects.create(group=value, name=name, user=client.actor if index == 0 else None) for index, name in enumerate(names)]
        groups.append(value)
        return value, people

    def bill(group, people, description, total, paid, shares, reversed=False):
        return Expense.objects.create(group=group, description=description, total=total,
            paid={str(people[index].id): str(value) for index, value in paid.items()},
            shares={str(people[index].id): str(value) for index, value in shares.items()}, split={"mode": "equal", "values": {}}, date="2026-10-18", deleted=reversed,
            notes="Private note that must never be included")

    goa, people = group("Goa trip", ["Riya", "Asha", "Bala"])
    lunch = bill(goa, people, "Lunch", 60000, {0: 10000, 1: 50000}, {0: 20000, 1: 20000, 2: 20000})
    bill(goa, people, "Cancelled taxi", 9000, {0: 9000}, {0: 3000, 1: 3000, 2: 3000}, reversed=True)
    Settlement.objects.create(group=goa, sender=people[0], recipient=people[1], amount=5000, date="2026-10-19")
    Settlement.objects.create(group=goa, sender=people[1], recipient=people[0], amount=7500, reversed=True)
    OpeningBalance.objects.create(group=goa, balances={str(people[0].id): "1000", str(people[1].id): "-1000"}, cutoff="2026-10-01", accepted=True, source="Private source")
    home, residents = group("Home", ["Riya", "Asha"])
    bill(home, residents, "Groceries", 100000, {0: 100000}, {0: 50000, 1: 50000})
    weekend, friends = group("Weekend", ["Riya", "Bala"])
    OpeningBalance.objects.create(group=weekend, balances={str(friends[0].id): "99900", str(friends[1].id): "-99900"}, cutoff="2026-10-01", accepted=False, source="Not yet agreed")

    job = manual(client)
    frozen = statements._prepare(job.id)  # No external delivery: capture the actual frozen message.
    assert frozen.payload["text"].startswith("Your balances as of ")
    assert "Goa trip: You owe INR 40.00" in frozen.payload["text"]
    assert "Home: You are owed INR 500.00" in frozen.payload["text"]
    assert "Weekend: You are settled up" in frozen.payload["text"]
    (tmp_path / "Email.txt").write_text(frozen.payload["text"])
    data = {}
    for attachment in frozen.payload["attachments"]:
        content = base64.b64decode(attachment["content"])
        (tmp_path / attachment["filename"]).write_bytes(content)
        data[attachment["filename"]] = list(csv.DictReader(io.StringIO(content.decode("utf-8-sig"))))
    balances, transactions = data["Balances.csv"], data["Transactions.csv"]
    assert next(row for row in balances if row["Group"] == "Goa trip" and row["Person"] == "Riya (you)") == {"Group": "Goa trip", "Person": "Riya (you)", "Balance": "Owes", "Amount (INR)": "40.00"}
    assert any(row["Group"] == "Weekend" and row["Balance"] == "Settled" and row["Amount (INR)"] == "0.00" for row in balances)
    lunch_row = next(row for row in transactions if row["Description"] == "Lunch")
    assert lunch_row["Paid by"] == "Asha: INR 500.00; Riya (you): INR 100.00"
    assert lunch_row["Split between"] == "Asha: INR 200.00; Bala: INR 200.00; Riya (you): INR 200.00"
    assert lunch_row["Date"] == "18 Oct 2026"
    assert len(transactions) == 7  # Three bills, two payments and two agreed opening entries.
    assert any(row["Paid by"] == "Riya (you)" and row["Paid to"] == "Asha" and row["Amount (INR)"] == "50.00" for row in transactions)
    assert all(row["Counted in balances (INR)"] == "0.00" for row in transactions if row["Status"] == "Reversed")
    assert {Decimal(row["Amount (INR)"]) for row in transactions if row["Status"] == "Reversed"} == {Decimal("90.00"), Decimal("75.00")}
    text = frozen.payload["text"] + "\n" + "\n".join((tmp_path / name).read_text() for name in ["Balances.csv", "Transactions.csv"])
    for excluded in [str(lunch.id), str(job.id), *(str(group.id) for group in groups), "Private", "999.00", "record_type", "_id", "recorded_at", client.actor.email]:
        assert excluded not in text

    sizes = [len(base64.b64decode(item["content"])) for item in frozen.payload["attachments"]]
    cap = max(sizes) + 1
    assert all(size < cap for size in sizes) and sum(sizes) > cap
    monkeypatch.setattr(statement_csv, "MAX_CSV_BYTES", cap)
    with transaction.atomic():
        locked = list(Group.objects.select_for_update().filter(id__in=[group.id for group in groups]).order_by("id"))
        with pytest.raises(statement_csv.StatementTooLarge):
            statement_csv.financial_statement(locked, client.actor.pk)
