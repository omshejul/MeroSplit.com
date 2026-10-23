"""The single Expo Push HTTP boundary; never retain/log provider error messages."""

import http.client
import json
import socket
import ssl

from django.conf import settings


class PushFailure(Exception):
    def __init__(self, code, *, permanent=False, invalid_token=False, resend=False):
        self.code = code
        self.permanent = permanent
        self.invalid_token = invalid_token
        self.resend = resend
        super().__init__(code)


def expo_request(path, payload):
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if settings.EXPO_ACCESS_TOKEN:
        headers["Authorization"] = f"Bearer {settings.EXPO_ACCESS_TOKEN}"
    connection = http.client.HTTPSConnection("exp.host", timeout=10)
    try:
        connection.request("POST", f"/--/api/v2/push/{path}", json.dumps(payload), headers)
        response = connection.getresponse()
        if response.status < 200 or response.status >= 300:
            raise PushFailure(
                f"http_{response.status}", permanent=response.status != 429 and response.status < 500
            )
        raw = response.read(65537)
        if len(raw) > 65536:
            raise PushFailure("invalid_response")
        result = json.loads(raw)
        if not isinstance(result, dict):
            raise PushFailure("invalid_response")
        if result.get("errors"):
            # Do not store arbitrary upstream strings (which can contain push tokens).
            code = (
                result["errors"][0].get("code")
                if isinstance(result["errors"], list) and isinstance(result["errors"][0], dict)
                else None
            )
            if code == "TOO_MANY_REQUESTS":
                raise PushFailure("rate_limited")
            raise PushFailure("request_rejected", permanent=True)
        return result.get("data")
    except (OSError, socket.timeout, ssl.SSLError, http.client.HTTPException):
        raise PushFailure("network_error") from None
    except (ValueError, TypeError):
        raise PushFailure("invalid_response") from None
    finally:
        connection.close()


def check_status(item):
    if not isinstance(item, dict):
        raise PushFailure("invalid_response")
    if item.get("status") == "ok":
        return
    if item.get("status") != "error":
        raise PushFailure("invalid_response")
    details = item.get("details")
    code = details.get("error") if isinstance(details, dict) else None
    if code == "DeviceNotRegistered":
        raise PushFailure("device_not_registered", invalid_token=True)
    if code == "MessageRateExceeded":
        raise PushFailure("message_rate_exceeded", resend=True)
    if code in {"MessageTooBig", "MismatchSenderId", "InvalidCredentials"}:
        raise PushFailure(
            {
                "MessageTooBig": "message_too_big",
                "MismatchSenderId": "sender_mismatch",
                "InvalidCredentials": "invalid_credentials",
            }[code],
            permanent=True,
            resend=True,
        )
    raise PushFailure("provider_rejected", permanent=True)


def send_bill_notification(device, data):
    result = expo_request(
        "send",
        {
            "to": device.token,
            "title": "MeroSplit",
            "body": "A new bill was added.",
            "data": data,
            "sound": "default",
            "channelId": "shared-bills",
            "ttl": 3600,
            "collapseId": data["event_id"],
            "tag": data["event_id"],
        },
    )
    check_status(result)
    ticket = result.get("id")
    if not isinstance(ticket, str) or not ticket or len(ticket) > 200:
        raise PushFailure("invalid_response")
    return ticket


def check_bill_notification_receipt(ticket):
    result = expo_request("getReceipts", {"ids": [ticket]})
    if not isinstance(result, dict):
        raise PushFailure("invalid_response")
    if ticket not in result:
        return False
    check_status(result[ticket])
    return True
