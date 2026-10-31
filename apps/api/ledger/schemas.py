from __future__ import annotations

from datetime import date as Date
from datetime import datetime as DateTime
from typing import Annotated, Literal
from uuid import UUID

from ninja import Schema
from pydantic import ConfigDict, Field, StrictBool, StrictInt, StrictStr


class Input(Schema):
    model_config = ConfigDict(extra="forbid")


class AccountDeleteIn(Input):
    confirmation: Literal["delete"]
    email: Annotated[StrictStr, Field(min_length=1, max_length=254)]


class Command(Input):
    command_id: UUID


class FeedbackIn(Input):
    id: UUID
    text: Annotated[StrictStr, Field(min_length=1, max_length=2000)]


class GroupLeaveIn(Command):
    remove_membership: StrictBool = False


class ChatMessageIn(Input):
    client_id: UUID
    text: Annotated[StrictStr, Field(min_length=1, max_length=2000)]


class ChatSeenIn(Input):
    tokens: Annotated[list[Annotated[StrictStr, Field(max_length=512)]], Field(max_length=50)]


class ChatPolicyIn(Input):
    version: StrictInt


class ChatBlockIn(Input):
    user_id: StrictInt
    blocked: StrictBool


class ChatReportIn(Input):
    message_id: Annotated[StrictStr, Field(pattern=r'^[1-9][0-9]{0,18}$')]
    kind: Literal['message', 'user']
    reason: Annotated[StrictStr, Field(min_length=1, max_length=500)]


class Person(Input):
    id: UUID
    name: Annotated[str, Field(min_length=1, max_length=120, pattern=r"\S")]
    email: Annotated[str, Field(max_length=254)] = ""


class GroupIn(Command):
    id: UUID
    name: Annotated[str, Field(min_length=1, max_length=120, pattern=r"\S")]
    self_participant_id: UUID
    participants: Annotated[list[Person], Field(min_length=1, max_length=100)]
    is_direct: bool = False
    simplify_debts: StrictBool = True


class SimplifyIn(Command):
    simplify_debts: StrictBool
    version: StrictInt = Field(ge=0)


class Split(Input):
    mode: Literal["equal", "exact", "percent", "shares"]
    values: dict[str, StrictStr]


class ExpenseIn(Command):
    # Read-only metadata may be echoed by older editing integrations.
    created_at: DateTime | None = Field(default=None, exclude=True)
    id: UUID
    description: Annotated[str, Field(min_length=1, max_length=200, pattern=r"\S")]
    total: StrictStr
    paid: dict[str, StrictStr]
    split: Split
    date: Date
    category: Annotated[str, Field(max_length=40)] = "other"
    category_auto: bool | None = None
    notes: Annotated[str, Field(max_length=2000)] = ""
    version: int | None = Field(default=None, ge=1)


class Revision(Command):
    version: int = Field(ge=1)


class SettlementIn(Command):
    id: UUID
    sender: UUID
    recipient: UUID
    amount: StrictStr
    date: Date | None = None
    attempt_id: UUID | None = None
    expected_group_version: Annotated[StrictInt, Field(ge=1)] | None = None


class OpeningIn(Command):
    id: UUID
    balances: dict[str, StrictStr]
    source: Annotated[str, Field(min_length=1, max_length=300, pattern=r"\S")]
    cutoff: Date


class InviteIn(Command):
    participant_id: UUID


class AttemptIn(Command):
    id: UUID
    sender: UUID
    recipient: UUID
    amount: StrictStr
    group_version: int = Field(ge=0)
    payee_version: int = Field(ge=1)


class ProfileIn(Input):
    vpa: Annotated[str, Field(min_length=3, max_length=254)]


class DisplayNameIn(Input):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    display_name: Annotated[StrictStr, Field(min_length=1, max_length=120, pattern=r"\S")]
    only_if_unnamed: StrictBool = False


class BalanceStatementPreferencesIn(Input):
    enabled: StrictBool
    frequency: Literal["weekly", "monthly"]


class NotificationPreferencesIn(Input):
    expense_updates: StrictBool
    email_reminders: StrictBool


class SignInPreferencesIn(Input):
    auto_link: StrictBool


class SeenNoticeIn(Input):
    id: UUID
    expense_version: Annotated[StrictInt, Field(ge=1)]


class SeenNoticesIn(Input):
    notices: Annotated[list[SeenNoticeIn], Field(max_length=100)]


class ArchiveIn(Command):
    archived: bool


class WriteResult(Schema):
    id: str
    version: int


class LinkedWriteResult(WriteResult):
    linked_participant_ids: list[str] = []


class ParticipantIn(Command):
    id: UUID
    name: Annotated[str, Field(min_length=1, max_length=120, pattern=r"\S")]
    email: Annotated[str, Field(max_length=254)] = ""


class ParticipantNameIn(Command):
    name: Annotated[str, Field(min_length=1, max_length=120, pattern=r"\S")]


class ContactIn(Command):
    email: Annotated[str, Field(max_length=254)] = ""


class SplitwisePreviewIn(Input):
    csv: Annotated[StrictStr, Field(min_length=1, max_length=1_048_576)]


class SplitwiseImportIn(SplitwisePreviewIn, Command):
    id: UUID
    name: Annotated[str, Field(min_length=1, max_length=120, pattern=r"\S")]
    self_index: Annotated[StrictInt, Field(ge=0, le=99)]
    payers: dict[str, StrictInt] = Field(default_factory=dict, max_length=10_000)


class SplitwiseImportResult(WriteResult):
    already_imported: bool


class PushDeviceIn(Input):
    bill_chat: StrictBool = False
    ledger_updates: StrictBool = False
    currency: Literal["INR", "USD", "EUR", "GBP", "AED", "AUD", "CAD", "SGD", "NZD", "CHF", "JPY"] = "INR"
    provider: Literal["expo"]
    token: Annotated[str, Field(min_length=1, max_length=4096, pattern=r"^(ExpoPushToken|ExponentPushToken)\[[A-Za-z0-9_-]+\]$")]
    platform: Literal["ios", "android"]


class PaymentReminderIn(Command):
    sender: UUID
    amount: Annotated[str, Field(pattern=r"^[1-9][0-9]{0,9}$")]
    group_version: Annotated[StrictInt, Field(ge=0)]
