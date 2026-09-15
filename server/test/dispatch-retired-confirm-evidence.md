# Retired Dispatch confirmation correction — 2026-09-14

The later LOINC-033146 live allocation conflict documented below was resolved
after the user confirmed that the recorded physical load is unchanged. The
follow-up is deployed and its live post-check passes; see
[recorded PO load evidence](dispatch-recorded-po-load-evidence.md). The replay
and deployment results in this document retain their original activity context.

Risk tier 3. Spec approval: not obtained (autonomous implementation under the
requested correction, regression, replay and post-check). No commits were made;
unrelated existing workspace changes were preserved.

## Corrected behavior

The canonical order feed now applies the same global lifecycle authority used
by the save validator. SOA08404-S2 remains retired and cannot be restored through
a stale draft. Active materialized definitions retain their ownership metadata
without overwriting current source packing status or cargo.

The actual browser payload no longer adopts incidental unassigned canonical
splits and direct COs. Assigned orders, new splits/groups, explicit ownership and
source transit edits remain serializable. Direct CO cargo references cannot hide
their source SO or replace its stops; genuine aggregate CO groups still work.

The guarded data correction removes only CO-GOA-7894-7895's obsolete retired
global-group metadata, after proving its later explicit recreation in audit
18037. The canonical CO and its cargo remain unchanged. The repair rehearses
with rollback by default; application requires the exact before-state fingerprint
and a private before-image backup. Audit and catalog updates are transactional.

Replay exposed an additional timing defect: authoritative projection refresh
cleared recorded timing from executed stops. The correction uses the existing
executed-schedule overlay to retain those timings while invalidating future route
estimates. Structural and cargo changes still reach the unchanged driver guard.

## Regression evidence

Artifacts are under `server/test-artifacts/retired-confirm/final-6/` unless stated
otherwise. The initial `red.log` records 6 failing behavioral regressions; the
timing regression separately failed 3/3 before its implementation. Additional
browser and assignment-shape failures were retained during development.

| Check | Result |
| --- | --- |
| New focused tests | 30/30 pass; frontend, real PostgreSQL lifecycle/repair, recorded timing |
| Property cases | 264 cases, fixed seed 20260914: 200 ownership, 20 lifecycle, 24 repair guards, 20 timing |
| Adversarial/concurrent repair | Active/genuine groups, cancellation, stale fingerprint, audit failure, rollback, idempotence and competing row lock covered |
| Existing affected tests | 87 pass; 6 failures identical to the original deployed-source baseline |
| Additional projection suite | 6/6 pass, including concurrent saves and executed-prefix rejection |
| Browser | 6/6 Chromium tests; real browser code with HTTP fixtures; structured Playwright report |
| Changed executable lines | 98/98 covered: server 20, plan repository 9, browser 14, repair 55 |
| Mutation checks | 11/11 killed; 9/9 applicable mutants also killed by property tests alone |
| Reordered tests | 30/30 pass in reversed file order with fresh Node processes |
| TypeScript | 233 existing diagnostics; zero added diagnostics |
| Lint | 2 existing diagnostics, verified against original source; zero added diagnostics |
| Syntax, secret scan, whitespace | Pass |
| Full MBT | 462 files; 2,297 passing tests, 2 pre-existing failures, 1 skipped; zero new failures |
| Legacy compatibility | 134/134 harnesses pass |

Mutation coverage includes lifecycle filtering, ownership metadata, incidental
adoption, assigned/local order retention, active-group repair, stale fingerprint,
strict retirement, explicit reactivation, unmaterialized definitions and executed
timing. Strict retirement/reactivation command intent is covered by direct DB
tests rather than by the eligibility property alone. Coverage is executable-line
V8 coverage, not a claim of complete branch coverage.

Existing affected failures are the SO/PO/TO/CO global-definition lifecycle test,
grouped-CO lifecycle test, DP-05 group/ungroup sequence, DP-05 split/unsplit,
completed-history search, and DP-11/DP-12 compact command retry. The original
SOA07894/SOA07895 13-stage event replay passes. Lint's existing findings are the
undefined `getSmartScmNetSuitePoReviewLoad` and a pre-existing `!=` comparison in
the plan repository. Baselines are retained beside the final artifacts.

The two full-suite failures are `P3.12: browser specs share one worker-owned
database-pool lifecycle` and `quality non-regression: the gauntlet builds and
validates the omit-dev runtime`. Both fail on the original deployed-source test
image as well. The full suite was run to completion despite those failures.
The one skipped test is the unrelated migration-175 billing upgrade scenario.

