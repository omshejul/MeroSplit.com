"""Verified existing-account links made by an organizer's explicit add action."""

from functools import reduce
from operator import or_

from allauth.account.models import EmailAddress
from django.contrib.auth import get_user_model
from django.db.models import Q
from ninja.errors import HttpError

from .models import CommandReceipt
from .otp import EmailCodeLimited, consume_limits
from .store_review import entry_for_email, review_ids


def lock_link_users(actor, emails):
    """Call inside atomic, before any group lock. Never create/verify an identity."""
    emails = sorted(set(filter(None, emails)))
    query = reduce(or_, (Q(email__iexact=email) for email in emails), Q(pk__in=[]))
    User = get_user_model()
    ids = {actor.pk, *User.objects.filter(query).values_list('pk', flat=True),
           *EmailAddress.objects.filter(query).values_list('user_id', flat=True)}
    users = {user.pk: user for user in User.objects.select_for_update(no_key=True).filter(pk__in=ids).order_by('pk')}
    if actor.pk not in users or not users[actor.pk].is_active:
        raise HttpError(401, 'Sign in again')
    # Auth also takes User before EmailAddress. Recheck after waiting, so deletion,
    # verification and changed canonical addresses cannot leave a stale match.
    addresses = list(EmailAddress.objects.select_for_update().filter(query).order_by('pk'))
    current = list(User.objects.filter(query))
    if any(user.pk not in ids for user in current) or any(address.user_id not in ids for address in addresses):
        raise HttpError(409, 'Account details changed; try adding this person again')
    matches = {}
    reviews = review_ids()
    for email in emails:
        if entry_for_email(email):
            raise HttpError(409, 'This email cannot be linked to this ledger')
        matching = {user.pk for user in current if user.email.lower() == email}
        matching.update(address.user_id for address in addresses if address.email.lower() == email)
        if len(matching) != 1:
            if len(matching) > 1:
                raise HttpError(409, 'This email cannot be linked; check the account details')
            continue
        user = users.get(next(iter(matching)))
        if not user or not user.is_active or user.email.strip().lower() != email:
            continue
        if not any(address.user_id == user.pk and address.email.lower() == email and address.verified for address in addresses):
            continue
        if user.pk in reviews or actor.pk in reviews:
            raise HttpError(409, 'This email cannot be linked to this ledger')
        matches[email] = user
    return matches


def limit_links(actor, users):
    users = {user.pk for user in users}
    if not users:
        return
    try:
        for user in sorted(users):
            consume_limits([('member-add-sender', str(actor.pk), 3600, 40),
                            ('member-add-sender', str(actor.pk), 86400, 100),
                            ('member-add-recipient', str(user), 86400, 30)])
    except EmailCodeLimited:
        raise HttpError(429, 'Too many additions; try again later') from None


def linked_result(result, actor, command_id, people):
    """Persist the original outcome; replay must never perform a later auto-link."""
    linked = [person for person in people if person.user_id and person.user_id != actor.pk]
    result = {**result, 'linked_participant_ids': [str(person.id) for person in linked]}
    CommandReceipt.objects.filter(actor=actor, command_id=command_id).update(result=result)
    if linked:
        from .membership_notifications import queue_membership
        change = linked[0].group.changes.get(sequence=result['version'])
        queue_membership(change, linked)
    return result
