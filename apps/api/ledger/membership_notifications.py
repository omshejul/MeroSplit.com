"""Membership delivery in the existing supervised worker, separate from bills."""

from datetime import timedelta
from urllib.parse import urlsplit
from uuid import uuid4

from allauth.core.internal.sessionkit import get_session_user
from config.sessions import SessionStore
from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from . import email_delivery, push_provider
from .expense_notifications import verified_recipient
from .models import Group, MembershipDelivery, NotificationPreference, Participant, PushDevice
from .store_review import groups_for_actor, review_ids


def queue_membership(change, people):
    """Caller holds sorted user locks then group; rollback removes all delivery work."""
    now = timezone.now()
    for person in people:
        user = person.user
        if user.pk == change.actor_id or user.pk in review_ids():
            continue
        pref = NotificationPreference.objects.filter(user=user).first()
        if pref and not pref.expense_updates:
            continue
        email = verified_recipient(user)
        origin = urlsplit(settings.PUBLIC_WEB_URL)
        if (email and pref and pref.email_reminders and pref.email_enabled_at
                and origin.scheme == 'https' and origin.netloc and not origin.username and not origin.password
                and not origin.query and not origin.fragment and origin.path in {'', '/'}):
            text, html = email_delivery.render_message('membership_added', {'app_url': f'{settings.PUBLIC_WEB_URL.rstrip("/")}/app/'})
            MembershipDelivery.objects.create(change=change, participant=person, recipient=user,
                channel='email', recipient_email=email, due_at=now,
                payload=email_delivery.message_payload(email, 'You were added in MeroSplit', text, html))
        devices = PushDevice.objects.select_for_update(of=('self',)).filter(user=user,
            session__expire_date__gt=now, updated_at__gte=now - timedelta(days=30)).order_by('id')
        MembershipDelivery.objects.bulk_create([MembershipDelivery(change=change, participant=person,
            recipient=user, channel='push', device=device, device_revision=device.revision, due_at=now) for device in devices])


def cancel_membership(query, reason):
    query.filter(state__in=['pending', 'sending', 'queued', 'held']).update(
        state='cancelled', lease_id=None, lease_until=None, last_error=reason)


def _eligible(job):
    person = Participant.objects.select_related('user', 'group').filter(pk=job.participant_id,
        group_id=job.change.group_id, user_id=job.recipient_id, user__is_active=True, removed=False, group__archived=False).first()
    if not person:
        return False
    user, group = person.user, person.group
    if (user.pk in review_ids() or not job.change.actor_id or job.change.actor_id in review_ids()
            or not get_user_model().objects.filter(pk=job.change.actor_id, is_active=True).exists()
            or not groups_for_actor(Group.objects.filter(pk=group.pk), user).exists()):
        return False
    pref = NotificationPreference.objects.filter(user=user).first()
    if pref and (not pref.expense_updates or pref.updates_enabled_at and pref.updates_enabled_at > job.change.created_at):
        return False
    if job.channel == 'email':
        return bool(pref and pref.email_reminders and pref.email_enabled_at
                    and pref.email_enabled_at <= job.change.created_at and verified_recipient(user) == job.recipient_email)
    device = PushDevice.objects.select_related('session').filter(pk=job.device_id, user=user,
        revision=job.device_revision, provider=settings.PUSH_PROVIDER, session__expire_date__gt=timezone.now(),
        updated_at__gte=timezone.now() - timedelta(days=30)).first()
    if not device:
        return False
    session_user = get_session_user(SessionStore(session_key=device.session_id))
    return bool(session_user and session_user.pk == user.pk)


def _rows():
    return MembershipDelivery.objects.select_related('change', 'device')


def _claim():
    now = timezone.now()
    with transaction.atomic():
        job = MembershipDelivery.objects.select_for_update(skip_locked=True).filter(
            Q(state__in=['pending', 'queued'], due_at__lte=now) | Q(state='sending', lease_until__lte=now)
        ).order_by('due_at', 'id').first()
        if not job:
            return None
        # A crash after an unacknowledged push POST cannot safely resend it.
        uncertain_push = job.channel == 'push' and job.first_attempt_at and not job.provider_id
        if uncertain_push or job.attempts >= 8 or job.first_attempt_at and now >= job.first_attempt_at + timedelta(hours=23):
            job.state, job.last_error, job.lease_until = 'held', 'delivery_uncertain', None
            job.save(update_fields=['state', 'last_error', 'lease_until'])
            return job.id, None
        job.state, job.lease_id, job.lease_until = 'sending', uuid4(), now + timedelta(minutes=2)
        job.save(update_fields=['state', 'lease_id', 'lease_until'])
        return job.id, job.lease_id


def send_membership_notifications(*, limit=100):
    processed = 0
    for _ in range(limit):
        claimed = _claim()
        if not claimed:
            break
        identifier, lease = claimed
        processed += 1
        if lease is None:
            continue
        job = _rows().filter(pk=identifier, lease_id=lease).first()
        current = MembershipDelivery.objects.filter(pk=identifier, lease_id=lease, state='sending', lease_until__gt=timezone.now())
        if not job or not current.exists():
            continue
        if not _eligible(job):
            current.update(state='cancelled', lease_id=None, lease_until=None, last_error='ineligible')
            continue
        # External I/O follows the committed lease and a fresh permission check.
        if not current.update(first_attempt_at=job.first_attempt_at or timezone.now(), attempts=job.attempts + 1):
            continue
        try:
            if job.channel == 'email':
                provider_id = email_delivery.send_email(job.recipient_email, job.payload['subject'], job.payload['text'],
                    f'membership/{job.id}', payload=job.payload)
            elif job.provider_id:
                if not push_provider.check_bill_notification_receipt(job.provider_id):
                    current.update(state='queued', due_at=timezone.now() + timedelta(minutes=15), lease_id=None, lease_until=None)
                    continue
                provider_id = job.provider_id
            else:
                data = {'type': 'group_membership', 'event_id': f'membership:{job.change_id}:{job.recipient_id}',
                        'recipient_user_id': str(job.recipient_id), 'group_id': str(job.change.group_id)}
                from .notification_content import membership_content
                provider_id = push_provider.send_bill_notification(job.device, data, **membership_content(job))
        except (email_delivery.EmailDeliveryUnavailable, push_provider.PushFailure) as error:
            if isinstance(error, push_provider.PushFailure) and error.invalid_token:
                PushDevice.objects.filter(pk=job.device_id, revision=job.device_revision).delete()
            else:
                hold = isinstance(error, email_delivery.EmailDeliveryHeld) or isinstance(error, push_provider.PushFailure) and not job.provider_id
                current.update(state='held' if hold else 'queued' if job.provider_id else 'pending', lease_id=None, lease_until=None,
                    due_at=timezone.now() + timedelta(seconds=min(3600, 30 * 2 ** min(job.attempts + 1, 7))), last_error='delivery_uncertain')
        else:
            current.update(provider_id=provider_id, state='queued' if job.channel == 'push' and not job.provider_id else 'sent',
                accepted_at=job.accepted_at or timezone.now(), due_at=timezone.now() + timedelta(minutes=15),
                lease_id=None, lease_until=None, last_error='')
    return processed
