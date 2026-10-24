"""Committed chat notices. The existing worker owns all external delivery."""
import secrets
from datetime import timedelta
from urllib.parse import urlsplit
from uuid import uuid4

from allauth.core.internal.sessionkit import get_session_user
from config.sessions import SessionStore
from django.conf import settings
from django.db import transaction
from django.db.models import Exists, OuterRef, Q
from django.utils import timezone
from ninja.errors import HttpError

from . import email_delivery, push_provider
from .bill_email import _known_user, _mail_allowed, _proof, mailbox_digest
from .bill_email_models import BillEmailPreference
from .expense_notifications import verified_recipient
from .models import BillChatBlock, BillChatDelivery, BillChatNotice, Group, NotificationPreference, PushDevice
from .otp import EmailCodeLimited, consume_limits
from .store_review import entry_for_email, groups_for_actor, review_ids


def included(bill, person):
    key = str(person.id)
    return int(bill.paid.get(key, '0')) > 0 or int(bill.shares.get(key, '0')) > 0


def queue_message_notices(message, group, sender):
    """Human decision47d72513: bill financial participants ONLY, never chat authors."""
    for person in group.participants.filter(removed=False).select_related('user'):
        if not included(message.expense, person) or person.user_id == sender.pk or person.user_id and not person.user.is_active:
            continue
        pref = NotificationPreference.objects.filter(user_id=person.user_id).first() if person.user_id else None
        email = person.user.email.strip().lower() if person.user_id else person.contact_email.strip().lower()
        if not person.user_id and not email:
            continue
        known = person.user if person.user_id else _known_user(email) if email else False
        if known and known.pk == sender.pk:
            continue
        row = BillChatNotice(message=message, participant=person, recipient_id=person.user_id,
            recipient_email=email, issued_user_id=known.pk if known else None, created_at=message.created_at,
            push_eligible=bool(person.user_id and (not pref or pref.expense_updates)))
        mail_on = bool(pref and pref.expense_updates and pref.email_reminders and pref.email_enabled_at
                       and verified_recipient(person.user) == email) if person.user_id else _mail_allowed(row)
        row.email_eligible = bool(email and not entry_for_email(email) and not email.endswith('.invalid') and mail_on)
        if not current_notice(row):
            row.push_eligible = row.email_eligible = False
        row.save()
        if row.push_eligible:
            devices = PushDevice.objects.select_for_update(of=('self',)).filter(user_id=row.recipient_id, bill_chat=True,
                session__expire_date__gt=message.created_at, updated_at__gte=message.created_at - timedelta(days=30)).order_by('id')
            BillChatDelivery.objects.bulk_create([BillChatDelivery(expense=message.expense, notice=row,
                recipient_id=row.recipient_id, channel='push', device=device, device_revision=device.revision,
                due_at=message.created_at) for device in devices])


def current_notice(row, *, external=False):
    person, bill = row.participant, row.message.expense
    if (row.seen_at or row.cancelled_at or row.message.hidden_at or person.removed or not included(bill, person)
            or person.user_id != row.recipient_id or external and (bill.deleted or bill.group.archived)):
        return False
    if row.recipient_id:
        if not row.recipient.is_active or not groups_for_actor(Group.objects.filter(pk=bill.group_id), row.recipient).exists():
            return False
        block = BillChatBlock.objects.filter(owner_id=row.recipient_id, blocked_id=row.message.sender_id).first()
        if block and (block.active or block.changed_at >= row.created_at):
            return False
    else:
        if not row.recipient_email or person.contact_email.strip().lower() != row.recipient_email:
            return False
        known = _known_user(row.recipient_email)
        if known:
            block = BillChatBlock.objects.filter(owner=known, blocked_id=row.message.sender_id).first()
            if block and (block.active or block.changed_at >= row.created_at):
                return False
    return True


