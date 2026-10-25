from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("ledger", "0026_groupinvitelink")]
    operations = [migrations.AddField(
        model_name="groupinvitelink", name="public_code",
        field=models.CharField(max_length=32, unique=True, null=True, editable=False),
    )]
