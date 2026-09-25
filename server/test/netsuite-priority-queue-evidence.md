# Operator pickup and return priority — evidence

**Deployed to both app and webhook worker on 2026-09-25 at 19:42 UTC**, following
the user's explicit deployment instruction. Migration 227 is applied. The
[release evidence](netsuite-priority-deployment-evidence.md) records fresh checks
against both live service versions, source hashes, rollback rehearsal and live
verification. The earlier instruction to leave the fix prepared is superseded.

The sections below retain the original preparation evidence from 2026-09-24.
That preparation superseded the earlier SuiteQL-bypass-only image and did not
modify production. The original frozen artifacts remain unchanged.

Operator requests take precedence over waiting background requests. SuiteQL,
record REST and RESTlet HTTP attempts from upgraded app/worker processes sharing
the database use **four total slots**, with **at most one background attempt**.
Running requests finish normally. Response consumption remains inside the slot;
retry delays do not retain a slot. Existing local Operator operation pooling is
preserved.

Priority covers pickup, delivery, receiving, returns, inventory and counting
routes used by the Operator screen. Pickup and return validation, posting and
readback retain priority. Bulk delivery/receiving/inventory sync and detached
return-directory refresh remain background work.

## Source and reproduction

- Tier: 3, concurrency and existing financial posting boundaries.
- [Executable specification](netsuite-priority-queue-spec.md).
- Spec approval: **not obtained (autonomous run)**. The user authorized the work,
  but did not independently review the specification; confidence is limited by
  that lack of independent review.
- Final frozen source: `test-artifacts/netsuite-priority-queue/candidate-v4`.
- Source-tree hash:
  `bd27284c4ab81b71d7b0f8d10b3a7ae235376ed6e41dd4e3da70db189db33521`.
- [Prepared manifest](../test-artifacts/netsuite-priority-queue/prepared-manifest.json)
  identifies every runtime file and the additive migration.
- [Combined review patch](../test-artifacts/netsuite-priority-queue/prepared-combined.patch)
  includes the earlier undeployed SuiteQL bypass as well as this change. The
  comparison baseline already contained that earlier prepared line; the combined
  patch explicitly restores the original NetSuite-file base for review.
- Original uncommitted workspace captured in
  `test-artifacts/netsuite-priority-queue/baseline`, with a saved hash manifest.
  Retain this snapshot for reproduction; unrelated existing work was neither
  reverted nor committed. The frozen candidate overlays only this task's files.

One reproduction entry point, with a fresh label:

```sh
bash tools/netsuite-priority-queue-gauntlet.sh candidate-review-01
```

This runs the complete baseline/candidate inventory, focused coverage, static
comparisons, mutation, shuffle, local server execution, and preparation checks.
It uses the existing Docker dev image and isolated PostgreSQL/internal networks.
The final execution used the identical, hash-verified baseline from the earlier
complete run:

```sh
python3 tools/netsuite-priority-queue-gauntlet.py candidate-v4 --baseline-from candidate-v3
python3 tools/netsuite-priority-queue-prepare.py candidate-v4
```

Toolchain: Node 20.20.2, PostgreSQL 18-alpine, c8 12.0.0, ESLint 10.8.0,
fast-check 4.9.0, TypeScript 7.0.2. Existing dev image:
`sha256:a213a201d54066121bc474fd418fe25417cc595bfc4be21abd3cefcd0cd6e6a2`.
No dependency installation, package changes or git commits.

## Final results

| Layer | Actual result |
| --- | --- |
| Focused tests and neighboring workflows | **94 passed, 0 failed** |
| Full baseline, 588 files | 3,143 tests: 3,118 passed, 24 failed, 1 skipped, 0 cancelled |
| Full candidate, 593 files | 3,162 tests: 3,137 passed, 24 failed, 1 skipped, 0 cancelled |
| Regression comparison | **19 new tests passed; 0 new failing tests or files** |
| Types | 254 existing diagnostics; **0 new** |
| Scoped lint | 949 existing diagnostics; **0 new** |
| Changed-line coverage | **221/221 measured changed lines** |
| Changed-branch coverage | **88/94 measured branches**; core scheduler fully covered |
| Queue mutation | **5/5 killed by examples, 5/5 killed by the property test alone** |
| Existing PO race protection | Version-recheck mutant killed; original assertions unchanged |
| New property scenarios | 24 mixed priority/background scenarios, seed 240925 |
| Shuffled focused execution | All passed, seed 250926; separate processes preserve actual shuffled order |
| Real execution | Actual server health 200, DB-backed bootstrap 200; real HTTP transport against a local simulator |
| Cross-process concurrency | Four independent Node processes, 12 HTTP requests; peak total 4, peak background 1 |
| Migration | Applied to disposable databases and repeated successfully |
| Dependency/secret/capability review | Dependency files unchanged; basic added-diff credential-pattern scan passed; new capability is independent coordination transactions in the existing DB |