def email_eligible(row):
    if not row.email_eligible or not current_notice(row, external=True):
        return False
    if not row.recipient_id:
        known = _known_user(row.recipient_email)
        return not (known and row.issued_user_id is None) and _mail_allowed(row)
    pref = NotificationPreference.objects.filter(user_id=row.recipient_id, expense_updates=True, email_reminders=True).first()
    return bool(pref and pref.email_enabled_at and row.created_at >= pref.email_enabled_at
                and (not pref.updates_enabled_at or row.created_at >= pref.updates_enabled_at)
                and verified_recipient(row.recipient) == row.recipient_email)


def notice_rows():
    return BillChatNotice.objects.select_related('message__expense__group', 'participant', 'recipient')


def cancel_chat_notices(query, reason):
    ids = list(query.values_list('id', flat=True))
    query.update(cancelled_at=timezone.now(), push_eligible=False, email_eligible=False)
    BillChatDelivery.objects.filter(notice_id__in=ids, channel='push', state__in=['pending', 'sending']).update(
        state='cancelled', lease_id=None, lease_until=None, last_error=reason)
    cancel_seen_deliveries(ids)


def cancel_seen_deliveries(ids):
    BillChatDelivery.objects.filter(notice_id__in=ids, channel='push', state__in=['pending', 'sending']).update(state='cancelled', lease_id=None, lease_until=None)
    jobs = BillChatDelivery.objects.filter(id__in=BillChatNotice.objects.filter(id__in=ids).values('email_delivery_id'), state__in=['pending', 'sending', 'held'])
    for job in jobs:
        if not any(email_eligible(row) for row in notice_rows().filter(email_delivery=job)):
            BillChatDelivery.objects.filter(pk=job.pk, state__in=['pending', 'sending', 'held']).update(state='cancelled', lease_id=None, lease_until=None)


def chat_notice_feed(actor, ids):
    if len(ids) > 100:
        raise HttpError(422, 'Choose up to 100 chat notices')
    return {'notices': [{'id': str(row.id)} for row in notice_rows().filter(id__in=ids, recipient=actor) if current_notice(row)]}


def create_chat_email():
    now = timezone.now()
    open_mail = BillChatDelivery.objects.filter(expense_id=OuterRef('message__expense_id'),
        recipient_email=OuterRef('recipient_email'), channel='email', state__in=['pending', 'sending', 'held'])
    candidate = notice_rows().filter(~Exists(open_mail), email_eligible=True, email_delivery__isnull=True, seen_at__isnull=True, cancelled_at__isnull=True).filter(
        Q(recipient__isnull=True) | Q(created_at__lte=now - timedelta(minutes=10))).order_by('created_at', 'id').first()
    if not candidate:
        return None
    with transaction.atomic():
        mailbox = mailbox_digest(candidate.recipient_email)
        BillEmailPreference.objects.get_or_create(email_digest=mailbox)
        BillEmailPreference.objects.select_for_update().get(pk=mailbox)
        Group.objects.select_for_update().get(pk=candidate.message.expense.group_id)
        rows = list(notice_rows().filter(message__expense_id=candidate.message.expense_id, recipient_email=candidate.recipient_email,
            email_eligible=True, email_delivery__isnull=True, seen_at__isnull=True, cancelled_at__isnull=True)
            .select_for_update(of=('self',)).order_by('created_at', 'id')[:100])
        valid = [row for row in rows if email_eligible(row)]
        invalid = [row.id for row in rows if row not in valid]
        BillChatNotice.objects.filter(pk__in=invalid).update(email_eligible=False)
        if not valid or not any(not row.recipient_id or row.created_at <= now - timedelta(minutes=10) for row in valid):
            return None
        if BillChatDelivery.objects.filter(expense=candidate.message.expense, mailbox=mailbox, channel='email', state__in=['pending', 'sending', 'held']).exists():
            return None
        origin = urlsplit(settings.PUBLIC_WEB_URL)
        if origin.scheme != 'https' or not origin.netloc or origin.username or origin.password or origin.query or origin.fragment or origin.path not in {'', '/'}:
            return None
        row = valid[0]
        job = BillChatDelivery(id=uuid4(), expense=row.message.expense, notice=row, recipient_id=row.recipient_id,
            channel='email', mailbox=mailbox, recipient_email=row.recipient_email, due_at=now)
        # Ordinary protected URL, no login/enrollment/claim grant or new access.
        url = f'{settings.PUBLIC_WEB_URL.rstrip("/")}/app/chat/{job.expense.group_id}/{job.expense_id}'
        stop = f'{settings.PUBLIC_WEB_URL.rstrip("/")}/bill-email/opt-out/{job.id}#proof={_proof(job)}'
        text, html = email_delivery.render_message('chat_updates', {'app_url': url, 'stop_url': stop})
        job.payload = email_delivery.message_payload(job.recipient_email, 'Unread messages in MeroSplit', text, html)
        job.save()
        BillChatNotice.objects.filter(pk__in=[row.id for row in valid]).update(email_delivery=job)
        return job.id


