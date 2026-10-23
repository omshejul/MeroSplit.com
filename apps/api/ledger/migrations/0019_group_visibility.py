from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("ledger", "0018_bill_email_notice")]
    operations = [migrations.AddField(model_name="participant", name="hidden", field=models.BooleanField(default=False, db_default=False))]