The complete suite is **not globally green**: it retains the baseline's 24
failures. Exact identities, hashes and counts are in
[regression.json](../test-artifacts/netsuite-priority-queue/regression.json).
[checks.json](../test-artifacts/netsuite-priority-queue/checks.json) and the
adjacent logs contain the focused, mutation, static, shuffle and startup results.
Coverage is measured rather than claimed exhaustive: six branches remain
uncovered, including defensive defaults, a PDF application-error variant and a
store cleanup path; their locations are retained in the c8 report.

## Specification mapping

| Scenario / invariant | Evidence | Status |
| --- | --- | --- |
| Pickup and return validation/POST/readback proceed despite held background work | `netsuite-priority-queue-http.test.js`; retained `operator-suiteql-priority.test.js` | Pass |
| Four shared slots; one background; FIFO and Operator precedence | `netsuite-priority-queue.test.js`, property suite and five mutants | Pass |
| Same budget across processes | `netsuite-priority-queue-process.test.js` with real PostgreSQL/HTTP | Pass |
| Slot held through body read; 429 delay releases it | `netsuite-priority-queue-transport.test.js` | Pass |
| Actual Operator route inventory, including pickup and return | Production registration assertions plus HTTP middleware tests and existing real-server pickup/return tests | Pass |
| Bulk sync/detached directory refresh remain background | HTTP bulk test and real directory-refresh transport test | Pass |
| Cancellation, deadlines, expired/stale grants, queue bounds, DB fail-closed behavior, release recovery | Seven adversarial/failure tests in `netsuite-priority-queue-failure.test.js` | Pass |
| No business-pool deadlock; repeatable additive migration | Business pool fully occupied while independent queue works; migration replay | Pass |
| Preserve payloads, IDs, auth/yard checks, retries, pages, idempotency and stale-write protection | Transport matrix, existing readiness/pickup/return tests, PO race test and mutation, full baseline comparison | Pass |
| Separate queue/HTTP timing without SQL or credential logging | Existing Operator timing/attribution tests; shared-queue timing preserved | Pass |
| No production deployment or external business writes | Internal-only test networks, fake credentials, prepared manifest | Pass |

## Corrections and limits

- The initial scheduler stub failed its behavioral examples and property test.
  Pickup/return blocking tests failed before routing changes. Logs are retained
  as `red.log` and `red-http.log`.
- Coverage exposed nondeterministic test arrival order when fixed sleeps were
  used before DB registration. The fixture now waits for each actual queue entry;
  the FIFO assertions were unchanged.
- Final route review found the legacy pickup/delivery/receiving route prefixes.
  Expanded route assertions and a bulk-sync test failed first, then passed after
  wiring those routes. See `red-route-inventory.log` and `green-route-inventory.log`.
- The existing PO test extracted a function into a VM and omitted its new shared
  helper. Its harness now includes the real helper and dependencies. All original
  assertions are unchanged; the version-check mutant still fails those assertions.
- Two isolated test groups initially could not allocate Docker network ranges.
  Only the missing groups were rerun after earlier containers cleaned up. No
  unrelated containers or networks were pruned. The final candidate has complete
  fresh results for all three groups.
- This limits this application's upgraded processes sharing the same database.
  Other integrations, old code still running elsewhere, and OAuth token endpoints
  are outside this data-request budget. A local timeout cannot prove NetSuite
  stopped processing remotely. Abandoned grants expire after their request
  deadline plus a 30-second recovery margin.
- Strict Operator priority can defer background work under sustained Operator
  demand. There is no absolute latency promise for NetSuite processing or external
  account throttling.
- Skipped: live NetSuite execution and production rollout, per the user's
  instruction. UI/browser changes and dependency auditing are not applicable:
  neither browser assets nor dependencies changed. No production release image
  was built for this revision.

Any later authorized rollout needs migration 227 and coordinated adoption by
both the app and webhook worker, with fresh checks against their current live
versions. The older single-app bypass image is marked superseded. The additive
queue table can remain unused after a rollback; it stores no request payloads or
business documents.
