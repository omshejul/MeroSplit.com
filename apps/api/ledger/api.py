from urllib.parse import quote
from uuid import UUID

from allauth.headless.contrib.ninja.security import x_session_token_auth
from django.db import DatabaseError, IntegrityError, connection, transaction
from django.http import HttpResponse, JsonResponse
from ninja import NinjaAPI
from ninja.errors import HttpError, ValidationError
from ninja.security import django_auth

from .accounting import AccountingError
from .collaboration import (
    acknowledge_opening,
    add_participant,
    archive_group,
    claim_invite,
    create_invite,
    create_opening,
    guest_view,
    invite_token,
    review_invite,
)
from .models import Group
from .payments import change_payment, launch_details, prepare_payment, profile_for, update_profile
from .portability import accepted_export, account_export, csv_export, delete_account
from .schemas import (
    ArchiveIn,
    AttemptIn,
    Command,
    ExpenseIn,
    GroupIn,
    InviteIn,
    OpeningIn,
    ParticipantIn,
    ProfileIn,
    Revision,
    SettlementIn,
    WriteResult,
)
from .services import (
    create_group,
    record_settlement,
    reverse_settlement,
    save_expense,
    set_expense_deleted,
    snapshot,
    visible_group,
)

api = NinjaAPI(title="MeroSplit", version="1.0", auth=[x_session_token_auth, django_auth])


@api.get("/health", auth=None)
def health(request):
    return {"status": "ok"}


@api.get("/ready", auth=None)
def ready(request):
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
    except DatabaseError:
        return JsonResponse({"status": "unavailable"}, status=503)
    return {"status": "ready"}


@api.exception_handler(HttpError)
def http_error(request, exc):
    return JsonResponse(
        {
            "error": {401: "unauthorized", 403: "forbidden", 404: "not_found", 409: "conflict"}.get(
                exc.status_code, "request_failed"
            ),
            "detail": str(exc),
        },
        status=exc.status_code,
    )


@api.exception_handler(AccountingError)
def accounting_error(request, exc):
    return JsonResponse({"error": "invalid_input", "detail": str(exc)}, status=422)


@api.exception_handler(ValidationError)
def validation_error(request, exc):
    return JsonResponse(
        {
            "error": "invalid_input",
            "detail": "Check the request fields",
            "fields": [{"path": list(e["loc"]), "message": e["msg"]} for e in exc.errors],
        },
        status=422,
    )


@api.exception_handler(IntegrityError)
def duplicate_error(request, exc):
    constraint = getattr(getattr(exc.__cause__, "diag", None), "constraint_name", "") or ""
    if constraint not in {
        "actor_command_once",
        "one_user_per_group",
        "one_active_payment_attempt",
    } and not constraint.endswith("_pkey"):
        raise exc
    return JsonResponse(
        {
            "error": "conflict",
            "detail": "This identifier or operation was already used; refresh before retrying",
        },
        status=409,
    )


@api.get("/groups")
def groups(request):
    return {
        "groups": list(
            Group.objects.filter(participants__user=request.auth).values(
                "id", "name", "version", "archived", "is_direct"
            )
        )
    }


@api.post("/groups", response=WriteResult)
def group_create(request, body: GroupIn):
    return create_group(request.auth, body.model_dump(mode="json"))


@api.get("/groups/{group_id}")
def group_get(request, group_id: UUID):
    with transaction.atomic():
        group = visible_group(request.auth, group_id, lock=True)
        state = snapshot(group)
        if group.owner_id != request.auth.pk:
            state["invites"] = []
        return state


@api.post("/groups/{group_id}/expenses", response=WriteResult)
def expense_create(request, group_id: UUID, body: ExpenseIn):
    return save_expense(request.auth, group_id, body.model_dump(mode="json"))


@api.put("/groups/{group_id}/expenses/{expense_id}", response=WriteResult)
def expense_update(request, group_id: UUID, expense_id: UUID, body: ExpenseIn):
    return save_expense(request.auth, group_id, body.model_dump(mode="json"), expense_id)


@api.delete("/groups/{group_id}/expenses/{expense_id}", response=WriteResult)
def expense_delete(request, group_id: UUID, expense_id: UUID, body: Revision):
    return set_expense_deleted(request.auth, group_id, expense_id, body.model_dump(mode="json"), True)


@api.post("/groups/{group_id}/expenses/{expense_id}/restore", response=WriteResult)
def expense_restore(request, group_id: UUID, expense_id: UUID, body: Revision):
    return set_expense_deleted(request.auth, group_id, expense_id, body.model_dump(mode="json"), False)


@api.post("/groups/{group_id}/settlements", response=WriteResult)
def settlement_create(request, group_id: UUID, body: SettlementIn):
    return record_settlement(request.auth, group_id, body.model_dump(mode="json"))


