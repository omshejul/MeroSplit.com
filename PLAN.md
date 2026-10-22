# SplitDumb implementation

Django/PostgreSQL owns accepted shared records. Expo React Native owns local drafts/cache/outbox. Build functions and plain controls only. No visual design, paid features, OCR, attachments, recurrence or multi-currency in this implementation.

## Phases and exit checks

| Phase | Functional result | Required evidence | Status |
|---|---|---|---|
| 0 | Minimal executable Django and Expo projects; fixed API shapes | Dependencies pinned; health check; TypeScript compiles | Passed |
| 1 | INR allocation, balances and Simplify debts | Shared fixtures in Python/TypeScript; exact/percent/shares/multiple payer validation | Passed |
| 2 | Django accounts, groups, expenses, revisions and repayments | Real PostgreSQL; auth isolation; rollback; duplicate requests; edit conflicts | Passed |
| 3 | App functions for local persistence, offline commands and sync | SQLite migrations; restart/retry; conflicts; account separation | Passed |
| 4 | Invites/claims, payment attempts/manual/receipt confirmation, opening balances and exports | Scoped access; no double posting; no callback-as-payment; reconciling export | Passed |
| 5 | Operable native app against Railway Django/PostgreSQL | Native Android end-to-end; iOS build/tests where tooling available; deployed auth/ledger/export smoke tests | Pending |

After EVERY phase, record an abstraction check below before marking it complete: Can this be a one-line change? If not, what is the smallest readable correct change? Remove unnecessary layers, speculative options, duplicate state and unused dependencies. Prefer direct Django ORM calls and named transaction functions. Record changes, necessary complexity and commands/results. Line count is evidence of size, not permission to compress readable code or omit validation.

The original PRD's P0 functional requirements remain the acceptance baseline. P1/P2 stay deferred. Guest web access can use small Django-rendered pages instead of a separate JavaScript application. Real UPI receipt and iOS runtime claims require actual evidence; do not substitute mocks. Deployment does not include an App Store submission.

## Phase checks

### Phase0: passed

Django/PostgreSQL health/readiness and allauth native signup/token smoke passed. Expo58 TypeScript compilation passed independently. Removed an unused static-file dependency and used one plain functional screen, no navigation/form/global-state framework. No UI design work.

### Phase1: passed

109 Python accounting checks and the matching TypeScript fixtures/cumulative replay passed. Removed unreachable parser catches, reducing the Python core to121lines. Kept only reused allocation/parser helpers. Common JSON fixtures keep Python authority and local TypeScript previews consistent.

### Phase2: passed

121 combined Python/API tests passed on actual PostgreSQL17, including simultaneous same-command retry, invalid-write rollback, stale revisions, deletion/restoration, settlement reversal and authenticated outsider access. Independent reviewer repeated the suite. Write replies are small `{id,version}` acknowledgments; clients fetch snapshots separately, avoiding stored copies of the entire ledger per command. No repository/service hierarchy or dispatch bus added.

Phase3/4 reviews passed after the local→shared version reset and manual-payment/attempt linkage fixes. Full reviewer notes are in [.dev/PHASE_REVIEWS.md](.dev/PHASE_REVIEWS.md).


### Phase3: passed

113 TypeScript checks and typecheck pass. Real SQLite tests cover migrations/restart, atomic acknowledgment, ownership, retries, conflicts and stale snapshots. Review found and fixed local-version20 blocking a new shared server version1; the shared accepted cache now starts at0. Restore/reversal previews are explicit; unsupported financial acknowledgment previews are withheld.

### Phase4: passed, native execution reserved for phase5

13 PostgreSQL feature tests passed, plus independent review probes. Linked manual records and later acknowledgment share one settlement even when actual amount differs from quote. Guest views expose only involved records; forwarded invite claims require explicit organizer approval. Pending opening balances require participant acknowledgment and cannot activate after archive. Deleted payment addresses are redacted. Kept direct Django functions and a small Django guest page, no separate web application. The private CSV experiment passes47 tests and always blocks publishing unvalidated history.

### Phase5: local Android runtime passed; release gates pending

The coordinator observed three Android native checks pass: SQLite migration/write/close/reopen/read; BigInt fixtures and cumulative ledger; and the native app's end-to-end self-test against local Django/PostgreSQL. The last check exercises durable outbox reopen, duplicate retries, stale edits, scoped claim approval, reused payment attempt, payer report without posting, differing actual manual amount, recipient confirmation without double posting and JSON/CSV response retrieval. This is local emulator evidence; system share-sheet delivery, accessibility, OS process termination/relaunch and physical payment apps require their own checks.

The reviewer independently reran113 TypeScript tests and typecheck successfully. No Railway deployment has happened yet. Production access is verified via a scoped private wrapper; publication still requires tested GitHub main and a clean exact-match release checkout, followed by deployment/migrations and a repeat against the HTTPS service. iOS compilation/runtime remain unavailable without Xcode. Direct UPI launch is disabled and no real bank transfer has been made. This phase remains pending those applicable release gates; functional phase passes are not a public-store release claim.

Capacity is not a measured release promise: current input caps are100 participants and1,000,000,000paise per bill/payment. The server10,000 guard counts expense rows including deleted rows, not all accepted history. The proposed100-local-group/10,000-event capacity and performance targets remain unverified.
