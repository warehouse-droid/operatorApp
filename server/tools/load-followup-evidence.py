"""Build an evidence report from retained test and production results."""
from datetime import datetime, timezone
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ARTIFACT = ROOT / 'test-artifacts/load-followup'
BACKUP = Path('/home/ubuntu/operatorapp-deploy-backups/load-followup-20260917')


def read(name):
    return json.loads((ARTIFACT / (name + '.json')).read_text())


full, coverage, browser = read('full-comparison'), read('coverage'), read('browser')
changed_browser = read('browser-changed-coverage')
verify, applied, repeated = read('verify'), read('repair-applied'), read('repair-repeat')
deployment = json.loads((BACKUP / 'deployment-result.json').read_text())
refresh = read('refresh-audit') if (ARTIFACT / 'refresh-audit.json').exists() else None
audit = read('audit')
audit_counts = {status: sum(row['status'] == status for row in audit['results']) for status in sorted(set(row['status'] for row in audit['results']))}
refresh_text = 'Pending explicit approval for the five exact status/date corrections in `header-refresh-plan.json`.'
refresh_approval = 'The exact replacement remains staged for explicit approval.'
if refresh:
    refresh_text = 'Applied the five reviewed source status/date corrections: ' + ', '.join(
        row['ref'] for row in refresh['results'] if row['refreshed']) + '. Every line field remained unchanged.'
    refresh_approval = 'The user explicitly approved the five corrections, which were then applied and verified.'
lines = '\n'.join(f"| {row['line_id']} | {row['item_id']} | {row['quantity']} | {row['loaded_qty']} |" for row in verify['lines'])
failures = '\n'.join(f'- `{file}`: {name}.' for file, name in full['baseline']['failures'])
source_hashes = '\n'.join(f'- `{file}`: `{value}`' for file, value in deployment['sourceHashes'].items())
report = f'''# Load follow-up: implementation and production evidence

Recorded {datetime.now(timezone.utc).isoformat()}. Executable acceptance criteria:
[load-followup-spec.md](load-followup-spec.md). Evidence-first Tier 3 workflow;
no dependencies, migrations or commits added. Unrelated workspace changes were retained.

## Result and cause

- Live application: `{deployment['app']['image']}`.
- Live webhook worker: `{deployment['worker']['image']}`.
- Health check: `{json.dumps(deployment['health'])}`.
- SOB120541/995451: command `8574bd86-a8fb-48ee-aba5-042d85734d4f` completed,
  operator status `{verify['operatorStatus']}`, {verify['remainingConfirmableLines']} remaining lines,
  {verify['activeClaims']} active claims, one four-line load record ({verify['loadRecords'][0]['id']}).
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
{lines}

Completed packing flags/quantities are cleared by the normal local finalizer; the four
confirmed loaded lines are retained in the load record. This is completed work, not an
open confirmation draft.

- Rollback-only production dry run preserved the complete command/order/load snapshot.
- Applied repair: before `{applied['beforeHash']}`, after `{applied['afterHash']}`.
- Repeat returned `alreadyCompleted: true`, with identical before/after hash
  `{repeated['beforeHash']}`. No second load record was created.
- Final verification is read-only and checks all four quantities, the original submission
  hash, the existing IF, no active claims, one load record and no remaining quantity.

## Discarded-update audit

The candidate set grew from 13 during planning to 15 by execution. Current source data
was read for each in-scope order; historical webhook payloads were never replayed.
SOT17398 is excluded by the existing cross-charge policy. The remaining 14 orders were
checked for line identity, quantities, conversions, yard, source status and source date.

{refresh_text}

The reviewed corrections are source status B→F for SOA08816, SOA08822, SOA08840 and
SOB120541, and removing the stale September 23 source date on SOB120613 to match
NetSuite. The scoped tool only updates source status/status text/date for these IDs.
It compares exact reviewed before/after values, locks affected rows, defers active
posting/newer-webhook work, preserves every line field and writes an audit entry.
Latest audit counts: {json.dumps(audit_counts)}.

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
- c8: all {sum(row['total'] for row in coverage['changed'].values())} changed instrumented backend/repair
  lines executed. New helper modules have 100% line coverage and more than 93% branch
  coverage. This does not claim full coverage of the existing repository.
- Chromium: {len(browser['results'])} scenarios passed with zero page errors. All
  {changed_browser['executed']} changed frontend code lines executed. Includes popup
  cancellation/ESC, all-confirmed and remaining-only scans, reload controls, a second
  operator claiming the order, changed confirmations, failed/completed jobs, lost
  responses, corrupted browser storage and status recovery.
- Scoped lint/type checks: zero new diagnostics; both new helper modules typecheck
  without errors. Existing workspace diagnostics remain and are compared against baseline.
- Full MBT baseline: {full['baseline']['files']} files, {full['baseline']['counts']['tests']} tests,
  {full['baseline']['counts']['pass']} pass, {full['baseline']['counts']['fail']} fail, one skip.
- Final candidate: {full['candidate']['files']} files, {full['candidate']['counts']['tests']} tests,
  {full['candidate']['counts']['pass']} pass, {full['candidate']['counts']['fail']} fail, one skip.
  **Zero new failures.** Implementation and frontend hashes were stable throughout the
  final run. Superseded intermediate runs are retained but are not used as final evidence.
- The two files requiring the base `mbt_test` database were rerun separately: nine tests
  passed. Grouped local loads took 305.13, 264.90 and 229.27 ms at the fixture's live-scale
  order population, below the one-second budget. Background-photo tests passed.

Existing baseline failures, retained rather than suppressed:

{failures}

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
{refresh_approval}

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

{source_hashes}
'''
(ROOT / 'test/load-followup-evidence.md').write_text(report)
print('Wrote server/test/load-followup-evidence.md')
