import json
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from uuid import uuid4

import pytest
from django.contrib.auth import get_user_model
from django.db import IntegrityError, close_old_connections, connection, connections, transaction
from django.test import Client
from django.utils import timezone

from .models import Expense, ExpensePushDelivery, Group, Participant, PushDevice
from .push import claim_delivery, send_pending_bill_notifications
from .push_provider import PushFailure
from .services import save_expense
from .test_api import client as client
from .test_api import expense, send, uid
from .test_api import group as group

pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture(autouse=True)
def configured(settings):
    settings.PUSH_PROVIDER = "expo"


def login():
    email = f"{uuid4().hex}@push.invalid"
    password = "Only-synthetic-Push-tests-2026!"
    user = get_user_model().objects.create_user(username=email, email=email, password=password)
    result = Client()
    response = result.post(
        "/_allauth/app/v1/auth/login",
        data=json.dumps({"email": email, "password": password}),
        content_type="application/json",
    )
    assert response.status_code == 200
    result.defaults["HTTP_X_SESSION_TOKEN"] = response.json()["meta"]["session_token"]
    result.actor = user
    return result


def register(client, installation=None, token=None):
    installation = installation or uuid4()
    response = send(
        client,
        "put",
        f"/me/push-devices/{installation}",
        {
            "provider": "expo",
            "platform": "ios",
            "token": token or f"ExpoPushToken[test-{installation}]",
        },
    )
    assert response.status_code == 200, response.content
    assert response.json() == {"id": str(installation), "enabled": True}
    return PushDevice.objects.get(pk=installation)


@pytest.fixture
def joined(client, group):
    recipient = login()
    Participant.objects.filter(pk=group[1][1]).update(user=recipient.actor)
    device = register(recipient)
    return recipient, device


def new_bill(client, group):
    payload = expense(group[1])
    response = send(client, "post", f"/groups/{group[0]}/expenses", payload)
    assert response.status_code == 200, response.content
    return payload


def test_auth_owner_removal_and_payload_privacy(client):
    path = f"/me/push-devices/{uuid4()}"
    assert send(Client(), "put", path, {}).status_code == 401
    assert send(Client(), "delete", path).status_code == 401
    device = register(client)
    outsider = login()
    assert send(outsider, "delete", f"/me/push-devices/{device.id}").status_code == 200
    assert PushDevice.objects.filter(pk=device.id).exists()
    assert send(client, "delete", f"/me/push-devices/{device.id}").status_code == 200
    assert send(client, "delete", f"/me/push-devices/{device.id}").status_code == 200
    assert not PushDevice.objects.exists()


def test_only_joined_recipients_and_create_replay(client, group, joined):
    register(client)  # Never notify creator.
    register(login())  # Never notify unrelated users.
    second = register(joined[0])
    payload = new_bill(client, group)
    assert ExpensePushDelivery.objects.count() == 2
    assert set(ExpensePushDelivery.objects.values_list("recipient_id", flat=True)) == {joined[0].actor.pk}
    event_ids = set(ExpensePushDelivery.objects.values_list("event_id", flat=True))
    assert len(event_ids) == 1
    assert send(client, "post", f"/groups/{group[0]}/expenses", payload).status_code == 200
    assert ExpensePushDelivery.objects.count() == 2
    payload.update(command_id=uid(), version=1, description="An edit must not notify")
    assert send(client, "put", f"/groups/{group[0]}/expenses/{payload['id']}", payload).status_code == 200
    assert ExpensePushDelivery.objects.count() == 2
    assert second.id in ExpensePushDelivery.objects.values_list("device_id", flat=True)


def test_database_dedupe_constraint(client, group, joined):
    new_bill(client, group)
    original = ExpensePushDelivery.objects.get()
    with pytest.raises(IntegrityError), transaction.atomic():
        ExpensePushDelivery.objects.create(
            expense=original.expense,
            recipient=original.recipient,
            device=original.device,
            device_revision=original.device_revision,
            event_id=uuid4(),
            due_at=timezone.now(),
        )


