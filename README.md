# MeroSplit

Functional shared-expense app for iOS and Android, built with Expo React Native and a Django/PostgreSQL backend. Backend: [Railway readiness](https://api-production-fb6ac.up.railway.app/api/v1/ready). Source: [private GitHub repository](https://github.com/omshejul/SplitDumb). The app uses Groups, People and Me, React Native Paper controls, native pickers and Hugeicons. The 0.3.1 candidate adds compact monochrome light/dark appearance, Splitwise CSV import and private optimized profile/bill media. See the [design decisions](.dev/merosplit-design-decisions.md).

Version 0.3.0 is the earlier mint release. The current 0.3.1 candidate and pending live/native gates are recorded in [the combined update status](.dev/MEROSPLIT_MONOCHROME_STATUS.md). Current results, artifact identities and limitations are in the [design acceptance report](.dev/merosplit-acceptance.md), with separate [Android](.dev/merosplit-native-qa.md) and [iOS simulator](.dev/merosplit-ios-qa.md) evidence. This release keeps the installed package identity, SQLite database and account session. The earlier 0.2.0 builds and iPhone installer are historical evidence, not artifacts for this version.

See the [original verification and artifacts](.dev/VERIFICATION.md), [development instructions](.dev/DEV.md), [implementation phases](PLAN.md), and [API contract](API_CONTRACT.md). Email verification/recovery, direct UPI app launch, physical-device payments, public store release, and measured maximum-capacity performance remain outside this controlled functional build.

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
