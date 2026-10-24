from concurrent.futures import ThreadPoolExecutor
from threading import Event
from time import monotonic, sleep

import pytest
from allauth.account.models import EmailAddress
from django.contrib.auth import get_user_model
from django.db import close_old_connections, connection, connections, transaction
from django.test import Client
from ninja.errors import HttpError

from .collaboration import claim_invite, invite_token, review_invite
from .models import Change, Group, Participant
from .profiles import update_display_name
from .test_api import client as client
from .test_api import expense, send, uid
from .test_api import group as group
from .test_collaboration import account, invite, prepare
from .test_email_codes import mailbox as mailbox

pytestmark = pytest.mark.django_db


@pytest.mark.parametrize("value", ["", "   ", "x" * 121, 42, None])
def test_display_name_rejects_invalid_values_without_mutation(client, value):
    assert send(client, "put", "/me/profile", {"display_name": value}).status_code == 422
    client.actor.refresh_from_db()
    assert client.actor.first_name == "" and Change.objects.count() == 0


def test_profile_update_requires_auth_and_browser_csrf(client):
    assert send(Client(), "put", "/me/profile", {"display_name": "Someone"}).status_code == 401
    browser = Client(enforce_csrf_checks=True)
    browser.force_login(client.actor, backend="allauth.account.auth_backends.AuthenticationBackend")
    browser.get("/_allauth/browser/v1/config")
    assert send(browser, "put", "/me/profile", {"display_name": "Browser name"}).status_code == 403
    browser.defaults["HTTP_X_CSRFTOKEN"] = browser.cookies["csrftoken"].value
    assert send(browser, "put", "/me/profile", {"display_name": "Browser name"}).json() == {"display_name": "Browser name"}


def test_canonical_name_invalidates_only_active_linked_groups_and_preserves_history(client, group):
    group_id, ids, _ = group
    get_user_model().objects.filter(pk=client.actor.pk).update(last_name="Preserved family field")
    Participant.objects.filter(pk=ids[0]).update(name="Original imported name")
    Group.objects.filter(pk=group_id).update(import_source_hash="synthetic-import-fingerprint")
    bill = expense(ids)
    assert send(client, "post", f"/groups/{group_id}/expenses", bill).status_code == 200
    assert send(client, "post", f"/groups/{group_id}/settlements", {
        "command_id": uid(), "id": uid(), "sender": ids[1], "recipient": ids[0], "amount": "123",
    }).status_code == 200
    archived = Group.objects.create(name="Archived synthetic group", owner=client.actor, archived=True, version=7)
    Participant.objects.create(group=archived, user=client.actor, name="Archived recorded label")
    removed = Group.objects.create(name="Former synthetic group", owner=account().actor, version=9)
    Participant.objects.create(group=removed, user=client.actor, name="Former recorded label", removed=True)
    unrelated = Group.objects.create(name="Unrelated label", owner=account().actor, version=11)
    Participant.objects.create(group=unrelated, name="Original imported name")
    before = send(client, "get", f"/groups/{group_id}").json()
    old_changes = list(Change.objects.order_by("id").values("id", "sequence", "kind", "data", "actor_id"))
    recorded_names = {person["id"]: person["recorded_name"] for person in before["participants"]}
    client.actor.refresh_from_db()
    identity = (client.actor.email, client.actor.username, client.actor.last_name, client.actor.password)
    assert send(client, "get", "/me").json()["display_name"] == ""

    response = send(client, "put", "/me/profile", {"display_name": "  Current account name  "})
    assert response.status_code == 200 and response.json() == {"display_name": "Current account name"}
    assert send(client, "get", "/me").json()["display_name"] == "Current account name"
    client.actor.refresh_from_db()
    assert (client.actor.email, client.actor.username, client.actor.last_name, client.actor.password) == identity
    after = send(client, "get", f"/groups/{group_id}").json()
    summary = send(client, "get", f"/groups/{group_id}/summary").json()
    for state in (after, summary, send(client, "get", f"/groups/{group_id}/export").json()["group"]):
        person = next(person for person in state["participants"] if person["id"] == ids[0])
        assert person["name"] == "Current account name" and person["recorded_name"] == "Original imported name"
    for key in ("balances", "transfers", "totals", "expenses", "settlements", "opening_balance", "payment_attempts"):
        assert after[key] == before[key]
    assert list(Change.objects.filter(id__in=[row["id"] for row in old_changes]).order_by("id").values("id", "sequence", "kind", "data", "actor_id")) == old_changes
    assert {str(person.id): person.name for person in Participant.objects.filter(group_id=group_id)} == recorded_names
    assert Group.objects.get(pk=group_id).import_source_hash == "synthetic-import-fingerprint"
    assert Group.objects.get(pk=group_id).version == before["version"] + 1
    assert Group.objects.get(pk=archived.pk).version == 8
    assert Group.objects.get(pk=removed.pk).version == 9
    assert Group.objects.get(pk=unrelated.pk).version == 11
    changed = Change.objects.filter(kind="display_name_changed")
    assert changed.count() == 2 and all(row.data == {"user_id": client.actor.pk} for row in changed)
    assert send(client, "put", "/me/profile", {"display_name": " Current account name "}).status_code == 200
    assert Group.objects.get(pk=group_id).version == after["version"] and changed.count() == 2


def test_profile_name_limit_applies_after_trimming_and_does_not_accept_identity_edits(client):
    value = "x" * 120
    assert send(client, "put", "/me/profile", {"display_name": f" {value} "}).json() == {"display_name": value}
    assert send(client, "put", "/me/profile", {"display_name": "New", "email": "other@example.invalid"}).status_code == 422
    assert send(client, "put", "/me/profile", {"display_name": "New", "user_id": 999}).status_code == 422


