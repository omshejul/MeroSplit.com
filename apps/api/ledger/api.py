from urllib.parse import quote
from uuid import UUID

from allauth.account.models import EmailAddress
from allauth.headless.contrib.ninja.security import x_session_token_auth
from django.conf import settings
from django.db import DatabaseError, IntegrityError, connection, transaction
from django.db.models import F
from django.http import HttpResponse, JsonResponse
from ninja import File, Form, NinjaAPI
from ninja.errors import HttpError, ValidationError
from ninja.files import UploadedFile as RequestFile
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
    remove_participant,
    review_invite,
)
from .email_invites import send_person_invite, update_contact
from .expense_notifications import foreground, mark_seen, notice_feed, preferences, update_preferences
from .history_reads import (
    account_activity,
    expense_detail,
    group_summary,
    history_page,
    payment_attempt_detail,
    settlement_detail,
)
from .media import avatar_for, download_url, list_attachments, remove_attachment, remove_avatar, upload_file
from .models import Group
from .otp import client_network
from .payments import change_payment, launch_details, prepare_payment, profile_for, update_profile
from .portability import accepted_export, account_export, csv_export, delete_account
from .profiles import display_name, update_display_name
from .schemas import (
    ArchiveIn,
    AttemptIn,
    Command,
    ContactIn,
    DisplayNameIn,
    ExpenseIn,
    GroupIn,
    InviteIn,
    NotificationPreferencesIn,
    OpeningIn,
    ParticipantIn,
    ProfileIn,
    PushDeviceIn,
    Revision,
    SeenNoticesIn,
    SettlementIn,
    SplitwiseImportIn,
    SplitwiseImportResult,
    SplitwisePreviewIn,
    WriteResult,
)
from .services import (
    create_group,
    record_settlement,
    reverse_expense,
    reverse_settlement,
    save_expense,
    snapshot,
    visible_group,
)
from .splitwise_import import import_splitwise, preview_splitwise
from .store_review import groups_for_actor

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
        "one_push_token",
        "one_user_per_group",
        "one_active_payment_attempt",
        "one_splitwise_source_per_owner",
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
            groups_for_actor(Group.objects.filter(participants__user=request.auth, participants__removed=False), request.auth).annotate(hidden=F("participants__hidden")).values(
                "id", "name", "version", "archived", "is_direct", "hidden"
            )
        )
    }


@api.post("/groups", response=WriteResult)
def group_create(request, body: GroupIn):
    return create_group(request.auth, body.model_dump(mode="json"))


@api.post("/imports/splitwise/preview")
def splitwise_preview(request, body: SplitwisePreviewIn):
    return preview_splitwise(request.auth, body.csv)


@api.post("/imports/splitwise", response=SplitwiseImportResult)
def splitwise_import(request, body: SplitwiseImportIn):
    return import_splitwise(request.auth, body.model_dump(mode="json"))


@api.get("/activity")
def activity_get(request, limit: int = 50, cursor: str | None = None):
    return account_activity(request.auth, limit=limit, cursor=cursor)


@api.get("/groups/{group_id}")
def group_get(request, group_id: UUID):
    with transaction.atomic():
        group = visible_group(request.auth, group_id, lock=True)
        state = snapshot(group)
        state["hidden"] = group.participants.filter(user=request.auth, removed=False).values_list("hidden", flat=True).get()
        if group.owner_id == request.auth.pk:
            emails = dict(group.participants.values_list("id", "contact_email"))
            for person in state["participants"]:
                person["email"] = emails[UUID(person["id"])]
        if group.owner_id != request.auth.pk:
            state["invites"] = []
        return state


@api.post("/groups/{group_id}/expenses", response=WriteResult)
def expense_create(request, group_id: UUID, body: ExpenseIn):
    return save_expense(request.auth, group_id, body.model_dump(mode="json"))


@api.get("/groups/{group_id}/summary")
def group_summary_get(request, group_id: UUID, limit: int = 50):
    return group_summary(request.auth, group_id, limit=limit)


@api.get("/groups/{group_id}/history/{resource}")
def group_history_get(request, group_id: UUID, resource: str, limit: int = 50, cursor: str | None = None,
                      version: int | None = None, deleted: str = "all", q: str = "", reversed: str = "all",
                      kind: str = "", sender: UUID | None = None, recipient: UUID | None = None, state: str = "all"):
    return history_page(request.auth, group_id, resource, limit=limit, cursor=cursor, version=version,
                        filters={"deleted": deleted, "q": q, "reversed": reversed, "kind": kind,
                                 "sender": sender, "recipient": recipient, "state": state})


@api.get("/groups/{group_id}/expenses/{expense_id}")
def expense_get(request, group_id: UUID, expense_id: UUID, version: int | None = None):
    return expense_detail(request.auth, group_id, expense_id, version=version)


@api.put("/groups/{group_id}/expenses/{expense_id}", response=WriteResult)
def expense_update(request, group_id: UUID, expense_id: UUID, body: ExpenseIn):
    return save_expense(request.auth, group_id, body.model_dump(mode="json"), expense_id)


@api.post("/groups/{group_id}/expenses/{expense_id}/reverse", response=WriteResult)
def expense_reverse(request, group_id: UUID, expense_id: UUID, body: Revision):
    return reverse_expense(request.auth, group_id, expense_id, body.model_dump(mode="json"))


@api.post("/groups/{group_id}/settlements", response=WriteResult)
def settlement_create(request, group_id: UUID, body: SettlementIn):
    return record_settlement(request.auth, group_id, body.model_dump(mode="json", exclude_unset=True))


