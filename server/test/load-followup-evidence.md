# Load follow-up: implementation and production evidence

Recorded 2026-09-17T22:36:51.915572+00:00. Executable acceptance criteria:
[load-followup-spec.md](load-followup-spec.md). Evidence-first Tier 3 workflow;
no dependencies, migrations or commits added. Unrelated workspace changes were retained.

## Result and cause

- Live application: `mbbs-operator-app:load-followup-20260917`.
- Live webhook worker: `mbbs-operator-app:load-followup-20260917-webhook-worker`.
- Health check: `{"ok": true, "app": "MBBS Yard Server"}`.
- SOB120541/995451: command `8574bd86-a8fb-48ee-aba5-042d85734d4f` completed,
  operator status `loaded`, 0 remaining lines,
  0 active claims, one four-line load record (1174).
- Existing IF153890/996410 was verified and linked. The repair issued no NetSuite
  mutation or transform. Original submission hash, snapshot and payload were preserved;
  approved four-line variance is retained separately in the step result and audit history.

Webhook 6323 arrived at 11:37:11.830 UTC and webhook 6324 arrived at 11:37:43.439 UTC
on September 17. Both carried source modification time 11:37:00 UTC. The queue treated
payload-hash order as version order and discarded the later four-line edit. Local posting
therefore knew only lines 1, 2 and 3. NetSuite also fulfilled line 8 during the transform.
Strict verification detected the extra positive line and held local completion. The backend
claim already prevented a second posting, but the frontend made loading appear available.

The queue now uses serialized arrival order for equal timestamps, keeping exact-hash
idempotency and rejecting genuinely older versions. Minimal durable posting state disables
both load controls across refreshes/operators. Observed IF identity is retained separately
from verified completion, including when a subsequent recovery lookup times out.

Customer Pickup and Delivery Prep, including consolidation, warn about all eligible
unconfirmed lines before loading. Cancel/ESC preserves work. Only confirmed quantities
load; unfinished lines remain local and appear on a fresh scan, while completed lines
are hidden. A completed browser journal is cleared before a later partial-load command.
The existing receiving follow-up behavior and background photo flow were preserved.

Fresh posting still uses transform then verification, with no live source/history/duplicate
preflight. An edit that has not arrived locally may still cause strict verification to hold
a load for review; the UI now reports that state and retains the known IF reference.

## SOB120541 production reconciliation

The user explicitly confirmed all four lines were physically loaded.

| Stable line key | Item ID | Source quantity | Recorded loaded quantity |
| --- | --- | --- | --- |
| 4967884 | 1354 | 156.75 | 156.75 |
| 4967885 | 1501 | 24.6 | 24.6 |
| 4967886 | 1784 | 2 | 2 |
| 4967891 | 602 | 2 | 2 |

Completed packing flags/quantities are cleared by the normal local finalizer; the four
confirmed loaded lines are retained in the load record. This is completed work, not an
open confirmation draft.

- Rollback-only production dry run preserved the complete command/order/load snapshot.
- Applied repair: before `bd8155682fa448d5b8d2e1406612b9dd35dafef4df685e7ae81e655128231db1`, after `55d64c890fd4fe5830e7f445df629ffec72358dcbadece87bdb9b3e0cb82604e`.
- Repeat returned `alreadyCompleted: true`, with identical before/after hash
  `55d64c890fd4fe5830e7f445df629ffec72358dcbadece87bdb9b3e0cb82604e`. No second load record was created.
- Final verification is read-only and checks all four quantities, the original submission
  hash, the existing IF, no active claims, one load record and no remaining quantity.

## Discarded-update audit

The candidate set grew from 13 during planning to 15 by execution. Current source data
was read for each in-scope order; historical webhook payloads were never replayed.
SOT17398 is excluded by the existing cross-charge policy. The remaining 14 orders were
checked for line identity, quantities, conversions, yard, source status and source date.

