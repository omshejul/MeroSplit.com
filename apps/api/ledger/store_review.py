"""Optional exact store-demo identities; no permission to cross into real ledgers."""

from allauth.account.models import EmailAddress
from django.conf import settings
from django.contrib.auth import get_user_model
from ninja.errors import HttpError

from .models import Group, Participant


def entry_for_email(email):
    return next((entry for entry in settings.STORE_REVIEW_AUTH if entry["email"] == email), None)


def review_ids():
    # Blank hashes disable credential login while preserving these reservations.
    return {entry["user_id"] for entry in settings.STORE_REVIEW_AUTH}


def valid_identity(user, entry):
    return bool(user and user.pk == entry["user_id"] and user.email.lower() == entry["email"]
                and user.is_active and not user.is_staff and not user.is_superuser)


def credential_user(entry):
    user = get_user_model().objects.select_for_update().filter(pk=entry["user_id"]).first()
    if not valid_identity(user, entry):
        return None
    if get_user_model().objects.filter(email__iexact=entry["email"]).exclude(pk=user.pk).exists():
        return None
    if EmailAddress.objects.filter(email__iexact=entry["email"]).exclude(user=user).exists():
        return None
    return user


def groups_for_actor(query, actor):
    ids = review_ids()
    if not ids:
        return query
    if actor.pk in ids:
        entry = next(entry for entry in settings.STORE_REVIEW_AUTH if entry["user_id"] == actor.pk)
        if not valid_identity(actor, entry):
            return query.none()
        real_members = Participant.objects.filter(user__isnull=False).exclude(user_id__in=ids)
        return query.filter(owner_id__in=ids).exclude(id__in=real_members.values("group_id"))
    review_members = Participant.objects.filter(user_id__in=ids)
    return query.exclude(owner_id__in=ids).exclude(id__in=review_members.values("group_id"))


def require_group_scope(actor, group):
    if settings.STORE_REVIEW_AUTH and not groups_for_actor(Group.objects.filter(pk=group.pk), actor).exists():
        raise HttpError(404, "Group not found")


def require_no_review_email(actor):
    if actor.pk in review_ids():
        raise HttpError(403, "Store demo accounts cannot send invitation emails")
