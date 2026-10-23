"""Allowlisted agent reads and existing ledger commands; actor comes from OAuth."""

from uuid import UUID

from django.core import signing
from django.db import transaction
from django.db.models import F
from ninja.errors import HttpError

from . import services
from .history_reads import expense_detail, history_page, settlement_detail
from .mcp_oauth import issuer_url
from .models import Group, OpeningBalance
from .profiles import display_name, participant_display_name
from .schemas import Command, ExpenseIn, GroupIn, Revision, SettlementIn
from .services import finance_state, visible_group
from .store_review import groups_for_actor

MCP_SCOPE = "merosplit:mcp"
GROUP_CURSOR_SALT = "merosplit.mcp-groups.v1"
BILL_FIELDS = ("id", "version", "description", "total", "paid", "shares", "date", "category", "deleted")
PAYMENT_FIELDS = ("id", "sender", "recipient", "amount", "method", "date", "reversed")


def _uuid(value):
    try:
        return value if isinstance(value, UUID) else UUID(value)
    except (ValueError, TypeError, AttributeError) as exc:
        raise HttpError(422, "Use a valid record ID") from exc


def _page_input(limit, cursor):
    if type(limit) is not int or not 1 <= limit <= 100:
        raise HttpError(422, "Page size must be between 1 and 100")
    if cursor is not None and (not isinstance(cursor, str) or len(cursor) > 4096):
        raise HttpError(422, "Invalid page cursor")


def _version(value):
    if value is not None and (type(value) is not int or value < 0):
        raise HttpError(422, "Use a valid group version")


def get_account_context(actor):
    """Identify the OAuth account without exposing contact or payment credentials."""
    origin = issuer_url()
    return {"account": {"id": actor.pk, "display_name": display_name(actor)}, "currency": "INR",
            "minor_unit": "paise", "minor_units_per_unit": 100, "amount_format": "integer string",
            "app_url": f"{origin}/app/", "setup_url": f"{origin}/mcp/setup"}


def list_groups(actor, *, limit=50, cursor=None):
    """Page currently joined ledgers, including archived ledgers, without contact data."""
    _page_input(limit, cursor)
    context = {"actor": actor.pk, "limit": limit}
    query = groups_for_actor(Group.objects.filter(participants__user=actor, participants__removed=False), actor)
    if cursor:
        try:
            payload = signing.loads(cursor, salt=GROUP_CURSOR_SALT, max_age=86400)
            if not isinstance(payload, dict) or any(payload.get(key) != value for key, value in context.items()):
                raise ValueError()
            query = query.filter(id__gt=UUID(payload["after"]))
        except signing.SignatureExpired as exc:
            raise HttpError(409, "Group page expired; start again") from exc
        except (signing.BadSignature, ValueError, TypeError, KeyError, AttributeError) as exc:
            raise HttpError(422, "Invalid group cursor") from exc
    rows = list(query.annotate(hidden=F("participants__hidden")).order_by("id").values(
        "id", "name", "version", "archived", "is_direct", "hidden")[:limit + 1])
    more, rows = len(rows) > limit, rows[:limit]
    return {
        "groups": [{**row, "id": str(row["id"])} for row in rows],
        "next_cursor": signing.dumps({**context, "after": str(rows[-1]["id"])}, salt=GROUP_CURSOR_SALT) if more else None,
    }


@transaction.atomic
def get_group(actor, group_id):
    """Return complete canonical finance, not unbounded history or private profiles."""
    group = visible_group(actor, _uuid(group_id), lock=True)
    people = list(group.participants.select_related("user").order_by("id"))
    opening = OpeningBalance.objects.filter(group=group, accepted=True).first()
    finance = finance_state(
        [person.id for person in people],
        group.expenses.filter(deleted=False).values_list("total", "paid", "shares").iterator(chunk_size=1000),
        group.settlements.filter(reversed=False).values_list("sender_id", "recipient_id", "amount").iterator(chunk_size=1000),
        opening.balances if opening else None,
    )
    return {
        "id": str(group.id), "name": group.name, "version": group.version,
        "archived": group.archived, "is_direct": group.is_direct, "currency": "INR",
        "participants": [{"id": str(person.id), "name": participant_display_name(person),
                          "is_self": person.user_id == actor.pk and not person.removed, "removed": person.removed}
                         for person in people],
        **finance,
    }


