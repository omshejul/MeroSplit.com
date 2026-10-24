"""Save feedback once; the existing worker makes one bounded Notify attempt."""
import json
from datetime import timedelta
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import transaction
from django.utils import timezone
from ninja.errors import HttpError

from .models import Feedback
from .store_review import review_ids


@transaction.atomic
def submit(actor, identifier, text):
    text = text.strip()
    if not text:
        raise HttpError(422, 'Write your feedback first.')
    if not get_user_model().objects.select_for_update(no_key=True).filter(pk=actor.pk, is_active=True).exists():
        raise HttpError(401, 'Sign in again to send feedback.')
    existing = Feedback.objects.filter(pk=identifier).first()
    if existing:
        if existing.user_id != actor.pk or existing.text != text:
            raise HttpError(409, 'This feedback submission has changed.')
        return {'id': str(existing.pk), 'saved': True}
    if Feedback.objects.filter(user=actor, created_at__gte=timezone.now() - timedelta(days=1)).count() >= 20:
        raise HttpError(429, 'You have sent a lot of feedback today. Try again tomorrow.')
    row, _ = Feedback.objects.get_or_create(id=identifier, defaults={'user': actor, 'text': text,
                            'notify_state': 'held' if actor.pk in review_ids() else 'pending'})
    if row.user_id != actor.pk or row.text != text:
        raise HttpError(409, 'This feedback submission has changed.')
    return {'id': str(identifier), 'saved': True}


def notify(row):
    # User text is plain Slack text, never executable mrkdwn or a channel mention.
    payload = {'text': 'New MeroSplit feedback', 'blocks': [
        {'type': 'section', 'text': {'type': 'plain_text', 'text': f'MeroSplit feedback · {row.id}', 'emoji': False}},
        {'type': 'section', 'text': {'type': 'plain_text', 'text': row.text, 'emoji': False}},
        {'type': 'section', 'text': {'type': 'mrkdwn', 'text': '<https://merosplit.com/app/|Open MeroSplit>'}},
    ]}
    url = 'https://nodered.omshejul.com/api/om?' + urlencode({'msg': json.dumps(payload)})
    with urlopen(Request(url, headers={'User-Agent': 'MeroSplit-feedback/1.0'}), timeout=10) as response:
        body = response.read(16385)
        if not 200 <= response.status < 300 or len(body) > 16384:
            raise ValueError('Notify rejected')
    try:
        result = json.loads(body)
    except ValueError:
        result = body.decode().strip()
    if not (result == 'message sent' or isinstance(result, dict) and
            (result.get('ok') is True or result == {'message': 'message sent'})):
        raise ValueError('Notify acceptance not confirmed')


def send_feedback_notifications(*, limit=100):
    if not settings.FEEDBACK_NOTIFY_ENABLED:
        return 0
    # An abandoned/uncertain send is held, never automatically sent twice.
    Feedback.objects.filter(notify_state='sending', attempted_at__lt=timezone.now() - timedelta(minutes=2)).update(notify_state='held')
    processed = 0
    for _ in range(limit):
        with transaction.atomic():
            row = Feedback.objects.select_for_update(skip_locked=True).filter(notify_state='pending').order_by('created_at', 'id').first()
            if row is None:
                break
            row.notify_state = 'held' if row.user_id in review_ids() else 'sending'
            row.attempted_at = timezone.now()
            row.save(update_fields=['notify_state', 'attempted_at'])
        if row.notify_state == 'held':
            continue
        try:
            notify(row)
            state = 'accepted'  # Node-RED acceptance, not proof of Slack delivery.
        except Exception:
            state = 'held'  # Do not log a URL containing private feedback.
        Feedback.objects.filter(pk=row.pk, notify_state='sending').update(notify_state=state)
        processed += 1
    return processed
