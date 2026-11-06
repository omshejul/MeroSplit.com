"""Bounded HTTPS file downloads without redirects, credentials or private-network access."""

import ipaddress
import socket
import time
from urllib.parse import urlsplit

import urllib3
from ninja.errors import HttpError

MAX_FILE_SIZE = 20 * 1024 * 1024


def download_file(url):
    try:
        parsed = urlsplit(url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.port not in (None, 443) or parsed.username is not None or parsed.password is not None or parsed.fragment:
            raise HttpError(422, "Use a direct HTTPS download link")
        host = parsed.hostname.encode("idna").decode("ascii")
        addresses = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
        if not addresses or any(not ipaddress.ip_address(item[4][0]).is_global for item in addresses):
            raise HttpError(422, "Use a public HTTPS download link")
        # Pin the verified address, retaining the original Host, TLS SNI and certificate check.
        with urllib3.HTTPSConnectionPool(addresses[0][4][0], port=443, server_hostname=host,
                assert_hostname=host, cert_reqs="CERT_REQUIRED") as pool:
            deadline = time.monotonic() + 20
            with pool.request("GET", (parsed.path or "/") + ("?" + parsed.query if parsed.query else ""),
                    headers={"Host": f"[{host}]" if ":" in host else host, "Accept-Encoding": "identity"}, preload_content=False,
                    redirect=False, retries=False, timeout=urllib3.Timeout(connect=3, read=5, total=15)) as response:
                if response.status != 200 or response.headers.get("Content-Encoding", "identity").lower() != "identity":
                    raise HttpError(422, "Use a fresh, direct file download link")
                length = response.headers.get("Content-Length")
                if length is not None and not 0 < int(length) <= MAX_FILE_SIZE:
                    raise HttpError(422, "Choose a nonempty file no larger than 20 MiB")
                data = bytearray()
                while True:
                    if time.monotonic() > deadline:
                        raise HttpError(422, "File download timed out; try a fresh link")
                    chunk = response.read1(min(64 * 1024, MAX_FILE_SIZE + 1 - len(data)))
                    if not chunk:
                        break
                    data.extend(chunk)
                    if len(data) > MAX_FILE_SIZE:
                        raise HttpError(422, "Choose a file no larger than 20 MiB")
                if not data or length is not None and len(data) != int(length):
                    raise HttpError(422, "File download was empty or incomplete")
                return bytes(data)
    except (ValueError, UnicodeError, OSError, urllib3.exceptions.HTTPError):
        # Signed source URLs and provider credentials must not appear in tool results.
        raise HttpError(422, "File could not be downloaded; try a fresh public HTTPS link") from None
