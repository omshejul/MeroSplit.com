"""Independent channels; legacy account mutes are retired only on an explicit edit."""
from django.db import transaction
from ninja.errors import HttpError

from . import balance_statements
from .expense_notifications import _locked_preference, notification_settings, update_preferences
from .models import NotificationChannelCursor, PushDevice


def preferences(actor):
    settings = notification_settings(actor)
    statement = balance_statements.preferences(actor)
    return {
        'email_notifications': settings['expense_updates'] and settings['email_reminders'],
        'email_available': settings['email_available'],
        'legacy_muted': not settings['expense_updates'],
        'muted_push_devices': [{'id': str(row.client_id), 'revision': row.revision} for row in NotificationChannelCursor.objects.filter(user=actor, push_disabled=True)],
        'statement_enabled': bool(settings['expense_updates'] and settings['email_reminders'] and statement['enabled']),
        'statement_frequency': statement['frequency'],
    }


def accept_revision(actor, client_id, revision, allow_same=False, push_enabled=None):
    # Caller holds the account lock. Keep tombstones after device removal so an
    # old timed-out registration cannot undo a newer OFF request.
    cursor, _ = NotificationChannelCursor.objects.get_or_create(user=actor, client_id=client_id)
    if revision < cursor.revision or revision == cursor.revision and (not allow_same or push_enabled is True and cursor.push_disabled):
        return False
    if revision > cursor.revision:
        cursor.revision = revision
    if push_enabled is not None:
        cursor.push_disabled = not push_enabled
    cursor.save(update_fields=['revision', 'push_disabled'])
    return True


@transaction.atomic
def update(actor, *, client_id, revision, email_notifications=None, statement_frequency=None, activate_push=False):
    if email_notifications is None and statement_frequency is None and not activate_push:
        raise HttpError(422, 'Choose a notification setting to change')
    row = _locked_preference(actor)
    if not accept_revision(actor, client_id, revision):
        return {**preferences(actor), 'revision': NotificationChannelCursor.objects.get(user=actor, client_id=client_id).revision}
    if not row.expense_updates:
        # A legacy master OFF meant every channel was paused. Retire its saved
        # bindings before lifting that gate, so enabling Email never enables Push.
        for device in PushDevice.objects.select_for_update().filter(user=actor).order_by('id'):
            cursor, _ = NotificationChannelCursor.objects.get_or_create(user=actor, client_id=device.pk)
            cursor.push_disabled = True
            cursor.save(update_fields=['push_disabled'])
            device.delete()
    email = row.expense_updates and row.email_reminders if email_notifications is None else email_notifications
    if email and not notification_settings(actor)['email_available']:
        raise HttpError(422, 'Add a verified email address to receive emails')
    update_preferences(actor, True, email)
    if email_notifications is not None or statement_frequency is not None:
        balance_statements.update_preferences(actor, email, statement_frequency or row.statement_frequency)
    return {**preferences(actor), 'revision': revision}