def test_outer_rollback_removes_bill_and_delivery(client, group, joined):
    with pytest.raises(RuntimeError), transaction.atomic():
        save_expense(client.actor, group[0], expense(group[1]))
        assert ExpensePushDelivery.objects.count() == 1
        raise RuntimeError("rollback outer transaction")
    assert not ExpensePushDelivery.objects.exists()
    assert not Expense.objects.exists()


def test_uncommitted_delivery_not_visible_to_worker(client, group, joined):
    def other_connection_count():
        close_old_connections()
        try:
            return ExpensePushDelivery.objects.count()
        finally:
            connections.close_all()

    with transaction.atomic():
        save_expense(client.actor, group[0], expense(group[1]))
        with ThreadPoolExecutor(max_workers=1) as pool:
            assert pool.submit(other_connection_count).result() == 0
    assert ExpensePushDelivery.objects.count() == 1


def test_delivery_generic_payload_and_no_network_transaction(client, group, joined, monkeypatch):
    payload = new_bill(client, group)
    sent = []

    def provider(device, data):
        assert not connection.in_atomic_block
        sent.append(data)
        return "provider-request-id"

    monkeypatch.setattr("ledger.push_provider.send_bill_notification", provider)
    assert send_pending_bill_notifications() == 1
    assert send_pending_bill_notifications() == 0
    assert sent == [
        {
            "type": "new_bill",
            "event_id": str(ExpensePushDelivery.objects.get().event_id),
            "recipient_user_id": str(joined[0].actor.pk),
            "group_id": group[0],
            "expense_id": payload["id"],
        }
    ]
    assert ExpensePushDelivery.objects.get().state == "queued"


@pytest.mark.parametrize("change", ["archived", "deleted", "unlinked", "removed", "inactive", "expired"])
def test_rechecks_eligibility_before_send(client, group, joined, monkeypatch, change):
    payload = new_bill(client, group)
    if change == "archived":
        Group.objects.filter(pk=group[0]).update(archived=True)
    elif change == "deleted":
        Expense.objects.filter(pk=payload["id"]).update(deleted=True)
    elif change == "unlinked":
        Participant.objects.filter(user=joined[0].actor).update(user=None)
    elif change == "removed":
        Participant.objects.filter(user=joined[0].actor).update(removed=True)
    elif change == "inactive":
        get_user_model().objects.filter(pk=joined[0].actor.pk).update(is_active=False)
    else:
        type(joined[1].session).objects.filter(pk=joined[1].session_id).update(
            expire_date=timezone.now() - timedelta(seconds=1)
        )

    def forbidden(*args):
        pytest.fail("Ineligible delivery reached provider")

    monkeypatch.setattr("ledger.push_provider.send_bill_notification", forbidden)
    send_pending_bill_notifications()
    assert ExpensePushDelivery.objects.get().state == "skipped"


def test_logout_cascades_device_and_delivery(client, group, joined):
    new_bill(client, group)
    response = joined[0].delete("/_allauth/app/v1/auth/session")
    assert response.status_code == 401
    assert not PushDevice.objects.filter(pk=joined[1].pk).exists()
    assert not ExpensePushDelivery.objects.exists()


def test_existing_stock_db_session_keeps_native_token_valid(client):
    from allauth.core.internal.sessionkit import get_session_user
    from allauth.headless import app_settings
    from config.sessions import SessionStore
    from django.contrib.sessions.backends.db import SessionStore as StockSessionStore
    from django.contrib.sessions.models import Session

    token = client.defaults["HTTP_X_SESSION_TOKEN"]
    old = app_settings.TOKEN_STRATEGY.lookup_session(token)
    data = old.load()
    Session.objects.filter(pk=old.session_key).update(session_data=StockSessionStore().encode(data))
    assert SessionStore().key_salt == StockSessionStore().key_salt
    assert SessionStore(session_key=old.session_key).load() == data
    assert get_session_user(app_settings.TOKEN_STRATEGY.lookup_session(token)).pk == client.actor.pk
    assert send(client, "get", "/me").status_code == 200


