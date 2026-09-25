# Aggregate access and requester workflow evidence

Spec: [aggregate-access-flow-spec.md](aggregate-access-flow-spec.md). Tier 3 (authorization, concurrent permission changes and workflow state). **Spec approval: not obtained (autonomous run).** The user authorized implementation and deployment; no checkpoint commits or dependencies were added.

Verified source: `02b217c839c0239a4076f1815633c12c184777bbfe584dcd4aad169c408ed962`. Node `v20.20.2`. Candidate image: `sha256:1f80126c8561128d5639674b94daaa13c3c157b8b9d83d0f84be68e2d625ee94`. The source manifest records hashes of runtime files, tests and validation tools. The scoped release changes 23 runtime files over the live image, preserving unrelated live/workspace differences.

## Acceptance mapping

| Behavior | Executable evidence |
| --- | --- |
| Separate grants, one eligible designated submitter per yard | `aggregate-request-access.test.js` unit role matrix and 150 generated grant/ordinary-yard combinations; HTTP grant/forgery tests |
| Admin assignment, normal access preserved, revisions, audit | Integration tests for same-session grants, simultaneous Admin updates, hostile inputs, role/password changes, forced audit rollback; real Admin browser assignment/removal in English/Chinese |
| Revocation/reassignment cannot be bypassed | Direct stale actors, committed-operation retries, edits by former/new requesters, and a writer waiting behind a revocation transaction |
| Submit becomes edit without lists/filters | Mobile and desktop Chromium create/reload/edit tests; exact eight-card count, no sidebar/history/filter/table/new action |
| SCM confirmation becomes actual reporting | Browser confirmation during unsaved edits, confirmed amounts, blank actual inputs, original due-date restriction, explicit zero, next submission, shortage review |
| Refresh and retries preserve the right state | Delayed yard response, failed fetch/recovery, committed submission with a lost response retried once, language switches, revoked controls |
| SCM and Operator navigation stay usable | SCM approval/proxy report/review/history/tabs, delayed tab responses, keyboard focus; Inventory entries including unavailable Damage/Count Sheet and working Cycle Count |
| Switching SCM request cannot act on the previous request | Deliberately delayed detail response: old Confirm button must disappear; the selected request is confirmed/reported in the database |

## Validation

- Focused final run: **57/57 passed**. Shuffled file order (seed 20260922): **57/57 passed**.
- Neighboring stock-request/cache checks: **50/50 passed**. Selected navigation checks: **2/2 passed**, four unrelated tests excluded by the documented name filter.
- Candidate built from the live image: migration, syntax/types/lint, **57 feature**, **50 neighbor**, and **2 navigation** checks passed.
- Syntax/ESLint/domain TypeScript: zero errors/warnings. New browser functions stay within the existing complexity limit of 20; backend functions use the existing lint budget.
- Instrumented changed lines: **442/442 covered**. All new access repository/router and requester lines executed. Requester branch coverage: 94%; access repository branch coverage: 98.14%; access router branch coverage: 64.28%.
- Manual mutations: **6/6 distinct faults killed**, **8/8 runs**, including both grant mutants against the property test alone. Faults cover inherited/inverted grants, former submitter access, missing locking, ignored revisions and missing audit writes.
- Migration 216 rehearsed in a disposable schema: exactly four initially unassigned yards, idempotent reapplication, complete rollback and unchanged normal account permissions.
- Hostile input/rollback/concurrency checks use PostgreSQL and real authenticated HTTP. Browser tests use Chromium at 390px and 1280px; focused accessibility checks have no serious/critical violations. Final screenshots reviewed for requester cards and the Admin grant section.

## Scope and limits

No package or lockfile changes. No NetSuite material links, external integrations, or messages to other people were added. The release adds a local assignment table, Admin endpoints, authorized workspace reads, and reuses existing application events.

`server.js` route wiring is exercised through real HTTP but not included in scoped coverage. Service-worker changes are cache-version literals checked by the existing cache contract tests; these online browser scenarios block service-worker installation to avoid its deliberate first-install navigation reload. Offline/PWA lifecycle behavior is outside this change. CSS is checked visually. Coverage is instrumented line evidence, not proof of every branch: router fallback/default callbacks and several browser defensive branches remain unexercised. Dependency audit was not rerun because dependencies are unchanged. Benchmarks were not added because no latency budget or bulk-processing path changed.

