"""Bill conversations and their committed notification work, separate from money."""
import uuid

from django.conf import settings
from django.db import models
from django.db.models import Q


class BillChatMessage(models.Model):
    id = models.BigAutoField(primary_key=True)
    expense = models.ForeignKey('Expense', on_delete=models.CASCADE, related_name='chat_messages')
    sender = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    client_id = models.UUIDField()
    text = models.TextField(max_length=2000)
    created_at = models.DateTimeField()
    hidden_at = models.DateTimeField(null=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['sender', 'client_id'], name='chat_sender_client_once')]
        indexes = [models.Index(fields=['expense', '-id'], name='chat_bill_order'),
                   models.Index(fields=['sender', 'created_at'], name='chat_sender_rate')]


class BillChatNotice(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    message = models.ForeignKey(BillChatMessage, on_delete=models.CASCADE, related_name='notices')
    participant = models.ForeignKey('Participant', on_delete=models.CASCADE)
    recipient = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, null=True)
    recipient_email = models.EmailField(blank=True)
    issued_user_id = models.BigIntegerField(null=True)
    created_at = models.DateTimeField()
    seen_at = models.DateTimeField(null=True)
    cancelled_at = models.DateTimeField(null=True)
    push_eligible = models.BooleanField(default=False)
    email_eligible = models.BooleanField(default=False)
    email_delivery = models.ForeignKey('BillChatDelivery', null=True, on_delete=models.SET_NULL, related_name='email_notices')

    class Meta:
        constraints = [models.UniqueConstraint(fields=['message', 'participant'], name='chat_notice_recipient_once')]
        indexes = [models.Index(fields=['recipient', 'message'], condition=Q(seen_at__isnull=True, cancelled_at__isnull=True), name='chat_unread'),
                   models.Index(fields=['created_at'], condition=Q(email_eligible=True, email_delivery__isnull=True), name='chat_email_due')]


class BillChatBlock(models.Model):
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='chat_blocks')
    blocked = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='chat_blocked_by')
    active = models.BooleanField(default=True)
    changed_at = models.DateTimeField()

    class Meta:
        constraints = [models.UniqueConstraint(fields=['owner', 'blocked'], name='chat_block_once'),
                       models.CheckConstraint(condition=~Q(owner=models.F('blocked')), name='chat_block_not_self')]


class BillChatAcceptance(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    version = models.PositiveSmallIntegerField()
    accepted_at = models.DateTimeField()

    class Meta:
        constraints = [models.UniqueConstraint(fields=['user', 'version'], name='chat_policy_once')]


class BillChatReport(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    reporter = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    message = models.ForeignKey(BillChatMessage, on_delete=models.SET_NULL, null=True)
    kind = models.CharField(max_length=7)
    reason = models.CharField(max_length=500)
    created_at = models.DateTimeField()
    reviewed_at = models.DateTimeField(null=True)
    resolution = models.CharField(max_length=24, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['reporter', 'message', 'kind'], name='chat_report_once'),
                       models.CheckConstraint(condition=Q(kind__in=['message', 'user']), name='chat_report_kind')]


class BillChatDelivery(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    expense = models.ForeignKey('Expense', on_delete=models.CASCADE)
    notice = models.ForeignKey(BillChatNotice, null=True, on_delete=models.SET_NULL)
    recipient = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.CASCADE)
    channel = models.CharField(max_length=5)
    device = models.ForeignKey('PushDevice', null=True, on_delete=models.CASCADE)
    device_revision = models.PositiveIntegerField(null=True)
    recipient_email = models.EmailField(blank=True)
    mailbox = models.CharField(max_length=64, blank=True)
    payload = models.JSONField(default=dict)
    state = models.CharField(max_length=9, default='pending')
    due_at = models.DateTimeField()
    first_attempt_at = models.DateTimeField(null=True)
    attempts = models.PositiveSmallIntegerField(default=0)
    lease_id = models.UUIDField(null=True)
    lease_until = models.DateTimeField(null=True)
    provider_id = models.CharField(max_length=200, blank=True)
    accepted_at = models.DateTimeField(null=True)
    last_error = models.CharField(max_length=40, blank=True)

    class Meta:
        constraints = [
            models.CheckConstraint(condition=Q(channel='email', device__isnull=True) | Q(channel='push', device__isnull=False), name='chat_delivery_channel'),
            models.CheckConstraint(condition=Q(state__in=['pending', 'sending', 'queued', 'sent', 'cancelled', 'held', 'failed']), name='chat_delivery_state'),
            models.UniqueConstraint(fields=['notice', 'device', 'device_revision'], condition=Q(channel='push'), name='chat_push_binding_once'),
            models.UniqueConstraint(fields=['expense', 'mailbox'], condition=Q(channel='email', state__in=['pending', 'sending', 'held']), name='chat_open_email_once'),
        ]
        indexes = [models.Index(fields=['state', 'due_at'], name='chat_delivery_due')]
