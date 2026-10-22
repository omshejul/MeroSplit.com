import csv
import io

from allauth.account.models import EmailAddress
from django.contrib.auth import get_user_model
from django.db import transaction
from django.utils import timezone

from .media import avatar_for, metadata, purge_files
from .models import (
    Change,
    Group,
    Invite,
    Participant,
    PaymentAttempt,
    PaymentProfile,
    Settlement,
    UploadedFile,
)
from .services import snapshot, visible_group


def accepted_export(actor, group_id):
    with transaction.atomic():
        group = visible_group(actor, group_id, lock=True)
        state = snapshot(group)
        state["attachments"] = [
            {"expense_id": str(file.expense_id), **metadata(file)}
            for file in UploadedFile.objects.filter(expense__group=group, state="active").order_by("id")
        ]
        if group.owner_id != actor.pk:
            state["invites"] = []
        return {
            "schema_version": 1,
            "currency": "INR",
            "money_unit": "paise",
            "scope": "accepted_server_records",
            "exported_at": timezone.now().isoformat(),
            "group": state,
        }


def csv_export(export):
    group = export["group"]
    stream = io.StringIO(newline="")
    writer = csv.writer(stream)
    writer.writerow(
        [
            "kind",
            "id",
            "date",
            "description",
            "participant_id",
            "paid_paise",
            "share_paise",
            "net_paise",
            "provenance",
            "reversed_or_deleted",
        ]
    )

    def safe(value):
        text = str(value)
        return "'" + text if text.lstrip().startswith(("=", "+", "-", "@", "\t", "\r")) else text

    for expense in group["expenses"]:
        for person in group["balances"]:
            paid, share = expense["paid"].get(person, "0"), expense["shares"].get(person, "0")
            net = 0 if expense["deleted"] else int(paid) - int(share)
            writer.writerow(
                [
                    "expense",
                    expense["id"],
                    expense["date"],
                    safe(expense["description"]),
                    person,
                    paid,
                    share,
                    net,
                    "recorded_expense",
                    expense["deleted"],
                ]
            )
    for payment in group["settlements"]:
        for person, sign in [(payment["sender"], 1), (payment["recipient"], -1)]:
            net = 0 if payment["reversed"] else sign * int(payment["amount"])
            writer.writerow(
                [
                    "settlement",
                    payment["id"],
                    payment["date"],
                    "",
                    person,
                    "",
                    "",
                    net,
                    payment["method"],
                    payment["reversed"],
                ]
            )
    opening = group["opening_balance"]
    if opening and opening["accepted"]:
        for person, amount in opening["balances"].items():
            writer.writerow(
                [
                    "opening_balance",
                    opening["id"],
                    opening["cutoff"],
                    safe(opening["source"]),
                    person,
                    "",
                    "",
                    amount,
                    "acknowledged_opening",
                    False,
                ]
            )
    return stream.getvalue()


@transaction.atomic
def account_export(actor):
    groups = Group.objects.filter(participants__user=actor).order_by("id")
    return {
        "schema_version": 1,
        "account": {"id": actor.pk, "email": actor.email, "avatar": avatar_for(actor)},
        "groups": [accepted_export(actor, group.id) for group in groups],
    }


@transaction.atomic
def delete_account(actor):
    # Other members retain their shared financial records; solo-owned data is removed.
    get_user_model().objects.select_for_update(no_key=True).get(pk=actor.pk)
    photos = UploadedFile.objects.filter(avatar_owner=actor)
    media_ids = list(photos.values_list("id", flat=True))
    photos.update(state="deleted")
    groups = list(
        Group.objects.filter(participants__user=actor).order_by("id").select_for_update(of=("self",))
    )
    for group in groups:
        if group.owner_id == actor.pk:
            successor = (
                group.participants.filter(user__isnull=False).exclude(user=actor).order_by("id").first()
            )
            if not successor:
                files = UploadedFile.objects.filter(expense__group=group)
                media_ids.extend(files.values_list("id", flat=True))
                files.update(state="deleted")
                group.delete()
                continue
            group.owner_id = successor.user_id
            # Duplicate detection belongs to the original importing account.
            group.import_source_hash = ""
            group.save(update_fields=["owner", "import_source_hash"])
        group.version += 1
        group.save(update_fields=["version"])
        Change.objects.create(
            group=group,
            sequence=group.version,
            kind="account_deleted",
            data={
                "participant_ids": [
                    str(p)
                    for p in Participant.objects.filter(group=group, user=actor).values_list("id", flat=True)
                ]
            },
        )
    PaymentAttempt.objects.filter(recipient__user=actor).update(payee="")
    Participant.objects.filter(user=actor).update(name="Deleted participant", user=None)
    Settlement.objects.filter(recorded_by=actor).update(recorded_by=None)
    Change.objects.filter(actor=actor).update(actor=None)
    Invite.objects.filter(claimant=actor).update(claimant=None, revoked=True)
    PaymentProfile.objects.filter(user=actor).delete()
    UploadedFile.objects.filter(uploaded_by=actor).update(uploaded_by=None)
    EmailAddress.objects.filter(user=actor).delete()
    actor.email = ""
    actor.first_name = actor.last_name = ""
    actor.username = f"deleted-{actor.pk}"
    actor.is_active = False
    actor.set_unusable_password()
    actor.save()
    if media_ids:
        transaction.on_commit(lambda: purge_files(media_ids))
    return {"deleted": True}