def test_rebind_skips_previous_account_delivery(client, group, joined, monkeypatch):
    new_bill(client, group)
    old = joined[1]
    other = login()
    rebound = register(other, old.id, old.token)
    assert rebound.user_id == other.actor.pk and rebound.revision == old.revision + 1
    assert register(other, old.id, old.token).revision == rebound.revision

    def forbidden(*args):
        pytest.fail("Old recipient delivery reached rebound device")

    monkeypatch.setattr("ledger.push_provider.send_bill_notification", forbidden)
    send_pending_bill_notifications()
    assert ExpensePushDelivery.objects.get().state == "skipped"
    send(joined[0], "delete", f"/me/push-devices/{old.id}")
    assert PushDevice.objects.filter(pk=old.id, user=other.actor).exists()


def test_token_moves_to_new_installation(client):
    original = register(client)
    other = login()
    rebound = register(other, token=original.token)
    assert rebound.user_id == other.actor.pk
    assert not PushDevice.objects.filter(pk=original.pk).exists()
    assert PushDevice.objects.count() == 1


def test_account_deletion_revokes_devices(client, group, joined):
    new_bill(client, group)
    assert send(joined[0], "delete", "/account").status_code == 200
    assert not PushDevice.objects.filter(user=joined[0].actor).exists()
    assert not ExpensePushDelivery.objects.exists()


def test_transient_retry_backoff_and_success(client, group, joined, monkeypatch):
    new_bill(client, group)
    calls = []

    def provider(device, data):
        calls.append(data["event_id"])
        if len(calls) == 1:
            raise PushFailure("timeout")
        return "accepted"

    monkeypatch.setattr("ledger.push_provider.send_bill_notification", provider)
    send_pending_bill_notifications()
    row = ExpensePushDelivery.objects.get()
    assert row.state == "pending" and row.attempts == 1 and row.due_at > timezone.now()
    assert send_pending_bill_notifications() == 0
    ExpensePushDelivery.objects.update(due_at=timezone.now() - timedelta(seconds=1))
    send_pending_bill_notifications()
    row.refresh_from_db()
    assert row.state == "queued" and row.attempts == 2 and len(set(calls)) == 1


def test_invalid_token_retires_device(client, group, joined, monkeypatch):
    new_bill(client, group)

    def provider(*args):
        raise PushFailure("invalid_token", invalid_token=True)

    monkeypatch.setattr("ledger.push_provider.send_bill_notification", provider)
    send_pending_bill_notifications()
    assert not PushDevice.objects.exists()
    assert not ExpensePushDelivery.objects.exists()


def test_expired_lease_recovers_with_new_fence(client, group, joined):
    new_bill(client, group)
    first = claim_delivery()
    assert claim_delivery() is None
    ExpensePushDelivery.objects.update(lease_until=timezone.now() - timedelta(seconds=1))
    recovered = claim_delivery()
    assert first[0] == recovered[0] and first[1] != recovered[1]
    assert ExpensePushDelivery.objects.filter(id=first[0], lease_id=first[1]).update(state="sent") == 0


def test_postgres_worker_claims_are_disjoint(client, group, joined):
    new_bill(client, group)

    def claim():
        close_old_connections()
        try:
            return claim_delivery()
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: claim(), range(2)))
    assert sum(result is not None for result in results) == 1


def test_history_import_does_not_queue(client):
    from .test_splitwise_import import payload

    register(client)
    response = send(client, "post", "/imports/splitwise", payload())
    assert response.status_code == 200
    assert Expense.objects.count() == 1
    assert not ExpensePushDelivery.objects.exists()


def test_token_rotation_invalidates_queued_binding(client, group, joined, monkeypatch):
    new_bill(client, group)
    register(joined[0], joined[1].id, "ExpoPushToken[rotated-native-token]")

    def forbidden(*args):
        pytest.fail("Old delivery reached new token binding")

    monkeypatch.setattr("ledger.push_provider.send_bill_notification", forbidden)
    send_pending_bill_notifications()
    assert ExpensePushDelivery.objects.get().state == "skipped"


