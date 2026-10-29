"""Reclassify automatic bill icons without rewriting financial history."""
import importlib
import json

from django.db import migrations

REVISION = '5b2b1150b1c1eacd0ccb35ca6ef4cf17f42563bfdc3052afdd36cf28c701cde9'


def backfill_versatile_icons(apps, schema_editor):
    Expense, Change = (apps.get_model("ledger", name) for name in ("Expense", "Change"))
    repaired = 0
    # Older MCP clients sent a generic category as metadata, which disabled inference.
    # Keep a later manual choice made in the app, and leave non-generic choices alone.
    for bill in Expense.objects.filter(deleted=False, category_auto=False, version=1).iterator(chunk_size=100):
        if bill.category.strip().casefold() not in {"", "general", "other"}:
            continue
        if Change.objects.filter(group_id=bill.group_id, kind="expense_saved", data__id=str(bill.pk),
                data__version=1, data___history__origin="mcp").exists():
            repaired += Expense.objects.filter(pk=bill.pk, category_auto=False, version=1).update(category_auto=True)
    shared = importlib.import_module("ledger.migrations.0034_shared_expense_icons")
    shared.seed_shared_icons(apps, schema_editor, revision=REVISION, previous_revisions=())
    apps.get_model("ledger", "ExpenseCategoryDecision").objects.filter(state="pending").exclude(definition_revision=REVISION).update(state="stale", last_error="policy_changed")
    apps.get_model("ledger", "ExpenseCategoryCache").objects.filter(owner=None, state="pending").exclude(definition_revision=REVISION).update(state="uncertain", last_error="policy_changed")
    print("Versatile icon backfill: " + json.dumps({"mcp_defaults_repaired": repaired}))


class Migration(migrations.Migration):
    dependencies = [("ledger", "0036_icon_name_choices")]
    operations = [migrations.RunPython(backfill_versatile_icons, migrations.RunPython.noop)]
