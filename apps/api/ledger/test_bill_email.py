"""Notification-only mailbox delivery on isolated PostgreSQL, with fake email."""

import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier, Event
from urllib.parse import urlsplit
from uuid import uuid4

import pytest
from allauth.account.models import EmailAddress
from django.contrib.auth import get_user_model
from django.db import DatabaseError, close_old_connections, connection, connections, transaction
from django.test import Client
from django.utils import timezone

from . import bill_email, email_delivery, email_links, expense_notifications, push
from .bill_email_models import BillEmailNotice, BillEmailPreference
from .collaboration import archive_group, claim_invite, invite_token, remove_participant
from .email_invites import update_contact
from .models import (
    CommandReceipt,
    EmailLoginGrant,
    Expense,
    ExpenseNotice,
    Group,
    Invite,
    NotificationPreference,
    Participant,
)
from .otp import _verified_user
from .portability import delete_account
from .services import reverse_expense, save_expense
from .test_api import expense, uid

pytestmark = pytest.mark.django_db(transaction=True)
MAILBOX = "synthetic@example.com"


@pytest.fixture
def clock(monkeypatch):
    value = [timezone.now()]
    monkeypatch.setattr(timezone, "now", lambda: value[0])
    return value


@pytest.fixture
def provider(monkeypatch):
    calls = []

    def send(recipient, subject, text, key, **kwargs):
        assert not connection.in_atomic_block
        resolved = email_delivery.materialize_payload(kwargs.get("payload") or email_delivery.message_payload(recipient, subject, text))
        calls.append({"recipient": recipient, "key": key, "payload": resolved})
        return f"synthetic-provider-{len(calls)}"

    monkeypatch.setattr(email_delivery, "send_email", send)
    return calls


def user(email=None):
    return get_user_model().objects.create_user(username=uid(), email=email or f"{uid()}@example.invalid", first_name="Synthetic account")


@pytest.fixture
def ledger(clock):
    owner, member = user(), user()
    group = Group.objects.create(owner=owner, name="Private synthetic group", version=1)
    persons = [Participant.objects.create(group=group, user=owner, name="Private organizer"),
               Participant.objects.create(group=group, user=member, name="Private member"),
               Participant.objects.create(group=group, name="Private recipient", contact_email=MAILBOX)]
    return owner, member, group, persons


def add(ledger, *, actor=None, zero_net=False, **updates):
    owner, _, group, persons = ledger
    ids = [str(person.id) for person in persons]
    body = expense(ids, payer=0, beneficiaries=[2])
    body.update(description="Private synthetic receipt", notes="Private synthetic note", **updates)
    if zero_net:
        body["paid"] = {ids[2]: "10000"}
    save_expense(actor or owner, group.id, body)
    return body


def enabled_recipient(clock):
    actor = user(MAILBOX)
    EmailAddress.objects.create(user=actor, email=MAILBOX, verified=True, primary=True)
    NotificationPreference.objects.create(user=actor, expense_updates=True, email_reminders=True, email_enabled_at=clock[0])
    return actor


def claim(ledger, actor):
    person = ledger[3][2]
    invite_id = uuid4()
    token = invite_token(invite_id)
    Invite.objects.create(id=invite_id, participant=person, intended_email=MAILBOX,
        token_hash=hashlib.sha256(token.encode()).hexdigest(), expires_at=timezone.now() + timedelta(days=7))
    claim_invite(actor, token, {"command_id": uid()})
    person.refresh_from_db()
    assert person.user_id == actor.pk