def list_transactions(actor, group_id, *, limit=50, cursor=None, version=None, q=""):
    """Reuse canonical mixed ordering and account/version-bound history cursors."""
    _page_input(limit, cursor)
    _version(version)
    if not isinstance(q, str) or len(q.strip()) > 200:
        raise HttpError(422, "Check the bill search")
    page = history_page(actor, _uuid(group_id), "transactions", limit=limit, cursor=cursor,
                        version=version, filters={"q": q})
    items = [{"kind": item["kind"], "date": item["date"],
              item["kind"]: {key: item[item["kind"]][key] for key in
                             (BILL_FIELDS if item["kind"] == "bill" else PAYMENT_FIELDS)}}
             for item in page["items"]]
    return {"group_id": page["group_id"], "version": page["version"], "currency": "INR",
            "items": items, "next_cursor": page["next_cursor"]}


def get_bill(actor, group_id, bill_id, *, version=None):
    """Read one current authorized bill, including its historical deleted flag."""
    _version(version)
    bill = expense_detail(actor, _uuid(group_id), _uuid(bill_id), version=version)
    return {key: bill[key] for key in (*BILL_FIELDS, "split", "notes", "group_id", "group_version")} | {"currency": "INR"}


def get_payment(actor, group_id, payment_id, *, version=None):
    """Read an accounting record without historical UPI or authentication metadata."""
    _version(version)
    payment = settlement_detail(actor, _uuid(group_id), _uuid(payment_id), version=version)
    return {key: payment[key] for key in (*PAYMENT_FIELDS, "group_id", "group_version")} | {"currency": "INR"}


def create_group(actor, payload):
    """Create a ledger with silent, unlinked placeholders and no invitation contacts."""
    body = GroupIn.model_validate(payload)
    if any("email" in person.model_fields_set for person in body.participants):
        raise HttpError(422, "Participant email is not supported by this tool")
    return services.create_group(actor, body.model_dump(mode="json"))


def save_expense(actor, group_id, payload, *, expense_id=None):
    """Save once through the ordinary transaction, requiring an exact edit revision."""
    body = ExpenseIn.model_validate(payload)
    if expense_id is not None:
        expense_id = _uuid(expense_id)
        if body.id != expense_id or body.version is None:
            raise HttpError(422, "Editing requires the matching expense ID and version")
    elif body.version is not None:
        raise HttpError(422, "Omit version when creating a new expense")
    return services.save_expense(actor, _uuid(group_id), body.model_dump(mode="json"), expense_id)


def set_expense_deleted(actor, group_id, bill_id, payload, *, deleted):
    """Delete or restore an exact revision; a repeated command replays its result."""
    if type(deleted) is not bool:
        raise HttpError(422, "Choose explicitly whether to delete or restore the expense")
    body = Revision.model_validate(payload)
    return services.set_expense_deleted(actor, _uuid(group_id), _uuid(bill_id), body.model_dump(mode="json"), deleted)


def record_external_payment(actor, group_id, payload):
    """Record an external payment, without opening a bank app or asserting bank proof."""
    body = SettlementIn.model_validate(payload)
    if {"attempt_id", "expected_group_version"} & body.model_fields_set:
        raise HttpError(422, "External manual records must omit attempt_id and expected_group_version")
    if "date" not in body.model_fields_set:
        raise HttpError(422, "Provide the actual payment date, or null when it is unknown")
    return services.record_settlement(actor, _uuid(group_id), body.model_dump(mode="json", exclude_unset=True))


def reverse_external_payment(actor, group_id, payment_id, payload):
    """Reverse bookkeeping under the existing participant/organizer rules, never a bank refund."""
    body = Command.model_validate(payload)
    return services.reverse_settlement(actor, _uuid(group_id), _uuid(payment_id), body.model_dump(mode="json"))
