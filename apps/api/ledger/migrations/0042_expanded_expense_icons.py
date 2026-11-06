"""Refresh automatic icons under the expanded catalog, preserving manual choices."""
import importlib

from django.db import migrations

REVISION = '66eba0fafeb30eb982e409197fd9f79e3fdd184932d6d68c2e38bff1b4ab05ef'


def backfill_expanded_icons(apps, schema_editor):
    shared = importlib.import_module("ledger.migrations.0034_shared_expense_icons")
    shared.seed_shared_icons(apps, schema_editor, revision=REVISION, previous_revisions=())
    apps.get_model("ledger", "ExpenseCategoryDecision").objects.filter(
        state="pending").exclude(definition_revision=REVISION).update(state="stale", last_error="policy_changed")
    apps.get_model("ledger", "ExpenseCategoryCache").objects.filter(
        owner=None, state="pending").exclude(definition_revision=REVISION).update(state="uncertain", last_error="policy_changed")


class Migration(migrations.Migration):
    dependencies = [("ledger", "0041_join_pending_link_invites")]
    operations = [migrations.RunPython(backfill_expanded_icons, migrations.RunPython.noop)]
