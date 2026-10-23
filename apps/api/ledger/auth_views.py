from uuid import UUID

from allauth.account import app_settings as account_settings
from allauth.account.internal.flows.login import perform_login, record_authentication
from allauth.account.models import Login
from allauth.headless.base.response import AuthenticationResponse, ConflictResponse
from allauth.headless.base.views import APIView
from allauth.headless.internal.restkit.response import APIResponse
from django.core.exceptions import ValidationError

from .email_delivery import EmailDeliveryUnavailable
from .otp import (
    EmailCodeInvalid,
    EmailCodeLimited,
    client_network,
    confirm_email_code,
    normalized_email,
    request_email_code,
)


def auth_error(request, status=400):
    detail = "The code is invalid or has expired. Request a new code and try again."
    if status == 429:
        detail = "Too many requests. Wait a little before trying again."
    elif status == 503:
        detail = "Email sign-in is temporarily unavailable. Please try again."
    return APIResponse(request, status=status, errors=[{"code": "email_code_unavailable", "message": detail}])


class RequestEmailCodeView(APIView):
    def post(self, request, *args, **kwargs):
        if request.user.is_authenticated:
            return ConflictResponse(request)
        try:
            data = request_email_code(normalized_email((self.data or {}).get("email")), client_network(request))
        except ValidationError:
            return auth_error(request)
        except EmailCodeLimited:
            return auth_error(request, 429)
        except EmailDeliveryUnavailable:
            return auth_error(request, 503)
        return APIResponse(request, data=data, meta={"is_authenticated": False})


class ConfirmEmailCodeView(APIView):
    def post(self, request, *args, **kwargs):
        if request.user.is_authenticated:
            return ConflictResponse(request)
        try:
            data = self.data or {}
            challenge_id = UUID(str(data.get("challenge_id", "")))
            user, email, method = confirm_email_code(challenge_id, data.get("code"), client_network(request))
        except (ValueError, EmailCodeInvalid):
            return auth_error(request)
        except EmailCodeLimited:
            return auth_error(request, 429)
        record_authentication(request, user, method=method, email=email)
        response = perform_login(request, Login(
            user=user, email=email,
            email_verification=account_settings.EmailVerificationMethod.NONE if method == "demo_credential" else None,
        ))
        return AuthenticationResponse.from_response(request, response)
