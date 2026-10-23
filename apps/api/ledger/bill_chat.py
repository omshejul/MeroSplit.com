"""Authorized, ordered human messages. No financial command or revision writes."""
import re
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.core import signing
from django.db import transaction
from django.db.models import Count, Exists, OuterRef, Q
from django.utils import timezone
from ninja.errors import HttpError

from .models import BillChatAcceptance, BillChatBlock, BillChatMessage, BillChatNotice, BillChatReport
from .profiles import participant_display_name
from .services import visible_group

SALT = 'merosplit.bill-chat.v1'
POLICY_VERSION = 1
# A deliberately small first-line filter. Reports/operator review handle gaps.
OBVIOUS_ABUSE = re.compile(r'\b(?:porn(?:ography)?|nudes?|rape|kill yourself|i will kill you|child sex|sell cocaine)\b', re.IGNORECASE)


def _bill(actor, group_id, expense_id, *, lock=False):
    group = visible_group(actor, group_id, lock=lock)
    bill = group.expenses.filter(pk=expense_id).first()
    if not bill:
        raise HttpError(404, 'Bill not found')
    return group, bill


def _token(actor, bill, purpose, identifier):
    return signing.dumps([str(actor.pk), str(bill.pk), purpose, str(identifier)], salt=SALT, compress=True)


def _identifier(actor, bill, purpose, token):
    try:
        user, expense, kind, identifier = signing.loads(token, salt=SALT, max_age=86400)
        if (user, expense, kind) != (str(actor.pk), str(bill.pk), purpose) or not str(identifier).isdigit():
            raise ValueError()
        return int(identifier)
    except (signing.BadSignature, ValueError, TypeError) as exc:
        raise HttpError(422, 'Refresh this conversation and try again') from exc


def message_data(actor, bill, row, names):
    return {'id': str(row.pk), 'client_id': str(row.client_id), 'sender_id': str(row.sender_id),
            'sender': names.get(row.sender_id, 'Unknown participant'), 'text': '' if row.hidden_at else row.text, 'hidden': bool(row.hidden_at),
            'created_at': row.created_at.isoformat(), 'seen_token': _token(actor, bill, 'seen', row.pk)}


def _names(group):
    return {p.user_id: participant_display_name(p) for p in group.participants.select_related('user') if p.user_id}


def _unread(actor, bill):
    blocks = BillChatBlock.objects.filter(owner=actor, blocked_id=OuterRef('message__sender_id')).filter(Q(active=True) | Q(changed_at__gte=OuterRef('created_at')))
    involved = [p.id for p in bill.group.participants.filter(user=actor, removed=False)
                if int(bill.paid.get(str(p.id), '0')) > 0 or int(bill.shares.get(str(p.id), '0')) > 0]
    return BillChatNotice.objects.filter(participant_id__in=involved, message__expense=bill, message__hidden_at__isnull=True, recipient=actor,
                                        seen_at__isnull=True, cancelled_at__isnull=True).filter(~Exists(blocks))


def _visible_messages(actor, bill):
    return bill.chat_messages.filter(hidden_at__isnull=True).exclude(sender_id__in=BillChatBlock.objects.filter(owner=actor, active=True).values('blocked_id'))


