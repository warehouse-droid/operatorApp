# Recorded PO load correction — 2026-09-14

The user confirmed that LOINC-033146's recorded physical load is unchanged and
asked to deploy after the focused regressions passed, then run mutation and
broader checks. Risk tier 3; autonomous implementation under that authorization.
The append-only specification is `dispatch-recorded-po-load-spec.md`.

## Root cause and correction

Plan 324 records a 1500.29 PO drop on T4. Allocation 186 assigns 1274.4 to
SOM06255-S2. Automatic dependency projection therefore calculated a residual of
225.89 and rewrote the PO drop even after its physical pickup/drop had started.
The executed-prefix guard correctly rejected the resulting cargo change.

Refresh now derives started PO references from persisted snapshots and driver
events. For those POs it preserves the published route projection, including
absence of that optional projection, and leaves their recorded residual stops
intact. A submitted payload cannot supply this authority. Both canonical and
legacy projection spellings are normalized at the boundary. Unstarted POs
continue to use current allocations; travel, pending jobs and other-order work
do not freeze them. The existing executed-prefix validator still rejects edits
to protected cargo.

The follow-up replaces `dispatch-plan-repository.js`,
`dispatch-plan-order-projection.js`, and `scm-dependency-plan-reconciler.js`, and
adds `dispatch-recorded-po-projection.js`. It retains the previously deployed
unpacked-split and retired-order corrections. No production data repair,
allocation cancellation, source-order edit or recovery promotion was needed.

## Deployment and live evidence

The 41 focused tests passed before deployment. The app was then deployed at
15:14:15 UTC using `mbbs-operator-app:recorded-po-load-20260914-v1`, image ID
`sha256:d191827e555b09450f2301286dfdfdd84bc4ba9ed6041491692635b0c9015263`.
It is healthy. The webhook worker retains its original image and September 11
start time. All four deployed module hashes match the regression-tested source.

Read-only live checks passed for:

- LOINC-033146's exact 1500.29 quantity, all six recorded T4 stops and timings,
  absence of a newly projected residual, and acceptance of the unchanged plan
  by the executed-prefix guard.
- SOA08404-S2's retirement, CO-GOA-7894-7895's recreated canonical visibility,
  fresh feed-to-validator agreement, and rejection of an assigned retired split.
- App health, served browser assets, recovery integrity and repair audit 20756.

Before/after hashes are identical for plans 324/326, their snapshots, 27 recovery
records, 33 driver records, the scoped source SOs and the canonical CO. Plan 324
remains confirmed at revision 19 and plan 326 at revision 16. Production
save/confirmation writes were not used as a health check.

Deployment evidence is under `server/test-artifacts/recorded-po-load/`:
`deployment.log`, `production-containers.txt`, `deployed-source.sha256`,
`production-before.log`, `production-postcheck.log`, and
`production-persistence-proof.json`. `production-final-containers.txt` confirms
the app remains healthy and both app and worker identities/start times are
unchanged after the complete post-deployment test run.

## Replay

The retained isolated production copy is exercised through actual browser
payload generation, plan save, confirmation and rollback. A new full database
export was rejected by automatic approval review because it could include
unrelated sensitive data. The approved scoped alternative supplies only 21
current active driver events for plan 324 and applies them inside an outer
rollback transaction. No new full export was made.

With those current events:

| Candidate | Expected and observed result |
| --- | --- |
| Published plan 324 | Saves and confirms unchanged; all six T4 stops and 1500.29 retained |
| Latest recovery 17291 | Saves at revision 20 and confirms at revision 21 inside rollback; recorded stops and later draft edits retained |
| Older recovery 17288 | Correctly rejected by the T4 lock through stop index 5 because it omits both now-executed PO stops |
| September 13 recovery 17282 | Original retirement failure cleared; its independent T7 cargo lock remains |
| Direct edit to 225.89 | Rejected by the executed-prefix validator |

