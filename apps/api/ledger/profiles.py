"""Account display names, preserving recorded participant labels and login identity."""

from django.contrib.auth import get_user_model
from django.db import transaction
from ninja.errors import HttpError

from .accounting import AccountingError
from .models import Change, Group
from .store_review import require_group_scope


def display_name(user):
    return user.first_name.strip()


def participant_display_name(person):
    if person.user_id and not person.removed:
        return display_name(person.user) or person.name
    return person.name


@transaction.atomic
def update_display_name(actor, value):
    name = value.strip()
    if not name or len(name) > 120:
        raise AccountingError("Enter a display name of up to 120 characters")
    user = get_user_model().objects.select_for_update(no_key=True).filter(pk=actor.pk, is_active=True).first()
    if not user:
        raise HttpError(401, "Sign in again to update your profile")
    if user.first_name == name:
        return {"display_name": name}
    groups = list(Group.objects.filter(participants__user=user, participants__removed=False)
                  .order_by("id").select_for_update(of=("self",)))
    user.first_name = name
    user.save(update_fields=["first_name"])
    for group in groups:
        if not group.participants.filter(user=user, removed=False).exists():
            continue
        require_group_scope(user, group)
        group.version += 1
        group.save(update_fields=["version"])
        Change.objects.create(group=group, sequence=group.version, actor=user,
                              kind="display_name_changed", data={"user_id": user.pk})
    return {"display_name": name}
