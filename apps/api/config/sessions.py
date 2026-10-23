"""DB sessions with serialized push-device cascade collection on sign-out."""

from asgiref.sync import sync_to_async
from django.contrib.sessions.backends.db import SessionStore as DatabaseSessionStore
from django.db import transaction


class SessionStore(DatabaseSessionStore):
    def delete(self, session_key=None):
        from ledger.models import PushDevice

        key = self.session_key if session_key is None else session_key
        if key is None:
            return
        with transaction.atomic():
            row = self.model.objects.select_for_update().filter(session_key=key).first()
            if row:
                # Django collects CASCADE children before DELETE; wait for bill enqueue
                # before collecting, or its newly committed delivery can break logout.
                list(PushDevice.objects.select_for_update().filter(session_id=key).order_by("id"))
                row.delete()

    async def adelete(self, session_key=None):
        await sync_to_async(self.delete)(session_key)
