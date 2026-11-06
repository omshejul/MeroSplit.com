import importlib

from django.db import migrations

REVISION = '1e51b4cd0c6884469d60c6a4e77b9aaade3f832820c42c2626b5ea9fadc78647'


def backfill_icon_names(apps, schema_editor):
    shared = importlib.import_module("ledger.migrations.0034_shared_expense_icons")
    # The prompt and choices changed. Never carry forward old ready results.
    shared.seed_shared_icons(apps, schema_editor, revision=REVISION, previous_revisions=())
    # Retire only undispatched work. In-flight calls keep their old revision.
    apps.get_model("ledger", "ExpenseCategoryDecision").objects.filter(
        state="pending").exclude(definition_revision=REVISION).update(state="stale", last_error="policy_changed")
    apps.get_model("ledger", "ExpenseCategoryCache").objects.filter(
        owner=None, state="pending").exclude(definition_revision=REVISION).update(state="uncertain", last_error="policy_changed")


class Migration(migrations.Migration):
    dependencies = [("ledger", "0035_top_category_icons")]
    operations = [migrations.RunPython(backfill_icon_names, migrations.RunPython.noop)]
