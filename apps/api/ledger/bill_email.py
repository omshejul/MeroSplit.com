"""New-bill mailbox notices. Sign-in proves a mailbox, never group membership."""
import secrets
from datetime import timedelta
from uuid import uuid4

from allauth.account.models import EmailAddress
from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from django.utils.crypto import salted_hmac
from ninja.errors import HttpError

from . import email_delivery
from .bill_email_models import BillEmailNotice, BillEmailPreference
from .models import EmailLoginGrant, ExpenseNotice, Group, NotificationPreference, Participant
from .otp import EmailCodeLimited, consume_limits, normalized_email
from .store_review import entry_for_email, groups_for_actor, review_ids


def mailbox_digest(email):
    return salted_hmac('merosplit.bill-email-optout', email.strip().lower(), algorithm='sha256').hexdigest()


def _proof(row):
    return salted_hmac('merosplit.bill-email-stop.v1', f'{row.id}:{mailbox_digest(row.recipient_email)}', algorithm='sha256').hexdigest()


def _known_user(email):
    ids = set(get_user_model().objects.filter(email__iexact=email).values_list('pk', flat=True))
    ids.update(EmailAddress.objects.filter(email__iexact=email).values_list('user_id', flat=True))
    if len(ids) > 1:
        return False
    if not ids:
        return None
    user = get_user_model().objects.filter(pk=ids.pop(), is_active=True, email__iexact=email).first()
    return user if user and user.pk not in review_ids() else False


def _mail_allowed(row):
    if entry_for_email(row.recipient_email) or BillEmailPreference.objects.filter(email_digest=mailbox_digest(row.recipient_email), suppressed=True).exists():
        return False
    user = _known_user(row.recipient_email)
    if user is False or row.issued_user_id and (not user or user.pk != row.issued_user_id):
        return False
    if user:
        # Existing-account OFF/default-off wins even when this person is unclaimed.
        pref = NotificationPreference.objects.filter(user=user, expense_updates=True, email_reminders=True).first()
        return bool(pref and pref.email_enabled_at and (row.issued_user_id is None or row.created_at >= pref.email_enabled_at))
    return True


def _current(row):
    person, bill = row.participant, row.expense
    key = str(person.id)
    return (row.actor is not None and row.actor.is_active and row.actor_id not in review_ids()
            and groups_for_actor(Group.objects.filter(pk=bill.group_id), row.actor).exists()
            and not person.removed and not person.user_id
            and person.contact_email.strip().lower() == row.recipient_email and not bill.deleted and not bill.group.archived
            and (int(bill.paid.get(key, '0')) > 0 or int(bill.shares.get(key, '0')) > 0))


def queue_bill_emails(expense, actor):
    """Only the ordinary CREATE transaction calls this, never contact edits/imports."""
    now = timezone.now()
    for person in expense.group.participants.filter(user__isnull=True, removed=False).exclude(contact_email=''):
        key = str(person.id)
        if not (int(expense.paid.get(key, '0')) > 0 or int(expense.shares.get(key, '0')) > 0):
            continue
        email = normalized_email(person.contact_email)
        domain = email.rpartition('@')[2]
        if domain == 'invalid' or domain.endswith('.invalid') or entry_for_email(email):
            continue
        user = _known_user(email)
        if user is False or user and (user.pk == actor.pk or Participant.objects.filter(group=expense.group, user=user).exists()):
            continue
        row = BillEmailNotice(expense=expense, participant=person, actor=actor, recipient_email=email,
                              issued_user_id=user.pk if user else None, created_at=now, due_at=now)
        if not _mail_allowed(row):
            row.state, row.last_error = "cancelled", "preference_off"
        row.save()


def _delivery_events(row):
    # The delivery leader owns the frozen provider key/body. Individual events
    # retain their own cancellation even when another same-mailbox bill survives.
    return BillEmailNotice.objects.filter(Q(pk=row.pk) | Q(delivery_id=row.pk),
        recipient_email=row.recipient_email, cancelled_at__isnull=True).exclude(state='cancelled').select_related(
            'participant', 'expense__group', 'actor')