def opt_out_chat_email(job_id, proof):
    job = BillChatDelivery.objects.filter(pk=job_id, channel='email').first()
    if not job or not isinstance(proof, str) or not secrets.compare_digest(_proof(job), proof):
        raise HttpError(400, 'This email preference link is unavailable')
    BillEmailPreference.objects.update_or_create(email_digest=job.mailbox, defaults={'suppressed': True})
    BillChatNotice.objects.filter(recipient_email=job.recipient_email).update(email_eligible=False)
    BillChatDelivery.objects.filter(recipient_email=job.recipient_email, channel='email', state__in=['pending', 'sending', 'held']).update(state='cancelled', lease_id=None, lease_until=None)
    return {'stopped': True}


def _claim():
    now = timezone.now()
    with transaction.atomic():
        row = BillChatDelivery.objects.select_for_update(skip_locked=True).filter(
            Q(state__in=['pending', 'queued'], due_at__lte=now) | Q(state='sending', lease_until__lte=now)).order_by('due_at', 'id').first()
        if not row:
            return None
        if row.attempts >= 8 or row.first_attempt_at and now >= row.first_attempt_at + timedelta(hours=23):
            row.state, row.last_error, row.lease_until = 'held', 'delivery_uncertain', None
            row.save(update_fields=['state', 'last_error', 'lease_until'])
            return None
        row.state, row.lease_id, row.lease_until = 'sending', uuid4(), now + timedelta(minutes=2)
        row.save(update_fields=['state', 'lease_id', 'lease_until'])
        return row.id, row.lease_id


def _push_eligible(job):
    notice, device = job.notice, job.device
    if not notice or not device or not device.bill_chat or not notice.push_eligible or not current_notice(notice, external=True) or notice.recipient_id in review_ids():
        return False
    pref = NotificationPreference.objects.filter(user_id=notice.recipient_id).first()
    if pref and (not pref.expense_updates or pref.updates_enabled_at and pref.updates_enabled_at > notice.created_at):
        return False
    if (device.user_id != notice.recipient_id or device.revision != job.device_revision or device.provider != settings.PUSH_PROVIDER
            or device.session.expire_date <= timezone.now() or device.updated_at < timezone.now() - timedelta(days=30)):
        return False
    user = get_session_user(SessionStore(session_key=device.session_id))
    return bool(user and user.pk == notice.recipient_id)


