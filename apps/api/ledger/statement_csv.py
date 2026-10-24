"""Financial allowlist only. Never materialize the account backup or chat/media."""

import csv
import io
from datetime import timezone as dt_timezone
from decimal import Decimal

from django.views.decorators.debug import sensitive_variables

from .models import Expense, OpeningBalance, Participant, Settlement

MAX_CSV_BYTES = 3 * 1024 * 1024
COLUMNS = ["record_type", "group_id", "group_name", "record_id", "date", "recorded_at_utc",
           "description", "participant_id", "participant_name", "currency", "original_amount_inr",
           "paid_inr", "share_inr", "net_inr", "current_balance_inr", "status"]


class StatementTooLarge(Exception):
    pass


def _cell(value):
    if isinstance(value, str) and (value.startswith(("\t", "\r", "\n")) or value.lstrip().startswith(("=", "+", "-", "@"))):
        return "'" + value
    return value


@sensitive_variables()
def financial_csv(groups):
    """Caller holds group locks. Exact paise integers, retained reversed originals."""
    chunks, size = [b"\xef\xbb\xbf"], 3
    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer)

    def row(values):
        nonlocal size
        buffer.seek(0)
        buffer.truncate(0)
        writer.writerow([_cell(value) for value in values])
        encoded = buffer.getvalue().encode("utf-8")
        size += len(encoded)
        if size > MAX_CSV_BYTES:
            raise StatementTooLarge()
        chunks.append(encoded)

    row(COLUMNS)
    for group in groups:
        people = list(Participant.objects.filter(group=group).order_by("id").values("id", "name", "user__first_name"))
        names = {str(person["id"]): person["user__first_name"] or person["name"] for person in people}
        balances = dict.fromkeys(names, 0)

        def record(kind, person, **values):
            values.update(record_type=kind, group_id=str(group.id), group_name=group.name,
                          participant_id=person, participant_name=names[person], currency="INR")
            row([Decimal(values[key]).scaleb(-2) if key.endswith("_inr") and key in values else values.get(key, "") for key in COLUMNS])

        for bill in Expense.objects.filter(group=group).order_by("date", "id").values("id", "date", "description", "total", "paid", "shares", "deleted").iterator():
            for person in sorted(set(bill["paid"]) | set(bill["shares"])):
                paid, share = int(bill["paid"].get(person, 0)), int(bill["shares"].get(person, 0))
                net = 0 if bill["deleted"] else paid - share
                balances[person] += net
                record("bill", person, record_id=str(bill["id"]), date=bill["date"].isoformat(), description=bill["description"],
                       original_amount_inr=bill["total"], paid_inr=paid, share_inr=share, net_inr=net,
                       status="reversed" if bill["deleted"] else "accepted")
        for payment in Settlement.objects.filter(group=group).order_by("created_at", "id").values("id", "sender_id", "recipient_id", "amount", "date", "created_at", "reversed").iterator():
            for person, direction in [(str(payment["sender_id"]), 1), (str(payment["recipient_id"]), -1)]:
                net = 0 if payment["reversed"] else direction * payment["amount"]
                balances[person] += net
                record("payment", person, record_id=str(payment["id"]), date=payment["date"].isoformat() if payment["date"] else "",
                       recorded_at_utc=payment["created_at"].astimezone(dt_timezone.utc).isoformat(), original_amount_inr=payment["amount"], net_inr=net,
                       status="reversed" if payment["reversed"] else "accepted")
        opening = OpeningBalance.objects.filter(group=group, accepted=True).values("id", "cutoff", "balances").first()
        if opening:
            for person, amount in sorted(opening["balances"].items()):
                amount = int(amount)
                balances[person] += amount
                record("opening_balance", person, record_id=str(opening["id"]), date=opening["cutoff"].isoformat(),
                       original_amount_inr=amount, net_inr=amount, status="accepted")
        for person, balance in balances.items():
            record("balance", person, current_balance_inr=balance, status="current")
    return b"".join(chunks)
