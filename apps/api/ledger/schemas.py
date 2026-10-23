from __future__ import annotations

from datetime import date as Date
from typing import Annotated, Literal
from uuid import UUID

from ninja import Schema
from pydantic import ConfigDict, Field, StrictInt, StrictStr


class Input(Schema):
    model_config = ConfigDict(extra="forbid")


class Command(Input):
    command_id: UUID


class Person(Input):
    id: UUID
    name: Annotated[str, Field(min_length=1, max_length=120, pattern=r"\S")]


class GroupIn(Command):
    id: UUID
    name: Annotated[str, Field(min_length=1, max_length=120, pattern=r"\S")]
    self_participant_id: UUID
    participants: Annotated[list[Person], Field(min_length=1, max_length=100)]
    is_direct: bool = False


class Split(Input):
    mode: Literal["equal", "exact", "percent", "shares"]
    values: dict[str, StrictStr]


class ExpenseIn(Command):
    id: UUID
    description: Annotated[str, Field(min_length=1, max_length=200, pattern=r"\S")]
    total: StrictStr
    paid: dict[str, StrictStr]
    split: Split
    date: Date
    category: Annotated[str, Field(max_length=40)] = "other"
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


class ArchiveIn(Command):
    archived: bool


class WriteResult(Schema):
    id: str
    version: int


class ParticipantIn(Command):
    id: UUID
    name: Annotated[str, Field(min_length=1, max_length=120, pattern=r"\S")]


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
    provider: Literal["expo"]
    token: Annotated[str, Field(min_length=1, max_length=4096, pattern=r"^(ExpoPushToken|ExponentPushToken)\[[A-Za-z0-9_-]+\]$")]
    platform: Literal["ios", "android"]
