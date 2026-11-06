"""The helper transports approval, leaving credential handling to Codex."""
import json
from urllib.parse import urlencode

import pytest

from . import mcp_remote_login as login

AUTH = login.ORIGIN + '/oauth/authorize?' + urlencode({'client_id': 'synthetic-client',
    'redirect_uri': 'http://127.0.0.1:44321/callback', 'state': 'synthetic-state'})
CALLBACK = 'http://127.0.0.1:44321/callback?' + urlencode({'code': 'synthetic-one-time-code',
    'state': 'synthetic-state', 'iss': login.ORIGIN})


def test_helper_waits_for_approval_and_does_not_print_callback_or_secret(monkeypatch, capsys):
    replies = iter([{'device_code': 'synthetic-device-secret', 'user_code': 'ABCD-EFGH',
                     'verification_uri': login.ORIGIN + '/mcp/device', 'expires_in': 600, 'interval': 5},
                    {'error': 'authorization_pending'}, {'error': 'slow_down'}, {'redirect_url': CALLBACK}])
    waits = []
    monkeypatch.setattr(login, 'post', lambda path, data: next(replies))
    monkeypatch.setattr(login.time, 'sleep', waits.append)
    assert login.approval(AUTH) == CALLBACK
    output = capsys.readouterr().out
    assert 'ABCD-EFGH' in output and '/mcp/device' in output
    assert 'synthetic-device-secret' not in output and 'synthetic-one-time-code' not in output
    assert waits == [5, 5, 10]


@pytest.mark.parametrize('callback', [CALLBACK.replace('44321', '44322'),
                                    CALLBACK.replace('synthetic-state', 'wrong-state'),
                                    CALLBACK.replace('merosplit.com', 'evil.invalid')])
def test_helper_rejects_changed_callback_state_or_issuer(monkeypatch, callback):
    replies = iter([{'device_code': 'synthetic', 'user_code': 'ABCD-EFGH',
                     'verification_uri': login.ORIGIN + '/mcp/device', 'expires_in': 600, 'interval': 5},
                    {'redirect_url': callback}])
    monkeypatch.setattr(login, 'post', lambda path, data: next(replies))
    monkeypatch.setattr(login.time, 'sleep', lambda delay: None)
    with pytest.raises(RuntimeError, match='Invalid login response'):
        login.approval(AUTH)


def test_helper_passes_callback_to_waiting_cli_and_reports_saved_login(tmp_path, monkeypatch, capsys):
    executable = tmp_path / 'codex'
    config = json.dumps({'transport': {'type': 'streamable_http', 'url': login.ORIGIN + '/mcp'}})
    executable.write_text('#!/usr/bin/env python3\nimport sys\n'
        + f'if "get" in sys.argv: print({config!r})\n'
        + f'else:\n print({AUTH!r},flush=True)\n callback=input()\n sys.exit(0 if callback == {CALLBACK!r} else 1)\n')
    executable.chmod(0o700)
    monkeypatch.setattr(login.shutil, 'which', lambda name: str(executable))
    monkeypatch.setattr(login, 'approval', lambda url: CALLBACK)
    login.run()
    output = capsys.readouterr().out
    assert 'login saved by Codex' in output
    assert 'synthetic-one-time-code' not in output and '/oauth/authorize?' not in output
