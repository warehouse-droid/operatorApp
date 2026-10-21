# Stocking → Backorder conversion evidence

Generated 2026-10-07T13:47:50.490276+00:00.

Spec approval: not obtained (autonomous run). The user selected **Whole request** and **SCM**, and authorized implementation and deployment after passing checks. This report demonstrates the stated executable criteria; it does not substitute for independent review of the criteria.

SCM can convert an entirely open, uncommitted Stocking Transfer or Purchase in place. The request keeps its ID/STREQ reference, requesting Sales store, customer, remarks, saved material descriptions, quantities, UOM, pack quantities and individual receiving yards. SCM confirms vendors and Pickup/Delivery in the dialog. The request starts the existing Backorder stock-review workflow. Existing TO/PO/SO commitments and closed lines prevent conversion.

## Final checks

| Layer | Observed result |
| --- | --- |
| Focused real HTTP, Chromium, workflow and property suites | 97/97 pass; 0 failures; 0 skipped |
| Affected shared-suite baseline | 1500 tests; 1418 pass; 82 failures; 0 skipped |
| Affected shared-suite candidate | 1500 tests; 1419 pass; 81 failures; 0 skipped |
| New shared-suite failures | 0 |
| Changed executable lines | 274/274 executed; annotation-only lines identified separately |
| Manual plausible mutants | 15/15 killed |
| Applicable mutants rerun against properties alone | 4 killed |
| Reverse file order | 97/97 pass; 0 failures |
| Types | Baseline 9898, candidate 9898; 0 new errors |
| Lint, syntax, changed whitespace and secret scan | Passed |
| Packaged imports and deployed source hashes | Passed; 12 runtime files |
| Live application | Healthy; configuration preserved; 1 existing Backorders checked read-only |
| Disposable test resources | All removed; production health passed |

Branch observations are recorded in `changed-coverage.json`; full branch coverage is not claimed. Existing failures/skips are retained verbatim in `regressions.json` and the baseline/candidate TAP logs. Dependency auditing is not repeated because no dependency or lockfile changed. No schema change, NetSuite order creation, or conversion of production requests occurred during validation. Real integration tests exercise transaction locks, an actual concurrent commitment, rollback injection, authenticated roles, and stale Stocking endpoints; external NetSuite writes are denied in the isolated environment.

Shared Backorder browser fixtures wait for initial queue and vendor-directory loading before interacting. The tests do not claim preservation of edits across a late vendor-directory redraw on the existing Backorder page. The observed startup race and dependent completion assertion are retained in `initial-vendor-browser-loading-failure/`; only fixture initialization changed, with workflow assertions and timeouts preserved.

## Acceptance mapping

| SPEC criterion | Evidence |
| --- | --- |
| 1: SCM-only whole conversion, same request and submission details | API: `SCM converts the entire…`, `only SCM can convert…`; Chromium Transfer/Purchase dialog |
| 2: eligibility, revisions, committed/terminal rows and atomic rejection | API invalid revision/terminal/commitment tests; seeded eligibility properties; concurrent commitment |
| 3: saved material values, regular items, independent vendors/yards, no prices | API saved-master and Delivery tests; 600 generated material cases; receiving-yard API and Chromium tests |
| 4: original Sales access, preserved audit and retired source rows | API whole-conversion snapshots/history and role tests; audit-history and Sales-yard mutants |
| 5: fulfillment validation, new enquiry, no native orders | API invalid inputs and Delivery tests; real dialog; external-write trap and before/after snapshots |
| 6: existing Backorder sequence and legacy-action guards | Shared workflow suites; stale Stocking endpoint test; old acknowledgement→new review/PO notification test |
| 7: atomic conversion, no duplicate and raced commitment retained | API simultaneous conversion, concurrent locked SO commitment, injected event failure rollback |
| 8: actual UI, escaping, cancel, errors, busy and audience | Chromium dialog, stale revision, Sales absence and material-edit tests; browser coverage logs/screenshots |

The first RED API attempt had an invalid pack-quantity fixture; it is retained separately and is not claimed as behavioral RED. Corrected API, browser and property RED logs exist at the artifact root. Later failures exposed database profile/retirement ordering, original submission date, preview authorization, fulfillment validation, delivery visibility, stale Stocking resolve actions, cross-yard Sales edits and notification read-state incompatibility; they were corrected and rechecked. Fixture corrections are appended visibly in SPEC.md. The first final pass detected all 15 faults but exposed a reporting filename collision: its stage summary overwrote the detailed mutation JSON. The reporting label was separated, array validation added, and final verification repeated against unchanged runtime source. The earlier pass is retained in `verification-report-format-failure/`. Assertions were not weakened to accept failures.

## Reproduce and identify the source

Run from the repository root:

```sh
python3 server/tools/stocking-backorder-conversion-20261007/run.py all
```

The runner uses the standard bounded isolated Compose configuration under `mbbs-tests.slice`, registers teardown before startup and removes its disposable database, volumes, networks and containers on exit. `summary.json` identifies runtime, tests, tooling and the unchanged dependency lockfile by SHA-256. Test tooling: Node v20.20.2; {"@playwright/test": "1.62.1", "c8": "12.0.0", "eslint": "10.8.0", "espree": "11.2.0", "fast-check": "4.9.0", "typescript": "7.0.2"}. Manual mutation commands and final evidence generation are persisted alongside the runner. Deployment uses the narrow tested source overlay, app-only replacement and an automatic rollback on failed verification.

Deployed application image: `sha256:87d3a6faad7061152ae1e988b91b39fcd6842289aa987bfb8d4b7d4e36d015cb`. Production configuration and the other three production services were preserved. Final `docker ps` and `docker ps -a` appear in `cleanup-final.json`. No test databases were retained.
