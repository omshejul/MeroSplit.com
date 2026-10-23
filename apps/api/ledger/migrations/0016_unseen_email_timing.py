from django.db import migrations, models


def cancel_legacy_email(apps, schema_editor):
    # Historical rows stay generation0. The atomic final default is1 so old
    # API writers create valid fresh notices after the schema cutover.
    apps.get_model("ledger", "ExpenseNotice").objects.filter(email_policy=0).update(email_eligible=False)
    apps.get_model("ledger", "ExpenseDigest").objects.filter(state__in=["pending", "sending"]).update(
        state="cancelled", lease_id=None, lease_until=None, last_error="timing_cutover")
    # Keep frozen payloads, assignments and uncertain receipts for reconciliation.



class Migration(migrations.Migration):
    atomic = True
    dependencies = [("ledger", "0015_bind_email_invitation_identity")]
    operations = [
        migrations.AddField(model_name="expensenotice", name="email_policy",
                            field=models.PositiveSmallIntegerField(default=0, db_default=0)),
        migrations.AddField(model_name="expensedigest", name="email_policy",
                            field=models.PositiveSmallIntegerField(default=0, db_default=0)),
        migrations.RunPython(cancel_legacy_email, migrations.RunPython.noop),
        migrations.RemoveConstraint(model_name="expensedigest", name="one_open_expense_digest"),
        migrations.AddConstraint(model_name="expensedigest", constraint=models.UniqueConstraint(
            fields=["recipient", "email_policy"], condition=models.Q(state__in=["pending", "sending", "held"]),
            name="one_open_expense_digest")),
        migrations.AlterField(model_name="expensedigest", name="email_policy",
                              field=models.PositiveSmallIntegerField(default=1, db_default=1)),
        migrations.AlterField(model_name="expensenotice", name="email_policy",
                              field=models.PositiveSmallIntegerField(default=1, db_default=1)),
    ]