def _delivery_eligible(row):
    return any(_current(event) and _mail_allowed(event) for event in _delivery_events(row))


def cancel_bill_emails(query, reason):
    ids = list(query.values_list('id', flat=True))
    if not ids:
        return
    events = BillEmailNotice.objects.filter(pk__in=ids)
    if reason not in {'preference_off', 'mailbox_optout'}:
        events.update(cancelled_at=timezone.now())
    # Cancelling A must not cancel B's event or replace an attempted delivery.
    # A leader with children remains the durable delivery record until the final
    # eligibility check. A cancelled sibling itself never becomes a sender.
    leaders = (events.filter(first_attempt_at__isnull=False, batched_notices__isnull=False).values('id')
               if reason not in {'preference_off', 'mailbox_optout'} else [])
    affected = events.exclude(pk__in=leaders).exclude(state='accepted')
    affected.update(state='cancelled', lease_id=None, lease_until=None, last_error=reason)
    for row in events.filter(grant__isnull=False):
        if not _delivery_eligible(row):
            EmailLoginGrant.objects.filter(pk=row.grant_id, consumed_at__isnull=True).update(revoked_at=timezone.now())


def promote_current_bill_emails(person):
    """Called under the claim's group lock. Only captured current events transition."""
    if not person.user_id or person.removed:
        return
    now = timezone.now()
    rows = BillEmailNotice.objects.select_for_update(of=('self',)).filter(participant=person, cancelled_at__isnull=True).filter(~Q(state='cancelled') | Q(last_error__in=['preference_off', 'mailbox_optout'])).select_related('expense__group', 'grant')
    for row in rows:
        if row.recipient_email != person.contact_email.strip().lower() or row.expense.deleted or row.expense.group.archived:
            continue
        if row.grant_id and row.grant.expires_at and row.grant.expires_at <= now:
            continue
        key = str(person.id)
        if not (int(row.expense.paid.get(key, '0')) > 0 or int(row.expense.shares.get(key, '0')) > 0):
            continue
        user = get_user_model().objects.filter(pk=person.user_id, is_active=True).first()
        if not user or user.pk in review_ids() or not groups_for_actor(Group.objects.filter(pk=person.group_id), user).exists():
            continue
        # An attempted provider call may already have succeeded. Never add a
        # delayed second email for that event, even while its receipt is unknown.
        pref = NotificationPreference.objects.filter(user=user).first()
        email_ok = bool(not row.first_attempt_at and row.state != 'cancelled' and pref and _mail_allowed(row))
        # First access makes this captured current event visible to a newly
        # created identity. Its unread clock starts now, after disclosed enable.
        notice_at = now if email_ok and row.issued_user_id is None else row.created_at
        ExpenseNotice.objects.get_or_create(expense=row.expense, recipient=user, defaults={
            'expense_version': 1, 'created_at': notice_at, 'push_due_at': notice_at + timedelta(seconds=30),
            'push_processed_at': now, 'email_policy': 1, 'email_eligible': email_ok,
        })
        if row.state != 'accepted' and not (row.first_attempt_at and row.batched_notices.exists()):
            BillEmailNotice.objects.filter(pk=row.pk).update(state='held' if row.first_attempt_at else 'cancelled',
                lease_id=None, lease_until=None, last_error='claimed')
        if row.grant_id and not _delivery_eligible(row):
            EmailLoginGrant.objects.filter(pk=row.grant_id, consumed_at__isnull=True).update(revoked_at=now)


def _claim():
    now = timezone.now()
    with transaction.atomic():
        row = (BillEmailNotice.objects.select_for_update(skip_locked=True)
               .filter(Q(state='pending', due_at__lte=now) | Q(state='sending', lease_until__lte=now))
               .order_by('due_at', 'id').first())
        if not row:
            return None
        if row.first_attempt_at and (row.attempts >= 8 or now >= row.first_attempt_at + timedelta(hours=23)):
            row.state, row.last_error, row.lease_until = 'held', 'delivery_uncertain', None
            row.save(update_fields=['state', 'last_error', 'lease_until'])
            return row.id, None
        row.state, row.lease_id, row.lease_until = 'sending', uuid4(), now + timedelta(minutes=2)
        row.save(update_fields=['state', 'lease_id', 'lease_until'])
        return row.id, row.lease_id


