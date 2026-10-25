"""Keep public invite bearer paths out of application request/error logs."""
import logging
import re

INVITE_PATH = re.compile(r"/j/[^\s\"'<>?#]+(?:\?[^\s\"'<>]*)?")


class RedactInvitePath(logging.Filter):
    def filter(self, record):
        # Django puts paths in msg/args; runserver and Uvicorn log request lines.
        record.msg = INVITE_PATH.sub("/j/[redacted]", record.getMessage())
        record.args = ()
        if record.exc_info:
            record.exc_text = INVITE_PATH.sub("/j/[redacted]", logging.Formatter().formatException(record.exc_info))
        return True