def test_retry_exhaustion_is_durable(client, group, joined, monkeypatch):
    new_bill(client, group)
    ExpensePushDelivery.objects.update(attempts=7)

    def provider(*args):
        raise PushFailure("unavailable")

    monkeypatch.setattr("ledger.push_provider.send_bill_notification", provider)
    send_pending_bill_notifications()
    row = ExpensePushDelivery.objects.get()
    assert row.state == "failed" and row.attempts == 8 and row.last_error == "unavailable"
    assert send_pending_bill_notifications() == 0


def test_exports_never_include_device_secrets(client):
    device = register(client)
    response = send(client, "get", "/account/export")
    assert response.status_code == 200
    body = response.content.decode()
    assert device.token not in body and device.session_id not in body
    assert "push_devices" not in body


def test_expired_eighth_lease_stops_until_operator_retry(client, group, joined):
    new_bill(client, group)
    ExpensePushDelivery.objects.update(
        state="sending", attempts=8, lease_until=timezone.now() - timedelta(seconds=1)
    )
    assert claim_delivery() is None
    assert ExpensePushDelivery.objects.get().state == "failed"


def test_concurrent_create_retry_queues_once(client, group, joined):
    payload = expense(group[1])

    def create():
        close_old_connections()
        try:
            actor = get_user_model().objects.get(pk=client.actor.pk)
            return save_expense(actor, group[0], payload)
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: create(), range(2)))
    assert responses[0] == responses[1]
    assert Expense.objects.count() == ExpensePushDelivery.objects.count() == 1


def ticketed_bill(client, group, monkeypatch):
    monkeypatch.setattr("ledger.push_provider.send_bill_notification", lambda *_: str(uuid4()))
    new_bill(client, group)
    send_pending_bill_notifications()
    row = ExpensePushDelivery.objects.get()
    assert row.state == "queued" and row.sent_at is None
    ExpensePushDelivery.objects.update(due_at=timezone.now() - timedelta(seconds=1))
    return row


def test_receipt_acceptance_is_separate_from_ticket(client, group, joined, monkeypatch):
    from .push import check_pending_bill_receipts

    row = ticketed_bill(client, group, monkeypatch)

    def receipt(ticket):
        assert not connection.in_atomic_block and ticket == row.provider_id
        return True

    monkeypatch.setattr("ledger.push_provider.check_bill_notification_receipt", receipt)
    assert check_pending_bill_receipts() == 1
    row.refresh_from_db()
    assert row.state == "sent" and row.sent_at is not None and row.receipt_attempts == 1
    assert check_pending_bill_receipts() == 0


def test_receipt_missing_polls_without_resending(client, group, joined, monkeypatch):
    from .push import check_pending_bill_receipts

    ticketed_bill(client, group, monkeypatch)
    monkeypatch.setattr("ledger.push_provider.check_bill_notification_receipt", lambda _: False)
    check_pending_bill_receipts()
    row = ExpensePushDelivery.objects.get()
    assert row.state == "queued" and row.sent_at is None
    assert send_pending_bill_notifications() == 0
    ExpensePushDelivery.objects.update(
        ticketed_at=timezone.now() - timedelta(hours=25), due_at=timezone.now()
    )
    check_pending_bill_receipts()
    row.refresh_from_db()
    assert row.state == "failed" and row.provider_id and row.last_error == "receipt_unavailable"


def test_receipt_invalid_token_cannot_delete_rebound_device(client, group, joined, monkeypatch):
    from .push import check_pending_bill_receipts

    ticketed_bill(client, group, monkeypatch)
    rebound = register(login(), joined[1].id, joined[1].token)

    def receipt(_):
        raise PushFailure("device_not_registered", invalid_token=True)

    monkeypatch.setattr("ledger.push_provider.check_bill_notification_receipt", receipt)
    check_pending_bill_receipts()
    assert PushDevice.objects.filter(pk=rebound.pk, revision=rebound.revision).exists()