## Production-data replay

The production dump was restored to a separate isolated PostgreSQL database
with no outbound integrations. Replay invokes the actual browser payload,
lifecycle validator, schedule preparation, snapshot writer and confirmation
repository. Every write runs inside rollback transactions.

| Recovery | Outcome |
| --- | --- |
| 17282, September 13, plan 326 | Original two-reference retirement failure reproduced. Corrected payload clears retirement validation; existing T7 driver lock remains. Physical stops match, while protected order cargo fields differ. |
| 17288, September 14, plan 324 | Save and confirm pass inside rollback; new GOM-6255S1-6256S1 cargo preserved. |
| 17291, September 14, plan 324 | Latest captured draft saves and confirms inside rollback. |

The two successful replays reach revisions 20 (save) and 21 (confirm) without
committing either revision. Before/after hashes prove the two plans, their
snapshots, all 23 recovery-history records and 26 driver records for those plans,
the affected source SOs and the canonical CO are unchanged. No recovery draft is
promoted over the live plan.

## Live boundary at the initial deployment

Driver activity advanced after the dump: LOINC-033146's drop started at
13:57:15 UTC. The live protected T4 boundary now includes all six stops. The
correction preserves all six recorded timings. Separately, current dependency
projection changes that drop's `dropSalesQty` from 1500.29 to 225.89 and attaches
SOM06255-S2. The unchanged driver guard rejects that stop alteration. This is
reported separately; the original replay is not represented as proof that the
later live allocation conflict has disappeared. The user was asked which
allocation reflects the physical load. No driver cargo is changed implicitly.

## Deployment and post-check

Prepared image: `mbbs-operator-app:retired-confirm-20260914-v1`, derived directly
from the deployed `unpacked-split-20260914-v1` image. It replaces only server.js,
dispatch-plan-repository.js, dispatch.js, dispatch.html and adds the repair tool.
Original runtime hashes matched the deployed files before modification. The
worker retains `stale-address-20260911-v1`.

The app deployed successfully at 14:25:26 UTC and is healthy. Immutable image ID:
`sha256:1d743c75646eb23121ac1589aa5b674b6c9ae02aa48ba49141a969aebd963a7e`.
The worker's image and September 11 start time are unchanged. Live HTTP responses
for dispatch.js and dispatch.html match the tested files, including the new
browser cache version. All five deployed file hashes match the verified image.

Two live rollback rehearsals and the committed correction agree on fingerprint
`ba6a75bf8aff7b8cb310597211051cb72dddc68b90ba9df3416f5c0a03d8af8a`.
The private `co-goa-7894-7895-before.json` backup has mode 0600 and that exact
SHA-256. Repair audit 20756 records the archived metadata and recreation audit
18037. Rerunning the deployed tool reports `alreadyCorrect: true` with no writes.

Live read-only post-checks pass for exact/search feed visibility, feed-to-validator
agreement, CO catalog/pool visibility, strict rejection of a retired assigned
split, all six recorded timings, app health and served browser files. They also
explicitly report the separate live LOINC-033146 allocation conflict above.
At that deployment, confirmation with the later live allocation was not claimed
to pass. The recorded PO follow-up linked above subsequently resolves that
conflict while retaining the driver guard.

Before/after hashes are identical for plans 324/326, their active snapshots, all
23 recovery-history records, all 29 current driver records for those plans, the
affected source SOs and the canonical CO. Plan 324 remains confirmed at revision
19; plan 326 remains confirmed at revision 16. Recoveries 17282, 17288 and 17291
remain intact. Evidence: `production-postcheck.log`, `production-persistence-proof.json`,
`production-repair.log`, `production-idempotence.log` and `production-containers.txt`.

## Reproduce

Run `bash server/tools/dispatch-retired-confirm-gauntlet.sh <artifact-name>`
using the retained baseline/test images and the dedicated task databases. The
script resets only `mbbs-retired-confirm-db-1/mbt_test`; the replay database is
separate. It runs regression, replay, mutation, static, browser, coverage,
reordered, full MBT and legacy checks and rejects new baseline differences.

`tools/replay-dispatch-retired-confirm.mjs` additionally requires
`MBT_TEST_ISOLATED=1` and hostname `replay-db`. Production post-checks run through
`bash server/tools/dispatch-retired-confirm-postcheck.sh` in a read-only database
transaction. Pinned tool versions are recorded in `versions.json`; no dependency
was added. Private database/repair backups are outside the repository under
`/home/ubuntu/operatorapp-deploy-backups/retired-confirm-20260914/`.
