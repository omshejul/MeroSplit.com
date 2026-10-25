"""Google proves identity; allauth retains ownership of accounts and sessions."""
import secrets
import time
from datetime import datetime, timezone

import jwt
import requests
from allauth.account.models import EmailAddress
from allauth.core.exceptions import ImmediateHttpResponse, SignupClosedException
from allauth.headless.base.response import AuthenticationResponse
from allauth.headless.base.views import APIView
from allauth.headless.internal.restkit.response import APIResponse
from allauth.headless.socialaccount.internal import complete_token_login
from allauth.socialaccount.adapter import DefaultSocialAccountAdapter, get_adapter
from allauth.socialaccount.providers.oauth2.client import OAuth2Error
from django.conf import settings
from django.contrib.auth import get_user_model
from django.contrib.sessions.models import Session
from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.utils.crypto import salted_hmac
from django.views.decorators.debug import sensitive_variables

from .models import EmailRateBucket
from .otp import EmailCodeLimited, client_network, consume_limits, normalized_email
from .store_review import entry_for_email

CHALLENGE = "merosplit_google_signin"
TTL = 180


def error(request, code="google_unavailable", status=400):
    message = "Could not sign in with Google. Try again or use email."
    if code == "google_email_conflict":
        message = "Sign in with your email first, then connect Google in Me."
    elif code == "google_account_changed":
        message = "Your signed-in account changed. Try again. Saved changes are safe."
    return APIResponse(request, status=status, errors=[{"code": code, "message": message}])


def valid_process(request, process):
    return isinstance(process, str) and process in {"login", "connect"} and request.user.is_authenticated == (process == "connect")


class GoogleAccountAdapter(DefaultSocialAccountAdapter):
    def pre_social_login(self, request, sociallogin):
        from .apple_signin import apple_error

        provider = sociallogin.account.provider
        if provider not in {"google", "apple"} or not getattr(request, f"{provider}_proof_consumed", False):
            raise ImmediateHttpResponse(error(request) if provider == "google" else apple_error(request))
        if sociallogin.state["process"] == "login" and not sociallogin.is_existing:
            email = sociallogin.user.email
            if (not getattr(request, f"{provider}_email_authoritative", False) or get_user_model().objects.filter(email__iexact=email).exists()
                    or EmailAddress.objects.filter(email__iexact=email).exists()):
                raise ImmediateHttpResponse(error(request, "google_email_conflict", 409) if provider == "google" else apple_error(request, "apple_email_conflict", 409))
        if sociallogin.is_existing and (not sociallogin.user.is_active or entry_for_email(sociallogin.user.email)):
            raise ImmediateHttpResponse(error(request) if provider == "google" else apple_error(request))

    def is_open_for_signup(self, request, sociallogin):
        return sociallogin.account.provider in {"google", "apple"} and bool(getattr(request, f"{sociallogin.account.provider}_proof_consumed", False))


class GoogleChallengeView(APIView):
    @sensitive_variables()
    def post(self, request, *args, **kwargs):
        data = self.data or {}
        if not settings.GOOGLE_SIGN_IN_ENABLED:
            return error(request, status=503)
        if not isinstance(data, dict) or set(data) != {"process"} or not valid_process(request, data["process"]):
            return error(request, "google_account_changed", 409)
        if request.user.is_authenticated and entry_for_email(request.user.email):
            return error(request)
        try:
            with transaction.atomic():
                consume_limits([("google-challenge-network", client_network(request), 60, 10),
                                ("google-challenge-network", client_network(request), 3600, 100)])
        except EmailCodeLimited:
            return error(request, status=429)
        nonce = secrets.token_hex(32)
        request.session[CHALLENGE] = {"nonce": nonce, "expires_at": int(time.time()) + TTL,
                                      "process": data["process"], "actor": request.user.pk if request.user.is_authenticated else None}
        request.session.save()
        return APIResponse(request, data={"nonce": nonce, "expires_in": TTL, "client_id": settings.GOOGLE_OAUTH_WEB_CLIENT_ID})


