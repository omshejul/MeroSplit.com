"""Bounded, plain-text native notification copy. Amounts are never converted."""
import unicodedata

from .profiles import participant_display_name

SYMBOLS = {"INR": "₹", "USD": "$", "EUR": "€", "GBP": "£", "AED": "د.إ", "AUD": "A$",
           "CAD": "CA$", "SGD": "S$", "NZD": "NZ$", "CHF": "CHF", "JPY": "¥"}


def preview(value, limit=60, fallback=""):
    clean = " ".join("".join(c for c in str(value) if not unicodedata.category(c).startswith("C") or c in "\n\t\u200d").split())
    return (clean[:limit - 1] + "…" if len(clean) > limit else clean) or fallback


def money(value, currency="INR"):
    amount = int(value)
    whole, tail = divmod(abs(amount), 100)
    digits = str(whole)
    head, last = digits[:-3], digits[-3:]
    groups = []
    while head:
        groups.insert(0, head[-2:])
        head = head[:-2]
    formatted = ",".join([*groups, last])
    return f'{"-" if amount < 0 else ""}{SYMBOLS.get(currency, "₹")}{formatted}' + (f'.{tail:02}' if tail else '')


def actor_name(group, actor_id):
    if actor_id is None:
        return "Someone"
    person = group.participants.select_related("user").filter(user_id=actor_id, removed=False).first()
    return preview(participant_display_name(person), 40, "Someone") if person else "Someone"


def context(body, group):
    return body if group.is_direct else f'{body} · {preview(group.name, 50, "Group")}'


def new_bill_content(delivery):
    bill, group = delivery.expense, delivery.expense.group
    change = group.changes.filter(kind="expense_saved", data__id=str(bill.id), data__version=1).first()
    name = actor_name(group, change.actor_id if change else None)
    person = group.participants.filter(user_id=delivery.recipient_id, removed=False).first()
    share = int(bill.shares.get(str(person.id), "0")) if person else 0
    body = f'Your share is {money(share, delivery.device.currency)}.' if share else "You're included as a payer."
    return {"title": f'{name} added {preview(bill.description, 65, "a bill")}', "body": context(body, group)}


def membership_content(job):
    group = job.change.group
    name = actor_name(group, job.change.actor_id)
    title = f'{name} added you' if group.is_direct else f'{name} added you to {preview(group.name, 60, "a group")}'
    return {"title": title, "body": "Tap to view your shared bills." if group.is_direct else "Tap to view the group."}


def activity_content(job):
    group, data = job.group, job.payload
    name = actor_name(group, job.actor_id)
    currency = job.device.currency
    if job.kind == "bill_updated":
        title = f'{name} updated {preview(data["description"], 65, "a bill")}'
        field = "share" if data["before_share"] != data["share"] else "paid amount"
        old, new = (data["before_share"], data["share"]) if field == "share" else (data["before_paid"], data["paid"])
        body = f'Your {field} changed from {money(old, currency)} to {money(new, currency)}.'
    elif job.kind == "bill_deleted":
        title = f'{name} deleted {preview(data["description"], 65, "a bill")}'
        body = f'{money(data["share"], currency)} removed from your share.' if int(data["share"]) else "Bill removed from your balances."
    elif job.kind == "payment_recorded":
        title = f'{name} recorded a {money(data["amount"], currency)} payment'
        body = "Marked as paid to you." if data["direction"] == "incoming" else "Marked as paid by you."
        counterpart = group.participants.select_related("user").filter(pk=data["sender"] if data["direction"] == "incoming" else data["recipient"]).first()
        if counterpart and counterpart.user_id != job.actor_id:
            other = preview(participant_display_name(counterpart), 40, "another member")
            body = f'Marked as paid to you by {other}.' if data["direction"] == "incoming" else f'Marked as paid by you to {other}.'
    else:
        title = f'A reminder from {name}'
        body = f'You owe {name} {money(data["amount"], currency)}.'
    return {"title": title, "body": context(body, group)}