## Findings resolved during validation

- The first tests failed on inherited permissions and the old requester history view before implementation.
- The yard selector incorrectly marked a clean form dirty; fixed without weakening the yard-switch assertion.
- A complexity lint error led to extracting snapshot acceptance from fetch handling; assertions stayed unchanged.
- Repeated browser tests exposed old SCM actions during a selection load. A controlled delayed-response test failed before the one-line clearing fix, then passed. The test also verifies the selected database record, preventing a misleading pass against another request.
- Operator's first service-worker installation sometimes interrupted browser-test navigation. Online workflow contexts now block installation; cache contracts remain separate.
- Visual review found overlapping Admin assignment labels; the final card spans the account panel and names wrap correctly.
- One full-suite attempt used an unmigrated disposable database and was discarded. Validation was restarted with migration first. An artifact extraction ownership issue was corrected, including extraction options that preserve host-directory ownership.
- Whole-file c8 thresholds initially included unrelated, uncovered auth functions. The final gate enforces 100% of instrumented **changed** lines; it reports whole-file branches honestly instead of claiming full unrelated-module coverage.

## Reproduction

Run `sudo bash server/tools/aggregate-access-gauntlet.sh` from the repository root. It creates only named disposable Aggregate test containers, migrates before testing, runs focused/static/coverage/mutation/shuffled checks, then compares the full suite against `test/aggregate-access-existing-baseline.json`. `--focused` omits the full-suite rerun. Existing tools/dependencies in image `field-sales-check-2941306:latest` are required; no installation is performed.

Release commands are `python3 server/tools/aggregate-access-deploy.py prepare`, `build`, `check`, and `apply`. Preparation/build/check are reversible and can run while the full suite finishes. Apply requires zero new full-suite failures, matching sealed source and candidate image hashes, unchanged live configuration, successful candidate checks, database backups and an idle cutover check. Automatic rollback restores the prior image if live verification fails; the additive migration is retained.

## Full-suite and live results

Final full suite: **561 files, 2942 tests, 2917 passed, 24 failed, 1 skipped; zero new regressions after baseline investigation**. The initial pre-change run had 23 failing tests. The additional stock-return failure is a pre-existing cache-age dependency, independently reproduced on the untouched snapshot: fresh-cache baseline **8/8 runs passed**, expired-cache baseline **3/3 runs failed identically**; expired-cache final source **5/5 failed identically**, fresh-cache final source **3/3 passed**. The unchanged test classifies the existing metadata GET after the ten-minute return-reason cache expires as an unexpected request. No stock-return implementation or assertions were changed. The original full baseline is preserved; the comparison baseline explicitly records this additional observation with replay logs and source hashes.

The replay is reproducible with `tools/aggregate-regression-replay.mjs test/mbt/integration/stock-return-draft-insert.test.js COUNT --expired-return-cache` (or `--fresh-return-cache`) inside the isolated test environment. `tools/aggregate-cache-baseline.py` checks the captured before/after replay results and unchanged source hashes before recording the supplemental baseline. This is a known suite-health limitation, not a claim that the entire repository is green.

Deployed at **2026-09-22T15:03:03.570848+00:00** to **https://test.mbbsoperation.com** using `mbbs-operator-app:aggregate-access-flow-20260922-v3` (`sha256:1f80126c8561128d5639674b94daaa13c3c157b8b9d83d0f84be68e2d625ee94`). Migration 216 applied; normal account roles/yard permissions remained unchanged. No users were automatically granted Aggregate access.

Live checks passed against localhost and the public URL: health, both Aggregate/SCM pages, four unauthenticated API denials, and hashes of all 15 changed public assets. All 23 runtime file hashes match the candidate. The read-only database check confirms seven materials and four designated-yard slots. Application configuration and the other services are unchanged. The Dispatch edit session cleared before cutover; no operational requests or account assignments were created by verification.

Deployment result: `test-artifacts/aggregate-access-deployment-20260922/deployment-result.json`. Source/coverage/mutations/full comparison: `test-artifacts/aggregate-access-flow/`. Rollback image and verified schema/migration backups remain available in the release artifacts.

