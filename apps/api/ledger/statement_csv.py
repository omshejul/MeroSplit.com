"""Financial allowlist only. Never materialize the account backup or chat/media."""

import csv
import io
from decimal import Decimal

from django.views.decorators.debug import sensitive_variables

from .models import Expense, OpeningBalance, Participant, Settlement

MAX_CSV_BYTES = 3 * 1024 * 1024
BALANCE_COLUMNS = ["Group", "Person", "Balance", "Amount (INR)"]
TRANSACTION_COLUMNS = ["Date", "Group", "Transaction", "Description", "Paid by", "Paid to", "Amount (INR)",
                       "Counted in balances (INR)", "Split between", "Status"]


class StatementTooLarge(Exception):
    pass


def _cell(value):
    if isinstance(value, str) and (value.startswith(("\t", "\r", "\n")) or value.lstrip().startswith(("=", "+", "-", "@"))):
        return "'" + value
    return value


def _money(paise):
    return Decimal(int(paise)).scaleb(-2)


def _date(value):
    return value.strftime("%d %b %Y") if value else "Not recorded"


def _position(balance):
    return "Is owed" if balance > 0 else "Owes" if balance < 0 else "Settled"


def _amounts(amounts, names):
    return "; ".join(f"{names[person]}: INR {_money(amounts[person])}" for person in sorted(amounts, key=lambda person: names[person].casefold()))


@sensitive_variables()
def financial_statement(groups, user_id):
    """Caller holds group locks. Human reports from the financial allowlist only."""
    chunks, size, summary = [[b"\xef\xbb\xbf"], [b"\xef\xbb\xbf"]], 6, []
    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer)

    def row(table, values):
        nonlocal size
        buffer.seek(0)
        buffer.truncate(0)
        writer.writerow([_cell(value) for value in values])
        encoded = buffer.getvalue().encode("utf-8")
        size += len(encoded)
        if size > MAX_CSV_BYTES:
            raise StatementTooLarge()
        chunks[table].append(encoded)

    row(0, BALANCE_COLUMNS)
    row(1, TRANSACTION_COLUMNS)
    for group in sorted(groups, key=lambda group: group.name.casefold()):
        people = list(Participant.objects.filter(group=group).order_by("id").values("id", "name", "user_id", "user__first_name"))
        names = {str(person["id"]): (person["user__first_name"] or person["name"]) + (" (you)" if person["user_id"] == user_id else "") for person in people}
        balances = dict.fromkeys(names, 0)

        for bill in Expense.objects.filter(group=group).order_by("date", "id").values("date", "description", "total", "paid", "shares", "deleted").iterator():
            for person in sorted(set(bill["paid"]) | set(bill["shares"])):
                paid, share = int(bill["paid"].get(person, 0)), int(bill["shares"].get(person, 0))
                net = 0 if bill["deleted"] else paid - share
                balances[person] += net
            row(1, [_date(bill["date"]), group.name, "Bill", bill["description"], _amounts(bill["paid"], names), "",
                    _money(bill["total"]), _money(0 if bill["deleted"] else bill["total"]), _amounts(bill["shares"], names), "Reversed" if bill["deleted"] else "Recorded"])
        for payment in Settlement.objects.filter(group=group).order_by("created_at", "id").values("sender_id", "recipient_id", "amount", "date", "reversed").iterator():
            for person, direction in [(str(payment["sender_id"]), 1), (str(payment["recipient_id"]), -1)]:
                net = 0 if payment["reversed"] else direction * payment["amount"]
                balances[person] += net
            sender, recipient = names[str(payment["sender_id"])], names[str(payment["recipient_id"])]
            row(1, [_date(payment["date"]), group.name, "Payment", f"{sender} paid {recipient}", sender, recipient,
                    _money(payment["amount"]), _money(0 if payment["reversed"] else payment["amount"]), "", "Reversed" if payment["reversed"] else "Recorded"])
        opening = OpeningBalance.objects.filter(group=group, accepted=True).values("cutoff", "balances").first()
        if opening:
            for person, amount in sorted(opening["balances"].items()):
                amount = int(amount)
                balances[person] += amount
                row(1, [_date(opening["cutoff"]), group.name, "Starting balance", f"{names[person]}: {_position(amount).lower()} INR {_money(abs(amount))}", "", "",
                        _money(amount), _money(amount), "", "Agreed"])
        for person in sorted(people, key=lambda person: (person["user_id"] != user_id, names[str(person["id"])].casefold())):
            balance = balances[str(person["id"])]
            row(0, [group.name, names[str(person["id"])], _position(balance), _money(abs(balance))])
            if person["user_id"] == user_id:
                position = f"You are owed INR {_money(balance)}" if balance > 0 else f"You owe INR {_money(-balance)}" if balance < 0 else "You are settled up"
                summary.append(f"{group.name}: {position}")
    return {"Balances.csv": b"".join(chunks[0]), "Transactions.csv": b"".join(chunks[1])}, "\n".join(summary) or "No shared balances yet."