def test_new_bill_immediate_generic_delivery_without_account_membership_or_invitation(ledger, provider):
    initial_users = get_user_model().objects.count()
    body = add(ledger)
    row = BillEmailNotice.objects.get()
    assert row.state == "pending" and row.due_at == row.created_at
    assert not provider and not EmailLoginGrant.objects.exists() and not Invite.objects.exists()
    assert bill_email.send_pending_bill_emails() == 1
    row.refresh_from_db()
    assert row.state == "accepted" and len(provider) == 1
    assert provider[0]["recipient"] == MAILBOX and provider[0]["key"] == f"bill-notice/{row.id}"
    content = json.dumps(provider[0]["payload"])
    for private in [ledger[2].name, ledger[3][2].name, body["description"], body["notes"], body["total"], str(ledger[2].id)]:
        assert private not in content
    assert "does not join a group" in provider[0]["payload"]["text"]
    assert get_user_model().objects.count() == initial_users and not Invite.objects.exists()
    assert not Participant.objects.filter(pk=row.participant_id, user__isnull=False).exists()
    grant = EmailLoginGrant.objects.get(pk=row.grant_id)
    raw = urlsplit(email_links.delivery_url(grant.id)).fragment.removeprefix("proof=")
    assert raw not in json.dumps(row.payload) and bill_email._proof(row) not in json.dumps(row.payload)
    assert "#proof=" not in json.dumps(row.payload) and grant.purpose == "notice"
    assert grant.target == {"kind": "notice", "notice_id": str(row.id)}
    recipient, _, target = email_links.exchange_email_link(grant.id, raw, "192.0.2.0/24")
    assert target == {"kind": "home"} and get_user_model().objects.count() == initial_users + 1
    assert not Participant.objects.filter(user=recipient).exists() and not Invite.objects.exists()
    assert bill_email.notification_entry(recipient) == {"needs_invitation": True}


def test_nonorganizer_new_bill_uses_same_recipient_only_path(ledger, provider):
    add(ledger, actor=ledger[1])
    row = BillEmailNotice.objects.get()
    assert row.actor_id == ledger[1].pk
    assert bill_email.send_pending_bill_emails() == 1 and len(provider) == 1
    assert not Invite.objects.exists()


def test_paid_or_share_involvement_includes_zero_net_and_excludes_unrelated_people(ledger, provider):
    Participant.objects.create(group=ledger[2], name="Unrelated", contact_email="other-synthetic@example.com")
    add(ledger, zero_net=True)
    assert list(BillEmailNotice.objects.values_list("participant_id", flat=True)) == [ledger[3][2].id]
    bill_email.send_pending_bill_emails()
    assert len(provider) == 1


def test_same_command_replay_edits_and_reversal_never_queue_another_new_bill(ledger, provider):
    body = add(ledger)
    save_expense(ledger[0], ledger[2].id, body)
    body.update(command_id=uid(), version=1, description="Changed private description")
    save_expense(ledger[0], ledger[2].id, body, body["id"])
    assert BillEmailNotice.objects.count() == 1
    reverse_expense(ledger[0], ledger[2].id, body["id"], {"command_id": uid(), "version": 2})
    bill_email.send_pending_bill_emails()
    assert BillEmailNotice.objects.count() == 1 and not provider


def test_contact_save_and_existing_history_never_send_or_backfill(ledger, provider):
    person = ledger[3][2]
    person.contact_email = ""
    person.save(update_fields=["contact_email"])
    add(ledger)
    assert not BillEmailNotice.objects.exists()
    update_contact(ledger[0], ledger[2].id, person.id, {"command_id": uid(), "email": MAILBOX})
    assert bill_email.send_pending_bill_emails() == 0
    assert not BillEmailNotice.objects.exists() and not provider and not Invite.objects.exists()


def test_failed_bill_transaction_rolls_back_notice_and_same_command_can_retry(ledger, provider, monkeypatch):
    original = push.queue_new_bill

    def fail_after_notice(bill, actor):
        original(bill, actor)
        assert BillEmailNotice.objects.exists()
        raise RuntimeError("synthetic transaction failure")

    monkeypatch.setattr(push, "queue_new_bill", fail_after_notice)
    body = expense([str(person.id) for person in ledger[3]], payer=0, beneficiaries=[2])
    with pytest.raises(RuntimeError):
        save_expense(ledger[0], ledger[2].id, body)
    assert not Expense.objects.exists() and not BillEmailNotice.objects.exists() and not CommandReceipt.objects.exists()
    monkeypatch.setattr(push, "queue_new_bill", original)
    save_expense(ledger[0], ledger[2].id, body)
    save_expense(ledger[0], ledger[2].id, body)
    bill_email.send_pending_bill_emails()
    assert len(provider) == 1 and BillEmailNotice.objects.count() == 1


