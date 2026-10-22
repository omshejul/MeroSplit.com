# Functional mobile pilot

Expo 58.0.12, React Native 0.88.0, TypeScript. Plain native controls exercise the Django contract in `../../API_CONTRACT.md`. This is a functional test application with deliberately unpolished forms.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
REACT_NATIVE_PACKAGER_HOSTNAME=10.0.2.2 pnpm exec expo start --dev-client --host lan
pnpm android --device emulator-5556 --no-bundler --no-install
```

Use the selected Expo SDK's supported Node runtime. Tests were run with Node 24. Native builds require a JDK and Android SDK. `EXPO_PUBLIC_API_URL` is a public server address, never a credential. Android defaults to `http://10.0.2.2:8000`; iOS defaults to localhost. A deployed server should use HTTPS.

The account form uses allauth's native email/password endpoints and SecureStore session tokens. Email verification is not configured in this controlled pilot. Each account cache and outbox is scoped by server URL and Django user ID. Logout revokes the server session and removes that account's local data after explicit confirmation; private local groups remain separate.

SQLite holds local groups, saved expense forms, accepted group snapshots and unsent HTTP commands. A shared write returns an acknowledgment, then a snapshot fetch atomically updates the cache and removes the command. Lost responses reuse the same command ID. Financial conflicts retain the saved draft for review. Local group publication starts a new server sequence at zero and retains the independent original.

Amounts use BigInt internally and decimal-string paise over HTTP. The authoritative Python and preview TypeScript implementations consume `../../fixtures/accounting.json`. The package has no global state store, ORM, navigation framework or form framework.

The self-test buttons exercise native SQLite close/reopen, native accounting fixtures, and a synthetic Django group replay. The server replay creates test records, checks duplicate commands and an explicit revision conflict, then creates two disposable accounts for scoped claims and payment-record convergence. It leaves the caller's payment profile intact and makes no bank transfer. A development-only account button generates disposable credentials on the device and uses normal signup. Actual payment integration is limited to showing details and explicit bookkeeping/recipient acknowledgment. There is no bank-verification callback or direct UPI app launch.

Plain controls also exercise adding participants, accepted spending/paid/share totals, filtering expenses and sharing repayment reminders. System share sheets require an explicit tap. For this Mac's Android emulator, LAN binding avoids an IPv6-only localhost listener; `10.0.2.2` addresses the host's IPv4 loopback.

## Phase abstraction checks

- Phase 0: official blank TypeScript template and SDK-compatible native modules. One screen needs no navigation framework.
- Phase 1: one pure accounting module. Exact integers and strict parsing are required; no money class hierarchy.
- Phase 3: direct SQLite and HTTP functions. A small SQLite interface enables the same SQL to be tested with real Node SQLite. Drafts, accepted records and the outbox have separate ownership. No generic command dispatcher or mirrored durable global store.
- Phase 4: plain controls call explicit endpoints. Group financial commands use the durable outbox. Identity settings and claim requests require online access; they do not imply membership or received money. Payment details remain a fallback until physical-device/provider evidence exists.

Node tests cover fixture parity, migrations, durable restart, account separation, retry after lost responses, conflict retention, snapshot monotonicity, and publication from a high local revision into a lower independent server sequence. A successful JavaScript export or Node test does not establish native operation, iOS support, or payment-provider compatibility. Native verification belongs in the root test log after it is actually performed.