def _prepare(row_id, lease_id):
    from .email_links import EXPIRY_PLACEHOLDER, LINK_PLACEHOLDER, issue_email_link
    # Group -> notice order matches claim/contact/delete. No network under locks.
    with transaction.atomic():
        email = BillEmailNotice.objects.filter(pk=row_id).values_list('recipient_email', flat=True).first()
        if not email:
            return None
        mailbox, _ = BillEmailPreference.objects.get_or_create(email_digest=mailbox_digest(email))
        BillEmailPreference.objects.select_for_update().get(pk=mailbox.pk)
        candidates = BillEmailNotice.objects.filter(recipient_email=email, first_attempt_at__isnull=True,
            delivery__isnull=True, state__in=['pending', 'sending'], due_at__lte=timezone.now())
        candidate_ids = list(candidates.exclude(pk=row_id).order_by('created_at', 'id').values_list('id', flat=True)[:99])
        candidates = candidates.filter(pk__in=candidate_ids)
        group_ids = list(candidates.values_list('expense__group_id', flat=True))
        group_ids += list(BillEmailNotice.objects.filter(Q(pk=row_id) | Q(delivery_id=row_id)).values_list('expense__group_id', flat=True))
        list(Group.objects.filter(pk__in=group_ids).order_by('id').select_for_update())
        row = (BillEmailNotice.objects.select_for_update(of=('self',)).select_related('participant', 'expense__group', 'actor')
               .filter(pk=row_id, lease_id=lease_id, state='sending', lease_until__gt=timezone.now()).first())
        if not row:
            return None
        if row.participant.user_id:
            promote_current_bill_emails(row.participant)
            if not row.first_attempt_at:
                return None
        if not (_delivery_eligible(row) if row.first_attempt_at else _current(row) and _mail_allowed(row)):
            reason = 'preference_off' if _current(row) else 'ineligible'
            cancel_bill_emails(BillEmailNotice.objects.filter(pk=row.pk), reason)
            # No current event can justify this delivery. Keep its frozen audit,
            # but stop the leader lease even when cancelled children still exist.
            BillEmailNotice.objects.filter(pk=row.pk).exclude(state='accepted').update(
                state='cancelled', lease_id=None, lease_until=None)
            return None
        if not row.first_attempt_at:
            try:
                # Separate limits from login/invitation quotas. Immediate bursts
                # share a mailbox's minute slot rather than spamming each bill.
                with transaction.atomic():
                    consume_limits([('bill-mailbox', row.recipient_email, 60, 1), ('bill-mailbox', row.recipient_email, 86400, 5),
                                    ('bill-author', str(row.actor_id), 3600, 20), ('bill-global', 'all', 3600, 1000)])
            except EmailCodeLimited:
                BillEmailNotice.objects.filter(pk=row.pk).update(state='pending', due_at=timezone.now() + timedelta(minutes=1), lease_id=None, lease_until=None, last_error='rate_limited')
                return None
            now = timezone.now()
            grant = issue_email_link(row.recipient_email, purpose='notice', target={'kind': 'notice', 'notice_id': str(row.id)},
                                     source_key=f'bill-notice/{row.id}', expires_at=now + timedelta(hours=24))
            stop_url = "MEROSPLIT_BILL_EMAIL_STOP_LINK"
            text, html = email_delivery.render_message('bill_notice', {'app_url': LINK_PLACEHOLDER, 'expires_at': EXPIRY_PLACEHOLDER,
                'stop_url': stop_url})
            row.payload = email_delivery.message_payload(row.recipient_email, 'A new bill includes you in MeroSplit', text, html)
            row.payload['_email_link_id'] = str(grant.id)
            row.grant, row.first_attempt_at = grant, now
            siblings = list(candidates.exclude(pk=row.pk).select_for_update(of=('self',))
                            .select_related('participant', 'expense__group', 'actor').order_by('id')[:99])
            eligible = [item.id for item in siblings if _current(item) and _mail_allowed(item)]
            BillEmailNotice.objects.filter(pk__in=eligible).update(delivery=row, state='batched',
                first_attempt_at=now, lease_id=None, lease_until=None)
        row.attempts += 1
        row.save(update_fields=['payload', 'grant', 'first_attempt_at', 'attempts'])
        return row


