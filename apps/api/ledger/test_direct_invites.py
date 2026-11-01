import importlib
from datetime import timedelta
from types import SimpleNamespace

import pytest
from django.db import connection
from django.db.migrations.loader import MigrationLoader
from django.utils import timezone

from .models import Change, Group, Invite, Participant
from .services import previous_result, record_change
from .test_api import client as client
from .test_api import expense, send, uid
from .test_api import group as group
from .test_collaboration import account, invite, state

pytestmark = pytest.mark.django_db


def pending(owner, member, group_id, participant_id):
    invitation, token = invite(owner, group_id, participant_id)
    Invite.objects.filter(pk=invitation).update(claimant=member.actor)
    body = {"command_id": uid()}
    _, fingerprint = previous_result(member.actor, body["command_id"], f"claim:{invitation}", body)
    record_change(Group.objects.get(pk=group_id), member.actor, body["command_id"], fingerprint,
                  "participant_claim_requested", {"id": invitation, "participant_id": participant_id,
                                                   "claimant_id": member.actor.pk})
    return invitation, token, body


def upgrade_pending():
    apps = MigrationLoader(connection).project_state([("ledger", "0040_expense_time")]).apps
    migration = importlib.import_module("ledger.migrations.0041_join_pending_link_invites")
    migration.join_pending_links(apps, SimpleNamespace(connection=connection))


def test_upgrade_joins_first_valid_pending_claim_without_changing_financial_records(client, group):
    group_id, ids, _ = group
    assert send(client, "post", f"/groups/{group_id}/expenses", expense(ids)).status_code == 200
    first, second = account(), account()
    invitation, token, body = pending(client, first, group_id, ids[1])
    later, _, _ = pending(client, second, group_id, ids[1])
    before = state(client, group_id)
    upgrade_pending()
    after = state(first, group_id)
    assert Participant.objects.get(pk=ids[1]).user_id == first.actor.pk
    assert Invite.objects.get(pk=invitation).approved
    assert not Invite.objects.get(pk=later).approved
    assert send(second, "get", f"/groups/{group_id}").status_code == 404
    for key in ("balances", "expenses", "settlements", "totals"):
        assert before[key] == after[key]
    assert send(first, "post", f"/invites/{token}/claim", body).status_code == 200
    upgrade_pending()
    assert Change.objects.filter(group_id=group_id, kind="participant_claim_approved").count() == 1
    assert Group.objects.get(pk=group_id).version == after["version"]


@pytest.mark.parametrize("invalid", ["revoked", "expired", "removed", "contact", "addressed", "inactive", "archived", "already_linked"])
def test_upgrade_skips_invalid_pending_claims(client, group, invalid):
    group_id, ids, _ = group
    member = account()
    invitation, _, _ = pending(client, member, group_id, ids[1])
    if invalid == "revoked":
        Invite.objects.filter(pk=invitation).update(revoked=True)
    elif invalid == "expired":
        Invite.objects.filter(pk=invitation).update(expires_at=timezone.now() - timedelta(seconds=1))
    elif invalid == "removed":
        Participant.objects.filter(pk=ids[1]).update(removed=True)
    elif invalid == "contact":
        Participant.objects.filter(pk=ids[1]).update(contact_email=member.actor.email)
    elif invalid == "addressed":
        Invite.objects.filter(pk=invitation).update(intended_email=member.actor.email)
    elif invalid == "inactive":
        member.actor.is_active = False
        member.actor.save(update_fields=["is_active"])
    elif invalid == "archived":
        Group.objects.filter(pk=group_id).update(archived=True)
    elif invalid == "already_linked":
        Participant.objects.filter(pk=ids[2]).update(user=member.actor)
    before = Group.objects.get(pk=group_id).version
    upgrade_pending()
    assert Participant.objects.get(pk=ids[1]).user_id is None
    assert not Invite.objects.get(pk=invitation).approved
    assert Group.objects.get(pk=group_id).version == before
