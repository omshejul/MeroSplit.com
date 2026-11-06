import importlib

from django.db import migrations

REVISION = 'c04188b21e37a74830fb1dce885b1a973bed36339b60c916a04bc83e2b14a234'


def backfill_top_choice(apps, schema_editor):
    previous = importlib.import_module('ledger.migrations.0034_shared_expense_icons')
    previous.seed_shared_icons(apps, schema_editor, revision=REVISION,
        previous_revisions=(previous.REVISION, previous.PREVIOUS_REVISION))
    # Retire undispatched work for the old cutoff; the new title keys replace it.
    # In-flight calls keep their leases and cannot overwrite this policy's cache.
    apps.get_model('ledger', 'ExpenseCategoryDecision').objects.filter(
        definition_revision=previous.REVISION, state='pending').update(state='stale', last_error='policy_changed')
    apps.get_model('ledger', 'ExpenseCategoryCache').objects.filter(
        owner=None, definition_revision=previous.REVISION, state='pending').update(state='uncertain', last_error='policy_changed')


class Migration(migrations.Migration):
    dependencies = [('ledger', '0034_shared_expense_icons')]
    operations = [migrations.RunPython(backfill_top_choice, migrations.RunPython.noop)]