@pytest.mark.parametrize("preference", ["absent", "email_off", "master_off", "mailbox_off"])
def test_known_current_account_off_and_mailbox_suppression_are_preserved(ledger, provider, clock, preference):
    recipient = user(MAILBOX)
    EmailAddress.objects.create(user=recipient, email=MAILBOX, verified=True, primary=True)
    if preference != "absent":
        NotificationPreference.objects.create(user=recipient, expense_updates=preference != "master_off",
            email_reminders=preference != "email_off", email_enabled_at=clock[0])
    if preference == "mailbox_off":
        BillEmailPreference.objects.create(email_digest=bill_email.mailbox_digest(MAILBOX), suppressed=True)
    add(ledger)
    assert BillEmailNotice.objects.get().state == "cancelled"
    bill_email.send_pending_bill_emails()
    assert not provider and not EmailLoginGrant.objects.exists()


def test_existing_optin_does_not_auto_link_and_off_before_final_boundary_wins(ledger, provider, clock, monkeypatch):
    recipient = enabled_recipient(clock)
    add(ledger)
    original = bill_email._prepare

    def turn_off_after_prepare(*args):
        row = original(*args)
        NotificationPreference.objects.filter(user=recipient).update(email_reminders=False)
        return row

    monkeypatch.setattr(bill_email, "_prepare", turn_off_after_prepare)
    bill_email.send_pending_bill_emails()
    assert not provider and not Participant.objects.filter(user=recipient).exists()
    assert BillEmailNotice.objects.get().state == "cancelled"


@pytest.mark.parametrize("reason", ["contact", "deleted", "archived", "removed", "involvement", "actor_inactive", "actor_deleted", "group_deleted"])
def test_current_mutations_suppress_queued_delivery(ledger, provider, reason):
    body = add(ledger, actor=ledger[1], zero_net=reason == "removed")
    if reason == "contact":
        update_contact(ledger[0], ledger[2].id, ledger[3][2].id, {"command_id": uid(), "email": "changed-synthetic@example.com"})
    elif reason == "deleted":
        reverse_expense(ledger[0], ledger[2].id, body["id"], {"command_id": uid(), "version": 1})
    elif reason == "archived":
        archive_group(ledger[0], ledger[2].id, {"command_id": uid(), "archived": True})
    elif reason == "removed":
        remove_participant(ledger[0], ledger[2].id, ledger[3][2].id, {"command_id": uid()})
    elif reason == "involvement":
        body.update(command_id=uid(), version=1, split={"mode": "equal", "values": {str(ledger[3][0].id): "1"}})
        save_expense(ledger[0], ledger[2].id, body, body["id"])
    elif reason == "actor_inactive":
        get_user_model().objects.filter(pk=ledger[1].pk).update(is_active=False)
    elif reason == "actor_deleted":
        delete_account(ledger[1])
    else:
        ledger[2].delete()
    bill_email.send_pending_bill_emails()
    assert not provider


@pytest.mark.parametrize("change", ["inactive", "deleted", "email_changed"])
def test_known_recipient_identity_change_cannot_send_to_old_address(ledger, provider, clock, change):
    recipient = enabled_recipient(clock)
    add(ledger)
    if change == "inactive":
        get_user_model().objects.filter(pk=recipient.pk).update(is_active=False)
    elif change == "email_changed":
        get_user_model().objects.filter(pk=recipient.pk).update(email="changed-synthetic@example.com")
    else:
        delete_account(recipient)
    bill_email.send_pending_bill_emails()
    assert not provider