def send_pending_bill_emails(*, limit=100):
    processed = 0
    for _ in range(limit):
        claimed = _claim()
        if not claimed:
            break
        row_id, lease_id = claimed
        processed += 1
        if not lease_id or not (row := _prepare(row_id, lease_id)):
            continue
        current = BillEmailNotice.objects.filter(pk=row_id, lease_id=lease_id, state='sending', lease_until__gt=timezone.now())
        # Last check outside the prepare transaction catches committed opt-out,
        # contact/claim/removal changes. In-flight provider requests can still win.
        fresh = current.select_related('participant', 'expense__group', 'actor').first()
        if not fresh or not _delivery_eligible(fresh):
            current.update(state='cancelled', lease_id=None, lease_until=None, last_error='ineligible')
            if fresh and fresh.grant_id:
                EmailLoginGrant.objects.filter(pk=fresh.grant_id, consumed_at__isnull=True).update(revoked_at=timezone.now())
            continue
        try:
            provider_id = email_delivery.send_email(row.recipient_email, row.payload['subject'], row.payload['text'], f'bill-notice/{row.id}', payload=row.payload)
        except email_delivery.EmailDeliveryUnavailable:
            current.update(state='pending', due_at=timezone.now() + timedelta(minutes=min(60, 2 ** row.attempts)), lease_id=None, lease_until=None, last_error='delivery_uncertain')
        else:
            BillEmailNotice.objects.filter(Q(pk=row_id) | Q(delivery_id=row_id)).update(state='accepted', accepted_at=timezone.now(), provider_id=provider_id,
                                                            lease_id=None, lease_until=None, last_error='')
    return processed


def notification_entry(actor):
    email = actor.email.strip().lower()
    if not EmailAddress.objects.filter(user=actor, email__iexact=email, verified=True).exists():
        return {'needs_invitation': False}
    return {'needs_invitation': BillEmailNotice.objects.filter(recipient_email=email, state='accepted', cancelled_at__isnull=True, participant__user__isnull=True,
        participant__removed=False, expense__deleted=False, expense__group__archived=False, actor__is_active=True,
        first_attempt_at__gt=timezone.now() - timedelta(hours=24)).exists()}


def opt_out(notice_id, proof):
    with transaction.atomic():
        row = BillEmailNotice.objects.filter(pk=notice_id).first()
        if row is None:
            from .chat_notifications import opt_out_chat_email
            return opt_out_chat_email(notice_id, proof)
        if not row or not isinstance(proof, str) or len(proof) != 64 or not secrets.compare_digest(_proof(row), proof):
            raise HttpError(400, 'This email preference link is unavailable')
        mailbox, _ = BillEmailPreference.objects.get_or_create(email_digest=mailbox_digest(row.recipient_email))
        BillEmailPreference.objects.filter(pk=mailbox.pk).update(suppressed=True)
        cancel_bill_emails(BillEmailNotice.objects.filter(recipient_email=row.recipient_email), 'mailbox_optout')
        # Linked notices also respect this mailbox preference at final send.
        return {'stopped': True}


def validate_notification_entry(grant, actor):
    """Proof signs in only. It cannot approve or claim any participant."""
    row = BillEmailNotice.objects.select_related('participant', 'expense__group', 'actor').filter(pk=grant.target['notice_id'], grant=grant).first()
    if (not row or row.recipient_email != grant.email or actor.email.strip().lower() != grant.email or not any(_current(event) for event in _delivery_events(row))):
        from .otp import EmailCodeInvalid
        raise EmailCodeInvalid()
    return {'kind': 'home'}


def delivery_stop_url(grant):
    row = BillEmailNotice.objects.filter(pk=grant.target['notice_id'], grant=grant).first()
    if row is None:
        raise ValueError('Notification delivery is unavailable')
    return f"{grant.delivery_origin}/bill-email/opt-out/{row.id}#proof={_proof(row)}"
