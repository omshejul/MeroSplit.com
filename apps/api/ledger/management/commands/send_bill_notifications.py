import time

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import close_old_connections
from django.utils import timezone

from ledger.activity_notifications import send_activity_notifications
from ledger.balance_statements import send_balance_statements
from ledger.bill_email import send_pending_bill_emails
from ledger.chat_notifications import send_chat_notifications
from ledger.expense_categories import process_category_decisions
from ledger.expense_notifications import send_pending_digests
from ledger.feedback import send_feedback_notifications
from ledger.membership_notifications import send_membership_notifications
from ledger.models import ExpensePushDelivery
from ledger.push import check_pending_bill_receipts, send_pending_bill_notifications


class Command(BaseCommand):
    help = "Deliver committed new-bill notifications; run once or poll as a supervised worker."

    def add_arguments(self, parser):
        parser.add_argument("--loop", action="store_true")
        parser.add_argument("--interval", type=float, default=5)
        parser.add_argument("--limit", type=int, default=100)
        parser.add_argument(
            "--retry-failed", action="store_true", help="Retry failed rows with their original event IDs"
        )

    def handle(self, *args, **options):
        if settings.PUSH_PROVIDER != "expo":
            raise CommandError("PUSH_PROVIDER=expo must be configured before starting the worker")
        if not 1 <= options["limit"] <= 1000 or not 1 <= options["interval"] <= 3600:
            raise CommandError("Use limit 1–1000 and interval 1–3600 seconds")
        if options["retry_failed"]:
            # A known ticket retries receipt lookup only; never resend an uncertain accepted push.
            ExpensePushDelivery.objects.filter(state="failed").exclude(provider_id="").update(
                state="queued", due_at=timezone.now(), lease_until=None, last_error=""
            )
            ExpensePushDelivery.objects.filter(state="failed", provider_id="").update(
                state="pending", attempts=0, due_at=timezone.now(), lease_until=None, last_error=""
            )
        try:
            while True:
                close_old_connections()
                count = send_pending_bill_notifications(limit=options["limit"])
                receipts = check_pending_bill_receipts(limit=options["limit"])
                digests = send_pending_digests(limit=options["limit"])
                mailbox_notices = send_pending_bill_emails(limit=options["limit"])
                chat = send_chat_notifications(limit=options['limit'])
                statements = send_balance_statements(limit=options['limit'])
                memberships = send_membership_notifications(limit=options['limit'])
                activity = send_activity_notifications(limit=options['limit'])
                if activity:
                    self.stdout.write(f'Processed {activity} financial notifications')
                feedback = send_feedback_notifications(limit=min(options['limit'], 5))
                if feedback:
                    self.stdout.write(f'Processed {feedback} feedback notifications')
                if count or receipts or digests or mailbox_notices or chat or statements or memberships or not options["loop"]:
                    self.stdout.write(f"Processed {count} bill notifications, {receipts} receipts and {digests} unread digests and {mailbox_notices} mailbox notices and {chat} chat deliveries and {statements} balance statements and {memberships} membership deliveries")
                # One short cosmetic request AFTER delivery work, never a catch-up drain.
                process_category_decisions()
                if not options["loop"]:
                    return
                time.sleep(options["interval"])
        except KeyboardInterrupt:
            return