def test_receipt_transient_failure_does_not_resend(client, group, joined, monkeypatch):
    from .push import check_pending_bill_receipts

    ticketed_bill(client, group, monkeypatch)

    def receipt(_):
        raise PushFailure("http_503")

    monkeypatch.setattr("ledger.push_provider.check_bill_notification_receipt", receipt)
    check_pending_bill_receipts()
    assert ExpensePushDelivery.objects.get().state == "queued"
    assert send_pending_bill_notifications() == 0


def test_rate_limited_receipt_requeues_with_eligibility_recheck(client, group, joined, monkeypatch):
    from .push import check_pending_bill_receipts

    ticketed_bill(client, group, monkeypatch)

    def receipt(_):
        raise PushFailure("message_rate_exceeded", resend=True)

    monkeypatch.setattr("ledger.push_provider.check_bill_notification_receipt", receipt)
    check_pending_bill_receipts()
    row = ExpensePushDelivery.objects.get()
    assert row.state == "pending" and not row.provider_id
    Participant.objects.filter(user=joined[0].actor).update(user=None)
    ExpensePushDelivery.objects.update(due_at=timezone.now())
    send_pending_bill_notifications()
    row.refresh_from_db()
    assert row.state == "skipped"


def test_browser_registry_mutation_requires_csrf(client):
    browser = Client(enforce_csrf_checks=True)
    browser.force_login(client.actor)
    response = send(
        browser,
        "put",
        f"/me/push-devices/{uuid4()}",
        {
            "provider": "expo",
            "platform": "android",
            "token": "ExpoPushToken[browser-test]",
        },
    )
    assert response.status_code == 403
    assert not PushDevice.objects.exists()


def test_native_registry_rejects_non_expo_token(client):
    response = send(
        client,
        "put",
        f"/me/push-devices/{uuid4()}",
        {
            "provider": "expo",
            "platform": "ios",
            "token": "raw-apns-token",
        },
    )
    assert response.status_code == 422
    assert not PushDevice.objects.exists()


def test_operator_retry_keeps_known_ticket_without_resending(client, group, joined, monkeypatch):
    from django.core.management import call_command

    row = ticketed_bill(client, group, monkeypatch)
    ExpensePushDelivery.objects.update(state="failed", last_error="receipt_unavailable")

    def no_send(*args):
        pytest.fail("Operator retry resent an already accepted ticket")

    monkeypatch.setattr("ledger.push_provider.send_bill_notification", no_send)
    monkeypatch.setattr("ledger.push_provider.check_bill_notification_receipt", lambda _: True)
    call_command("send_bill_notifications", limit=1, retry_failed=True)
    row.refresh_from_db()
    assert row.state == "sent" and row.attempts == 1


def test_account_delete_racing_registration_leaves_no_device(client):
    from threading import Barrier

    barrier = Barrier(2)
    headers = dict(client.defaults)
    installation = str(uuid4())

    def act(kind):
        close_old_connections()
        local = Client(**headers)
        barrier.wait(timeout=10)
        try:
            if kind == "delete":
                return send(local, "delete", "/account").status_code
            return send(
                local,
                "put",
                f"/me/push-devices/{installation}",
                {
                    "provider": "expo",
                    "platform": "ios",
                    "token": "ExpoPushToken[delete-race]",
                },
            ).status_code
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(act, ["delete", "register"]))
    assert results[0] == 200 and results[1] in {200, 401}
    assert not PushDevice.objects.exists()
    assert not get_user_model().objects.filter(pk=client.actor.pk).exists()