@transaction.atomic
def chat_page(actor, group_id, expense_id, *, limit=50, before=None, after=None, known=''):
    if not 1 <= limit <= 50 or before and after or any(value and len(value) > 512 for value in (before, after)):
        raise HttpError(422, 'Choose one cursor and a page size from 1 to 50')
    group, bill = _bill(actor, group_id, expense_id, lock=True)
    query = _visible_messages(actor, bill)
    try:
        known_ids = [int(value) for value in known.split(',')] if known else []
        if len(known_ids) > 50 or len(known) > 1050 or any(value <= 0 for value in known_ids):
            raise ValueError()
    except ValueError as exc:
        raise HttpError(422, 'Choose up to 50 visible message IDs') from exc
    removed = sorted(set(known_ids) - set(query.filter(pk__in=known_ids).values_list('pk', flat=True)))
    if before:
        query = query.filter(id__lt=_identifier(actor, bill, 'before', before))
    if after:
        query = query.filter(id__gt=_identifier(actor, bill, 'after', after))
    rows = list(query.order_by('id' if after else '-id')[:limit + 1])
    has_more = len(rows) > limit
    rows = rows[:limit] if after else list(reversed(rows[:limit]))
    names = _names(group)
    return {'messages': [message_data(actor, bill, row, names) for row in rows],
            'older_cursor': _token(actor, bill, 'before', rows[0].id) if rows and not after and has_more else None,
            'after_cursor': _token(actor, bill, 'after', rows[-1].id if rows else _identifier(actor, bill, 'after', after) if after else 0),
            'has_more_newer': bool(after and has_more), 'unread': _unread(actor, bill).count(),
            'can_send': not group.archived and not bill.deleted, 'removed_ids': [str(value) for value in removed],
            'policy_accepted': BillChatAcceptance.objects.filter(user=actor, version=POLICY_VERSION).exists(),
            'policy_version': POLICY_VERSION,
            'blocked_users': [{'id': str(row.blocked_id), 'name': names.get(row.blocked_id, 'Participant')} for row in BillChatBlock.objects.filter(owner=actor, active=True, blocked_id__in=names)[:100]]}


@transaction.atomic
def chat_status(actor, group_id, expense_id):
    group, bill = _bill(actor, group_id, expense_id, lock=True)
    return {'unread': _unread(actor, bill).count(), 'can_send': not group.archived and not bill.deleted}


@transaction.atomic
def send_message(actor, group_id, expense_id, client_id, text):
    if not get_user_model().objects.select_for_update(no_key=True).filter(pk=actor.pk, is_active=True).exists():
        raise HttpError(401, 'Sign in again to send a message')
    group, bill = _bill(actor, group_id, expense_id, lock=True)
    existing = BillChatMessage.objects.filter(sender=actor, client_id=client_id).first()
    if existing:
        if existing.expense_id != bill.id or existing.text != text:
            raise HttpError(409, 'Message ID already used for different input')
        return message_data(actor, bill, existing, _names(group))
    if group.archived or bill.deleted:
        raise HttpError(409, 'This conversation is read-only')
    if not BillChatAcceptance.objects.filter(user=actor, version=POLICY_VERSION).exists():
        raise HttpError(409, 'Read and accept the chat policy before posting')
    if not isinstance(text, str) or not text.strip() or len(text) > 2000 or any(ord(c) < 32 and c not in '\n\t' for c in text):
        raise HttpError(422, 'Enter a message of up to 2,000 characters')
    if OBVIOUS_ABUSE.search(text):
        raise HttpError(422, 'That message is not allowed. Use Report for abusive content.')
    now = timezone.now()
    counts = BillChatMessage.objects.filter(sender=actor, created_at__gt=now - timedelta(hours=1)).aggregate(
        minute=Count('id', filter=Q(created_at__gt=now - timedelta(minutes=1))), hour=Count('id'))
    if counts['minute'] >= 20 or counts['hour'] >= 300:
        raise HttpError(429, 'Too many messages. Wait a minute and try again.')
    # The group lock serializes allocation/commit order and membership changes.
    row = BillChatMessage.objects.create(expense=bill, sender=actor, client_id=client_id, text=text, created_at=now)
    from .chat_notifications import queue_message_notices
    queue_message_notices(row, group, actor)
    return message_data(actor, bill, row, _names(group))


