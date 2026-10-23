"""Generic new-bill delivery to a supplied mailbox, without granting membership."""
import uuid

from django.conf import settings
from django.db import models
from django.db.models import Q


class BillEmailPreference(models.Model):
    email_digest = models.CharField(max_length=64, primary_key=True)
    suppressed = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)


class BillEmailNotice(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    expense = models.ForeignKey('Expense', on_delete=models.CASCADE)
    participant = models.ForeignKey('Participant', on_delete=models.CASCADE)
    delivery = models.ForeignKey("self", null=True, on_delete=models.SET_NULL, related_name="batched_notices")
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL)
    recipient_email = models.EmailField()
    issued_user_id = models.BigIntegerField(null=True)
    grant = models.OneToOneField('EmailLoginGrant', null=True, on_delete=models.SET_NULL)
    created_at = models.DateTimeField()
    due_at = models.DateTimeField()
    state = models.CharField(max_length=9, default='pending')
    payload = models.JSONField(default=dict)
    cancelled_at = models.DateTimeField(null=True)
    first_attempt_at = models.DateTimeField(null=True)
    attempts = models.PositiveSmallIntegerField(default=0)
    lease_id = models.UUIDField(null=True)
    lease_until = models.DateTimeField(null=True)
    accepted_at = models.DateTimeField(null=True)
    provider_id = models.CharField(max_length=200, blank=True)
    last_error = models.CharField(max_length=40, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=['expense', 'participant'], name='one_unclaimed_bill_email'),
            models.CheckConstraint(condition=Q(state__in=['pending', 'sending', 'batched', 'accepted', 'cancelled', 'held']), name='bill_email_state'),
        ]
        indexes = [models.Index(fields=['state', 'due_at'], name='bill_email_due')]
