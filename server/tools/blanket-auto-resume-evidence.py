"""Build the evidence report and task-only patch from the final run artifacts."""
from pathlib import Path
import difflib
import hashlib
import json
import re

root = Path(__file__).resolve().parents[1]
artifact = root / 'test-artifacts/blanket-auto-resume'
static = json.loads((artifact / 'static.json').read_text())
coverage = json.loads((artifact / 'changed-coverage.json').read_text())
mutations = json.loads((artifact / 'mutations.json').read_text())
types = json.loads((artifact / 'types.json').read_text())
suite = [json.loads(line) for line in (artifact / 'suite.log').read_text().splitlines() if line.startswith('{')]
assert len(suite) == 3 and all(row['matched'] for row in suite)
assert all(row['killed'] for row in mutations)
assert all(not row['missing'] for row in coverage)
assert not types['added']
patch = []
for file, expected in static['hashes'].items():
    assert hashlib.sha256((root / file).read_bytes()).hexdigest() == expected
    patch.extend(difflib.unified_diff((artifact / 'baseline' / file).read_text().splitlines(True),
                                    (root / file).read_text().splitlines(True),
                                    fromfile='a/server/' + file, tofile='b/server/' + file))
(root / 'test/blanket-auto-resume.changes.patch').write_text(''.join(patch))

def counts(name):
    text = (artifact / name).read_text()
    return {key: sum(map(int, re.findall(r'^# ' + key + r' (\d+)$', text, re.M)))
            for key in ['tests', 'pass', 'fail', 'skipped']}

focused = counts('focused-final.log')
reversed_counts = counts('focused-reversed-final.log')
regression = counts('regression-final.log')
covered = sum(row['coveredLines'] for row in coverage)
property_kills = sum(row['propertyKilled'] for row in mutations)
source_hash = hashlib.sha256(json.dumps(static['hashes'], sort_keys=True).encode()).hexdigest()
live_file = artifact / 'live-applied.json'
live = json.loads(live_file.read_text()) if live_file.exists() else None
deployment = Path('/home/ubuntu/operatorapp-deploy-backups/blanket-auto-resume-20260915/deployment-result.json')
deployed = json.loads(deployment.read_text()) if deployment.exists() else None
status = 'Deployed and existing holds reconciled.' if live and deployed else 'Verified; deployment or live reconciliation pending.'
report = f'''# Blanket coverage automatically resumes item holds

## Result

{status}

Usable Blanket coverage now retires active item holds regardless of when they
were entered. Reconciliation runs when a PO is flagged, when PO lines synchronize,
before ordinary/Blanket calculation, and when a new manual hold is entered.
Original holds remain in history with the supporting PO references and a system
audit. The pause screen reports the returned resumed status.

Spec approval: not obtained (autonomous run). The user explicitly clarified that
Blanket coverage always overrides item holds. See
[the acceptance criteria](blanket-auto-resume-spec.md).

## Verification

| Check | Final evidence |
| --- | --- |
| Focused database/API/UI tests | {focused['pass']}/{focused['tests']} passed; {focused['fail']} failed |
| Explicitly reversed file execution | {reversed_counts['pass']}/{reversed_counts['tests']} passed |
| Related Smart SCM regression selection | {regression['pass']}/{regression['tests']} passed; {regression['fail']} pre-existing failures, 0 new failures |
| Generated balance/conversion/date cases | 40 reproducible cases, seed 3737 |
| Changed JavaScript line coverage | {covered}/{covered} covered; HTML cache revision is checked during deployment |
| Manual mutation testing | {len(mutations)}/{len(mutations)} deliberate faults caught |
| Property-only mutation run | {property_kills}/{len(mutations)} caught; DB workflow tests catch the remaining faults |
| Syntax/lint | 7 JS files parse; 0 new lint findings (5 baseline findings remain) |
| JavaScript type comparison | {types['baselineErrors']} baseline, {types['currentErrors']} final diagnostics; 0 new diagnostics |
| Complexity | New helper within 12 |
| Concurrency | Six simultaneous reconciliations, one retirement/audit; five concurrent flag requests also produce one retirement |
| Atomic failure | Audit failure and outer rollback restore the flag, hold and audit together |

The two baseline failures are an old cache-version assertion in
`smart-scm-blanket-ui-harness.js` and missing `item_master` fixture input in
`smart-scm-harness.js`. Neither was weakened or skipped. The full repository suite
was not rerun; this selection covers the affected Smart SCM/Blanket workflows.

The initial database regression run failed all nine new behavior cases; the
corrected UI fixture then showed two new behavior failures and one existing
behavior passing. The first UI fixture incorrectly retained the input handler
instead of the click handler; it was corrected before UI implementation.
The coverage command initially inherited unrelated global 95% thresholds; the
task gate instead enforces 100% of changed JavaScript lines. Type checking found
missing JS contracts, which were corrected without suppressing diagnostics.

## Acceptance mapping and limits

- Blanket flag/history/new holds: database and actual HTTP tests.
- Existing backlog and residual planning: real Blanket and ordinary planner tests.
- Newly usable PO lines: synchronization regression.
- Ordinary/closed/inactive/exhausted/fractional/incompatible supply and unrelated
  items: explicit eligibility matrix and generated quantities. Reservation and
  split deductions reuse the existing Blanket pool calculation, exercised by the
  unchanged Blanket workflow harness.
- Expired history: explicit test retains the existing record unchanged.
- Audit uniqueness/rollback: real concurrent connections and injected database
  audit failure, plus outer-transaction rollback.
- FIFO and residual quantities: existing unit/property/workflow regressions.
- Browser layout tests were unnecessary for the small notice/copy change; the
  real UI event handler and API contract were executed. No vendor messages,
  reservations or external orders are generated by resumption.
- A hold stays resumed after Blanket quantity is later exhausted; a new hold can
  remain active when no usable Blanket coverage exists.

## Reproduce

From the repository root: `bash server/tools/blanket-auto-resume-gauntlet.sh`.
Use cached Docker image `mbbs-retired-confirm-test:20260914` and PostgreSQL
`18-alpine`. Tests run on disposable internal Docker networks. Node
{static['node']}, TypeScript {types['typescript']}, c8 12.0.0, ESLint 10.8.0,
fast-check 4.9.0. No dependencies were added. No commits were created in the dirty
shared worktree. Mutants run in temporary copies; source hashes verify restoration.

Source manifest hash: `{source_hash}`.
Task-only diff: [blanket-auto-resume.changes.patch](blanket-auto-resume.changes.patch).
Detailed logs, coverage, diagnostics and hashes: `server/test-artifacts/blanket-auto-resume/`.
'''
if live and deployed:
    preview = live['preview']
    report += f'''
## Live result

Image `{deployed['image']}` installed for app and worker; health 200 and eight
runtime file hashes verified against the tested source. The previous runtime and
Compose configuration are saved under
`/home/ubuntu/operatorapp-deploy-backups/blanket-auto-resume-20260915/`.

POB03737 holds 33–37 are resumed. A rollback rehearsal preceded the committed
reconciliation. Current planner preview: **{preview['loadCount']} loads,
{preview['pallets']} pallets**, forecast run {preview['forecastRunId']}.
Audit IDs: {', '.join(str(row['id']) for row in live['audits'])}.
This previews demand without replacing existing saved proposal drafts; Calculate
releases refreshes the saved plan using current inventory and forecasts.
'''
(root / 'test/blanket-auto-resume-evidence.md').write_text(report)
print(json.dumps({'status': status, 'focused': focused, 'regression': regression,
                  'changedLines': covered, 'mutations': len(mutations), 'sourceHash': source_hash}))