@sensitive_variables()
def consume_challenge(request, claims, process, provider="google", state=None):
    challenge_key = f"merosplit_{provider}_signin"
    with transaction.atomic():
        row = Session.objects.select_for_update().filter(session_key=request.session.session_key).first()
        stored = row.get_decoded() if row else {}
        challenge = stored.get(challenge_key, {})
        actor = request.user.pk if request.user.is_authenticated else None
        if (not challenge or challenge.get("process") != process or challenge.get("actor") != actor
                or challenge.get("expires_at", 0) <= time.time()
                or (provider == "apple" and (not isinstance(state, str) or not secrets.compare_digest(challenge.get("state", ""), state)))
                or not isinstance(claims.get("nonce"), str)
                or not secrets.compare_digest(challenge.get("nonce", ""), claims["nonce"])):
            raise ValidationError("Google sign-in expired")
        # A concurrent request could later save its stale session copy. Keep a
        # one-use fence in the existing rate table until this proof expires.
        key = salted_hmac(f"merosplit.{provider}-proof", claims["nonce"], algorithm="sha256").hexdigest()
        EmailRateBucket.objects.get_or_create(key=key, defaults={"expires_at": datetime.fromtimestamp(challenge["expires_at"], timezone.utc)})
        used = EmailRateBucket.objects.select_for_update().get(key=key)
        if used.count:
            raise ValidationError("Google sign-in already used")
        used.count = 1
        used.save(update_fields=["count"])
        stored.pop(challenge_key)
        row.session_data = request.session.encode(stored)
        row.save(update_fields=["session_data"])
    # Remove the successful proof from the request copy too. A rejected stale
    # token must not erase a newer challenge from the same browser/session.
    request.session.pop(challenge_key, None)
    setattr(request, f"{provider}_proof_consumed", True)


@sensitive_variables()
def prepare_google_identity(request, sociallogin, process):
    claims = sociallogin.account.extra_data
    email = normalized_email(claims.get("email"))
    if (not isinstance(claims.get("sub"), str) or not 1 <= len(claims["sub"]) <= 255
            or claims.get("aud") != settings.GOOGLE_OAUTH_WEB_CLIENT_ID
            or claims.get("iss") not in {"accounts.google.com", "https://accounts.google.com"}
            or type(claims.get("exp")) is not int or claims["exp"] <= time.time()
            or claims.get("email_verified") is not True or entry_for_email(email)):
        raise ValidationError("Invalid Google identity")
    browser_nonce = getattr(request, "google_browser_nonce", None)
    if browser_nonce is None:
        consume_challenge(request, claims, process)
    elif (not getattr(request, "google_proof_consumed", False) or not isinstance(claims.get("nonce"), str)
          or not secrets.compare_digest(browser_nonce, claims["nonce"])):
        raise ValidationError("Google sign-in expired")
    # A non-Google-hosted address may have changed owners since Google
    # verified it. Require email login + explicit connect for new links.
    request.google_email_authoritative = email.endswith("@gmail.com") or bool(isinstance(claims.get("hd"), str) and claims["hd"])
    if not request.google_email_authoritative:
        sociallogin.email_addresses = []
    sociallogin.state["process"] = process
    # Store basic profile claims only, never credentials or nonce/proof material.
    sociallogin.account.extra_data = {k: claims[k] for k in ["sub", "email", "email_verified", "given_name", "family_name"] if k in claims}
    sociallogin.user.email = email
    sociallogin.user.first_name = str(sociallogin.user.first_name or "").strip()[:150]
    sociallogin.user.last_name = str(sociallogin.user.last_name or "").strip()[:150]


class GoogleTokenView(APIView):
    @sensitive_variables()
    def post(self, request, *args, **kwargs):
        data = self.data or {}
        if not settings.GOOGLE_SIGN_IN_ENABLED:
            return error(request, status=503)
        if not isinstance(data, dict) or set(data) != {"process", "id_token"} or not valid_process(request, data.get("process")):
            return error(request, "google_account_changed", 409)
        credential = data["id_token"]
        try:
            if not isinstance(credential, str) or not 1 <= len(credential) <= 16384:
                raise ValidationError("Invalid Google credential")
            challenge = request.session.get(CHALLENGE, {})
            if challenge.get("expires_at", 0) <= time.time() or challenge.get("process") != data["process"]:
                raise ValidationError("Google sign-in expired")
            with transaction.atomic():
                consume_limits([("google-token-session", request.session.session_key, 60, 5),
                                ("google-token-network", client_network(request), 60, 30)])
            if jwt.get_unverified_header(credential).get("alg") != "RS256":
                raise ValidationError("Invalid signing algorithm")
            provider = get_adapter().get_provider(request, "google", client_id=settings.GOOGLE_OAUTH_WEB_CLIENT_ID)
            sociallogin = provider.verify_token(request, {"id_token": credential})
            prepare_google_identity(request, sociallogin, data["process"])
            with transaction.atomic():
                response = complete_token_login(request, sociallogin)
            return AuthenticationResponse.from_response(request, response)
        except ImmediateHttpResponse as exc:
            return exc.response
        except (ValidationError, OAuth2Error, jwt.PyJWTError, SignupClosedException, KeyError, TypeError, ValueError):
            return error(request)
        except EmailCodeLimited:
            return error(request, status=429)
        except requests.RequestException:
            return error(request, status=503)
        except IntegrityError:
            return error(request, "google_email_conflict", 409)
