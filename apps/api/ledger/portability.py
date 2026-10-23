import csv
import io

from django.contrib.auth import SESSION_KEY, get_user_model
from django.contrib.sessions.models import Session
from django.db import transaction
from django.db.models import F, Q
from django.utils import timezone

from .media import avatar_for, metadata, purge_files
from .models import (
    Change,
    Expense,
    Group,
    Invite,
    OpeningBalance,
    Participant,
    PaymentAttempt,
    Settlement,
    UploadedFile,
)
from .services import snapshot, visible_group
from .store_review import groups_for_actor, require_group_scope


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
    groups = groups_for_actor(Group.objects.filter(participants__user=actor, participants__removed=False), actor).order_by("id")
    return {
        "schema_version": 1,
        "account": {"id": actor.pk, "email": actor.email, "avatar": avatar_for(actor)},
        "groups": [accepted_export(actor, group.id) for group in groups],
    }


def _remove_user_ids(value, actor_id):
    if isinstance(value, list):
        return [_remove_user_ids(item, actor_id) for item in value]
    if isinstance(value, dict):
        return {
            key: _remove_user_ids(item, actor_id)
            for key, item in value.items()
            if not (key in {"user_id", "actor_id", "claimant_id", "owner_id", "recorded_by"}
                    and str(item) == str(actor_id))
        }
    return value


def _remove_authored_text(group, actor_id):
    # Expense changes contain complete snapshots, not a field-level author FK.
    # Unchanged fields keep their previous author when another member edits a bill.
    placeholders = {"description": "Deleted bill", "notes": "", "category": "other"}
    previous, authors = {}, {}
    changes = list(group.changes.order_by("sequence"))
    own_people = {str(pk) for pk in group.participants.filter(user_id=actor_id).values_list("id", flat=True)}
    created_here = any(c.actor_id == actor_id and c.kind == "group_created" for c in changes)
    guest_names = {}
    for change in changes:
        original = change.data
        data = _remove_user_ids(original, actor_id)
        expense_id = original.get("id")
        bill = change.kind in {"expense_saved", "expense_deleted", "expense_restored"}
        if bill and expense_id:
            last, provenance = previous.setdefault(expense_id, {}), authors.setdefault(expense_id, {})
            for field, placeholder in placeholders.items():
                if field not in original:
                    continue
                if change.kind == "expense_saved" and (field not in last or last[field] != original[field]):
                    provenance[field] = change.actor_id
                last[field] = original[field]
                if provenance.get(field) == actor_id:
                    data[field] = placeholder
        if change.actor_id == actor_id:
            for field, placeholder in {"name": "Removed content", "source": "Removed source", "source_hash": ""}.items():
                if field in data:
                    data[field] = placeholder
            if not bill:
                for field, placeholder in placeholders.items():
                    if field in data:
                        data[field] = placeholder
            if change.kind == "participant_added":
                guest_names[original.get("id")] = original.get("name")
            if change.kind == "opening_proposed":
                OpeningBalance.objects.filter(group=group, id=expense_id).update(source="Removed source")
        if change.kind == "participant_added" and expense_id in own_people and "name" in data:
            data["name"] = "Deleted participant"
        if data != original:
            change.data = data
            change.save(update_fields=["data"])
    for expense in group.expenses.all():
        provenance = authors.get(str(expense.id), {})
        fields = {key: value for key, value in placeholders.items()
                  if provenance.get(key) == actor_id or (not provenance and created_here)}
        if fields:
            Expense.objects.filter(pk=expense.pk).update(**fields, version=F("version") + 1)
    if created_here:
        group.name = "Shared group"
        group.import_source_hash = ""
        group.save(update_fields=["name", "import_source_hash"])
    for person in group.participants.filter(user__isnull=True):
        if guest_names.get(str(person.id)) == person.name or (created_here and not any(
            c.kind == "participant_added" and c.data.get("id") == str(person.id) for c in changes
        )):
            person.name = "Participant"
            person.save(update_fields=["name"])
    opening = OpeningBalance.objects.filter(group=group).first()
    if opening:
        opening.acknowledgments = _remove_user_ids(opening.acknowledgments, actor_id)
        opening.save(update_fields=["acknowledgments"])


@transaction.atomic
def delete_account(actor):
    from .models import PushDevice
    actor_id = actor.pk
    # Serialize with registration, ledger writes and logout before cascade collection.
    if not get_user_model().objects.select_for_update(no_key=True).filter(pk=actor_id).exists():
        return {"deleted": True}
    groups = list(
        Group.objects.filter(id__in=Group.objects.filter(
            Q(participants__user=actor) | Q(owner=actor) | Q(changes__actor=actor)
            | Q(expenses__attachments__uploaded_by=actor)
        ).values("id")).order_by("id").select_for_update(of=("self",))
    )
    for group in groups:
        require_group_scope(actor, group)
    session_ids = [row.session_key for row in Session.objects.all()
                   if str(row.get_decoded().get(SESSION_KEY)) == str(actor_id)]
    list(Session.objects.select_for_update().filter(session_key__in=session_ids).order_by("session_key"))
    files = UploadedFile.objects.filter(Q(avatar_owner=actor) | Q(uploaded_by=actor))
    media_ids = list(files.values_list("id", flat=True))
    files.update(state="deleted", purged=False, name="", source_hash="", size=0, uploaded_by=None, avatar_owner=None)
    PushDevice.objects.filter(user=actor).delete()
    for group in groups:
        if group.owner_id == actor.pk:
            successor = (
                group.participants.filter(user__isnull=False, removed=False)
                .exclude(user=actor).order_by("id").first()
            )
            if not successor:
                files = UploadedFile.objects.filter(expense__group=group)
                media_ids.extend(files.values_list("id", flat=True))
                files.update(state="deleted", purged=False, name="", source_hash="", size=0)
                group.delete()
                continue
            group.owner_id = successor.user_id
            # Duplicate detection belongs to the original importing account.
            group.import_source_hash = ""
            group.save(update_fields=["owner", "import_source_hash"])
        _remove_authored_text(group, actor_id)
        # Revoke links to the removed identity before unlinking its participant.
        Invite.objects.filter(participant__group=group, participant__user=actor).update(revoked=True)
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
    Session.objects.filter(session_key__in=session_ids).delete()
    # Cascades email/auth records, payment profile, command receipts and devices;
    # shared participant/payment/change FKs above remain anonymous numeric history.
    actor.delete()
    if media_ids:
        transaction.on_commit(lambda: purge_files(media_ids))
    return {"deleted": True}
