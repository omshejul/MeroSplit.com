"""Error diagnostics without request data, record contents or local variables."""

import os

import sentry_sdk
from sentry_sdk.integrations.django import DjangoIntegration
from sentry_sdk.integrations.logging import LoggingIntegration


def scrub_event(event, hint):
    for key in ("request", "user", "extra", "breadcrumbs", "logentry", "message", "transaction", "threads"):
        event.pop(key, None)
    event.pop("server_name", None)
    for exception in event.get("exception", {}).get("values", []):
        exception["value"] = "[redacted]"
        for frame in exception.get("stacktrace", {}).get("frames", []):
            for key in ("vars", "pre_context", "context_line", "post_context"):
                frame.pop(key, None)
    return event


def init_sentry():
    if not os.environ.get("SENTRY_DSN"):
        return
    sentry_sdk.init(
        dsn=os.environ["SENTRY_DSN"],
        environment=os.environ.get("SENTRY_ENVIRONMENT", "production"),
        release=os.environ.get("SENTRY_RELEASE") or os.environ.get("RAILWAY_GIT_COMMIT_SHA"),
        integrations=[DjangoIntegration(), LoggingIntegration(level=None, event_level=None)],
        send_default_pii=False,
        include_local_variables=False,
        max_request_body_size="never",
        max_breadcrumbs=0,
        traces_sample_rate=0,
        before_send=scrub_event,
    )
