import json
from uuid import UUID

from allauth.account import app_settings as account_settings
from allauth.account.internal.flows.login import perform_login, record_authentication
from allauth.account.models import Login
from allauth.headless.base.response import AuthenticationResponse, ConflictResponse
from allauth.headless.base.views import APIView
from allauth.headless.internal.restkit.response import APIResponse
from django.contrib.auth import logout
from django.core.exceptions import ValidationError
from django.views.decorators.debug import sensitive_variables

from .email_delivery import EmailDeliveryUnavailable
from .email_links import exchange_email_link, renew_email_link, resume_email_link
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
            disclosed = data.get("email_reminders_disclosed", False)
            if type(disclosed) is not bool:
                raise ValueError()
            challenge_id = UUID(str(data.get("challenge_id", "")))
            user, email, method = confirm_email_code(challenge_id, data.get("code"), client_network(request), email_reminders_disclosed=disclosed)
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


def link_error(request, status=400):
    message = "This sign-in link is unavailable. Send a new link to continue."
    if status == 429:
        message = "Too many requests. Wait a little before trying again."
    elif status == 503:
        message = "Email sign-in is temporarily unavailable. Please try again."
    return APIResponse(request, status=status, errors=[{"code": "email_link_unavailable", "message": message}])


def link_response(request, target, user):
    # Preserve allauth's session-token exposure, headers and authentication shape.
    response = AuthenticationResponse(request)
    body = json.loads(response.content)
    body["data"].update(target=target, needs_name=not bool(user.first_name.strip()))
    response.content = json.dumps(body)
    return response


class RequestEmailLinkView(APIView):
    @sensitive_variables()
    def post(self, request, *args, **kwargs):
        if request.user.is_authenticated:
            return ConflictResponse(request)
        try:
            data = self.data or {}
            if not isinstance(data, dict):
                raise ValueError()
            disclosed = data.get("email_reminders_disclosed", False)
            if type(disclosed) is not bool or set(data) - {"email", "email_reminders_disclosed"}:
                raise ValueError()
            request_email_code(normalized_email(data.get("email")), client_network(request), email_reminders_disclosed=disclosed)
        except (ValidationError, ValueError):
            return link_error(request)
        except EmailCodeLimited:
            return link_error(request, 429)
        except EmailDeliveryUnavailable:
            return link_error(request, 503)
        from .store_review import entry_for_email
        return APIResponse(request, data={"retry_after": 60, "accepted": not bool(entry_for_email(normalized_email(data.get("email"))))}, meta={"is_authenticated": False})


class ExchangeEmailLinkView(APIView):
    @sensitive_variables()
    def post(self, request, *args, **kwargs):
        try:
            data = self.data or {}
            if not isinstance(data, dict):
                raise ValueError()
            disclosed = data.get("email_reminders_disclosed", False)
            if type(disclosed) is not bool or set(data) - {"grant_id", "proof", "email_reminders_disclosed"}:
                raise ValueError()
            user, email, target = exchange_email_link(UUID(str(data.get("grant_id", ""))), data.get("proof"), client_network(request))
        except (ValueError, EmailCodeInvalid):
            return link_error(request)
        except EmailCodeLimited:
            return link_error(request, 429)
        if request.user.is_authenticated and request.user.pk != user.pk:
            logout(request)  # Django flushes the old session and its push bindings.
        record_authentication(request, user, method="email_link", email=email)
        perform_login(request, Login(user=user, email=email))
        return link_response(request, target, user)


class ResumeEmailLinkView(APIView):
    @sensitive_variables()
    def post(self, request, *args, **kwargs):
        try:
            data = self.data or {}
            if not isinstance(data, dict):
                raise ValueError()
            if set(data) != {"grant_id"}:
                raise ValueError()
            user, target = resume_email_link(UUID(str(data.get("grant_id", ""))), request.user)
        except (ValueError, EmailCodeInvalid):
            return link_error(request, 400 if request.user.is_authenticated else 401)
        return link_response(request, target, user)


class RenewEmailLinkView(APIView):
    @sensitive_variables()
    def post(self, request, *args, **kwargs):
        try:
            data = self.data or {}
            if not isinstance(data, dict):
                raise ValueError()
            if set(data) != {"grant_id"}:
                raise ValueError()
            accepted = renew_email_link(UUID(str(data.get("grant_id", ""))), client_network(request))
        except (ValueError, EmailCodeInvalid):
            return link_error(request)
        except EmailCodeLimited:
            return link_error(request, 429)
        except EmailDeliveryUnavailable:
            return link_error(request, 503)
        return APIResponse(request, data={"retry_after": 60, "accepted": accepted})
