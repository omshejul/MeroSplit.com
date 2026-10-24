# MeroSplit

Shared-expense app for iOS, Android and web, built with Expo React Native and a Django/PostgreSQL backend. [MeroSplit](https://merosplit.com) · [Private source repository](https://github.com/omshejul/SplitDumb).

The current 0.3.5 source, native build 13, uses Groups, People, Activity and Me with React Native Paper controls, native pickers and Hugeicons. Accounts sync automatically. PostgreSQL owns accepted records; the phone keeps an account-scoped cache, drafts and an idempotent offline queue. Sign-out preserves unsent work for that account. Earlier unowned phone records require explicit account and participant confirmation before recovery. Original history remains available in recovery export.

Groups show personal obligations above a mixed bill/payment timeline. Simplify calculates the complete ledger before filtering obligations involving you. Organizer removal preserves historical splits and requires zero balance. Personal leave can transfer ownership to the next evidenced member; a sole organizer instead hides the group privately. Archived and hidden lists are explicit, while the server index remains complete. Me contains profile/UPI, notifications, appearance and data actions.

Earlier compact app, full web and local acceptance are recorded in [the current acceptance report](.dev/MEROSPLIT_COMPACT_WEB_ACCEPTANCE.md). The earlier canonical-account migration is recorded in [the canonical-app verification](.dev/MEROSPLIT_SERVER_CORE.md). Earlier 0.3.1/0.3.2 reports and simulator ZIPs describe previous builds, not a current iPhone installer. The installed package identity, SQLite database and session are retained.

See the [original verification and artifacts](.dev/VERIFICATION.md), [development instructions](.dev/DEV.md), [implementation phases](PLAN.md), and [API contract](API_CONTRACT.md). Current source includes email-link/code sign-in, explicit participant invitations, guarded UPI handoff, private media and the same screens on the web. Linked-account unread emails become eligible after 10 minutes. New unclaimed-participant bill emails are generic notifications, never automatic invitations or membership claims. Live inbox flows, physical-device payments, public store release and maximum-capacity claims require separate release evidence. Historical test reports below do not establish those newer flows.

Current source adds OAuth MCP on the same backend at `https://merosplit.com/mcp`; [the portable plugin](plugins/merosplit/README.md) shares that endpoint with its Claude Code adapter. Its tools read authorized ledgers and record bookkeeping only. ASGI uses the existing service with two workers; the existing notification worker remains separate. New runtime deployment, native geometry and real host OAuth/read-write acceptance remain publisher gates. Package/schema checks do not establish them.

Start with the [PRD](PRD.md). It specifies the controlled pilot, later public beta, bill-splitting calculations, ledger rules, UPI states, guest participation, migration, architecture, acceptance criteria and delivery sequence.

The PRD's [implementation rules](PRD.md#rules-against-bloat-and-unnecessary-abstraction) require staged scope, small module interfaces, explicit financial write paths and a reason for each new layer or dependency. Future features do not get scaffolding in the pilot.

Simplify debts is required in the first iOS and Android release. It cancels circular obligations and proposes fewer group repayments while preserving each person's balance. The PRD includes its controls, explanations and eight acceptance cases.

## Research documents

- [Market assessment and build recommendation](research/MARKET_RESEARCH.md)
- [Splitwise features and documented behavior](research/SPLITWISE_FEATURES.md)
- [Indian user complaints, alternatives and counterevidence](research/INDIA_USER_RESEARCH.md)
- [UPI feasibility and React Native architecture](research/UPI_AND_ARCHITECTURE.md)
- [Reverse engineering repositories and testing tools](research/REVERSE_ENGINEERING_TOOLS.md)
- [Actual research-agent discussion and decisions](research/RESEARCH_DISCUSSION.md)
- [Android hands-on findings](research/ANDROID_HANDS_ON_FINDINGS.md) and [coverage / remaining device tests](research/HANDS_ON_TEST_LOG.md)
- [Research contract](research/RESEARCH_CONTRACT.md)

## Evidence and reproducibility

The corpus contains 1,500 public Splitwise Apple review IDs across India, US and UK storefronts. Research agents inspected a selected 130 India-store reviews plus 36 community records. The corpus is a discovery sample, not a representative survey or verified set of buyers. The [completion audit](research/results/completion_audit.json) records coverage and gaps.

- [Review audit summary](research/results/apple_review_audit_summary.json) and [record IDs](research/results/apple_review_audit.csv)
- [Community evidence](research/normalized/community_evidence.json)
- [Competitor comparison](research/results/competitors.csv)
- [Official source register](research/normalized/official_sources.json)
- [Technical source register](research/normalized/technical_sources.json)
- [Source coverage](research/results/source_coverage.csv)

`research/raw` preserves retrieved materials locally for audit. Marketing screenshots are reference material, not product assets. Source publication dates, collection dates and current product claims are distinguished in the reports.

To reproduce the bounded Apple collection and saved inspection labels with Python's standard library:

```sh
python3 research/collect_apple_reviews.py
python3 research/audit_reviews.py
```

Collection reuses existing raw snapshots. The saved label map is tied to the fixed review sample and must be inspected again if that sample changes. It is not an automatic sentiment or willingness-to-pay classifier.

Splitwise Android 26.9.1/963 was installed through Google Play and tested in the official Android emulator. Saved synthetic cases verified a simplified debt chain, partial manual repayment, paise rounding and multiple payers. The fifth expense was blocked after four bills. The labeled test group remains available for review. No real money moved. See the [hands-on findings](research/ANDROID_HANDS_ON_FINDINGS.md) and [transcribed accounting fixture](research/results/native_accounting_fixture.json). Splitwise's iOS behavior, real UPI handoff, offline conflicts and export fidelity remain untested. SplitDumb's implementation tests are recorded separately in the verification report above.
