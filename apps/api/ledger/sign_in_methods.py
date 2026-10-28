"""Account-owned provider links and the verified-email linking preference."""
from allauth.account.models import EmailAddress
from allauth.socialaccount.models import SocialAccount
from django.contrib.auth import get_user_model
from django.db import transaction
from ninja.errors import HttpError

from .models import SignInPreference


def auto_link_enabled(user_id):
    value = SignInPreference.objects.filter(user_id=user_id).values_list("auto_link", flat=True).first()
    return value is not False


def sign_in_methods(actor):
    accounts = list(SocialAccount.objects.filter(user=actor, provider__in=["google", "apple"]).order_by("provider", "pk"))
    email_verified = EmailAddress.objects.filter(user=actor, email__iexact=actor.email, verified=True).exists()
    return {"auto_link": auto_link_enabled(actor.pk), "accounts": [
        {"id": str(account.pk), "provider": account.provider, "uid": account.uid,
         "email": str(account.extra_data.get("email") or ""),
         "can_disconnect": email_verified or len(accounts) > 1}
        for account in accounts
    ]}


def update_auto_link(actor, enabled):
    SignInPreference.objects.update_or_create(user=actor, defaults={"auto_link": enabled})
    return sign_in_methods(actor)


def disconnect_provider(actor, account_id):
    with transaction.atomic():
        get_user_model().objects.select_for_update().get(pk=actor.pk)
        account = SocialAccount.objects.filter(pk=account_id, user=actor, provider__in=["google", "apple"]).first()
        if account is None:
            raise HttpError(404, "Connected account not found.")
        # This app uses passwordless email sign-in, so allauth's password-based
        # last-account check cannot determine whether email is a safe fallback.
        email_verified = EmailAddress.objects.filter(user=actor, email__iexact=actor.email, verified=True).exists()
        if not email_verified and not SocialAccount.objects.filter(user=actor).exclude(pk=account.pk).exists():
            raise HttpError(409, "Verify your email before disconnecting your last sign-in method.")
        result = {}
        if account.provider == "apple":
            from .apple_signin import revoke_apple_accounts_after_commit
            revoke_apple_accounts_after_commit([account.pk], result)
        account.delete()
    return {**sign_in_methods(actor), **result}