@api.get("/groups/{group_id}/settlements/{settlement_id}")
def settlement_get(request, group_id: UUID, settlement_id: UUID, version: int | None = None):
    return settlement_detail(request.auth, group_id, settlement_id, version=version)


@api.post("/groups/{group_id}/settlements/{settlement_id}/reverse", response=WriteResult)
def settlement_reverse(request, group_id: UUID, settlement_id: UUID, body: Command):
    return reverse_settlement(request.auth, group_id, settlement_id, body.model_dump(mode="json"))


@api.get("/me")
def me(request):
    return {
        "id": request.auth.pk,
        "email": request.auth.email,
        "display_name": display_name(request.auth),
        "email_verified": EmailAddress.objects.filter(user=request.auth, email__iexact=request.auth.email, verified=True).exists(),
        "payment_profile": profile_for(request.auth),
        "avatar": avatar_for(request.auth),
    }


@api.put("/me/profile")
def account_profile_update(request, body: DisplayNameIn):
    return update_display_name(request.auth, body.display_name, only_if_unnamed=body.only_if_unnamed)


@api.get("/me/notifications/preferences")
def notification_preferences(request):
    return preferences(request.auth)


@api.put("/me/notifications/preferences")
def notification_preferences_update(request, body: NotificationPreferencesIn):
    return update_preferences(request.auth, body.expense_updates, body.email_reminders)


@api.get("/me/notifications")
def notifications(request, limit: int = 50, expense_ids: str = ""):
    return notice_feed(request.auth, limit, expense_ids)


@api.post("/me/notifications/seen")
def notifications_seen(request, body: SeenNoticesIn):
    return mark_seen(request.auth, body.model_dump(mode="json")["notices"])


@api.post("/me/notifications/foreground")
def notifications_foreground(request):
    return foreground(request.auth)


@api.post("/me/avatar")
def avatar_upload(request, id: Form[UUID], file: File[RequestFile]):
    return upload_file(request.auth, id, file)


@api.delete("/me/avatar")
def avatar_remove(request):
    return remove_avatar(request.auth)


@api.get("/groups/{group_id}/expenses/{expense_id}/attachments")
def attachments_get(request, group_id: UUID, expense_id: UUID):
    return list_attachments(request.auth, group_id, expense_id)


@api.post("/groups/{group_id}/expenses/{expense_id}/attachments")
def attachment_upload(request, group_id: UUID, expense_id: UUID, id: Form[UUID], file: File[RequestFile]):
    return upload_file(request.auth, id, file, group_id=group_id, expense_id=expense_id)


@api.delete("/groups/{group_id}/expenses/{expense_id}/attachments/{file_id}")
def attachment_remove(request, group_id: UUID, expense_id: UUID, file_id: UUID):
    return remove_attachment(request.auth, group_id, expense_id, file_id)


@api.get("/media/{file_id}/url")
def media_url(request, file_id: UUID):
    return download_url(request.auth, file_id)


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


@api.get("/groups/{group_id}/payment-attempts/{attempt_id}")
def payment_attempt_get(request, group_id: UUID, attempt_id: UUID, version: int | None = None):
    return payment_attempt_detail(request.auth, group_id, attempt_id, version=version)


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


@api.post("/groups/{group_id}/participants/{participant_id}/contact", response=WriteResult)
def participant_contact(request, group_id: UUID, participant_id: UUID, body: ContactIn):
    return update_contact(request.auth, group_id, participant_id, body.model_dump(mode="json"))


@api.post("/groups/{group_id}/participants/{participant_id}/email-invite")
def participant_email_invite(request, group_id: UUID, participant_id: UUID, body: Command):
    return send_person_invite(
        request.auth, group_id, participant_id, body.model_dump(mode="json"),
        settings.PUBLIC_WEB_URL.rstrip("/"), client_network(request),
    )


@api.post("/groups/{group_id}/participants/{participant_id}/remove", response=WriteResult)
def participant_remove(request, group_id: UUID, participant_id: UUID, body: Command):
    return remove_participant(request.auth, group_id, participant_id, body.model_dump(mode="json"))


@api.put("/me/push-devices/{installation_id}")
def push_device_register(request, installation_id: UUID, body: PushDeviceIn):
    from .push import register_device
    return register_device(request, installation_id, body.model_dump())


@api.delete("/me/push-devices/{installation_id}")
def push_device_remove(request, installation_id: UUID):
    from .push import remove_device
    return remove_device(request.auth, installation_id)


@api.get("/me/mcp/pending")
def mcp_pending(request):
    from .mcp_oauth import pending_authorization
    return pending_authorization(request)


@api.get("/me/mcp")
def mcp_connections(request):
    from .mcp_oauth import connected_agents
    return connected_agents(request.auth)


@api.delete("/me/mcp/{grant_id}")
def mcp_disconnect(request, grant_id: UUID):
    from .mcp_oauth import OAuthError, disconnect_agent
    try:
        return disconnect_agent(request.auth, grant_id)
    except OAuthError as exc:
        raise HttpError(exc.status, exc.error) from None


@api.get("/me/bill-email-entry")
def bill_email_entry(request):
    from .bill_email import notification_entry
    return notification_entry(request.auth)


@api.post("/groups/{group_id}/leave")
def personal_group_leave(request, group_id: UUID, body: Command):
    from .group_membership import leave_group
    return leave_group(request.auth, group_id, body.model_dump(mode="json"))


@api.post("/groups/{group_id}/restore")
def personal_group_restore(request, group_id: UUID, body: Command):
    from .group_membership import restore_group
    return restore_group(request.auth, group_id, body.model_dump(mode="json"))
