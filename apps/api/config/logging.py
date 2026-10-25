"""Keep public invite bearer paths out of application request/error logs."""
import logging
import re

GOOGLE_CALLBACK = re.compile(r"(/auth/google/callback)\?[^\s\"\'<>]*")

INVITE_PATH = re.compile(r"/j/[^\s\"'<>?#]+(?:\?[^\s\"'<>]*)?")


class RedactInvitePath(logging.Filter):
    def filter(self, record):
        # Django puts paths in msg/args; runserver and Uvicorn log request lines.
        record.msg = GOOGLE_CALLBACK.sub(r"\1?[redacted]", INVITE_PATH.sub("/j/[redacted]", record.getMessage()))
        record.args = ()
        if record.exc_info:
            record.exc_text = GOOGLE_CALLBACK.sub(r"\1?[redacted]", INVITE_PATH.sub("/j/[redacted]", logging.Formatter().formatException(record.exc_info)))
        return True