def test_burst_is_coalesced_to_one_generic_delivery_and_no_replay(ledger, provider, clock):
    for _ in range(4):
        add(ledger)
    bill_email.send_pending_bill_emails()
    assert len(provider) == 1 and BillEmailNotice.objects.filter(state="accepted").count() == 4
    assert BillEmailNotice.objects.filter(delivery__isnull=True).count() == 1
    clock[0] += timedelta(days=2)
    assert bill_email.send_pending_bill_emails() == 0 and len(provider) == 1


def test_ambiguous_provider_retry_freezes_key_body_expiry_and_holds_after_23_hours(ledger, provider, clock, monkeypatch, settings):
    add(ledger)
    calls = []

    def uncertain(recipient, subject, text, key, **kwargs):
        assert not connection.in_atomic_block
        calls.append((key, email_delivery.materialize_payload(kwargs["payload"])))
        raise email_delivery.EmailDeliveryUnavailable()

    monkeypatch.setattr(email_delivery, "send_email", uncertain)
    bill_email.send_pending_bill_emails()
    row = BillEmailNotice.objects.get()
    grant = EmailLoginGrant.objects.get(pk=row.grant_id)
    frozen = row.payload, row.first_attempt_at, grant.expires_at
    settings.PUBLIC_WEB_URL = "https://changed.example.invalid"
    settings.DEFAULT_FROM_EMAIL = "Changed sender <changed@example.com>"
    monkeypatch.setattr(email_delivery, "render_message", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("Do not rerender frozen delivery")))
    clock[0] += timedelta(minutes=3)
    bill_email.send_pending_bill_emails()
    assert len(calls) == 2 and calls[0] == calls[1]
    row.refresh_from_db()
    assert (row.payload, row.first_attempt_at, EmailLoginGrant.objects.get(pk=row.grant_id).expires_at) == frozen
    clock[0] = row.first_attempt_at + timedelta(hours=23)
    bill_email.send_pending_bill_emails()
    row.refresh_from_db()
    assert row.state == "held" and row.last_error == "delivery_uncertain" and len(calls) == 2


def test_expired_worker_lease_reuses_frozen_delivery(ledger, provider, clock):
    add(ledger)
    row_id, lease = bill_email._claim()
    prepared = bill_email._prepare(row_id, lease)
    frozen = prepared.payload, prepared.first_attempt_at, prepared.grant_id
    clock[0] += timedelta(minutes=3)
    bill_email.send_pending_bill_emails()
    row = BillEmailNotice.objects.get()
    assert len(provider) == 1 and row.state == "accepted" and row.attempts == 2
    assert (row.payload, row.first_attempt_at, row.grant_id) == frozen


def test_optout_previews_are_inert_post_requires_csrf_and_exact_proof(ledger, provider):
    add(ledger)
    bill_email.send_pending_bill_emails()
    row = BillEmailNotice.objects.get()
    client = Client(enforce_csrf_checks=True)
    path = f"/bill-email/opt-out/{row.id}"
    assert client.get(path).status_code == 200 and client.head(path).status_code == 200
    assert not BillEmailPreference.objects.filter(suppressed=True).exists()
    assert client.post(path, {"proof": bill_email._proof(row)}).status_code == 403
    csrf = client.cookies["csrftoken"].value
    assert client.post(path, {"proof": "a" * 64}, HTTP_X_CSRFTOKEN=csrf).status_code == 400
    assert not BillEmailPreference.objects.filter(suppressed=True).exists()
    assert client.post(path, {"proof": bill_email._proof(row)}, HTTP_X_CSRFTOKEN=csrf).status_code == 200
    assert BillEmailPreference.objects.get().suppressed
    add(ledger)
    bill_email.send_pending_bill_emails()
    assert len(provider) == 1


