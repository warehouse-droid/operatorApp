# Direct-ship IR/IF evidence — 2026-10-01

The requested fix is deployed, and the authorized completed-order retry has finished. The target LOINC-036776 / POB03915 received **IR14954**; SOM06662 received **IF156236**. Independent NetSuite read-back verifies the parents, items, locations, external identities and exact native quantities. Seven completed orders remain held for persisted quantity, yard or workflow blockers; no transactions were sent for them.

Scope and executable acceptance criteria are in [the spec](direct-ship-posting-spec.md). Spec approval: not obtained (autonomous run). The user explicitly authorized the fix, all four gates, deployment and historical retries, then required live completed-order and remaining-line checks. No additional approval was inferred from elapsed time.

## Implementation

- Dispatch fulfillment recognizes fulfillable MBBS-Special Order lines, preserving live item eligibility and exclusions for charges and nonfulfillable services.
- Effective, fully covered direct-PO delivery completion creates one durable IR job. Pickup alone does not trigger receipt. Historical replay selects only effective verified direct completions and uses the existing command worker, receipt gates, external identity, recovery and source claims.
- Positive NetSuite parent IDs and exact source line, item and location mappings are required. Current order status and live positive remaining quantities are checked immediately before each transform. Already-completed orders or fully posted selected lines reconcile without a duplicate transaction.
- Automatic IR admission records immutable Driver completion provenance and a system action. Ordinary Operator commands still require a real Operator. Local receipt finalization occurs only after exact remote verification; Driver evidence can satisfy the automatic direct-receipt photo path only through the verified command/event join.

The release overlays only the 14 task files onto the then-current production image. Unrelated dirty workspace files were preserved and excluded. The [manifest](../deployments/direct-ship-posting-20261001/manifest.json), [published release result](../deployments/direct-ship-posting-20261001/published.json) and [final source integrity check](../test-artifacts/direct-ship-posting-20261001/final-source-integrity.json) bind the tested source hashes to the release.

## Verification

The one-entry verification command is `sudo -n bash tools/direct-ship-posting-gauntlet.sh` from the server directory. It uses disposable PostgreSQL databases, internal Docker networking and the existing pinned test image. Test and mutation runners use a nonexistent environment file, disabled live-posting flags and an isolated network. No packages were added.

| Check | Result |
|---|---|
| Focused final-source tests | 66 / 66 passed |
| New module line / statement / function coverage | 100% / 100% / 100% |
| New module branch coverage | 91.12%; existing 90% threshold retained |
| Focused mutations | 6 / 6 killed; original source restored and hash-verified |
| ESLint | Passed, zero errors or warnings |
| Types | 274 pre-existing diagnostics; zero new diagnostics |
| Added-line secret scan | Zero findings |
| Migration / rollback compatibility | Applied twice; prior source imports with new schema; ordinary Operator requirement retained |
| Full-suite comparison | Baseline 768 files / 4219 tests / 146 failures; candidate 771 files / 4246 tests / 144 failures; zero new failures |

The full suite is **not green**. Existing baseline failures and the same `aggregate-request-browser.test.js` timeout remain visible in both runs. Each file had the same 120-second timeout in baseline and candidate, and the comparison rejects new failed assertions, failed files, cancellations or timeouts. Coverage above measures the three new modules, not the entire repository. Type and full-suite checks compare against the immutable pre-change workspace rather than claiming existing failures were fixed.

Primary machine-readable evidence: [checks](../test-artifacts/direct-ship-posting-20261001/checks.json), [full regression comparison](../test-artifacts/direct-ship-posting-20261001/regression-comparison.json), [mutations](../test-artifacts/direct-ship-posting-20261001/mutations.json), [migration compatibility](../test-artifacts/direct-ship-posting-20261001/migration-rollback.log), and [tool versions](../test-artifacts/direct-ship-posting-20261001/tool-versions.json).

Before implementation, corrected executable fixtures showed the baseline defects: the special SO line was skipped, direct receipt finalization required ordinary receiving photos despite verified Driver evidence, and current-source guards/source-reader behavior were missing. Initial fixture errors (missing target-line identity and driver fields, SQL parameter typing) were corrected before accepting the meaningful RED runs. Evidence is retained in the `red-materializer`, `red-so-guard`, `red-finalization` and `red-source-reader` logs.

Mutation cases exercise special-item omission, posting completed orders, wrong parent identity, bypassed live receipt bounds, absent last-moment SO checks and disabled IR gates. Each mutant failed a corresponding executable constraint; tests and thresholds were not relaxed.

## Deployment and operations

The initial rollout automatically rolled back because migration 253 had not yet been applied. The old app was restored healthy before any requested historical posting. After the compatibility rehearsal, only `253_direct_ship_netsuite_posting.sql` was applied and recorded, then the release was deployed successfully. The final production image is `sha256:8891e1c5e78ba6ba6b825406742b62eda5919c717be5241ab3f8be392b93f9dc`, healthy with zero restarts. Configuration and dependent containers were preserved. The prior image and rollback configuration remain available in the deployment directory.

All 512 requested SO candidates have a final disposition: **502 already complete or selected lines already fulfilled, 3 verified new IFs, 7 held**. The raw candidate status counts are 503 reconciled, 2 completed, 5 waiting_evidence and 2 attention: SOA09523's concurrent background reconciliation retained its posted IF156234 and one attempt. It is counted among the three new IFs. No effective completed candidate remains `gate_disabled`.

Seven verified direct-PO completion events were replayed: **2 new verified IRs**, **5 live-complete skips**. The two new durable commands completed and finalized local receiving. All four approved gates are enabled; three required changes during this run, while Receiving IR 2967 had already been enabled. The five new records were independently fetched and checked, and every selected source line has zero remaining quantity.

The first read-back script assumed all posted candidates retained status `completed` and rejected SOA09523's observed `reconciled` label. It was corrected to accept either terminal label while still requiring its original transaction ID, external ID, exact quantities, one attempt and live full fulfillment. The first read log is preserved; the final independent read-back passes. This did not change production code or transaction verification rules.

[The operational report](../test-artifacts/direct-ship-posting-20261001/retry-report.md) lists each new transaction, the seven specific holds, both zero-remaining split reconciliations, gates and links to all 512 CSV results and live audit JSON. Waiting quantity evidence is not replaced with invented quantities, and the NetSuite workflow lock is not bypassed.
