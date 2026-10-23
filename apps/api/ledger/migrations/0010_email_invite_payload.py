from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("ledger", "0009_history_keysets")]

    operations = [
        migrations.AddField(
            model_name="invite", name="email_payload", field=models.JSONField(default=dict, blank=True),
        ),
    ]
