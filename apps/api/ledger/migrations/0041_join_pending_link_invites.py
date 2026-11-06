from django.conf import settings
from django.db import migrations, transaction
from django.utils import timezone


def join_pending_links(apps, schema_editor):
    """Honor existing shared-link requests in their original claim order."""
    db = schema_editor.connection.alias
    User = apps.get_model(settings.AUTH_USER_MODEL)
    Group = apps.get_model("ledger", "Group")
    Participant = apps.get_model("ledger", "Participant")
    Invite = apps.get_model("ledger", "Invite")
    Change = apps.get_model("ledger", "Change")
    review_ids = {entry["user_id"] for entry in settings.STORE_REVIEW_AUTH}
    joined = 0
    requests = Change.objects.using(db).filter(kind="participant_claim_requested", actor__isnull=False).order_by("id")
    for request in requests.iterator():
        with transaction.atomic(using=db):
            actor = User.objects.using(db).select_for_update(no_key=True).filter(pk=request.actor_id, is_active=True).first()
            if not actor or actor.pk in review_ids:
                continue
            group = Group.objects.using(db).select_for_update().get(pk=request.group_id)
            if group.archived or group.owner_id in review_ids:
                continue
            invite = Invite.objects.using(db).select_for_update(of=("self",)).filter(
                pk=request.data.get("id"), participant__group_id=group.pk,
                claimant_id=actor.pk, approved=False, revoked=False,
                intended_email="", expires_at__gt=timezone.now(),
                participant__user__isnull=True, participant__removed=False,
                participant__contact_email="",
            ).first()
            if not invite or Participant.objects.using(db).filter(group_id=group.pk, user_id=actor.pk).exists():
                continue
            if Participant.objects.using(db).filter(group_id=group.pk, user_id__in=review_ids).exists():
                continue
            Participant.objects.using(db).filter(pk=invite.participant_id).update(user_id=actor.pk)
            invite.approved = True
            invite.save(using=db, update_fields=["approved"])
            group.version += 1
            group.save(using=db, update_fields=["version"])
            Change.objects.using(db).create(
                group_id=group.pk, actor_id=actor.pk, sequence=group.version,
                kind="participant_claim_approved",
                data={"id": str(invite.pk), "participant_id": str(invite.participant_id)},
            )
            joined += 1
    print(f" Joined {joined} pending shared-link invitation(s).", end="")


class Migration(migrations.Migration):
    atomic = False
    dependencies = [("ledger", "0040_expense_time")]
    operations = [migrations.RunPython(join_pending_links, migrations.RunPython.noop)]