def send_chat_notifications(*, limit=100):
    processed = 0
    for _ in range(limit):
        create_chat_email()
        claimed = _claim()
        if not claimed:
            break
        identifier, lease = claimed
        job = BillChatDelivery.objects.select_related('notice__message__expense__group', 'notice__participant', 'notice__recipient',
            'device__session', 'expense__group').filter(pk=identifier, lease_id=lease).first()
        if not job:
            continue
        current = BillChatDelivery.objects.filter(pk=identifier, lease_id=lease, state='sending', lease_until__gt=timezone.now())
        eligible = any(email_eligible(row) for row in notice_rows().filter(email_delivery=job)) if job.channel == 'email' else _push_eligible(job)
        if not eligible:
            current.update(state='cancelled', lease_id=None, lease_until=None, last_error='ineligible')
            processed += 1
            continue
        if not current.exists():
            continue
        if job.channel == 'email':
            unread = [row for row in notice_rows().filter(email_delivery=job) if email_eligible(row)]
            due = min(row.created_at + (timedelta(minutes=10) if row.recipient_id else timedelta()) for row in unread) if unread else None
            if due and due > timezone.now():
                current.update(state='pending', due_at=due, lease_until=None)
                continue
        if job.channel == 'email' and not job.first_attempt_at:
            try:
                with transaction.atomic():
                    limits = [('chat-mailbox', job.recipient_email, 60, 1), ('chat-global', 'all', 3600, 1000)]
                    if not job.recipient_id:
                        limits += [('bill-mailbox', job.recipient_email, 60, 1), ('bill-mailbox', job.recipient_email, 86400, 5)]
                    consume_limits(limits)
            except EmailCodeLimited:
                current.update(state='pending', due_at=timezone.now() + timedelta(minutes=1), lease_until=None)
                continue
        # A local quota wait is not a provider attempt. Recheck just before HTTP.
        job = BillChatDelivery.objects.select_related('notice__message__expense__group', 'notice__participant', 'notice__recipient',
            'device__session', 'expense__group').filter(pk=identifier, lease_id=lease).first()
        if not job or not current.exists():
            continue
        eligible = any(email_eligible(row) for row in notice_rows().filter(email_delivery=job)) if job.channel == 'email' else _push_eligible(job)
        if not eligible:
            current.update(state='cancelled', lease_id=None, lease_until=None, last_error='ineligible')
            continue
        job.attempts += 1
        if not current.update(first_attempt_at=job.first_attempt_at or timezone.now(), attempts=job.attempts):
            continue
        try:
            if job.channel == 'email':
                provider_id = email_delivery.send_email(job.recipient_email, job.payload['subject'], job.payload['text'], f'bill-chat/{job.id}', payload=job.payload)
            elif job.provider_id:
                if not push_provider.check_bill_notification_receipt(job.provider_id):
                    current.update(state='queued', due_at=timezone.now() + timedelta(minutes=15), lease_until=None)
                    continue
                provider_id = job.provider_id
            else:
                data = {'type': 'bill_chat', 'event_id': str(job.notice_id), 'recipient_user_id': str(job.recipient_id),
                        'group_id': str(job.expense.group_id), 'expense_id': str(job.expense_id), 'message_id': str(job.notice.message_id)}
                provider_id = push_provider.send_bill_notification(job.device, data, body='New messages in a bill conversation.')
        except (email_delivery.EmailDeliveryUnavailable, push_provider.PushFailure) as error:
            invalid = isinstance(error, push_provider.PushFailure) and error.invalid_token
            if invalid:
                PushDevice.objects.filter(pk=job.device_id, revision=job.device_revision).delete()
            else:
                current.update(state='held' if isinstance(error, email_delivery.EmailDeliveryHeld) or isinstance(error, push_provider.PushFailure) and error.permanent else 'queued' if job.provider_id else 'pending',
                    due_at=timezone.now() + timedelta(seconds=min(3600, 30 * 2 ** job.attempts)), lease_until=None, last_error='delivery_uncertain')
        else:
            BillChatDelivery.objects.filter(pk=job.id).update(provider_id=provider_id, state='queued' if job.channel == 'push' and not job.provider_id else 'sent',
                accepted_at=timezone.now(), due_at=timezone.now() + timedelta(minutes=15), lease_until=None, last_error='')
        processed += 1
    return processed
