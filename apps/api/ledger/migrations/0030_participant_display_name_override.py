from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("ledger", "0029_normalized_category_cache")]
    operations = [migrations.AddField(
        model_name="participant", name="display_name_override",
        field=models.CharField(blank=True, default="", db_default="", max_length=120),
    )]
