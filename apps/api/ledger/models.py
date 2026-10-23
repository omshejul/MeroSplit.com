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
    import_source_hash = models.CharField(max_length=64, blank=True, default="")

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["owner", "import_source_hash"],
                condition=~Q(import_source_hash=""),
                name="one_splitwise_source_per_owner",
            )
        ]


class Participant(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    group = models.ForeignKey(Group, on_delete=models.CASCADE, related_name="participants")
    name = models.CharField(max_length=120)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL)
    removed = models.BooleanField(default=False)

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
    date = models.DateField(null=True, blank=True)
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


class UploadedFile(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    avatar_owner = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="profile_photos"
    )
    expense = models.ForeignKey(Expense, null=True, on_delete=models.SET_NULL, related_name="attachments")
    uploaded_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL)
    object_key = models.CharField(max_length=300, unique=True)
    source_hash = models.CharField(max_length=64)
    name = models.CharField(max_length=200)
    content_type = models.CharField(max_length=40)
    size = models.PositiveIntegerField()
    state = models.CharField(max_length=8, default="pending")
    purged = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=Q(state="deleted") | (
                    Q(avatar_owner__isnull=False, expense__isnull=True)
                    | Q(avatar_owner__isnull=True, expense__isnull=False)
                ),
                name="uploaded_file_has_one_scope",
            ),
            models.UniqueConstraint(
                fields=["avatar_owner"], condition=Q(state="active", avatar_owner__isnull=False),
                name="one_active_profile_photo",
            ),
            models.CheckConstraint(condition=Q(state__in=["pending", "active", "deleted"]), name="uploaded_file_state"),
        ]


class PushDevice(models.Model):
    id = models.UUIDField(primary_key=True)  # Installation ID, kept across account changes.
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    session = models.ForeignKey("sessions.Session", on_delete=models.CASCADE)
    provider = models.CharField(max_length=16)
    token = models.CharField(max_length=4096)
    token_hash = models.CharField(max_length=64)
    platform = models.CharField(max_length=7)
    revision = models.PositiveIntegerField(default=1)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["provider", "token_hash"], name="one_push_token"),
            models.CheckConstraint(condition=Q(platform__in=["ios", "android"]), name="push_device_platform"),
        ]


class ExpensePushDelivery(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    expense = models.ForeignKey(Expense, on_delete=models.CASCADE)
    recipient = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    device = models.ForeignKey(PushDevice, on_delete=models.CASCADE)
    device_revision = models.PositiveIntegerField()
    event_id = models.UUIDField()
    state = models.CharField(max_length=8, default="pending")
    attempts = models.PositiveIntegerField(default=0)
    due_at = models.DateTimeField()
    lease_id = models.UUIDField(null=True)
    lease_until = models.DateTimeField(null=True)
    provider_id = models.CharField(max_length=200, blank=True)
    ticketed_at = models.DateTimeField(null=True)
    receipt_attempts = models.PositiveIntegerField(default=0)
    last_error = models.CharField(max_length=40, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    sent_at = models.DateTimeField(null=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["expense", "device", "device_revision"], name="one_bill_push_per_device_binding"
            ),
            models.CheckConstraint(
                condition=Q(state__in=["pending", "sending", "queued", "checking", "sent", "skipped", "failed"]),
                name="expense_push_state",
            ),
        ]
        indexes = [models.Index(fields=["state", "due_at"], name="expense_push_due")]
