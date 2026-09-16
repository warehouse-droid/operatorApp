# Operator PO receiving — evidence

## Outcome

Prepared receiving now displays and confirms **ordered quantity minus the
NetSuite received baseline**, including quantities allocated to sales orders.
SO allocation metadata and records remain intact. The browser consumes the
projected remaining quantity without subtracting previous receipts a second time.

The yard guard resolves negative PO/TO IDs before the legacy local CO fallback,
fixing SN1400409's `Operator record not found` error. Explicit CO requests retain
their existing lookup and every request still uses the stored destination yard.

Item Receipt preparation now resolves negative purchase orders through the active
PO split ledger to the positive NetSuite PO. It uses the line ledger for synthetic
child line keys and rejects missing/ambiguous lineage. Existing receipt caps,
posting reconciliation, duplicate-command handling and finalization stay in place.
The Operator script/cache versions were advanced for eventual deployment.

**Not deployed. No production records, SO allocations or NetSuite transactions
were changed.** The earlier Smart SCM PO sync release remains deferred. Its saved
images predate this receiving correction.

Spec approval: **not obtained (autonomous run)**. See
`test/operator-receiving-identity-spec.md`, including the appended user correction
that supersedes the original identity-only scope.

The isolated runtime delta is `test/operator-receiving-identity.changes.patch`.
Exact original/prepared hashes and reversible source blocks are recorded in
`test/operator-receiving-identity-baseline-blocks.json`. All unrelated working-tree
changes were preserved. No dependencies, schema migrations or commits were added.

## Read-only search audit

Final snapshot: **2026-09-15T16:49:07.618Z**. One PostgreSQL repeatable-read,
read-only transaction compares the deployed and prepared repository, guards and
actual UI filters. The transaction is rolled back.

| Check | Result |
|---|---:|
| Split records checked | 179 |
| Active / cancelled | 163 / 16 |
| Eligible for receiving / searchable | 162 / 162 |
| Prepared detail successes, typed and untyped | 162 / 162 |
| Foreign-yard requests denied | 162 / 162 |
| Orders with visible receiving lines | 162 |
| Empty eligible details / other search exceptions | 0 / 0 |

All 16 cancelled splits are absent from receiving search. The remaining active
split `PO# B03429 (L2)` has `Pending Bill` status and remains outside the existing
receiving-status filter.

All seven previously empty allocated orders now display their unreceived lines:

| Split | Source PO | Unreceived item quantity | PALLET quantity |
|---|---|---:|---:|
| LOINC-022229 | POB03536 | 1088 PC | 34 EACH |
| PO# B03429 (L1) | POB03429 | 1771.2 SQFT | 18 EACH |
| SN1398647 | POB03747 | 144 PC | 16 EACH |
| 3022152102 | POB03768 | 1440 PC | 24 EACH |
| 3022152112 | POB03768 | 1440 PC | 24 EACH |
| 3022152120 | POB03768 | 1140 PC | 19 EACH |
| SN1400513 | POB03872 | 22 PC | 4 EACH |

`3022152120` retains a separate allocation discrepancy: 1320 PC and 22 EACH are
allocated to SOA07539-S3, exceeding its current PO quantities. Receiving now uses
the actual 1140 PC / 19 EACH. The allocation discrepancy was not repaired.

SN1400409 displays 2284.8 SQFT of UNI-TV80S-RDM-STORM (28 PLT) and 28 EACH PALLET.
The original deployed guard fails to open all 162 eligible synthetic negative IDs;
the prepared guard passes every corresponding lookup.

Record-level evidence: `test-artifacts/operator-receiving-identity/all-split-po-search.json`
and `.md`. The previous allocation-based audit is preserved as
`all-split-po-search-before-allocation-fix.json` in the same directory.

## Reproduction

Existing tools: Node 20.20.2, PostgreSQL 18, ESLint 10.8.0, TypeScript 7.0.2,
fast-check 4.9.0, c8 12.0.0 and Chromium in the installed Docker test images
`mbbs-retired-confirm-test:20260914` and `mbbs-mbt-p1-test-e2e:latest`.

From the server directory, one command runs the full suite, focused checks,
changed-line coverage, mutations, static checks, a fresh-database reversed run,
and the actual browser page:

```bash
sudo -n bash tools/operator-receiving-identity-gauntlet.sh
```

To repeat the separate production **read-only** search audit:

```bash
sudo -n bash tools/operator-receiving-split-search-audit.sh
```

The audit overlays prepared modules into a separate temporary process. It never
submits confirmation, receipt or allocation requests. The ordinary test wrapper
uses a disposable database on an internal Docker network and does not load the
production environment file.

## Final verification

All results below use the same final runtime candidate; its six runtime files
still match the prepared SHA256 manifest.