@pytest.mark.parametrize("attempted", [False, True])
def test_actual_verified_claim_promotes_current_event_once_without_second_email(ledger, provider, clock, attempted):
    recipient = enabled_recipient(clock)
    body = add(ledger)
    if attempted:
        bill_email.send_pending_bill_emails()
        assert len(provider) == 1
    claim(ledger, recipient)
    assert ExpenseNotice.objects.filter(expense_id=body["id"], recipient=recipient).count() == 1
    notice = ExpenseNotice.objects.get(expense_id=body["id"])
    assert notice.email_eligible is not attempted
    with transaction.atomic():
        Group.objects.select_for_update().get(pk=ledger[2].id)
        bill_email.promote_current_bill_emails(ledger[3][2])
    assert ExpenseNotice.objects.filter(expense_id=body["id"]).count() == 1
    bill_email.send_pending_bill_emails()
    clock[0] += timedelta(minutes=10)
    expense_notifications.send_pending_digests()
    assert len(provider) == 1  # immediate when attempted; otherwise ordinary delayed unread.


def test_claim_after_ambiguous_send_never_enqueues_second_delayed_email(ledger, provider, clock, monkeypatch):
    recipient = enabled_recipient(clock)
    body = add(ledger)

    def uncertain(*args, **kwargs):
        raise email_delivery.EmailDeliveryUnavailable()

    monkeypatch.setattr(email_delivery, "send_email", uncertain)
    bill_email.send_pending_bill_emails()
    claim(ledger, recipient)
    assert not ExpenseNotice.objects.get(expense_id=body["id"]).email_eligible
    clock[0] += timedelta(minutes=10)
    assert expense_notifications.send_pending_digests() == 0


def _worker(function):
    close_old_connections()
    try:
        return function()
    finally:
        connections.close_all()


def test_two_workers_coalesce_same_mailbox_without_duplicate_delivery(ledger, provider):
    add(ledger)
    add(ledger)
    barrier = Barrier(2)

    def run():
        barrier.wait(timeout=10)
        return bill_email.send_pending_bill_emails()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: _worker(run), range(2)))
    assert sum(results) >= 1 and len(provider) == 1
    assert BillEmailNotice.objects.filter(state="accepted").count() == 2


def test_account_deletion_waits_for_mailbox_before_any_shared_group_lock(ledger, provider, clock):
    recipient = enabled_recipient(clock)
    add(ledger)
    claim(ledger, recipient)
    mailbox = BillEmailPreference.objects.create(email_digest=bill_email.mailbox_digest(MAILBOX))
    trying_mailbox = Event()

    def delete():
        def track(execute, sql, params, many, context):
            if '"ledger_billemailpreference"' in sql and "FOR UPDATE" in sql:
                trying_mailbox.set()
            return execute(sql, params, many, context)

        with connection.execute_wrapper(track):
            return delete_account(recipient)

    with ThreadPoolExecutor(max_workers=1) as pool:
        with transaction.atomic():
            BillEmailPreference.objects.select_for_update().get(pk=mailbox.pk)
            future = pool.submit(_worker, delete)
            assert trying_mailbox.wait(10)
            try:
                with transaction.atomic():
                    Group.objects.select_for_update(nowait=True).get(pk=ledger[2].id)
                group_available = True
            except DatabaseError:
                group_available = False
        assert future.result(timeout=10) == {"deleted": True}
    assert group_available, "Deletion must not hold a group while waiting for the worker's mailbox lock"
    assert not BillEmailNotice.objects.exists() and not provider


def test_claim_of_captured_off_event_adds_in_app_once_but_keeps_email_off(ledger, provider, clock):
    recipient = enabled_recipient(clock)
    NotificationPreference.objects.filter(user=recipient).update(email_reminders=False)
    body = add(ledger)
    assert BillEmailNotice.objects.get().state == "cancelled"
    claim(ledger, recipient)
    row = ExpenseNotice.objects.get(expense_id=body["id"], recipient=recipient)
    assert not row.email_eligible
    clock[0] += timedelta(minutes=10)
    assert expense_notifications.send_pending_digests() == 0 and not provider


