"""Ten-minute policy boundaries on isolated PostgreSQL; provider calls are fake."""
import importlib
from datetime import timedelta

import pytest
from django.apps import apps
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import Client

from . import expense_notifications as notifications
from .models import ExpenseDigest, ExpenseNotice, NotificationPreference
from .test_api import client as client
from .test_api import group as group
from .test_api import send, uid
from .test_expense_notifications import add_bill, enable, seen
from .test_expense_notifications import clock as clock
from .test_expense_notifications import providers as providers
from .test_expense_notifications import recipient as recipient

pytestmark = pytest.mark.django_db(transaction=True)


def test_without_mobile_binding_or_foreground_delay_and_never_repeats(client, group, recipient, clock, providers):
    enable(recipient)
    add_bill(client, group)
    assert ExpenseNotice.objects.get().email_policy == 1
    for _ in range(9):
        clock[0] += timedelta(minutes=1)
        send(recipient, "post", "/me/notifications/foreground", {})
        assert notifications.send_pending_digests() == 0
    clock[0] += timedelta(minutes=1)
    assert notifications.send_pending_digests() == 1
    assert len(providers["email"]) == 1 and not providers["push"]
    clock[0] += timedelta(days=10)
    assert notifications.send_pending_digests() == 0


@pytest.mark.parametrize("web", [True, False])
def test_exact_visible_current_revision_on_web_or_native_cancels_due_email(client, group, recipient, clock, providers, web):
    enable(recipient)
    bill = add_bill(client, group)
    row = ExpenseNotice.objects.get()
    bill.update(command_id=uid(), version=1, description="Current synthetic revision")
    assert send(client, "put", f"/groups/{group[0]}/expenses/{bill['id']}", bill).status_code == 200
    actor = recipient
    if web:
        actor = Client(enforce_csrf_checks=True)
        actor.force_login(recipient.actor)
        # CSRF token is public random state, not an authentication credential.
        actor.cookies['csrftoken'] = 'a' * 32
        actor.defaults['HTTP_X_CSRFTOKEN'] = 'a' * 32
    assert seen(actor, [{"id": str(row.id), "expense_version": 1}]).json() == {"seen": 0}
    assert seen(actor, [{"id": str(row.id), "expense_version": 2}]).json() == {"seen": 1}
    clock[0] += timedelta(minutes=10)
    assert notifications.send_pending_digests() == 0 and not providers["email"]


def test_historical_unassigned_and_frozen_daily_batch_do_not_send_or_block_fresh_bill(client, group, recipient, clock, providers):
    enable(recipient)
    first = add_bill(client, group)
    second = add_bill(client, group)
    clock[0] += timedelta(days=2)
    identifier = notifications.create_due_digest()
    digest = ExpenseDigest.objects.get(pk=identifier)
    ExpenseNotice.objects.filter(expense_id__in=[first['id'], second['id']]).update(email_policy=0)
    # Simulate already frozen daily work and an unassigned historical notice.
    ExpenseNotice.objects.filter(expense_id=second['id']).update(digest=None)
    frozen = (digest.payload, digest.first_attempt_at, digest.attempts)
    migration = importlib.import_module('ledger.migrations.0016_unseen_email_timing')
    migration.cancel_legacy_email(apps, None)
    digest.refresh_from_db()
    assert digest.state == 'cancelled' and digest.lease_id is None
    assert (digest.payload, digest.first_attempt_at, digest.attempts) == frozen
    ExpenseNotice.objects.filter(expense_id=second['id']).update(email_eligible=True)
    assert notifications.send_pending_digests() == 0 and not providers['email']
    add_bill(client, group)
    clock[0] += timedelta(minutes=10)
    assert notifications.send_pending_digests() == 1 and len(providers['email']) == 1
    assert ExpenseNotice.objects.filter(email_policy=0, digest__state='accepted').count() == 0


def test_cutover_preserves_uncertain_hold_and_current_preferences(client, group, recipient, clock):
    enable(recipient)
    add_bill(client, group)
    clock[0] += timedelta(minutes=10)
    digest = ExpenseDigest.objects.get(pk=notifications.create_due_digest())
    ExpenseDigest.objects.filter(pk=digest.pk).update(state='held', first_attempt_at=clock[0], attempts=8, last_error='ambiguous_delivery')
    migration = importlib.import_module('ledger.migrations.0016_unseen_email_timing')
    migration.cancel_legacy_email(apps, None)
    digest.refresh_from_db()
    assert digest.state == 'held' and digest.attempts == 8 and digest.first_attempt_at == clock[0]
    assert NotificationPreference.objects.get(user=recipient.actor).email_reminders