| Layer | Measured result |
|---|---|
| Full suite, 475 files | 2413 tests: **2410 pass, 2 existing failures, 1 skipped, 0 cancelled**; no new failures |
| Focused receiving/posting/security checks | **127/127 pass** |
| Generated identity, quantity and UI cases | **260 cases pass**; seeds 20260915 |
| Changed executable-line coverage | **47/47 covered**: authorization 4, receiving projection 5, posting lineage 35, UI 1, service worker 2 |
| Manual mutation checks | **15/15 bugs caught**, 28/28 runs; 13 also caught by property tests alone |
| Enforced reverse execution, fresh database | **127/127 pass** across 16 files |
| TypeScript | **233 baseline / 233 current** diagnostics; no new errors |
| Lint | **1115 baseline / 1115 current** diagnostics in the expanded existing-source scope; no new warnings/errors; new tests/tools clean |
| Syntax and secret checks | Pass |
| Actual Chromium Operator page | Original 404: 0 line cards; prepared response: 2; fully allocated partial receipt: 2 with 14 PLT / 14 EACH; **0 browser errors** |
| Production read-only search/detail audit | **162/162** eligible split POs show lines; seven previously empty allocated orders restored |

The HTML script reference is covered by the asset installation/contract tests;
it is not counted as an executable JavaScript coverage line. The SQL lines in
posting lineage are executed against PostgreSQL. No new branch was added to the
quantity arithmetic; the authorization and lineage success/failure branches are
exercised by the focused cases and deliberate mutants.

Detailed outputs are in `test-artifacts/operator-receiving-identity/`:
`full.log`, `focused.log`, `coverage/`, `changed-coverage.json`, `mutations.json`,
`gauntlet.json`, `lint*.log`, `types*.log`, `reversed.log`, `reversed.json`,
`browser.json`, and the three `receiving-*.png` screenshots.
`sources.json` captures the candidate and original verification tools. The final
reverse-order runner has its separate tested SHA256 in `reversed.json`.

## Specification mapping

| Criteria | Executable verification |
|---|---|
| 1–8: signed identity, CO fallback, yard access, collisions, closed/missing records | Nine cases in `test/mbt/integration/operator-receiving-identity.test.js`; 80 generated identity/grant cases |
| 9–12: allocated/partial/overallocated quantities and unchanged allocations | `test/mbt/integration/operator-receiving-allocations.test.js`; 80 generated quantity cases |
| 10: UI subtracts receipt only once | `test/mbt/unit/operator-receiving-quantity-ui.test.js`; 100 generated cases; actual Chromium page |
| 13: positive PO parent, retained/synthetic line keys, cancelled/missing lineage | Allocation integration tests with real database lineage and mocked remote reads; existing posting-target tests |
| Receipt caps and duplicate protection | Existing posting-domain, posting-service and posting-concurrency tests included in the focused list |
| Assets load the fresh script and preserve other caches | Existing Operator asset/UI contract tests with updated version expectations |
| 14: all split searches | Persisted production read-only audit tool and per-record report |
| Prior unrelated behavior and APIs | Full suite and baseline-relative static checks; isolated runtime patch |
| No production writes, deployment or new dependencies | Disposable internal test database; read-only production transaction; source/capability diff review |

## Notes and limits

- Original identity RED: seven of nine tests failed. Existing CO/closed behavior
  passed initially and was challenged with deliberate mutants.
- Allocation/UI/cache RED: nine failures with assertion/property errors. A
  separate missing-lineage test failed with `Missing expected rejection.`
  Initial fixture setup omitted required dispatch allocation target fields;
  those fixtures were corrected before recording behavioral RED results.
- Earlier broad/reversed runs reused a database polluted by existing yard tests,
  causing duplicate-key and cached-lookup failures. Full tests now run first in
  a fresh database; the reversed run receives another fresh database. Failed
  logs are retained as `full-polluted-template.log` and
  `reversed-polluted-template.log`; these are not accepted as baseline failures.
- Node sorts multi-file `--test` arguments, so reversing arguments alone did not
  change execution order. The final runner invokes one file at a time in the
  requested reverse order. That runner was corrected after the full gauntlet,
  then rerun against a fresh database with its own syntax, lint and secret checks.
  The runtime implementation and all test assertions stayed unchanged; only the
  affected runner was rechecked. `reversed.log` records each actual file boundary.
- The pre-task full baseline has two unrelated infrastructure failures:
  `P3.12: browser specs share one worker-owned database-pool lifecycle` and
  `quality non-regression: the gauntlet builds and validates the omit-dev runtime`.
- Existing frontend lint messages embed source line numbers. The comparison
  normalizes those positions while retaining file, rule and message content.
  Audit helpers were separated to meet the complexity budget; no test assertion
  was weakened.
- A browser 404 can leave the previous screen until a normal language toggle
  renders the found order with empty detail. Successful responses show the lines
  immediately. The additional partial-receipt fixture shows 14 remaining PLT and
  14 EACH even when the original 28 PLT / 28 EACH are fully allocated.
- No live Item Receipt was submitted. Production search checks read existing
  records; IR preparation uses an isolated real database and replaces only the
  remote NetSuite read boundary. Existing posting/reconciliation tests cover
  caps and retry behavior. Live NetSuite acceptance remains unverified.
- Dependency vulnerability/license auditing and migration rollback rehearsal
  are inapplicable because packages and schema did not change. Concurrency is
  checked through the existing posting concurrency tests; no new lock or write
  protocol was introduced.