Applied the five reviewed source status/date corrections: SOA08816, SOA08822, SOA08840, SOB120541, SOB120613. Every line field remained unchanged.

The reviewed corrections are source status B→F for SOA08816, SOA08822, SOA08840 and
SOB120541, and removing the stale September 23 source date on SOB120613 to match
NetSuite. The scoped tool only updates source status/status text/date for these IDs.
It compares exact reviewed before/after values, locks affected rows, defers active
posting/newer-webhook work, preserves every line field and writes an audit entry.
Latest audit counts: {"current": 14, "excluded_cross_charge": 1}.

## Verification

- RED: real database equal-time webhook cases failed before the ordering fix; the
  missing-line/count and observed-IF tests failed before implementation; browser popup
  assertions failed before the frontend change; repair positive cases failed before the
  repair implementation; the follow-up lookup timeout reproduced lost observed evidence.
- Focused regression suite: 107 passed, zero failed or skipped.
- Source-refresh tests: three passed, including exact scope, before/after drift rejection,
  preserving local progress, unchanged line rows and repeat execution.
- Real HTTP + database tests preserve fresh POST→GET posting, no extra transform after
  a lost response, bounded parallel consolidation and rollback on partial failure.
- Property checks: 100 confirmation partitions and 100 equal-time hash-order cases;
  actual concurrent queue enqueues retain the final serialized arrival. Existing
  posting claim-race and recovery tests also passed.
- Seven targeted faults were killed; independent property runs killed two of them again
  (nine successful mutation checks total).
- Reordered targeted suites: 22/22 passed in each of two orders.
- c8: all 201 changed instrumented backend/repair
  lines executed. New helper modules have 100% line coverage and more than 93% branch
  coverage. This does not claim full coverage of the existing repository.
- Chromium: 17 scenarios passed with zero page errors. All
  122 changed frontend code lines executed. Includes popup
  cancellation/ESC, all-confirmed and remaining-only scans, reload controls, a second
  operator claiming the order, changed confirmations, failed/completed jobs, lost
  responses, corrupted browser storage and status recovery.
- Scoped lint/type checks: zero new diagnostics; both new helper modules typecheck
  without errors. Existing workspace diagnostics remain and are compared against baseline.
- Full MBT baseline: 519 files, 2657 tests,
  2649 pass, 7 fail, one skip.
- Final candidate: 523 files, 2673 tests,
  2665 pass, 7 fail, one skip.
  **Zero new failures.** Implementation and frontend hashes were stable throughout the
  final run. Superseded intermediate runs are retained but are not used as final evidence.
- The two files requiring the base `mbt_test` database were rerun separately: nine tests
  passed. Grouped local loads took 305.13, 264.90 and 229.27 ms at the fixture's live-scale
  order population, below the one-second budget. Background-photo tests passed.

Existing baseline failures, retained rather than suppressed:

- `test/mbt/infrastructure/p3-gauntlet-artifacts.test.js`: P3 gauntlet artifacts: CI always uploads the bounded artifact directory with a pinned action.
- `test/mbt/infrastructure/p3-gauntlet-contract.test.js`: P3.11: the extended mutation manifest owns every dedicated runner and the P3 gauntlet executes it.
- `test/mbt/infrastructure/p3-gauntlet-contract.test.js`: P3.12: browser specs share one worker-owned database-pool lifecycle.
- `test/mbt/infrastructure/production-runtime-contract.test.js`: quality non-regression: the gauntlet builds and validates the omit-dev runtime.
- `test/mbt/integration/local-load-performance.test.js`: /app/test/mbt/integration/local-load-performance.test.js.
- `test/mbt/integration/operator-background-photos.test.js`: /app/test/mbt/integration/operator-background-photos.test.js.
- `test/mbt/unit/operations-navigation-enhancements.test.js`: operator cache assets advance with the cycle-count pagination release.

## Release and reproducibility

