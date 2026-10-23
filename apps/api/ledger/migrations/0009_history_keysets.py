from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("ledger", "0008_email_codes_and_person_invites")]

    operations = [
        migrations.AddIndex(model_name="expense", index=models.Index(fields=["group", "date", "id"], name="bill_history_keyset")),
        migrations.AddIndex(model_name="settlement", index=models.Index(fields=["group", "created_at", "id"], name="payment_history_keyset")),
        migrations.AddIndex(model_name="paymentattempt", index=models.Index(fields=["group", "created_at", "id"], name="attempt_history_keyset")),
    ]
