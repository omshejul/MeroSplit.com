from django.core.management.base import BaseCommand

from ledger.media import purge_stale_files


class Command(BaseCommand):
    help = "Delete up to 100 retired media objects and abandoned uploads older than one day."

    def handle(self, *args, **options):
        result = purge_stale_files()
        self.stdout.write(f"Media objects cleaned: {result['cleaned']}; pending retry: {result['pending']}")