def test_optout_also_suppresses_later_linked_account_digest(ledger, provider, clock):
    recipient = enabled_recipient(clock)
    add(ledger)
    bill_email.send_pending_bill_emails()
    row = BillEmailNotice.objects.get()
    bill_email.opt_out(row.id, bill_email._proof(row))
    claim(ledger, recipient)
    add(ledger)
    assert ExpenseNotice.objects.filter(recipient=recipient).count() == 2
    clock[0] += timedelta(minutes=10)
    assert expense_notifications.send_pending_digests() == 0 and len(provider) == 1


def test_generic_next_action_survives_primary_batch_person_claim_while_other_group_stays_unclaimed(ledger, provider, clock):
    recipient = enabled_recipient(clock)
    owner, member, _, _ = ledger
    group = Group.objects.create(owner=owner, name="Other private group", version=1)
    persons = [Participant.objects.create(group=group, user=owner, name="Organizer"),
               Participant.objects.create(group=group, user=member, name="Member"),
               Participant.objects.create(group=group, name="Unclaimed", contact_email=MAILBOX)]
    other = owner, member, group, persons
    add(ledger)
    add(other)
    bill_email.send_pending_bill_emails()
    parent = BillEmailNotice.objects.get(delivery__isnull=True)
    claim(ledger if parent.expense.group_id == ledger[2].id else other, recipient)
    assert BillEmailNotice.objects.filter(state="accepted", participant__user__isnull=True).count() == 1
    assert bill_email.notification_entry(recipient) == {"needs_invitation": True}
    assert len(provider) == 1


def test_recipient_delete_between_grant_read_and_materialization_is_safe(ledger, provider, clock, monkeypatch):
    recipient = enabled_recipient(clock)
    add(ledger)
    original = bill_email.delivery_stop_url

    def remove_before_stop_url(grant):
        delete_account(recipient)
        return original(grant)

    monkeypatch.setattr(bill_email, "delivery_stop_url", remove_before_stop_url)
    bill_email.send_pending_bill_emails()
    assert not BillEmailNotice.objects.exists() and not EmailLoginGrant.objects.exists() and not provider


@pytest.mark.parametrize("change", ["contact", "claim", "delete"])
def test_last_boundary_rechecks_committed_contact_claim_and_deletion(ledger, provider, clock, monkeypatch, change):
    recipient = enabled_recipient(clock)
    add(ledger)
    original = bill_email._prepare

    def mutate_after_prepare(*args):
        row = original(*args)
        if change == "contact":
            update_contact(ledger[0], ledger[2].id, ledger[3][2].id, {"command_id": uid(), "email": "changed-synthetic@example.com"})
        elif change == "claim":
            claim(ledger, recipient)
        else:
            delete_account(recipient)
        return row

    monkeypatch.setattr(bill_email, "_prepare", mutate_after_prepare)
    bill_email.send_pending_bill_emails()
    assert not provider


def test_inflight_claim_preserves_notice_but_never_adds_delayed_email(ledger, provider, clock, monkeypatch):
    recipient = enabled_recipient(clock)
    body = add(ledger)
    original = email_delivery.send_email

    def claim_during_provider(*args, **kwargs):
        provider_id = original(*args, **kwargs)
        claim(ledger, recipient)
        return provider_id

    monkeypatch.setattr(email_delivery, "send_email", claim_during_provider)
    bill_email.send_pending_bill_emails()
    assert len(provider) == 1
    notice = ExpenseNotice.objects.get(expense_id=body["id"], recipient=recipient)
    assert not notice.email_eligible
    clock[0] += timedelta(minutes=10)
    assert expense_notifications.send_pending_digests() == 0


