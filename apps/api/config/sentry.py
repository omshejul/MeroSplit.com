"""Sentry diagnostics with account IDs and content-free traces/breadcrumbs."""

import os
import re
from urllib.parse import urlsplit

import sentry_sdk
from sentry_sdk.integrations.django import DjangoIntegration
from sentry_sdk.integrations.logging import LoggingIntegration

_SEGMENTS = set("api v1 _allauth app browser auth code request confirm link inspect exchange resume renew google apple challenge token session me groups expenses settlements summary history transactions activity attempts payment-attempts launch cancel reverse payments participants invite invites invitations notifications preferences channels foreground chat chat-conversations attachments versions expense-icons account profile photo avatar uploads media download files sign-in-methods email statements balance-statements bill-email-entry ledger-heads export import pending health ready app-releases simplify leave restore archive opening acknowledge join nickname name upi".split())
_METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"}


def diagnostic_route(value):
    if not isinstance(value, str):
        return "/unknown"
    value = re.sub(r"^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) ", "", value)
    if not value.startswith(("/", "http://", "https://")):
        return "/operation"
    try:
        url = urlsplit(value)
        if url.netloc and url.hostname not in {"merosplit.com", "merosplit.omshejul.com"}:
            return "/external"
        return "/" + "/".join(part if part in _SEGMENTS else ":id" for part in url.path.split("/") if part)[:500]
    except ValueError:
        return "/unknown"


def scrub_breadcrumb(crumb, hint=None):
    data = crumb.get("data") or {}
    if crumb.get("type") != "http" and crumb.get("category") not in {"http", "httplib", "fetch", "xhr"}:
        return None
    clean = {"url": diagnostic_route(data.get("url"))}
    if isinstance(data.get("method"), str) and data["method"] in _METHODS:
        clean["method"] = data["method"]
    status = data.get("status_code")
    if type(status) is int and 100 <= status <= 599:
        clean["status_code"] = status
    return {"category": "http", "type": "http", "timestamp": crumb.get("timestamp"), "data": clean}


def scrub_span(span, hint=None):
    span["description"] = diagnostic_route(span.get("description")) if str(span.get("op", "")).startswith("http") else span.get("op", "operation")
    span["data"] = {key: value for key, value in span.get("data", {}).items() if key in {"http.status_code", "http.response.status_code"} and type(value) is int or key == "http.request.method" and isinstance(value, str) and value in _METHODS}
    span.pop("tags", None)
    return span


def scrub_event(event, hint):
    for key in ("request", "extra", "logentry", "message", "threads", "server_name", "fingerprint"):
        event.pop(key, None)
    identifier = str((event.get("user") or {}).get("id", ""))
    if re.fullmatch(r"[1-9]\d{0,19}", identifier):
        event["user"] = {"id": identifier}
    else:
        event.pop("user", None)
    if "breadcrumbs" in event:
        raw = event["breadcrumbs"]
        values = raw.get("values", []) if isinstance(raw, dict) else raw if isinstance(raw, list) else []
        event["breadcrumbs"] = {"values": [clean for crumb in values if isinstance(crumb, dict) and (clean := scrub_breadcrumb(crumb))][-50:]}
    if event.get("transaction"):
        event["transaction"] = diagnostic_route(event["transaction"])
    if "contexts" in event:
        fields = {"trace": ("trace_id", "span_id", "parent_span_id", "op", "status", "origin"), "runtime": ("name", "version")}
        event["contexts"] = {name: {key: event["contexts"][name][key] for key in keys if key in event["contexts"][name]} for name, keys in fields.items() if name in event["contexts"]}
    event.pop("tags", None)
    for exception in event.get("exception", {}).get("values", []):
        exception["value"] = "[redacted]"
        for frame in exception.get("stacktrace", {}).get("frames", []):
            for key in ("vars", "pre_context", "context_line", "post_context"):
                frame.pop(key, None)
    for span in event.get("spans", []):
        scrub_span(span)
    return event


def sentry_request_context(get_response):
    def respond(request):
        if sentry_sdk.is_initialized():
            def identify(event, hint):
                user = getattr(request, "auth", None) or getattr(request, "user", None)
                if getattr(user, "is_authenticated", False):
                    event["user"] = {"id": str(user.pk)}
                else:
                    event.pop("user", None)
                return event
            sentry_sdk.get_isolation_scope().add_event_processor(identify)
            sentry_sdk.add_breadcrumb(category="http", type="http", data={"url": request.path, "method": request.method})
        return get_response(request)
    return respond


def init_sentry():
    if not os.environ.get("SENTRY_DSN"):
        return
    sentry_sdk.init(
        dsn=os.environ["SENTRY_DSN"],
        environment=os.environ.get("SENTRY_ENVIRONMENT", "production"),
        release=os.environ.get("SENTRY_RELEASE") or os.environ.get("RAILWAY_GIT_COMMIT_SHA"),
        integrations=[DjangoIntegration(transaction_style="url"), LoggingIntegration(level=None, event_level=None)],
        send_default_pii=False,
        include_local_variables=False,
        max_request_body_size="never",
        max_breadcrumbs=50,
        before_breadcrumb=scrub_breadcrumb,
        traces_sample_rate=1.0,
        before_send=scrub_event,
        before_send_transaction=scrub_event,
        before_send_span=scrub_span,
    )
