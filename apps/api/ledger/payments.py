import re
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.db import transaction
from django.utils import timezone
from ninja.errors import HttpError

from .accounting import AccountingError
from .models import Change, CommandReceipt, Group, PaymentAttempt, PaymentProfile, Settlement
from .profiles import participant_display_name
from .services import (
    keep_removed_balances_zero,
    people,
    positive_amount,
    previous_result,
    record_change,
    snapshot,
    visible_group,
    writable,
)
from .store_review import require_group_scope


def profile_for(user):
    profile = PaymentProfile.objects.filter(user=user).first()
    return None if not profile else {"vpa": profile.vpa, "version": profile.version}


@transaction.atomic
def update_profile(actor, vpa):
    if not re.fullmatch(r"[A-Za-z0-9._-]{2,}@[A-Za-z0-9.-]{2,}", vpa):
        raise AccountingError("Enter a UPI address; format checks do not verify its owner")
    if not get_user_model().objects.select_for_update(no_key=True).filter(pk=actor.pk, is_active=True).exists():
        raise HttpError(401, "Sign in again to update your payment profile")
    # Lock shared groups in the same order as other financial writes.
    groups = list(
        Group.objects.filter(participants__user=actor, participants__removed=False)
        .order_by("id").select_for_update(of=("self",))
    )
    for group in groups:
        require_group_scope(actor, group)
    profile = PaymentProfile.objects.select_for_update().filter(user=actor).first()
    if profile:
        if profile.vpa == vpa:
            return profile_for(actor)
        profile.vpa = vpa
        profile.version += 1
        profile.save()
    else:
        profile = PaymentProfile.objects.create(user=actor, vpa=vpa)
    for group in groups:
        if not group.participants.filter(user=actor, removed=False).exists():
            continue
        group.version += 1
        group.save(update_fields=["version"])
        Change.objects.create(
            group=group,
            sequence=group.version,
            actor=actor,
            kind="payment_profile_changed",
            data={"user_id": actor.pk, "version": profile.version},
        )
    return profile_for(actor)


@transaction.atomic
def prepare_payment(actor, group_id, payload):
    group = visible_group(actor, group_id, lock=True)
    previous, fingerprint = previous_result(
        actor, payload["command_id"], f"prepare_payment:{group_id}", payload
    )
    if previous:
        return previous
    writable(group)
    members = people(group)
    sender, recipient = members.get(payload["sender"]), members.get(payload["recipient"])
    if not sender or sender.user_id != actor.pk or not recipient or sender == recipient:
        raise HttpError(403, "Prepare only your own payment to another group participant")
    active = group.attempts.filter(
        sender=sender, recipient=recipient, state__in=["prepared", "reported"]
    ).first()
    if active:
        result = {"id": str(group.id), "version": group.version}
        CommandReceipt.objects.create(
            actor=actor, command_id=payload["command_id"], fingerprint=fingerprint, result=result
        )
        return result
    profile = PaymentProfile.objects.filter(user_id=recipient.user_id).first() if recipient.user_id else None
    if not profile:
        raise HttpError(409, "Recipient must claim their participant and set their own payment address")
    if group.version != payload["group_version"] or profile.version != payload["payee_version"]:
        raise HttpError(409, "Balance or recipient details changed; review again")
    amount = positive_amount(payload["amount"])
    proposed = next(
        (
            int(t["amount"])
            for t in snapshot(group)["transfers"]
            if t["sender"] == str(sender.id) and t["recipient"] == str(recipient.id)
        ),
        0,
    )
    if amount > proposed:
        raise AccountingError("Payment exceeds the current proposed repayment")
    if PaymentAttempt.objects.filter(id=payload["id"]).exists():
        raise HttpError(409, "Payment attempt ID already used")
    attempt = PaymentAttempt.objects.create(
        id=payload["id"],
        group=group,
        sender=sender,
        recipient=recipient,
        amount=amount,
        payee=profile.vpa,
        payee_version=profile.version,
        group_version=group.version + 1,
        expires_at=timezone.now() + timedelta(minutes=10),
    )
    return record_change(
        group,
        actor,
        payload["command_id"],
        fingerprint,
        "payment_prepared",
        {
            "id": str(attempt.id),
            "sender": str(sender.id),
            "recipient": str(recipient.id),
            "amount": str(amount),
        },
    )


