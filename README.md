# MeroSplit

Shared-expense app for iOS, Android and web, built with Expo React Native and a Django/PostgreSQL backend. [MeroSplit](https://merosplit.com) · [Private source repository](https://github.com/omshejul/MeroSplit).

The current 0.3.5 source, native build 13, uses Groups, People, Activity and Me with React Native Paper controls, native pickers and Hugeicons. Accounts sync automatically. PostgreSQL owns accepted records; the phone keeps an account-scoped cache, drafts and an idempotent offline queue. Sign-out preserves unsent work for that account. Earlier unowned phone records require explicit account and participant confirmation before recovery. Original history remains available in recovery export.

Groups show personal obligations above a mixed bill/payment timeline. Simplify calculates the complete ledger before filtering obligations involving you. Organizer removal preserves historical splits and requires zero balance. Personal leave can transfer ownership to the next evidenced member; a sole organizer instead hides the group privately. Archived and hidden lists are explicit, while the server index remains complete. Me contains profile/UPI, notifications, appearance and data actions.

Earlier compact app, full web and local acceptance are recorded in [the current acceptance report](.dev/MEROSPLIT_COMPACT_WEB_ACCEPTANCE.md). The earlier canonical-account migration is recorded in [the canonical-app verification](.dev/MEROSPLIT_SERVER_CORE.md). Earlier 0.3.1/0.3.2 reports and simulator ZIPs describe previous builds, not a current iPhone installer. The installed package identity, SQLite database and session are retained.

See the [original verification and artifacts](.dev/VERIFICATION.md), [development instructions](.dev/DEV.md), [implementation phases](PLAN.md), and [API contract](API_CONTRACT.md). Current source includes email-link/code sign-in, explicit participant invitations, guarded UPI handoff, private media and the same screens on the web. Linked-account unread emails become eligible after 10 minutes. New unclaimed-participant bill emails are generic notifications, never automatic invitations or membership claims. Live inbox flows, physical-device payments, public store release and maximum-capacity claims require separate release evidence. Historical test reports below do not establish those newer flows.

Current source adds OAuth MCP on the same backend at `https://merosplit.com/mcp`; [the portable plugin](plugins/merosplit/README.md) shares that endpoint with its Claude Code adapter. Its tools read authorized ledgers and record bookkeeping only. ASGI uses the existing service with two workers; the existing notification worker remains separate. New runtime deployment, native geometry and real host OAuth/read-write acceptance remain publisher gates. Package/schema checks do not establish them.

Start with the [PRD](PRD.md). It specifies the controlled pilot, later public beta, bill-splitting calculations, ledger rules, UPI states, guest participation, migration, architecture, acceptance criteria and delivery sequence.

The PRD's [implementation rules](PRD.md#rules-against-bloat-and-unnecessary-abstraction) require staged scope, small module interfaces, explicit financial write paths and a reason for each new layer or dependency. Future features do not get scaffolding in the pilot.

Simplify debts is required in the first iOS and Android release. It cancels circular obligations and proposes fewer group repayments while preserving each person's balance. The PRD includes its controls, explanations and eight acceptance cases.

## Research privacy

Scraped research, reviewer profiles and third-party snapshots are kept outside the source repository. Use synthetic fixtures for development and testing.
