#!/usr/bin/env python3
"""Device approval for Codex MCP. No dependencies or credential-store access."""
import json
import os
import re
import selectors
import shutil
import subprocess
import sys
import time
from urllib.error import HTTPError
from urllib.parse import parse_qsl, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

ORIGIN = "https://merosplit.com"


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def post(path, data):
    request = Request(ORIGIN + path, data=urlencode(data).encode(),
                      headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        response = build_opener(NoRedirect).open(request, timeout=20)
    except HTTPError as failure:
        if failure.code != 400:
            raise RuntimeError("MeroSplit could not complete this request. Try again shortly.") from None
        response = failure
    with response:
        return json.loads(response.read(32768))


def approval(authorization_url):
    parsed = urlsplit(authorization_url)
    if parsed.scheme + "://" + parsed.netloc != ORIGIN or parsed.path != "/oauth/authorize":
        raise RuntimeError("Unexpected authorization server. Check the MeroSplit endpoint.")
    pairs = parse_qsl(parsed.query, keep_blank_values=True)
    data = dict(pairs)
    if len(data) != len(pairs):
        raise RuntimeError("Invalid authorization request.")
    device = post("/oauth/device", data)
    if "error" in device:
        raise RuntimeError("Could not start device login. Start again from your server.")
    print("Open " + device["verification_uri"] + " on your phone or computer.", flush=True)
    print("Code from your server: " + device["user_code"], flush=True)
    print("Waiting for approval. Keep this command running.", flush=True)
    deadline = time.monotonic() + device["expires_in"]
    interval = device["interval"]
    while time.monotonic() < deadline:
        time.sleep(interval)
        result = post("/oauth/device/poll", {"client_id": data["client_id"], "device_code": device["device_code"]})
        if "redirect_url" in result:
            # Pass only the original registered callback, state and issuer to Codex.
            target = urlsplit(result["redirect_url"])
            original = urlsplit(data["redirect_uri"])
            query = dict(parse_qsl(target.query))
            if ((target.scheme, target.netloc, target.path) != (original.scheme, original.netloc, original.path)
                    or query.get("state", "") != data.get("state", "") or query.get("iss") != ORIGIN):
                raise RuntimeError("Invalid login response. Start again.")
            return result["redirect_url"]
        if result.get("error") == "slow_down":
            interval += 5
        elif result.get("error") != "authorization_pending":
            raise RuntimeError("Login cancelled or expired. Start again on your server.")
    raise RuntimeError("Login expired. Start again on your server.")


def run():
    executable = shutil.which("codex")
    if not executable:
        raise RuntimeError("Install Codex CLI first, then run this command again.")
    config = subprocess.run([executable, "mcp", "get", "merosplit", "--json"], capture_output=True, text=True, timeout=20)
    if config.returncode:
        raise RuntimeError("First run: codex mcp add merosplit --url " + ORIGIN + "/mcp\n"
                           "If it waits for browser login, press Ctrl+C, then run this helper again.")
    transport = json.loads(config.stdout).get("transport", {})
    if transport.get("url") != ORIGIN + "/mcp" or transport.get("bearer_token_env_var"):
        raise RuntimeError("The merosplit entry must use " + ORIGIN + "/mcp with browser OAuth.")
    process = subprocess.Popen([executable, "mcp", "login", "merosplit", "--no-browser"],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    buffer, delivered = "", False
    deadline = time.monotonic() + 720
    try:
        while time.monotonic() < deadline:
            events = selector.select(timeout=1)
            for key, _ in events:
                chunk = os.read(key.fileobj.fileno(), 8192)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                buffer = (buffer + chunk.decode(errors="replace"))[-32768:]
                if not delivered:
                    found = re.search(r"https?://[^\s<>\"']+/oauth/authorize\?[^\s<>\"']+", buffer)
                    if found:
                        callback = approval(found.group())
                        process.stdin.write((callback + "\n").encode())
                        process.stdin.flush()
                        delivered = True
            if process.poll() is not None and not selector.get_map():
                if process.returncode != 0 or not delivered:
                    raise RuntimeError("Codex did not finish login. Check codex mcp login --help supports --no-browser and try again.")
                print("MeroSplit login saved by Codex. Refresh MeroSplit in /mcp, then call get_account_context with {}.")
                return
        raise RuntimeError("Codex login timed out. Start again.")
    finally:
        selector.close()
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        process.stdin.close()
        process.stdout.close()


if __name__ == "__main__":
    try:
        run()
    except (RuntimeError, OSError, ValueError, subprocess.SubprocessError) as failure:
        # Never print raw HTTP bodies, OAuth URLs or subprocess output.
        print(str(failure) if isinstance(failure, RuntimeError) else "Login failed. Check your connection and try again.", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("Login cancelled.", file=sys.stderr)
        sys.exit(130)
