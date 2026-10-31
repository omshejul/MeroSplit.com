# Development

Use Python 3.12+, uv, PostgreSQL 17, Node 24 and pnpm 12.14.0. Dependency versions are locked in the API and mobile lockfiles. Keep the Expo and React Native versions pinned by the project.

## API

Copy the variable names from `apps/api/.env.example` into your private environment. Set a local `DATABASE_URL`, a private `DJANGO_SECRET_KEY`, `DEBUG=true` and suitable local `ALLOWED_HOSTS`. Environment files are not loaded automatically by these commands.

```sh
uv sync --project apps/api --frozen
apps/api/.venv/bin/python apps/api/manage.py migrate
apps/api/.venv/bin/python apps/api/manage.py runserver 0.0.0.0:8000
apps/api/.venv/bin/python -m pytest apps/api/ledger -q
apps/api/.venv/bin/ruff check apps/api
```

Use a disposable local PostgreSQL database for tests. Configure your own email provider for interactive sign-in; isolated tests use fake delivery boundaries. Optional Google/Apple login and private store reviewer configuration are disabled unless configured. Never use a real customer account as a fixture.

## Mobile and web

```sh
cd apps/mobile
corepack pnpm@12.14.0 install --frozen-lockfile
corepack pnpm@12.14.0 typecheck
corepack pnpm@12.14.0 test
corepack pnpm@12.14.0 start
```

Set `EXPO_PUBLIC_API_URL` for your local API. Android's emulator can reach the host at `http://10.0.2.2:8000`; use the appropriate host address for other targets. Native modules require a development build rather than Expo Go. Platform SDKs and signing are separate prerequisites.

## Conventions

Django allauth owns identity and sessions. Account linking is explicit. Keep account-scoped cache/queue ownership, stable participant IDs, idempotency and linked reversals intact. Native-stack navigation owns page transitions and unsaved-change guards. See [the API contract](../API_CONTRACT.md) for domain behavior.

## UPI handoff

The client can hand off to installed payment apps through `apps/mobile/src/upi.ts`. A handler check only establishes that an app can open the URI. Launch, cancellation and return do not prove a bank payment occurred. Recording bookkeeping and moving money are separate actions.

## Keyboard visibility

Use `TextField` and its variants for forms, or `KeyboardInput` for custom inputs. Put scrollable inputs inside `KeyboardScrollView`; dialogs use `DialogScrollBody` and people sheets supply their own scroller. For a virtualized list with editable content, return `KeyboardScrollView` from `renderScrollComponent`. The nearest container reveals the focused field on focus, keyboard and layout changes, and caps multiline inputs to the available height. Existing keyboard-avoiding ancestors own resizing; the scroller adds only remaining Android keyboard overlap. Web keeps the native browser components. Chat retains its separate composer viewport.

`tests/native/KeyboardProbe.tsx` is an isolated synthetic native entry for screen, dialog, sheet, list, sign-in and chat keyboard checks. It writes measurements to `keyboard-probe.json` in the app's documents directory. Capture each reported `capture` stage, then create `keyboard-continue` there to advance. At the `tap: Message` stage, focus the actual chat composer through native UI automation. Production `index.ts` must never import the probe.

## Remote MCP login

`/mcp/device` is a standalone browser page. It uses the existing allauth email-code endpoints and explicit consent without loading the Expo app. The downloadable `/mcp/login.py` helper wraps `codex mcp login merosplit --no-browser`. It exchanges that CLI's authorization request for a short server code, polls approval, then sends the original callback to the waiting CLI. Codex retains ownership of token storage and refresh. This is an approval bridge, not an advertised RFC 8628 token grant.

Device requests expire after ten minutes. Store only hashes of the device secret and user code. Bind approval to the browser session and displayed account. Deliver a PKCE authorization code once, under a database lock. Preserve state, exact redirect, resource and existing disconnect behavior. Keep secrets and callback URLs out of terminal output and HTTP logs. The public setup page has current remote installation commands.

Run `apps/api/.venv/bin/python -m pytest apps/api/ledger/test_mcp_device.py apps/api/ledger/test_mcp_remote_login.py apps/api/ledger/test_mcp_oauth.py -q` against a disposable PostgreSQL database. For interactive QA, run the helper against a local test server and approve in a separate phone-sized browser. Confirm the phone never leaves the device/consent pages and the CLI reports saved login. Use synthetic accounts only.
