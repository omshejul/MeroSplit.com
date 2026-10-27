"""Native Apple proof, existing allauth ownership, encrypted revocation credential."""
import json
import secrets
import time

import jwt
import requests
from allauth.account.models import EmailAddress
from allauth.core.exceptions import ImmediateHttpResponse, SignupClosedException
from allauth.headless.base.response import AuthenticationResponse
from allauth.headless.base.views import APIView
from allauth.headless.internal.restkit.response import APIResponse
from allauth.headless.socialaccount.internal import complete_token_login
from allauth.socialaccount.adapter import get_adapter
from allauth.socialaccount.models import SocialAccount, SocialToken
from allauth.socialaccount.providers.oauth2.client import OAuth2Error
from cryptography.fernet import Fernet, InvalidToken
from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.views.decorators.debug import sensitive_variables

from .google_signin import TTL, consume_challenge, valid_process
from .otp import EmailCodeLimited, client_network, consume_limits, normalized_email
from .store_review import entry_for_email

CHALLENGE = "merosplit_apple_signin"


def apple_error(request, code="apple_unavailable", status=400):
    message = "Could not sign in with Apple. Try again or use email."
    if code == "apple_email_conflict":
        message = "Sign in with your email first, then connect Apple in Me."
    elif code == "apple_account_changed":
        message = "Your signed-in account changed. Try again. Saved changes are safe."
    return APIResponse(request, status=status, errors=[{"code": code, "message": message}])


@sensitive_variables()
def token_cipher():
    return Fernet(settings.APPLE_SIGN_IN_TOKEN_ENCRYPTION_KEY.encode())


def configured():
    return settings.APPLE_SIGN_IN_ENABLED and all((settings.APPLE_SIGN_IN_CLIENT_ID,
        settings.APPLE_SIGN_IN_TEAM_ID, settings.APPLE_SIGN_IN_KEY_ID,
        settings.APPLE_SIGN_IN_PRIVATE_KEY, settings.APPLE_SIGN_IN_TOKEN_ENCRYPTION_KEY))


@sensitive_variables()
def client_secret():
    now = int(time.time())
    return jwt.encode({"iss": settings.APPLE_SIGN_IN_TEAM_ID, "sub": settings.APPLE_SIGN_IN_CLIENT_ID,
        "aud": "https://appleid.apple.com", "iat": now, "exp": now + 300},
        settings.APPLE_SIGN_IN_PRIVATE_KEY, algorithm="ES256", headers={"kid": settings.APPLE_SIGN_IN_KEY_ID})


@sensitive_variables()
def apple_request(action, fields):
    # Fixed Apple endpoint, no redirect/retry and a bounded private response.
    with requests.post(f"https://appleid.apple.com/auth/{action}", data={
        "client_id": settings.APPLE_SIGN_IN_CLIENT_ID, "client_secret": client_secret(), **fields,
    }, timeout=(3, 5), allow_redirects=False, stream=True) as response:
        body = bytearray()
        for chunk in response.iter_content(4096):
            body.extend(chunk)
            if len(body) > 32768:
                raise ValidationError("Invalid Apple response")
        if response.status_code != 200:
            raise ValidationError("Apple request not confirmed")
        return json.loads(body) if action == "token" else None


def validate_identity(claims):
    if (not isinstance(claims.get("sub"), str) or not 1 <= len(claims["sub"]) <= 255
            or claims.get("aud") != settings.APPLE_SIGN_IN_CLIENT_ID
            or claims.get("iss") != "https://appleid.apple.com"
            or type(claims.get("exp")) is not int or claims["exp"] <= time.time()):
        raise ValidationError("Invalid Apple identity")


class AppleChallengeView(APIView):
    @sensitive_variables()
    def post(self, request, *args, **kwargs):
        data = self.data or {}
        if not configured():
            return apple_error(request, status=503)
        if not isinstance(data, dict) or set(data) != {"process"} or not valid_process(request, data["process"]):
            return apple_error(request, "apple_account_changed", 409)
        if request.user.is_authenticated and entry_for_email(request.user.email):
            return apple_error(request)
        try:
            token_cipher()  # Fail before offering a flow whose refresh token cannot be retained safely.
            with transaction.atomic():
                consume_limits([("apple-challenge-network", client_network(request), 60, 10),
                                ("apple-challenge-network", client_network(request), 3600, 100)])
        except EmailCodeLimited:
            return apple_error(request, status=429)
        except (ValueError, TypeError):
            return apple_error(request, status=503)
        nonce, state = secrets.token_hex(32), secrets.token_hex(32)
        request.session[CHALLENGE] = {"nonce": nonce, "state": state, "expires_at": int(time.time()) + TTL,
            "process": data["process"], "actor": request.user.pk if request.user.is_authenticated else None}
        request.session.save()
        return APIResponse(request, data={"nonce": nonce, "state": state, "expires_in": TTL,
                                          "client_id": settings.APPLE_SIGN_IN_CLIENT_ID})