@api.post("/groups/{group_id}/settlements/{settlement_id}/reverse", response=WriteResult)
def settlement_reverse(request, group_id: UUID, settlement_id: UUID, body: Command):
    return reverse_settlement(request.auth, group_id, settlement_id, body.model_dump(mode="json"))


@api.get("/me")
def me(request):
    return {
        "id": request.auth.pk,
        "email": request.auth.email,
        "email_verified": False,
        "payment_profile": profile_for(request.auth),
    }


@api.put("/me/payment-profile")
def profile_update(request, body: ProfileIn):
    return update_profile(request.auth, body.vpa)


@api.post("/groups/{group_id}/invites")
def invite_create(request, group_id: UUID, body: InviteIn):
    result = create_invite(request.auth, group_id, body.model_dump(mode="json"))
    token = invite_token(body.command_id)
    return {**result, "token": token, "url": request.build_absolute_uri(f"/invite/{quote(token, safe='')}")}


@api.get("/invites/{token}", auth=None)
def invite_view(request, token: str):
    return guest_view(token)


@api.post("/invites/{token}/claim", response=WriteResult)
def invite_claim(request, token: str, body: Command):
    return claim_invite(request.auth, token, body.model_dump(mode="json"))


@api.post("/groups/{group_id}/invites/{invite_id}/approve", response=WriteResult)
def invite_approve(request, group_id: UUID, invite_id: UUID, body: Command):
    return review_invite(request.auth, group_id, invite_id, body.model_dump(mode="json"), True)


@api.post("/groups/{group_id}/invites/{invite_id}/revoke", response=WriteResult)
def invite_revoke(request, group_id: UUID, invite_id: UUID, body: Command):
    return review_invite(request.auth, group_id, invite_id, body.model_dump(mode="json"), False)


@api.post("/groups/{group_id}/opening-balances", response=WriteResult)
def opening_create(request, group_id: UUID, body: OpeningIn):
    return create_opening(request.auth, group_id, body.model_dump(mode="json"))


@api.post("/groups/{group_id}/opening-balances/{opening_id}/acknowledge", response=WriteResult)
def opening_acknowledge(request, group_id: UUID, opening_id: UUID, body: Command):
    return acknowledge_opening(request.auth, group_id, opening_id, body.model_dump(mode="json"))


@api.post("/groups/{group_id}/payment-attempts", response=WriteResult)
def payment_prepare(request, group_id: UUID, body: AttemptIn):
    return prepare_payment(request.auth, group_id, body.model_dump(mode="json"))


@api.get("/groups/{group_id}/payment-attempts/{attempt_id}/launch")
def payment_details(request, group_id: UUID, attempt_id: UUID):
    return launch_details(request.auth, group_id, attempt_id)


@api.post("/groups/{group_id}/payment-attempts/{attempt_id}/report", response=WriteResult)
def payment_report(request, group_id: UUID, attempt_id: UUID, body: Command):
    return change_payment(request.auth, group_id, attempt_id, body.model_dump(mode="json"), "report")


@api.post("/groups/{group_id}/payment-attempts/{attempt_id}/confirm", response=WriteResult)
def payment_confirm(request, group_id: UUID, attempt_id: UUID, body: Command):
    return change_payment(request.auth, group_id, attempt_id, body.model_dump(mode="json"), "confirm")


@api.post("/groups/{group_id}/payment-attempts/{attempt_id}/cancel", response=WriteResult)
def payment_cancel(request, group_id: UUID, attempt_id: UUID, body: Command):
    return change_payment(request.auth, group_id, attempt_id, body.model_dump(mode="json"), "cancel")


@api.post("/groups/{group_id}/archive", response=WriteResult)
def group_archive(request, group_id: UUID, body: ArchiveIn):
    return archive_group(request.auth, group_id, body.model_dump(mode="json"))


@api.get("/groups/{group_id}/export")
def group_export(request, group_id: UUID, format: str = "json"):
    result = accepted_export(request.auth, group_id)
    if format == "json":
        response = JsonResponse(result)
    elif format == "csv":
        response = HttpResponse(csv_export(result), content_type="text/csv; charset=utf-8")
    else:
        raise HttpError(422, "Choose json or csv")
    response["Content-Disposition"] = f'attachment; filename="merosplit-{group_id}.{format}"'
    return response


@api.get("/account/export")
def export_account(request):
    return JsonResponse(account_export(request.auth))


@api.delete("/account")
def account_delete(request):
    return delete_account(request.auth)


@api.post("/groups/{group_id}/participants", response=WriteResult)
def participant_add(request, group_id: UUID, body: ParticipantIn):
    return add_participant(request.auth, group_id, body.model_dump(mode="json"))