Release overlays the frozen live background-photo app and the worker's own previous
image. Only nine app backend files, three frontend assets and two worker queue files
were replaced. Unshipped Return RA frontend changes were excluded. Preserved-module
hashes cover receiving, stored order-line posting, photo outbox, styles and inventory
calculation behavior. Worker configuration was compared and remained identical apart
from its image. No migration was needed.

The first deployment request was stopped by automatic approval review; the user then
explicitly approved live deployment. The broader cache refresh was separately stopped,
and its replacement was prepared as the five exact header-only corrections above.
The user explicitly approved the five corrections, which were then applied and verified.

Backups, original hashes and compose rollback image definitions:
`/home/ubuntu/operatorapp-deploy-backups/load-followup-20260917/`.
An image rollback does not undo the explicitly approved SOB120541 business reconciliation.

Retained artifacts: `server/test-artifacts/load-followup/`. Repair snapshots are mode
0600. Test runner uses a disposable internal Docker network and PostgreSQL database;
real NetSuite boundaries are mocked in tests. Production mutation tools are separate.

Reproduction commands (run from repository root with Docker access):

```sh
bash server/tools/load-followup-test.sh node tools/load-followup-gauntlet.mjs
bash server/tools/load-followup-test.sh node --test test/workload/integration/load-followup-audit.test.js
bash server/tools/load-followup-test.sh node tools/load-followup-full.mjs
python3 server/tools/load-followup-full-compare.py
LOAD_FOLLOWUP_TEST_IMAGE=mbbs-scm-search-vendor-test:20260910 LOAD_FOLLOWUP_PUBLIC_SOURCE=/home/ubuntu/apps/operatorApp/server/test-artifacts/load-followup/release/public bash server/tools/load-followup-test.sh node tools/load-followup-browser.mjs
python3 server/tools/load-followup-live.py verify
```

`test/support/load-followup-baseline.patch` preserves this task's reversible change
against its captured workspace baseline. Baseline runs use the captured originals via
`LOAD_FOLLOWUP_BASELINE=1`. The build applies only this patch's frontend changes onto
the frozen live assets, with zero patch fuzz.

Deployed file hashes:

- `src/netsuite-order-webhook-queue-policy.js`: `c850b0fe60424cd81b53877721717669570b9326cb664e24c5535781e998213f`
- `src/netsuite-order-webhook-queue-repository.js`: `65a89272db12e438ba874f04eec8dd62294bd5468b0a7087d5318e316c1b5d65`
- `src/delivery-repository.js`: `e0059128e0835fe331fd66dfb8fcfbf13ba46c5c16c0b186ce5d2347f9eb98d2`
- `src/consolidation-load-repository.js`: `d300d1eb46fb9967bcfddee5a2251f1c89bb10b8cd75a2cd761ca02539e58e2e`
- `src/operator-netsuite-posting-service.js`: `16cc57faf1183735b0aa1e62a2c3fc23ad6ecb9f7055a0aac01fa218e834d9c1`
- `src/operator-netsuite-posting-repository.js`: `64ef931c77d40c2b1c36481d1da4de28e8fead61e4842993cef8549bdc1e023b`
- `src/operator-netsuite-posting-controller.js`: `07b9b19453cf47c09b3c6527d0d6a2e72cce7e81c4485d54c616ff9eb06f7c53`
- `public/operator.js`: `0758ab1f28436de7742555929556cd1b5fc76c2d40b1dcdc77f187276a759f88`
- `public/operator.html`: `1ac46329669cc03e716c8277dad2bb63b66b38979a8ad1d61c8fedd214bf926f`
- `public/service-worker.js`: `c3e1df517d91c3c8580affc2c79bdd07f30ed7848a60d5b38e7860283272d582`
- `src/operator-load-state.js`: `f2f452aeafae6a2bbdf3d55ceb6b167e905737cdfb0babdba7200ad7feefd3dd`
- `src/operator-load-state-repository.js`: `f95c7176c3c39f8da558d774e0bd2adba64489118b5d684bd60d55ea4ea9da0b`