@transaction.atomic
def chat_seen(actor, group_id, expense_id, tokens):
    group, bill = _bill(actor, group_id, expense_id, lock=True)
    ids = {_identifier(actor, bill, 'seen', token) for token in tokens}
    if len(ids) > 50 or _visible_messages(actor, bill).filter(pk__in=ids).count() != len(ids):
        raise HttpError(422, 'Refresh this conversation and try again')
    notices = _unread(actor, bill).filter(message_id__in=ids)
    notice_ids = list(notices.values_list('id', flat=True))
    seen = notices.update(seen_at=timezone.now(), push_eligible=False, email_eligible=False)
    from .chat_notifications import cancel_seen_deliveries
    cancel_seen_deliveries(notice_ids)
    return {'seen': seen}


@transaction.atomic
def accept_policy(actor, version):
    if version != POLICY_VERSION:
        raise HttpError(409, 'Read the current chat policy before accepting')
    if not get_user_model().objects.select_for_update(no_key=True).filter(pk=actor.pk, is_active=True).exists():
        raise HttpError(401, 'Sign in again')
    BillChatAcceptance.objects.get_or_create(user=actor, version=version, defaults={'accepted_at': timezone.now()})
    return {'accepted': True, 'version': version}


@transaction.atomic
def block_user(actor, group_id, expense_id, user_id, active):
    get_user_model().objects.select_for_update(no_key=True).get(pk=actor.pk)
    group, bill = _bill(actor, group_id, expense_id, lock=True)
    if actor.pk == user_id or not group.participants.filter(user_id=user_id).exists():
        raise HttpError(404, 'Participant not found')
    if active and BillChatBlock.objects.filter(owner=actor, active=True).count() >= 100 and not BillChatBlock.objects.filter(owner=actor, blocked_id=user_id, active=True).exists():
        raise HttpError(422, 'Manage existing blocked chat users first')
    row, created = BillChatBlock.objects.get_or_create(owner=actor, blocked_id=user_id, defaults={'active': active, 'changed_at': timezone.now()})
    if not created and row.active != active:
        row.active, row.changed_at = active, timezone.now()
        row.save(update_fields=['active', 'changed_at'])
    if active:
        from .chat_notifications import cancel_chat_notices
        cancel_chat_notices(BillChatNotice.objects.filter(recipient=actor, message__sender_id=user_id), 'chat_blocked')
    return {'blocked': active}


@transaction.atomic
def report_message(actor, group_id, expense_id, message_id, kind, reason):
    get_user_model().objects.select_for_update(no_key=True).get(pk=actor.pk)
    group, bill = _bill(actor, group_id, expense_id, lock=True)
    message = _visible_messages(actor, bill).filter(pk=message_id).first()
    if not message or message.sender_id == actor.pk:
        raise HttpError(404, 'Message not found')
    existing = BillChatReport.objects.filter(reporter=actor, message=message, kind=kind).first()
    if existing:
        return {'id': str(existing.id), 'reported': True}
    if not reason.strip() or len(reason) > 500 or kind not in {'message', 'user'}:
        raise HttpError(422, 'Enter a report reason of up to 500 characters')
    if BillChatReport.objects.filter(reporter=actor, created_at__gt=timezone.now() - timedelta(hours=1)).count() >= 5:
        raise HttpError(429, 'Too many reports. Contact support if you need help.')
    row = BillChatReport.objects.create(reporter=actor, message=message, kind=kind, reason=reason, created_at=timezone.now())
    return {'id': str(row.id), 'reported': True}


@transaction.atomic
def hide_reported_message(report_id):
    """Existing authorized server operator only; no public moderation endpoint."""
    report = BillChatReport.objects.get(pk=report_id)
    if report.message_id:
        group_id = report.message.expense.group_id
        from .models import Group
        Group.objects.select_for_update().get(pk=group_id)
        BillChatMessage.objects.filter(pk=report.message_id).update(hidden_at=timezone.now())
        from .chat_notifications import cancel_chat_notices
        cancel_chat_notices(BillChatNotice.objects.filter(message_id=report.message_id), 'chat_hidden')
    BillChatReport.objects.filter(pk=report_id).update(reviewed_at=timezone.now(), resolution='hidden')
