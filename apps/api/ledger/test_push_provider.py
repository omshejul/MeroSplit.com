import json
from types import SimpleNamespace
from uuid import uuid4

import pytest

from .push_provider import PushFailure, check_bill_notification_receipt, send_bill_notification


@pytest.fixture
def expo_http(monkeypatch, settings):
    settings.EXPO_ACCESS_TOKEN = ""
    fixture = SimpleNamespace(status=200, body={}, calls=[], closed=False)

    class Connection:
        def __init__(self, host, timeout):
            assert host == "exp.host" and timeout == 10

        def request(self, method, path, body, headers):
            fixture.calls.append((method, path, json.loads(body), headers))

        def getresponse(self):
            return SimpleNamespace(
                status=fixture.status, read=lambda limit: json.dumps(fixture.body).encode()
            )

        def close(self):
            fixture.closed = True

    monkeypatch.setattr("ledger.push_provider.http.client.HTTPSConnection", Connection)
    return fixture


def data():
    return {
        "type": "new_bill",
        "event_id": str(uuid4()),
        "recipient_user_id": "123",
        "group_id": str(uuid4()),
        "expense_id": str(uuid4()),
    }


def test_expo_send_generic_payload_and_ticket(expo_http):
    ticket = str(uuid4())
    expo_http.body = {"data": {"status": "ok", "id": ticket}}
    payload = data()
    assert send_bill_notification(SimpleNamespace(token="ExpoPushToken[synthetic]"), payload) == ticket
    method, path, body, headers = expo_http.calls[0]
    assert method == "POST" and path.endswith("/send")
    assert body == {
        "to": "ExpoPushToken[synthetic]",
        "title": "MeroSplit",
        "body": "A new bill was added.",
        "data": payload,
        "sound": "default",
        "channelId": "shared-bills",
        "ttl": 3600,
        "collapseId": payload["event_id"],
        "tag": payload["event_id"],
    }
    assert "Authorization" not in headers and expo_http.closed


@pytest.mark.parametrize(
    "status,permanent", [(429, False), (500, False), (503, False), (400, True), (401, True)]
)
def test_http_failures_sanitized(expo_http, status, permanent):
    expo_http.status = status
    expo_http.body = {"message": "sensitive token must never be persisted"}
    with pytest.raises(PushFailure) as failure:
        send_bill_notification(SimpleNamespace(token="ExpoPushToken[synthetic]"), data())
    assert failure.value.code == f"http_{status}" and failure.value.permanent == permanent
    assert "sensitive" not in str(failure.value) and expo_http.closed


def test_optional_expo_security_header(expo_http, settings):
    settings.EXPO_ACCESS_TOKEN = "test-only-private-credential"
    expo_http.body = {"data": {"status": "ok", "id": str(uuid4())}}
    send_bill_notification(SimpleNamespace(token="ExpoPushToken[synthetic]"), data())
    assert expo_http.calls[0][3]["Authorization"] == "Bearer test-only-private-credential"


def test_ticket_device_not_registered(expo_http):
    expo_http.body = {
        "data": {
            "status": "error",
            "details": {"error": "DeviceNotRegistered"},
            "message": "synthetic token private",
        }
    }
    with pytest.raises(PushFailure) as failure:
        send_bill_notification(SimpleNamespace(token="ExpoPushToken[synthetic]"), data())
    assert failure.value.invalid_token and str(failure.value) == "device_not_registered"


def test_receipt_missing_then_accepted(expo_http):
    ticket = str(uuid4())
    expo_http.body = {"data": {}}
    assert check_bill_notification_receipt(ticket) is False
    expo_http.body = {"data": {ticket: {"status": "ok"}}}
    assert check_bill_notification_receipt(ticket) is True
    assert expo_http.calls[-1][1].endswith("/getReceipts")
    assert expo_http.calls[-1][2] == {"ids": [ticket]}


@pytest.mark.parametrize(
    "code,invalid,permanent,resend",
    [
        ("DeviceNotRegistered", True, False, False),
        ("MessageRateExceeded", False, False, True),
        ("InvalidCredentials", False, True, True),
    ],
)
def test_receipt_error_types(expo_http, code, invalid, permanent, resend):
    ticket = str(uuid4())
    expo_http.body = {"data": {ticket: {"status": "error", "details": {"error": code}}}}
    with pytest.raises(PushFailure) as failure:
        check_bill_notification_receipt(ticket)
    assert (failure.value.invalid_token, failure.value.permanent, failure.value.resend) == (
        invalid,
        permanent,
        resend,
    )