The separate replay with the earlier driver activity still passes save and
confirmation for both 17288 and 17291. These are distinct historical contexts;
an older draft is not allowed to erase physical work recorded since that draft.
No missing stops are synthesized into it. Rollback witnesses verify that plans,
snapshots, recoveries, drivers, source PO/SOs, allocations and the CO are unchanged.

Both replay variants passed again after deployment. Logs are
`server/test-artifacts/retired-confirm/recorded-po-postdeploy/replay.log` and
`recorded-po-replay.log`.

## Test evidence

The focused suite passed 41/41 again after deployment. Its new PO regressions
cover real PostgreSQL read/save/confirm behavior, late allocation, stale legacy
payloads, zero/new residuals, physical versus nonphysical activity, exact recorded
stops, input immutability and idempotence. Two new fixed-seed properties exercise
150 cases in addition to the existing 264 retirement/ownership/repair/timing
cases. Behavioral failures before implementation are retained in
`server/test-artifacts/recorded-po-load/red-behavior.log` and `alias-db-red.log`.

Post-deployment artifacts are in
`server/test-artifacts/retired-confirm/recorded-po-postdeploy/`.

| Check | Result |
| --- | --- |
| Focused regressions | 41/41 pass, including 11 new PO tests |
| Fixed-seed property cases | 414 pass: 264 existing plus 150 new; seed 20260914 |
| Existing affected tests | 87 pass; the same 6 failures as the original deployed-source baseline |
| Projection/concurrency suite | 6/6 pass |
| PO residual unit/UI/property/adversarial suite | 24/24 pass |
| Mutation checks | 19/19 killed; all 15 applicable mutants also killed by property tests alone |
| Chromium browser tests | 6/6 pass, including both originally reported unpacked orders |
| Changed executable lines | 149/149 covered |
| Reordered focused tests | 41/41 pass in separate processes with reversed file order |
| TypeScript | 233 existing diagnostics; zero added |
| Lint | 2 existing diagnostics; zero added |
| Syntax, secret scan and whitespace | Pass |
| Full MBT | 462 files; 2,297 pass, 2 pre-existing failures and 1 existing skip; zero new failures |
| Legacy compatibility | 134/134 harnesses pass |

Coverage comprises server 20, plan repository 17, recorded PO helper 31,
authoritative projection 6, dependency reconciliation 6, browser 14 and repair
tool 55 executable lines. This is line coverage, not a complete branch-coverage
claim. Mutation checks cover residual rewriting, legacy aliases, incorrect PO
classification and acceptance of an edited active drop, alongside all prior
retirement/ownership/repair/timing mutations. They run in disposable copied
containers and assert byte-for-byte source restoration.

The six affected-suite failures and two existing lint findings are enumerated in
`dispatch-retired-confirm-evidence.md`; the automated baseline comparisons find
no new failures or diagnostics. Tool versions: Node 20.20.2, pg 8.21.0,
fast-check 4.9.0, ESLint 10.8.0 and TypeScript 7.0.2. No dependencies were added.

The two full-suite failures remain the browser worker pool-lifecycle contract
and the production-runtime gauntlet contract. Both failed on the original
deployed-source baseline as well. The one skipped case is the unrelated
migration-175 billing upgrade scenario. The suite ran through all 462 files.

The complete post-deployment gauntlet exited 0 after checking the documented
baseline differences. All nine runtime/source hashes are unchanged from the
tested input. `summary.json`, `source-check.log` and
`server/test-artifacts/recorded-po-load/postdeploy-driver.log` record completion.

Reproduce with
`bash server/tools/dispatch-retired-confirm-gauntlet.sh <artifact-name>` using
the retained task images and isolated test databases. The script resets only
the dedicated `mbbs-retired-confirm-db-1/mbt_test` database. Live read-only checks
use `bash server/tools/dispatch-retired-confirm-postcheck.sh recorded`.