def test_account_delete_and_actual_logout_share_session_before_device_lock_order(client):
    from concurrent.futures import TimeoutError
    from threading import Event

    device = register(client)
    removed, release, logout_started = Event(), Event(), Event()

    def delete_account():
        close_old_connections()

        def pause_after_device_delete(execute, sql, params, many, context):
            result = execute(sql, params, many, context)
            if sql.startswith("DELETE") and '"ledger_pushdevice"' in sql:
                removed.set()
                assert release.wait(10)
            return result

        try:
            with connection.execute_wrapper(pause_after_device_delete):
                return send(Client(**client.defaults), "delete", "/account").status_code
        finally:
            connections.close_all()

    def logout():
        close_old_connections()

        def observe_session_lock(execute, sql, params, many, context):
            if '"django_session"' in sql and "FOR UPDATE" in sql:
                logout_started.set()
            return execute(sql, params, many, context)

        try:
            with connection.execute_wrapper(observe_session_lock):
                return Client(**client.defaults).delete("/_allauth/app/v1/auth/session").status_code
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        deleting = pool.submit(delete_account)
        assert removed.wait(10)
        signing_out = pool.submit(logout)
        try:
            assert logout_started.wait(10)
            with pytest.raises(TimeoutError):
                signing_out.result(timeout=0.2)
        finally:
            release.set()
        assert deleting.result(timeout=10) == 200
        assert signing_out.result(timeout=10) == 401
    assert not get_user_model().objects.filter(pk=client.actor.pk).exists()
    assert not PushDevice.objects.filter(pk=device.pk).exists()


@pytest.mark.parametrize("operation", ["unregister", "token_move", "rebind", "logout", "account_delete"])
def test_bill_enqueue_serializes_device_changes_without_losing_the_bill(client, group, joined, monkeypatch, operation):
    from concurrent.futures import TimeoutError
    from threading import Event

    from .push import eligible_delivery, remove_device

    selected, release, removing = Event(), Event(), Event()
    original = ExpensePushDelivery.objects.bulk_create
    replacement = login() if operation == "token_move" else None
    body = expense(group[1])

    def pause_insert(rows, **kwargs):
        selected.set()  # The recipient rows have been read and must stay locked.
        assert release.wait(10)
        return original(rows, **kwargs)

    monkeypatch.setattr(ExpensePushDelivery.objects, "bulk_create", pause_insert)

    def create():
        close_old_connections()
        try:
            return save_expense(client.actor, group[0], body)
        finally:
            connections.close_all()

    def revoke():
        close_old_connections()
        def started(execute, sql, params, many, context):
            table = "ledger_group" if operation == "account_delete" else "ledger_pushdevice"
            if table in sql and ("FOR UPDATE" in sql or sql.startswith("DELETE")):
                removing.set()
            return execute(sql, params, many, context)
        try:
            with connection.execute_wrapper(started):
                if operation == "unregister":
                    return remove_device(joined[0].actor, joined[1].id)
                if operation == "logout":
                    local = Client(**joined[0].defaults)
                    return local.delete("/_allauth/app/v1/auth/session").status_code
                if operation == "account_delete":
                    local = Client(**joined[0].defaults)
                    return send(local, "delete", "/account").status_code
                if operation == "rebind":
                    return register(joined[0], joined[1].id, "ExpoPushToken[rebound-race]")
                return register(replacement, token=joined[1].token)
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        bill = pool.submit(create)
        assert selected.wait(10)
        removal = pool.submit(revoke)
        try:
            assert removing.wait(10)
            with pytest.raises(TimeoutError):
                removal.result(timeout=0.2)
        finally:
            release.set()
        bill.result(timeout=10)
        result = removal.result(timeout=10)
    assert Expense.objects.filter(pk=body["id"]).count() == 1
    if operation == "rebind":
        device = PushDevice.objects.get(pk=joined[1].id)
        assert device.revision == joined[1].revision + 1
        delivery = ExpensePushDelivery.objects.select_related("device__session", "expense__group", "recipient").get()
        assert not eligible_delivery(delivery)
    else:
        if operation == "logout":
            assert result == 401
            assert send(joined[0], "get", "/groups").status_code == 401
        if operation == "account_delete":
            assert result == 200
            assert not get_user_model().objects.filter(pk=joined[0].actor.pk).exists()
        assert not PushDevice.objects.filter(pk=joined[1].id).exists()
        assert not ExpensePushDelivery.objects.filter(expense_id=body["id"]).exists()