@pytest.mark.parametrize("kind", ["invalid_domain", "reviewer", "conflicting_identity", "self_mail"])
def test_invalid_demo_conflicting_and_actor_mailboxes_never_receive_notices(ledger, provider, settings, kind):
    target = ledger[3][2]
    if kind == "invalid_domain":
        target.contact_email = "synthetic@example.invalid"
    elif kind == "self_mail":
        target.contact_email = ledger[0].email
    elif kind == "reviewer":
        reviewer = user(MAILBOX)
        settings.STORE_REVIEW_AUTH = [{"store": "apple", "user_id": reviewer.pk, "email": MAILBOX, "pin_hash": ""}]
    else:
        user(MAILBOX)
        user(MAILBOX)
    target.save(update_fields=["contact_email"])
    add(ledger)
    assert not BillEmailNotice.objects.exists()
    assert bill_email.send_pending_bill_emails() == 0 and not provider


@pytest.mark.parametrize("channel", ["master", "email"])
def test_off_then_on_never_replays_previously_pending_unclaimed_event(ledger, provider, clock, channel):
    recipient = enabled_recipient(clock)
    add(ledger)
    assert BillEmailNotice.objects.get().issued_user_id == recipient.pk
    clock[0] += timedelta(minutes=1)
    expense_notifications.update_preferences(recipient, channel != "master", channel != "email")
    clock[0] += timedelta(minutes=1)
    expense_notifications.update_preferences(recipient, True, True)
    bill_email.send_pending_bill_emails()
    assert not provider
    clock[0] += timedelta(minutes=1)
    add(ledger)
    bill_email.send_pending_bill_emails()
    assert len(provider) == 1  # Only a later ordinary creation is eligible.


def test_same_bill_command_from_two_connections_captures_exactly_one_notice(ledger, provider):
    body = expense([str(person.id) for person in ledger[3]], payer=0, beneficiaries=[2])
    barrier = Barrier(2)

    def run():
        barrier.wait(timeout=10)
        return save_expense(ledger[0], ledger[2].id, body)

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: _worker(run), range(2)))
    assert results[0] == results[1] and Expense.objects.count() == BillEmailNotice.objects.count() == 1
    bill_email.send_pending_bill_emails()
    assert len(provider) == 1


@pytest.mark.parametrize("claim_before_send", [False, True])
def test_unknown_current_intent_survives_first_disclosed_account_enable_and_claim(ledger, provider, clock, claim_before_send):
    body = add(ledger)
    intent = BillEmailNotice.objects.get()
    assert intent.issued_user_id is None and not get_user_model().objects.filter(email=MAILBOX).exists()
    clock[0] += timedelta(minutes=1)
    # This is the existing successful OTP identity-creation path, with the
    # rendered new-account disclosure. It sends no email at this boundary.
    with transaction.atomic():
        recipient, _ = _verified_user(MAILBOX, email_reminders_disclosed=True)
    pref = NotificationPreference.objects.get(user=recipient)
    assert pref.email_reminders and pref.email_enabled_at > intent.created_at
    if not claim_before_send:
        bill_email.send_pending_bill_emails()
        assert len(provider) == 1
    claim(ledger, recipient)
    notice = ExpenseNotice.objects.get(expense_id=body["id"], recipient=recipient)
    assert notice.email_eligible is claim_before_send
    with transaction.atomic():
        Group.objects.select_for_update().get(pk=ledger[2].id)
        bill_email.promote_current_bill_emails(ledger[3][2])
    assert ExpenseNotice.objects.filter(expense_id=body["id"], recipient=recipient).count() == 1
    bill_email.send_pending_bill_emails()
    clock[0] += timedelta(minutes=10)
    expense_notifications.send_pending_digests()
    assert len(provider) == 1
    expense_notifications.send_pending_digests()
    assert len(provider) == 1