def test_atomic_cutover_historical_silence_and_fresh_old_writer_delivery(client, group, recipient, clock, providers):
    enable(recipient)
    add_bill(client, group)
    executor = MigrationExecutor(connection)
    latest = executor.loader.graph.leaf_nodes()
    try:
        executor.migrate([('ledger', '0015_bind_email_invitation_identity')])
        executor = MigrationExecutor(connection)
        old = executor.loader.project_state([('ledger', '0015_bind_email_invitation_identity')]).apps
        old_notice = old.get_model('ledger', 'ExpenseNotice')
        old_expense = old.get_model('ledger', 'Expense')
        old_person = old.get_model('ledger', 'Participant')
        assert old_notice.objects.get().email_eligible
        executor.migrate(latest)
        historical = ExpenseNotice.objects.get()
        assert historical.email_policy == 0 and not historical.email_eligible
        # These old ORM classes omit BOTH new columns. Database defaults, not
        # current Python constructors, must keep rolling API writers working.
        late_person = old_person.objects.create(group_id=group[0], name='Late old-writer person')
        from .models import Participant
        assert Participant.objects.get(pk=late_person.pk).hidden is False
        bill = old_expense.objects.create(group_id=group[0], description='Fresh post-cutover bill', total=100,
            paid={group[1][0]: '100'}, shares={group[1][1]: '100'},
            split={'mode': 'exact', 'values': {group[1][1]: '100'}}, date='2026-10-18')
        late = old_notice.objects.create(expense_id=bill.pk, recipient_id=recipient.actor.pk, expense_version=1,
            created_at=clock[0], push_due_at=clock[0] + timedelta(seconds=30), email_eligible=True)
        assert ExpenseNotice.objects.get(pk=late.pk).email_policy == 1
        with connection.cursor() as cursor:
            cursor.execute("SELECT column_default FROM information_schema.columns WHERE table_name='ledger_expensenotice' AND column_name='email_policy'")
            assert cursor.fetchone()[0] == '1'
            cursor.execute("SELECT column_default FROM information_schema.columns WHERE table_name='ledger_participant' AND column_name='hidden'")
            assert cursor.fetchone()[0] == 'false'
        clock[0] += timedelta(minutes=9, seconds=59)
        assert notifications.send_pending_digests() == 0
        clock[0] += timedelta(seconds=1)
        assert notifications.send_pending_digests() == 1 and len(providers['email']) == 1
        assert ExpenseNotice.objects.get(pk=late.pk).digest.state == 'accepted'
        assert ExpenseNotice.objects.get(pk=historical.pk).digest_id is None
        migration = importlib.import_module('ledger.migrations.0016_unseen_email_timing')
        assert migration.Migration.atomic
    finally:
        MigrationExecutor(connection).migrate(latest)


def test_real_cutover_keeps_held_audit_but_delivers_only_fresh_generation(client, group, recipient, clock, providers):
    enable(recipient)
    bill = add_bill(client, group)
    clock[0] += timedelta(minutes=10)
    identifier = notifications.create_due_digest()
    ExpenseDigest.objects.filter(pk=identifier).update(state='held', first_attempt_at=clock[0], attempts=8,
        provider_id='uncertain-provider-receipt', last_error='ambiguous_delivery')
    executor = MigrationExecutor(connection)
    latest = executor.loader.graph.leaf_nodes()
    try:
        executor.migrate([('ledger', '0015_bind_email_invitation_identity')])
        executor = MigrationExecutor(connection)
        historical_apps = executor.loader.project_state([('ledger', '0015_bind_email_invitation_identity')]).apps
        old_digest = historical_apps.get_model('ledger', 'ExpenseDigest')
        old_notice = historical_apps.get_model('ledger', 'ExpenseNotice')
        frozen_digest = old_digest.objects.filter(pk=identifier).values().get()
        frozen_notice = old_notice.objects.filter(expense_id=bill['id']).values().get()
        executor.migrate(latest)
        assert ExpenseDigest.objects.get(pk=identifier).email_policy == 0
        # Migration may disable email eligibility, but cannot erase or reassign
        # an uncertain attempt's content, lease/audit, key or original notices.
        assert {key: value for key, value in ExpenseDigest.objects.filter(pk=identifier).values().get().items()
                if key != 'email_policy'} == frozen_digest
        add_bill(client, group)
        clock[0] += timedelta(minutes=10)
        assert notifications.send_pending_digests() == 1
        assert len(providers['email']) == 1
        assert providers['email'][0]['key'] != f'expense-digest/{identifier}'
        assert ExpenseDigest.objects.get(state='accepted').email_policy == 1
        assert {key: value for key, value in ExpenseDigest.objects.filter(pk=identifier).values().get().items()
                if key != 'email_policy'} == frozen_digest
        after = ExpenseNotice.objects.filter(expense_id=bill['id']).values().get()
        assert {key: value for key, value in after.items() if key not in {'email_policy', 'email_eligible'}} == {
            key: value for key, value in frozen_notice.items() if key != 'email_eligible'}
        assert not after['email_eligible'] and after['email_policy'] == 0
    finally:
        MigrationExecutor(connection).migrate(latest)
