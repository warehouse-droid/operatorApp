"""Produce the final report from saved test, release and repair results."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ART = ROOT / 'test-artifacts/rejected-edit-lifecycle'
RELEASE = Path('/home/ubuntu/operatorapp-deploy-backups/rejected-edit-lifecycle-20260923-v1')
gate = json.loads((ART / 'verification.json').read_text())
deployment = json.loads((RELEASE / 'deployment-result.json').read_text())
repair = json.loads((ART / 'repair-applied.json').read_text())
repeat = json.loads((ART / 'repair-idempotence.json').read_text())
assert gate['passed'] and deployment['deployed'] and repair['applied'] and repeat['alreadyCorrect']
versions = json.loads((ART / 'tool-versions.json').read_text())
files = ['public/dispatch.js', 'public/dispatch.html',
         'test/dispatch/frontend/dispatch-rejected-edit-lifecycle.test.js',
         'test/support/rejected-edit-lifecycle-checks.mjs', 'tools/repair-sob120921-group.mjs']
hashes = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in files}
(ART / 'source-hashes.json').write_text(json.dumps(hashes, indent=2) + '\n')
b, a = gate['baseline'], gate['current']
report = f'''# SOB120921 split/group fix: evidence

Deployed {deployment['at']}. Group `GOB-120921-121097` contains
`SOB120921-S1` (21 pallets) and `SOB121097` (2 pallets), total **23 pallets**.
S2 retains **5 pallets and Pick-Up**. Plan 336 revision {repair['oldRevision']} →
{repair['newRevision']}; audit {repair['auditId']}. A repeat repair is a verified
no-op. Source quantities, packing state, truck CE94487, load, stops, other orders,
address, date and delivery window are preserved. No NetSuite writes were made.

Tier 3; **spec approval: not obtained (autonomous run)**. User explicitly requested
the fix. The [specification](dispatch-rejected-edit-lifecycle-spec.md) was stated
before implementation; the user did not independently review its criteria.
Confidence is bounded by that limitation and the checks below.

## Cause and scope

Rejected edits restored an older undo snapshot through the same function as
deliberate undo/redo. Structures fetched since that snapshot were mistakenly
queued for global retirement. The live audit ties split retirement to a truck
change save; the exact preceding browser rejection was not retained. Reproduction
proved this failure path for assignment, dependency and stop-time rejection.

The fix suppresses lifecycle reconciliation only for those three rollback calls.
Deliberate history changes retain the existing behavior. The release overlays the
five changed executable lines and HTML cache version onto the captured live image;
unrelated workspace changes are excluded. {deployment['verifiedFiles']} deployed
source files were verified against the expected inventory. Runtime configuration,
worker, database and other services were preserved. Rollback image retained.

## Specification mapping

| Criteria | Evidence |
| --- | --- |
| 1–2: rejected truck/dependency/stop edits preserve structures | Three REJECT paths in the new test; behavioral RED then GREEN |
| 3: existing queued intents survive | Three pending-intent regression tests |
| 4: undo/redo still retire/reactivate | HISTORY test and existing authoritative-retirement suite; deliberate-undo mutant killed |
| 5: arbitrary IDs/repetition and empty snapshots | 50 generated cases, seed 120921; EMPTY-HISTORY RED then GREEN |
| 6: exact 23-pallet repair, S2 Pick-Up, preserved source/route | Real database rollback rehearsal, committed verification, and idempotence check |
| 7: atomicity, concurrency guards, backup, audit, refusal | Shared advisory/row locks, inactive editor and execution checks, fresh fingerprint, stale-fingerprint refusal, before-image, archived snapshot, audit {repair['auditId']} |

## Verification results

| Layer | Actual result |
| --- | --- |
| Initial regression RED | Original 8 tests: 7 fail, 1 pre-existing history behavior passes; that behavior's mutant fails |
| Empty-history RED | 1 selected test fails on original code |
| Focused final tests | 61/61 pass in workspace and 61/61 on exact candidate |
| Full project suite | 577 files; baseline {b['pass']} pass / {b['fail']} fail / {b['skipped']} skipped; final {a['pass']} pass / {a['fail']} fail / {a['skipped']} skipped |
| Extra full-run failure | Stock-return metadata test reproduced on original code 5/5 and fixed code 5/5; no newly introduced failure identified |
| Types | 2,825 existing diagnostics before and after; zero new diagnostics |
| Lint / syntax | Zero diagnostics on changed browser/test/check/repair files under repository ESLint configuration; Python tools parse successfully |
| Changed-line coverage | 5/5 executable lines covered; all changed V8 branch counters hit |
| Manual mutation | 5/5 killed by full regression tests and independently 5/5 by property tests alone |
| Suite health | 61/61 pass when the three files run separately in seeded shuffled order |
| Real execution | Real transactional repair rehearsals, committed catalog/operator-group verification, live public and local health 200, deployed assets verified |
| Complexity | No new production functions; one explicit lifecycle guard, default preserves existing callers |
| Dependencies / secrets | No dependency change; no dependency audit needed. Two-file release patch reviewed; no credentials or new browser capabilities introduced |

The full suite is **not globally green**. Its baseline failures are preserved in
[verification.json](../test-artifacts/rejected-edit-lifecycle/verification.json)
and the complete logs. The stock-return difference depends on existing metadata
freshness behavior and does not load either changed browser asset. No assertion
was weakened and no unrelated implementation or test was changed.

## Limits and resolved verification issues

- Chromium execution was attempted, but the existing image lacks the Playwright
  browser executable. Browser checks are unavailable; production function bodies
  ran in VM tests, and real database/API projection and public HTTP checks passed.
- Production race injection was not performed. Shared locks, activity guards,
  stale-state refusal, transaction rollback and immediate revision verification
  protect this one-time repair; no general concurrency proof is claimed.
- The first operator projection assertion expected the delivery-fee line, which
  the operator API intentionally excludes. This clarification was appended to
  the spec. All seven source lines remain covered by before/after equality; the
  operator projection verifies all six loadable lines.
- The initial coverage invocation picked up the repository's unrelated global
  MBT threshold. The final check explicitly enforces changed-line/branch coverage.
  It found a sparse-snapshot edge case, added as a failing-before-fix regression.
- Initial test setup lacked schema; that incomplete run was discarded, the
  isolated database was migrated, and both full runs used the migrated baseline.
- A test runner mount and an interrupted script read were corrected before the
  final candidate and mutation runs. Final results above come from completed runs.

## Reproduction and retained records

From the server directory, `python3 tools/rejected-edit-lifecycle-gauntlet.py run`
reruns the isolated software matrix. It uses the existing test image and retained
candidate under `{RELEASE}`. `check` validates saved results. The baseline browser
source is reconstructed by reversing only this task's patch. The live-incident
guard evidence is retained separately because the repaired original state should
not be recreated in production. `python3 tools/sob120921-repair.py verify` checks
the completed incident without changing it. `apply` rechecks state and is a no-op
when already correct. Deployment verification is
`python3 tools/rejected-edit-lifecycle-deploy.py verify`.

Runtime/tool versions: `{json.dumps(versions, sort_keys=True)}`.
Source hashes: [source-hashes.json](../test-artifacts/rejected-edit-lifecycle/source-hashes.json).
No commit was created; the pre-existing dirty workspace was preserved.
Candidate image: `{deployment['imageId']}`.
Private before-image: `/home/ubuntu/operatorapp-investigations/sob120921-20260923/sob120921-before-*.json`
(mode 0600); source snapshot history and audit also retain the repair evidence.

Raw artifacts: `test-artifacts/rejected-edit-lifecycle/` (RED, GREEN, complete
before/after suites, repeat checks, coverage, mutation, lint, types, repair guards,
committed repair and idempotence). Release manifest, source inventories and HTTP
verification: `{RELEASE}`.
'''
(ROOT / 'test/dispatch-rejected-edit-lifecycle-evidence.md').write_text(report)
print('test/dispatch-rejected-edit-lifecycle-evidence.md')