def launch_details(actor, group_id, attempt_id):
    with transaction.atomic():
        group = visible_group(actor, group_id, lock=True)
        attempt = group.attempts.select_related("sender", "recipient__user").filter(id=attempt_id).first()
        if not attempt:
            raise HttpError(404, "Payment attempt not found")
        if attempt.sender.user_id != actor.pk:
            raise HttpError(403, "Only the payer can prepare a handoff")
        profile = PaymentProfile.objects.filter(user_id=attempt.recipient.user_id).first()
        if (
            attempt.state != "prepared"
            or attempt.sender.removed
            or attempt.recipient.removed
            or attempt.expires_at <= timezone.now()
            or group.version != attempt.group_version
            or not profile
            or profile.version != attempt.payee_version
        ):
            raise HttpError(
                409, "Quote is stale or already reported; review the payment instead of launching again"
            )
        return {
            "id": str(attempt.id),
            "vpa": attempt.payee,
            "amount": str(attempt.amount),
            "currency": "INR",
            "recipient": participant_display_name(attempt.recipient),
            "note": "",
            "bank_verified": False,
            "direct_launch_supported": True,
            "expires_at": attempt.expires_at.isoformat(),
            "group_version": attempt.group_version,
        }


@transaction.atomic
def change_payment(actor, group_id, attempt_id, payload, action):
    group = visible_group(actor, group_id, lock=True)
    previous, fingerprint = previous_result(
        actor, payload["command_id"], f"payment:{group_id}:{attempt_id}:{action}", payload
    )
    if previous:
        return previous
    attempt = group.attempts.select_related("sender", "recipient").filter(id=attempt_id).first()
    if not attempt:
        raise HttpError(404, "Payment attempt not found")
    if attempt.sender.removed or attempt.recipient.removed:
        raise HttpError(409, "This payment involves a removed person")
    if action == "confirm":
        if attempt.recipient.user_id != actor.pk:
            raise HttpError(403, "Only the recipient can acknowledge receipt")
        if attempt.state not in ["reported", "recorded", "confirmed", "cancelled"]:
            raise HttpError(409, "Payer has not reported this transfer")
        payment = Settlement.objects.filter(attempt=attempt).first()
        if payment and payment.reversed:
            raise HttpError(409, "This record was reversed; review the actual transfer")
        if not payment:
            # A late actual receipt is recorded even if a quote was cancelled.
            payment = Settlement.objects.create(
                group=group,
                sender=attempt.sender,
                recipient=attempt.recipient,
                amount=attempt.amount,
                date=timezone.localdate(),
                method="recipient_confirmed",
                recorded_by=actor,
                attempt=attempt,
            )
        elif payment.method == "manual_record":
            payment.method = "manual_then_confirmed"
            payment.save(update_fields=["method"])
        attempt.state = "confirmed"
    elif action == "report":
        if attempt.sender.user_id != actor.pk:
            raise HttpError(403, "Only the payer can report payment")
        if attempt.state in ["confirmed", "recorded"]:
            raise HttpError(409, "This transfer already has a bookkeeping entry")
        attempt.state = "reported"
    elif action == "cancel":
        if attempt.sender.user_id != actor.pk:
            raise HttpError(403, "Only the payer can cancel a prepared quote")
        if attempt.state != "prepared":
            raise HttpError(409, "An existing payment report must remain visible")
        attempt.state = "cancelled"
    else:
        raise HttpError(400, "Unknown payment action")
    attempt.save(update_fields=["state"])
    keep_removed_balances_zero(group)
    data = {"id": str(attempt.id), "state": attempt.state}
    if action == "confirm":
        data.update(
            settlement_id=str(payment.id), amount=str(payment.amount), quoted_amount=str(attempt.amount)
        )
    return record_change(group, actor, payload["command_id"], fingerprint, f"payment_{action}", data)