def test_payment_launch_uses_current_canonical_recipient_name(client, group):
    group_id, ids, _ = group
    recipient = account()
    assert send(recipient, "put", "/me/profile", {"display_name": "Recipient account name"}).status_code == 200
    attempt = prepare(client, recipient, group_id, ids)
    quote = send(client, "get", f"/groups/{group_id}/payment-attempts/{attempt['id']}/launch")
    assert quote.status_code == 200 and quote.json()["recipient"] == "Recipient account name"
    assert Participant.objects.get(pk=ids[1]).name == "B"


def test_display_name_update_preserves_store_review_group_isolation(client, group, settings):
    group_id, ids, _ = group
    settings.STORE_REVIEW_AUTH = [{"store": "apple", "user_id": client.actor.pk, "email": client.actor.email, "pin_hash": ""}]
    assert send(client, "put", "/me/profile", {"display_name": "Synthetic reviewer"}).status_code == 200
    Participant.objects.filter(pk=ids[1]).update(user=account().actor)
    version = Group.objects.get(pk=group_id).version
    assert send(client, "put", "/me/profile", {"display_name": "Blocked rename"}).status_code == 404
    client.actor.refresh_from_db()
    assert client.actor.first_name == "Synthetic reviewer" and Group.objects.get(pk=group_id).version == version


@pytest.mark.parametrize("joining", ["email_claim", "manual_approval", "automatic_link"])
@pytest.mark.django_db(transaction=True)
def test_new_membership_waits_for_profile_name_update(client, group, mailbox, joining):
    group_id, ids, _ = group
    member = account()
    if joining in {"email_claim", "automatic_link"}:
        EmailAddress.objects.create(user=member.actor, email=member.actor.email, verified=joining == "automatic_link", primary=True)
        assert send(client, "post", f"/groups/{group_id}/participants/{ids[1]}/contact", {"command_id": uid(), "email": member.actor.email}).status_code == 200
        if joining == "email_claim":
            invitation = uid()
            assert send(client, "post", f"/groups/{group_id}/participants/{ids[1]}/email-invite", {"command_id": invitation}).status_code == 200
            EmailAddress.objects.filter(user=member.actor).update(verified=True)
            token = invite_token(invitation)
    else:
        invitation, token = invite(client, group_id, ids[1])
        assert send(member, "post", f"/invites/{token}/claim", {"command_id": uid()}).status_code == 200
    started, worker_pids = Event(), []
    def join():
        close_old_connections()
        try:
            actor = get_user_model().objects.get(pk=member.actor.pk if joining == "email_claim" else client.actor.pk)
            worker_pids.append(connections["default"].connection.info.backend_pid)
            started.set()
            if joining == "email_claim":
                return claim_invite(actor, token, {"command_id": uid()})
            if joining == "automatic_link":
                from .email_invites import send_person_invite
                return send_person_invite(actor, group_id, ids[1], {"command_id": uid()}, 'https://merosplit.example', 'synthetic-network')
            return review_invite(actor, group_id, invitation, {"command_id": uid()}, True)
        finally:
            connections.close_all()
    with ThreadPoolExecutor(max_workers=1) as pool:
        with transaction.atomic():
            get_user_model().objects.select_for_update(no_key=True).get(pk=member.actor.pk)
            future = pool.submit(join)
            assert started.wait(5)
            deadline = monotonic() + 5
            while True:
                with connection.cursor() as cursor:
                    cursor.execute("SELECT wait_event_type FROM pg_stat_activity WHERE pid = %s", worker_pids)
                    waiting = cursor.fetchone()
                if waiting and waiting[0] == "Lock":
                    break
                assert monotonic() < deadline, "Membership did not serialize with the profile owner"
                sleep(0.01)
            assert update_display_name(member.actor, "Name before joining") == {"display_name": "Name before joining"}
        assert future.result(timeout=5)["id"] == group_id
    state = send(member, "get", f"/groups/{group_id}/summary").json()
    person = next(row for row in state["participants"] if row["id"] == ids[1])
    assert person["name"] == "Name before joining" and person["recorded_name"] == "B"


@pytest.mark.django_db(transaction=True)
def test_approval_retries_if_claim_appears_while_waiting_for_group_lock(client, group):
    group_id, ids, _ = group
    invitation, token = invite(client, group_id, ids[1])
    member = account()
    started, worker_pids = Event(), []
    def approve():
        close_old_connections()
        try:
            actor = get_user_model().objects.get(pk=client.actor.pk)
            worker_pids.append(connections["default"].connection.info.backend_pid)
            started.set()
            try:
                review_invite(actor, group_id, invitation, {"command_id": uid()}, True)
            except HttpError as error:
                return error.status_code
        finally:
            connections.close_all()
    with ThreadPoolExecutor(max_workers=1) as pool:
        with transaction.atomic():
            Group.objects.select_for_update().get(pk=group_id)
            future = pool.submit(approve)
            assert started.wait(5)
            deadline = monotonic() + 5
            while True:
                with connection.cursor() as cursor:
                    cursor.execute("SELECT wait_event_type FROM pg_stat_activity WHERE pid = %s", worker_pids)
                    waiting = cursor.fetchone()
                if waiting and waiting[0] == "Lock":
                    break
                assert monotonic() < deadline, "Approval did not wait for the group lock"
                sleep(0.01)
            claim_invite(member.actor, token, {"command_id": uid()})
        assert future.result(timeout=5) == 409
    assert Participant.objects.get(pk=ids[1]).user_id is None
    assert send(client, "post", f"/groups/{group_id}/invites/{invitation}/approve", {"command_id": uid()}).status_code == 200
