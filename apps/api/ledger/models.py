import uuid

from django.conf import settings
from django.db import models
from django.db.models import Q


class Group(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=120)
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    version = models.PositiveIntegerField(default=0)
    archived = models.BooleanField(default=False)
    is_direct = models.BooleanField(default=False)


class Participant(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    group = models.ForeignKey(Group, on_delete=models.CASCADE, related_name="participants")
    name = models.CharField(max_length=120)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["group", "user"], condition=Q(user__isnull=False), name="one_user_per_group"
            )
        ]


class Expense(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    group = models.ForeignKey(Group, on_delete=models.CASCADE, related_name="expenses")
    version = models.PositiveIntegerField(default=1)
    description = models.CharField(max_length=200)
    total = models.BigIntegerField()
    paid = models.JSONField()
    shares = models.JSONField()
    split = models.JSONField()
    date = models.DateField()
    category = models.CharField(max_length=40, default="other")
    notes = models.TextField(blank=True, max_length=2000)
    deleted = models.BooleanField(default=False)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=Q(total__gt=0, total__lte=1_000_000_000), name="expense_amount_bound"
            )
        ]


class PaymentAttempt(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    group = models.ForeignKey(Group, on_delete=models.CASCADE, related_name="attempts")
    sender = models.ForeignKey(Participant, on_delete=models.RESTRICT, related_name="outgoing_attempts")
    recipient = models.ForeignKey(Participant, on_delete=models.RESTRICT, related_name="incoming_attempts")
    amount = models.BigIntegerField()
    payee = models.CharField(max_length=254)
    payee_version = models.PositiveIntegerField()
    group_version = models.PositiveIntegerField()
    state = models.CharField(max_length=16, default="prepared")
    expires_at = models.DateTimeField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=Q(amount__gt=0, amount__lte=1_000_000_000), name="attempt_amount_bound"
            ),
            models.CheckConstraint(
                condition=~Q(sender=models.F("recipient")), name="attempt_distinct_people"
            ),
            models.UniqueConstraint(
                fields=["group", "sender", "recipient"],
                condition=Q(state__in=["prepared", "reported"]),
                name="one_active_payment_attempt",
            ),
        ]


class Settlement(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    group = models.ForeignKey(Group, on_delete=models.CASCADE, related_name="settlements")
    sender = models.ForeignKey(Participant, on_delete=models.RESTRICT, related_name="sent_settlements")
    recipient = models.ForeignKey(Participant, on_delete=models.RESTRICT, related_name="received_settlements")
    amount = models.BigIntegerField()
    date = models.DateField()
    method = models.CharField(max_length=24, default="manual_record")
    recorded_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL)
    attempt = models.OneToOneField(PaymentAttempt, null=True, on_delete=models.RESTRICT)
    reversed = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=Q(amount__gt=0, amount__lte=1_000_000_000), name="settlement_amount_bound"
            ),
            models.CheckConstraint(
                condition=~Q(sender=models.F("recipient")), name="settlement_distinct_people"
            ),
        ]


class OpeningBalance(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    group = models.OneToOneField(Group, on_delete=models.CASCADE, related_name="opening")
    balances = models.JSONField()
    source = models.CharField(max_length=300)
    cutoff = models.DateField()
    acknowledgments = models.JSONField(default=dict)
    accepted = models.BooleanField(default=False)


class Invite(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    participant = models.ForeignKey(Participant, on_delete=models.CASCADE)
    token_hash = models.CharField(max_length=64, unique=True)
    expires_at = models.DateTimeField()
    revoked = models.BooleanField(default=False)
    claimant = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL)
    approved = models.BooleanField(default=False)


class PaymentProfile(models.Model):
    user = models.OneToOneField(settings.AUTH_USER_MODEL, primary_key=True, on_delete=models.CASCADE)
    vpa = models.CharField(max_length=254)
    version = models.PositiveIntegerField(default=1)


class Change(models.Model):
    group = models.ForeignKey(Group, on_delete=models.CASCADE, related_name="changes")
    sequence = models.PositiveIntegerField()
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL)
    kind = models.CharField(max_length=40)
    data = models.JSONField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["group", "sequence"], name="group_change_sequence")]


class CommandReceipt(models.Model):
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    command_id = models.UUIDField()
    fingerprint = models.CharField(max_length=64)
    result = models.JSONField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["actor", "command_id"], name="actor_command_once")]
