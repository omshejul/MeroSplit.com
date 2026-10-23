"""Private support review through the existing authorized server operator CLI."""
import sys

from django.core.management.base import BaseCommand, CommandError

from ledger.bill_chat import hide_reported_message
from ledger.models import BillChatReport


class Command(BaseCommand):
    help = 'Review private bill-chat reports. Only existing authorized server operators may run this command.'

    def add_arguments(self, parser):
        parser.add_argument('--show', type=str)
        parser.add_argument('--hide', type=str)
        parser.add_argument('--limit', type=int, default=20)

    def handle(self, *args, **options):
        if not 1 <= options['limit'] <= 100 or options['show'] and options['hide']:
            raise CommandError('Choose one action and limit1–100')
        if options['hide']:
            hide_reported_message(options['hide'])
            self.stdout.write('Reported chat message hidden. Financial records unchanged.')
        elif options['show']:
            if not sys.stdin.isatty():
                raise CommandError('Private report content requires an interactive authorized terminal; do not stream it into worker logs.')
            row = BillChatReport.objects.select_related('message').get(pk=options['show'])
            self.stdout.write(f'{row.id}\nReport: {row.reason}\nMessage: {row.message.text if row.message else "Content removed"}')
        else:
            for row in BillChatReport.objects.filter(reviewed_at__isnull=True).order_by('created_at', 'id')[:options['limit']]:
                self.stdout.write(f'{row.id} {row.kind} {row.created_at.isoformat()}')