class AppleTokenView(APIView):
    @sensitive_variables()
    def post(self, request, *args, **kwargs):
        data = self.data or {}
        if not configured():
            return apple_error(request, status=503)
        required = {"process", "id_token", "authorization_code", "state"}
        if (not isinstance(data, dict) or not required <= set(data) or set(data) - required - {"given_name", "family_name"}
                or not valid_process(request, data.get("process"))):
            return apple_error(request, "apple_account_changed", 409)
        try:
            if any(not isinstance(data[k], str) or not 1 <= len(data[k]) <= 16384
                   for k in ("id_token", "authorization_code", "state")):
                raise ValidationError("Invalid Apple proof")
            if any(not isinstance(data[k], str) or len(data[k]) > 150 for k in ("given_name", "family_name") if k in data):
                raise ValidationError("Invalid Apple name")
            with transaction.atomic():
                consume_limits([("apple-token-session", request.session.session_key, 60, 5),
                                ("apple-token-network", client_network(request), 60, 30)])
            if jwt.get_unverified_header(data["id_token"]).get("alg") != "RS256":
                raise ValidationError("Invalid Apple algorithm")
            provider = get_adapter().get_provider(request, "apple", client_id=settings.APPLE_SIGN_IN_CLIENT_ID)
            sociallogin = provider.verify_token(request, {"id_token": data["id_token"]})
            claims = sociallogin.account.extra_data
            validate_identity(claims)
            email = normalized_email(claims["email"]) if claims.get("email") else ""
            if email and ((claims.get("email_verified") is not True and claims.get("email_verified") != "true") or entry_for_email(email)):
                raise ValidationError("Invalid Apple email")
            request.apple_email_authoritative = bool(email)
            consume_challenge(request, claims, data["process"], "apple", data["state"])
            sociallogin.state["process"] = data["process"]
            # Name is initial-only display data, never identity or account-linking proof.
            sociallogin.user.first_name = data.get("given_name", "").strip()
            sociallogin.user.last_name = data.get("family_name", "").strip()
            sociallogin.account.extra_data = {k: claims[k] for k in ("sub", "email", "email_verified", "is_private_email") if k in claims}
            existing = SocialAccount.objects.filter(provider="apple", uid=claims["sub"]).select_related("user").first()
            if existing and (not existing.user.is_active or entry_for_email(existing.user.email)):
                raise ValidationError("Invalid Apple account")
            if data["process"] == "connect" and existing and existing.user_id != request.user.pk:
                return apple_error(request, "apple_email_conflict", 409)
            if data["process"] == "login" and not existing and (not email
                    or ((get_user_model().objects.filter(email__iexact=email).exists()
                         or EmailAddress.objects.filter(email__iexact=email).exists())
                        and EmailAddress.objects.filter(email__iexact=email, verified=True, user__is_active=True).count() != 1)):
                return apple_error(request, "apple_email_conflict", 409)
            exchanged = apple_request("token", {"grant_type": "authorization_code", "code": data["authorization_code"]})
            if not isinstance(exchanged, dict) or not isinstance(exchanged.get("refresh_token"), str) or not 1 <= len(exchanged["refresh_token"]) <= 16384:
                raise ValidationError("Missing Apple revocation credential")
            if jwt.get_unverified_header(exchanged.get("id_token")).get("alg") != "RS256":
                raise ValidationError("Invalid Apple exchange algorithm")
            verified = provider.verify_token(request, {"id_token": exchanged.get("id_token")}).account.extra_data
            validate_identity(verified)
            if verified["sub"] != claims["sub"] or ("nonce" in verified and verified["nonce"] != claims["nonce"]):
                raise ValidationError("Apple exchange mismatch")
            encrypted = token_cipher().encrypt(exchanged["refresh_token"].encode()).decode()
            with transaction.atomic():
                response = complete_token_login(request, sociallogin)
                # Persist only for the identity that allauth actually adopted/connected.
                account = SocialAccount.objects.select_for_update().get(provider="apple", uid=claims["sub"], user=request.user)
                SocialToken.objects.update_or_create(account=account, app=None, defaults={"token": "", "token_secret": encrypted})
            return AuthenticationResponse.from_response(request, response)
        except ImmediateHttpResponse as exc:
            return exc.response
        except EmailCodeLimited:
            return apple_error(request, status=429)
        except requests.RequestException:
            return apple_error(request, status=503)
        except IntegrityError:
            return apple_error(request, "apple_email_conflict", 409)
        except (ValidationError, OAuth2Error, jwt.PyJWTError, SignupClosedException, SocialAccount.DoesNotExist,
                KeyError, TypeError, ValueError, InvalidToken):
            return apple_error(request)


@sensitive_variables()
def after_account_deletion(actor, result):
    """Capture encrypted credentials before cascade; revoke only AFTER deletion commits."""
    accounts = list(SocialAccount.objects.filter(user=actor, provider="apple").values_list("pk", flat=True))
    if not accounts:
        return
    encrypted = list(SocialToken.objects.filter(account_id__in=accounts).values_list("token_secret", flat=True))
    result["apple_revocation"] = "manual_required"

    @sensitive_variables()
    def revoke():
        try:
            if not configured() or len(encrypted) != len(accounts):
                return
            for value in encrypted:
                token = token_cipher().decrypt(value.encode()).decode()
                if not token:
                    return
                apple_request("revoke", {"token": token, "token_type_hint": "refresh_token"})
            result["apple_revocation"] = "revoked"
        except (requests.RequestException, ValidationError, ValueError, TypeError, InvalidToken, jwt.PyJWTError):
            # Local account deletion still completes. Client offers Apple's manual removal path.
            pass

    transaction.on_commit(revoke)
