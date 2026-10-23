# MeroSplit implementation

Django/PostgreSQL owns accepted records. Expo React Native owns account-scoped drafts/cache/outbox. The phases below record historical milestones; their test counts and deployment claims do not establish acceptance of later source. Current metadata is 0.3.5/native build 13. OCR, subscriptions, recurrence and multi-currency remain outside this scope.

## Phases and exit checks

| Phase | Functional result | Required evidence | Status |
|---|---|---|---|
| 0 | Minimal executable Django and Expo projects; fixed API shapes | Dependencies pinned; health check; TypeScript compiles | Passed |
| 1 | INR allocation, balances and Simplify debts | Shared fixtures in Python/TypeScript; exact/percent/shares/multiple payer validation | Passed |
| 2 | Django accounts, groups, expenses, revisions and repayments | Real PostgreSQL; auth isolation; rollback; duplicate requests; edit conflicts | Passed |
| 3 | App functions for local persistence, offline commands and sync | SQLite migrations; restart/retry; conflicts; account separation | Passed |
| 4 | Invites/claims, payment attempts/manual/receipt confirmation, opening balances and exports | Scoped access; no double posting; no callback-as-payment; reconciling export | Passed |
| 5 | Operable native app against Railway Django/PostgreSQL | Native Android/iOS end-to-end; deployed auth/ledger/export/security smoke tests; cold session recovery | Passed |

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

### Phase5: passed

Standalone Android and iOS builds passed accounting, SQLite and native end-to-end flows against Railway. Both retained SecureStore sessions across process termination/relaunch. The deployed API passed signup/authentication, ledger/payment/export and guest/browser-CSRF/security smoke checks. Final API source is published commit5ae9e546, deployed from a freshly verified clean GitHub-main checkout. Full evidence and artifact hashes are in [.dev/VERIFICATION.md](.dev/VERIFICATION.md).

Abstraction check: removed the obsolete ten-line Railway configuration after its API rejected that format. Six direct Django logging lines make server errors observable; explicit service settings schedule migrations and readiness. No deployment framework, worker or additional service was added. One API and one PostgreSQL remain sufficient. The six functional phases are complete; direct UPI launch, physical payments, accessibility certification, share-destination delivery, and public store release remain separate from this functional acceptance.

Capacity is not a measured release promise: current input caps are100 participants and1,000,000,000paise per bill/payment. The server10,000 guard counts expense rows including deleted rows, not all accepted history. The proposed100-local-group/10,000-event capacity and performance targets remain unverified.

### Phase6: normal product flows, passed

Replace the diagnostic form with plain Groups, Friends, Activity and Account navigation. Use named people, rupee inputs, separate payer/beneficiary selectors, readable expense detail, partial settlements and reversible records. Preserve SQLite/session data and make pending/conflicting changes recoverable without technical inputs. Backend direct ledgers and guest-opening disclosure are published at07bda7d and passed192 local tests plus34 live checks. Fresh Android and iOS normal-control acceptance and replacement builds passed; earlier diagnostic self-tests are historical evidence.

Android normal-control acceptance passed on product commit7c6d8eac, including real conflict/reapply, claimant approval, linked partial receipt, opening consent, reversal, archive/reopen and a three-person debt chain. A fresh clean verified-main APK was built and installed in place; native smoke preserved session, history, groups and balances. Its embedded app bundle is byte-identical to the operated final QA build. Current checks are118 mobile tests, TypeScript and Expo Doctor20/20. Fresh iOS direct CUA manual acceptance passed group/bill detail, equal allocation, payment Cancel/Confirm, balances and all four tabs. Broader automated native UI tests passed lifecycle, draft/restart, paused queue and real conflict/reapply. Physical IPA compilation/export/signing passed; actual phone installation remains unverified. See [.dev/USABLE_ACCEPTANCE.md](.dev/USABLE_ACCEPTANCE.md).

Abstraction check: one optional boolean on the existing group replaces a separate friendship model. Screens call the existing accounting, storage and fetch functions. No form engine, global state store, navigation framework, repository or new service was added. Safe-area handling is the only new native dependency. Removed the unused diagnostic screen/self-test modules. Provisional-group cleanup needs one guarded SQLite transaction across cache, outbox and drafts; separate deletions would leave stranded data.

Independent final source review found no remaining blocker and repeated the type check. It checked account-scoped loads and drafts, explicit saved-change review, atomic group cleanup, pause restoration and payment-attempt linkage. These are source-review conclusions; manual acceptance is recorded separately. Keep these explicit guards rather than collapsing financial writes into a generic command or form framework.

## Current unified source checkpoint

Implemented source adds the 10-minute unread-email policy, generic immediate notifications for new unclaimed bill participants, personal group leave/private hide/restore, and OAuth MCP on the existing ASGI service. Atomic migration 0016 keeps historical notices/digests at policy 0 and leaves final Python/database defaults 1 for fresh inserts, including old API writers. Per-recipient/policy open-digest uniqueness preserves old held audit records alongside new work. Proof and provider retry lifetimes remain distinct from reminder timing. Migration 0019 defaults private hidden to false in Python and PostgreSQL.

The portable ChatGPT/Codex plugin and Claude Code adapter share one skill/endpoint. Core-schema, documented DCR contract and CLI validation are recorded separately because the official generic MCP schema rejects OpenAI's documented extension fields. No host installation, directory approval or live OAuth/write acceptance follows from packaging.

Abstraction check: plain transactional membership functions reuse existing receipts and outbox. A complete index refresh acknowledges departure without reading the revoked group and keeps unsent work. Shared KeyboardDialog/DialogScrollBody/CancelDialogActions replace repeated JSX without moving form state or financial callbacks. Focused SQLite/PostgreSQL/component tests and TypeScript cover source behavior; earlier test counts above remain historical. Publication, runtime two-worker/host checks, controlled email acceptance and native keyboard/layout acceptance belong to the publisher after the final source freeze.
