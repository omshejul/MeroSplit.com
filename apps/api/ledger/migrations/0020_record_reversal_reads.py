from django.db import migrations, models
from django.db.models.fields.json import KeyTextTransform
from django.db.models.functions import Coalesce


class Migration(migrations.Migration):
    dependencies = [("ledger", "0019_group_visibility")]

    operations = [
        migrations.RemoveIndex(model_name="change", name="human_activity_order"),
        migrations.AddIndex(
            model_name="change",
            index=models.Index(fields=["-created_at", "-id"], name="human_activity_order", condition=models.Q(kind__in=[
                "expense_saved", "expense_deleted", "expense_restored", "expense_reversed", "manual_settlement", "payment_confirm",
                "settlement_reversed", "participant_added", "participant_claim_approved", "participant_removed",
                "group_created", "group_archived", "group_unarchived",
            ])),
        ),
        migrations.RemoveIndex(model_name="change", name="payment_activity_identity"),
        migrations.AddIndex(
            model_name="change",
            index=models.Index(
                models.F("group"), Coalesce(KeyTextTransform("settlement_id", "data"), KeyTextTransform("id", "data")), models.F("id"),
                name="payment_activity_identity",
                condition=models.Q(kind__in=["manual_settlement", "payment_confirm", "expense_reversed", "settlement_reversed"]),
            ),
        ),
    ]
