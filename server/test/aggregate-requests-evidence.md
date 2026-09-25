# Aggregate Requests implementation evidence

Validated on 2026-09-22 against the acceptance specification in [aggregate-requests-spec.md](aggregate-requests-spec.md).

The standalone page is `/aggregate-requests`; SCM manages the same records at `/scm/stock-requests?tab=aggregate`. Migration [215_aggregate_requests.sql](../migrations/215_aggregate_requests.sql) adds requests, seven material lines per request, and an immutable operation history. No NetSuite items or inventory transactions are used.

## Behavior and evidence

| Requirement | Executable evidence |
| --- | --- |
| Staff roles, assigned yards, original requester ownership, private SCM actions | Domain role matrix; real authenticated HTTP tests; revoked-SCM retry test; existing sidebar authority test |
| Seven fixed materials, inbound/outbound directions, explicit integer loads and zero actuals | Catalog and validation tests; fractional-load property; mobile/browser actual-report validation |
| Tomorrow's service date and next-day reporting using Toronto calendar days | Midnight, weekend, year-end and DST cases; report-date property; stale service-date rejection |
| One request per yard/date, durable retries and stale-edit protection | Concurrent submissions by two users; 25 simultaneous identical retries; changed-payload retry rejection; competing confirmations |
| Overdue pending/confirmed requests block their creator at that yard | Repository and HTTP overdue-gate tests; requester browser flow; other-user/other-yard cases |
| SCM adjustments, actuals, shortfall review, corrections and acknowledgment | Domain transitions; persisted repository/HTTP flows; SCM browser confirmation, proxy reporting and acknowledgment |
| Atomic writes and consistent detail reads | Forced audit-insert failure rollback; report versus confirmation race; read blocked behind uncommitted confirmation |
| Forms and active tabs survive refreshes | Chromium delayed-response, language/live refresh, keyboard focus and recoverable network-error cases |

Tests are in [aggregate-request-domain.test.js](mbt/unit/aggregate-request-domain.test.js), [aggregate-request-repository.test.js](mbt/integration/aggregate-request-repository.test.js), [aggregate-request-http.test.js](mbt/integration/aggregate-request-http.test.js), and [aggregate-request-browser.test.js](mbt/integration/aggregate-request-browser.test.js).

## Feature validation

- **36/36 feature tests pass**: 13 domain/property, 15 PostgreSQL repository, 2 HTTP, and 6 Chromium browser tests.
- Four seeded properties exercise 100 generated cases each. A second seeded file ordering passes all feature tests.
- **51 related checks pass**: 44 existing Regular/Special tests, 6 Operator refresh/cache tests, and the existing sidebar authority test.
- Seven deliberately injected faults are detected: fractional quantities, reversed reporting date, missing owner check, incorrect variance calculation, missing revision increment, missing overdue gate, and missing retry-payload conflict. All five domain faults are also detected using only property tests.
- Syntax checks, ESLint (including complexity constraints), domain TypeScript checking, and `git diff --check` pass. No dependencies or dependency-lock changes were introduced by this feature.
- Migration creates all three tables, tolerates reapplication, and rolls back completely in a disposable schema. A forced audit failure also rolls back request and material changes.
- The 390px mobile page has no document overflow and no serious/critical axe findings in the module. Mobile and desktop screenshots were reviewed. Keyboard tab focus remains stable through background refresh.

| Coverage scope | Lines | Functions | Branches |
| --- | ---: | ---: | ---: |
| Three new server modules | 473/473 (100%) | 43/44 (97.72%) | 208/222 (93.69%) |
| Aggregate browser client | 358/358 (100%) | 36/36 (100%) | 287/314 (91.40%) |
| Shared SCM tabs | 44/44 (100%) | 5/5 (100%) | 22/23 (95.65%) |

The validation command enforces 95% lines/functions and 90% branches for new code. Coverage is scoped to the new modules; it does not claim complete coverage of the existing application.

Two additional failures were reproduced before their fixes: background refresh lost tab keyboard focus, and a detail read waiting on confirmation could combine a new header with old material quantities. Both regression tests pass after the fixes. Operator script/refresh-guard cache versions are aligned; public Sales retains only its existing navigation.

## Full regression comparison

The existing isolated `npm test` suite completed in both snapshots:

| Snapshot | Test files | Tests | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: | ---: | ---: |
| Before this feature | 555 | 2,884 | 2,859 | 24 | 1 |
| Final implementation | 559 | 2,920 | 2,896 | 23 | 1 |

**No new failing test names were introduced.** The 36 added feature tests pass in the complete run as well as the feature suite. Existing failures remain in 20 files (21 before the change), including prior cache/version contracts, migration inventory checks, gate assertions, and existing integration failures. One pre-existing stock-return test passed on the final run; this is recorded as baseline variability, not a claimed Aggregate fix.

The complete suite is therefore **not green**. The comparison preserves the existing failures rather than changing unrelated implementation or assertions to hide them. Inspect [full-regression.json](../test-artifacts/aggregate-validation/full-regression.json), [final log](../test-artifacts/aggregate-validation/full-regression.log), and [baseline log](../test-artifacts/aggregate-validation/baseline.log).

## Reproduce and inspect

Run from the repository root on a host with Docker:

```sh
bash server/tools/aggregate-gauntlet.sh
```

This manages only `mbbs-aggregate-requests-*` containers on an internal test network. It uses the locally available `field-sales-check-2941306:latest` Node/test image and `postgres:18-alpine`; `AGGREGATE_TEST_IMAGE` can select an equivalent prepared image. Source mounts are read-only, external integration writes are disabled, and the database and artifacts are disposable.

Full-suite comparison uses the existing isolated `npm test` runner and [aggregate-regression.py](../tools/aggregate-regression.py). Its pre-change result is retained in [aggregate-existing-baseline.json](aggregate-existing-baseline.json).

Raw test, static, migration, mutation, coverage, and source records are in [test-artifacts/aggregate-validation](../test-artifacts/aggregate-validation). Screenshots: [mobile](../test-artifacts/aggregate-validation/aggregate-mobile.png), [SCM](../test-artifacts/aggregate-validation/aggregate-scm.png). These generated artifacts are gitignored.

Validated source digest: `2cf61cc57c93cbcb8d79c0d51a9e41833ca0a55d4bfc95769cb379825c9a80b8` (per-file SHA-256 manifest in `aggregate-source.json`). Runtime: Node 20.20.2, PostgreSQL 18, Chromium. The original workspace baseline was captured before edits; pre-existing changes were preserved.

Implementation validation used disposable databases and did not deploy to production. A subsequent explicit deployment request was completed; see [deployment evidence](aggregate-requests-deployment.md). Browser checks cover Chromium; offline aggregate submissions are not supported.