def test_deleted_prepared_batch_leader_keeps_valid_sibling_delivery_login_and_claim(ledger, provider, clock, monkeypatch):
    recipient = enabled_recipient(clock)
    first = add(ledger)
    clock[0] += timedelta(seconds=1)
    second = add(ledger)
    original = bill_email._prepare
    frozen = []

    def delete_leader_after_prepare(*args):
        prepared = original(*args)
        if prepared and not frozen:
            assert str(prepared.expense_id) == first["id"]
            sibling = BillEmailNotice.objects.get(expense_id=second["id"])
            assert sibling.delivery_id == prepared.id and sibling.state == "batched"
            frozen.append((prepared.id, prepared.payload, prepared.grant_id, prepared.first_attempt_at))
            reverse_expense(ledger[0], ledger[2].id, first["id"], {"command_id": uid(), "version": 1})
        return prepared

    monkeypatch.setattr(bill_email, "_prepare", delete_leader_after_prepare)
    bill_email.send_pending_bill_emails()
    assert len(provider) == 1
    assert provider[0]["key"] == f"bill-notice/{frozen[0][0]}"
    leader = BillEmailNotice.objects.get(pk=frozen[0][0])
    assert (leader.payload, leader.grant_id, leader.first_attempt_at) == frozen[0][1:]
    grant = EmailLoginGrant.objects.get(pk=leader.grant_id)
    proof = urlsplit(email_links.delivery_url(grant.id)).fragment.removeprefix("proof=")
    identity, _, destination = email_links.exchange_email_link(grant.id, proof, "192.0.2.0/24")
    assert identity.pk == recipient.pk and destination == {"kind": "home"}
    claim(ledger, recipient)
    assert not ExpenseNotice.objects.filter(expense_id=first["id"], recipient=recipient).exists()
    notice = ExpenseNotice.objects.get(expense_id=second["id"], recipient=recipient)
    assert not notice.email_eligible
    with transaction.atomic():
        Group.objects.select_for_update().get(pk=ledger[2].id)
        bill_email.promote_current_bill_emails(ledger[3][2])
    assert ExpenseNotice.objects.filter(expense_id=second["id"], recipient=recipient).count() == 1
    clock[0] += timedelta(minutes=10)
    bill_email.send_pending_bill_emails()
    expense_notifications.send_pending_digests()
    assert len(provider) == 1


@pytest.mark.parametrize('channel', ['master', 'email'])
def test_first_account_off_cycle_cancels_already_prepared_unknown_batch(ledger, provider, clock, monkeypatch, channel):
    add(ledger)
    clock[0] += timedelta(seconds=1)
    add(ledger)
    original = bill_email._prepare
    account = []
    def switch_off_after_prepare(*args):
        prepared = original(*args)
        if prepared and not account:
            with transaction.atomic():
                recipient, _ = _verified_user(MAILBOX, email_reminders_disclosed=True)
            account.append(recipient)
            expense_notifications.update_preferences(recipient, channel != 'master', channel != 'email')
            clock[0] += timedelta(seconds=1)
            expense_notifications.update_preferences(recipient, True, True)
        return prepared
    monkeypatch.setattr(bill_email, '_prepare', switch_off_after_prepare)
    bill_email.send_pending_bill_emails()
    assert not provider
    assert set(BillEmailNotice.objects.values_list('state', flat=True)) == {'cancelled'}
    claim(ledger, account[0])
    assert ExpenseNotice.objects.count() == 2
    assert not ExpenseNotice.objects.filter(email_eligible=True).exists()
    clock[0] += timedelta(minutes=10)
    bill_email.send_pending_bill_emails()
    expense_notifications.send_pending_digests()
    assert not provider


def test_cloudflare_uncertain_bill_mail_holds_immediately(ledger, provider, clock, monkeypatch, settings):
    settings.EMAIL_PROVIDER = "cloudflare"
    add(ledger)
    calls = []
    def held(*args, **kwargs):
        calls.append(1)
        raise email_delivery.EmailDeliveryHeld()
    monkeypatch.setattr(email_delivery, "send_email", held)
    bill_email.send_pending_bill_emails()
    row = BillEmailNotice.objects.get()
    assert row.state == "held" and row.payload["_email_provider"] == "cloudflare"
    frozen = row.payload
    clock[0] += timedelta(minutes=5)
    bill_email.send_pending_bill_emails()
    row.refresh_from_db()
    assert calls == [1] and row.payload == frozen and row.attempts == 1
