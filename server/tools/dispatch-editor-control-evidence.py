"""Create the reproducible evidence report from final candidate results."""
from pathlib import Path
import difflib
import hashlib
import json
import re

SERVER = Path(__file__).resolve().parents[1]
OUT = SERVER / 'test-artifacts/dispatch-editor-control-20261015'
run = OUT / 'candidate'
validation = json.loads((OUT / 'validation.candidate.json').read_text())
assert validation['passed'] and validation['cleanupVerified']
prepared = json.loads((OUT / 'prepared.json').read_text())
coverage = json.loads((run / 'coverage/coverage-summary.json').read_text())
details = json.loads((run / 'coverage/coverage-final.json').read_text())
mutations = json.loads((run / 'mutations.json').read_text())
static = json.loads((run / 'static.json').read_text())
cleanup = json.loads((run / 'cleanup.json').read_text())
assert all(row['killed'] for row in mutations)
assert all(not row['added'] for row in static['lint']) and not static['types']['added'] and not static['secrets']
assert not any(cleanup[key] for key in ['containers', 'networks', 'volumes'])
suite = (run / 'suites.log').read_text()
counts = re.search(r'run passed: (\d+) file\(s\), (\d+) test\(s\)', suite)
assert counts
changed_coverage = {}
for name in ['src/dispatch-plan-lease-repository.js', 'public/dispatch-edit-activity.js']:
    before_path = OUT / 'before-local' / name
    before = before_path.read_text().splitlines() if before_path.exists() else []
    current = (OUT / 'candidate-source' / name) if (OUT / 'candidate-source').exists() else (SERVER / name)
    after = current.read_text().splitlines()
    changed = set()
    for operation, _i1, _i2, j1, j2 in difflib.SequenceMatcher(a=before, b=after).get_opcodes():
        if operation in ['replace', 'insert']:
            changed.update(range(j1 + 1, j2 + 1))
    measured = details['/app/' + name]
    line_counts = {}
    for key, location in measured['statementMap'].items():
        for line in range(location['start']['line'], location['end']['line'] + 1):
            line_counts[line] = max(line_counts.get(line, 0), measured['s'][key])
    executable = changed.intersection(line_counts)
    changed_coverage[name] = {'executableChangedLines': len(executable),
        'coveredChangedLines': sum(line_counts[line] > 0 for line in executable)}
source_hashes = prepared['sourceHashes']
tree_hash = hashlib.sha256(json.dumps(source_hashes, sort_keys=True).encode()).hexdigest()
tool_names = [
    'test/dispatch-editor-control-spec.md', 'test/dispatch/frontend/dispatch-editor-idle.test.js',
    'test/dispatch/frontend/dispatch-editor-actions.test.js', 'test/dispatch/integration/dispatch-editor-control.test.js',
    'test/dispatch/integration/dispatch-editor-confirmation.browser.test.js', 'tools/dispatch-editor-control-check.py',
    'tools/dispatch-editor-control-suite.mjs', 'tools/dispatch-editor-control-static.mjs',
    'tools/dispatch-editor-control-mutations.mjs', 'tools/dispatch-editor-control-release.py',
    'tools/dispatch-editor-control-evidence.py']
evidence = {'specApproval': 'not obtained (autonomous run)', 'tier': 3,
    'testFiles': int(counts[1]), 'tests': int(counts[2]), 'mutationKills': sum(row['killed'] for row in mutations),
    'mutationTotal': len(mutations), 'coverage': coverage['total'], 'changedCoverage': changed_coverage,
    'types': static['types'], 'versions': static['versions'], 'sourceHashes': source_hashes, 'runtimeTreeHash': tree_hash,
    'testAndToolHashes': {name: hashlib.sha256((SERVER / name).read_bytes()).hexdigest() for name in tool_names},
    'cleanupVerified': True, 'deployment': json.loads((OUT / 'deployment.json').read_text()),
    'liveVerification': json.loads((OUT / 'live-verification.json').read_text())}
(OUT / 'evidence.json').write_text(json.dumps(evidence, indent=2) + '\n')
lines = coverage['total']['lines']; branches = coverage['total']['branches']
report = f'''# Dispatch editor controls — evidence

Dispatch was removed from the 15-Oct-2026 date plan at the user's immediate request. Admin now lists active date-plan editors; Admin and Dispatch can kick the selected editor after a confirmation popup. Idle editing expires after ten minutes; background heartbeats cannot extend it.

Spec approval: not obtained (autonomous run). Tier 3, authorization and concurrency. Confidence is bounded by the scenarios in `dispatch-editor-control-spec.md`; there was no independent human review of that specification.

## Final candidate validation

- `{counts[2]}` tests passed in `{counts[1]}` files, including both real browser confirmation flows. Cancel preserved the editor; Confirm revoked the old credentials. Existing save/recovery regressions passed. The three feature suites also passed in reversed order (19 tests before any additional scenarios).
- `{sum(row['killed'] for row in mutations)}/{len(mutations)}` deliberate mutants were rejected: idle boundary, synthetic activity, programmatic scroll, confirmation bypass, legacy heartbeat renewal and stale session selection.
- Measured core lease repository and activity tracker: `{lines['covered']}/{lines['total']}` executable lines, `{branches['covered']}/{branches['total']}` branches. Changed executable line counts are in `test-artifacts/dispatch-editor-control-20261015/evidence.json`. Browser adapters, the Admin DOM module and monolithic route wiring were executed in browser/HTTP tests but are outside the numeric coverage measurement.
- Seven runtime JavaScript files passed syntax checks. Lint and scoped TypeScript comparison reported zero new diagnostics; `{static['types']['baseline']}` existing type diagnostics remain. Scoped secret scanning found zero findings. Tool versions are recorded in evidence.json.
- Every disposable container, database volume and test network was removed; both docker ps and docker ps -a were captured, and production health passed after teardown. The host memory-budget verifier passed six checks.
- The deployed source hashes match the validated overlay. Application configuration, database and worker image identities were checked by the release helper. A rollback image and Compose override are retained. No schema migration was needed.

## Scenario mapping

| Scenario | Executed evidence |
| --- | --- |
| Admin authorization, active listing, no secret exposure | ADMIN-01 |
| Token revocation, audit actor/target, plan/date isolation, next acquisition | ADMIN-02; DISPATCH-01 |
| Replacement session and repeated kick | ADMIN-03; IDLE-DB-02 |
| Hostile/missing selection and malformed activity age | ADMIN-04; IDLE-DB-01 |
| Delayed save after kick | ADMIN-05, real PostgreSQL fleet-lock barrier |
| Audit failure cannot partially kick | ADMIN-06, failing audit trigger and transaction rollback |
| Actual activity and exact inactivity boundary | IDLE-01 through IDLE-05; 150 seeded property examples |
| Late responses, preserved draft and immediate snapshot exit | ACTION-01 through ACTION-05 |
| Both confirmation popups, Cancel and Confirm | CONFIRM-01, real Chromium plus real isolated HTTP/database |
| Reload/tab fences and save compatibility | Existing save-reliability suites and edit-lease-session properties |

## Reproduce

From the repository root, run `python3 server/tools/dispatch-editor-control-check.py all` for workspace validation and `python3 server/tools/dispatch-editor-control-check.py candidate` for the saved release source. Both commands register teardown before startup and remove disposable resources in finally. `python3 server/tools/dispatch-editor-control-evidence.py` recreates this report from final candidate and deployment artifacts. Production capture/build/release/verify commands are in `tools/dispatch-editor-control-release.py`; release requires successful candidate validation.

Runtime source-tree hash: `{tree_hash}`. Individual deployed source hashes, test/tool hashes, image identity and exact tool versions are recorded in evidence.json. No Git commit was created in the shared dirty workspace.

## Limits and corrected failures

The repository-wide suite and whole-application type checks were not run: this validation covers editor controls and the existing Dispatch save/recovery suites. Numeric branch coverage is partial. The tests use clocks and persisted timestamps rather than a ten-minute wall-clock wait. Dedicated negative-role assertions cover the Admin endpoints; Dispatch reuses the existing dispatcher/admin middleware. Randomized suite order, sustained production contention and a live rollback rehearsal were not run; reversed ordering, deterministic input properties, database barriers and a retained rollback image cover those risks partially. Dependency audit/license checks were skipped because dependencies did not change. No latency budget was supplied.

The initial tests reproduced missing controls and idle heartbeat renewal. Test setup fixes corrected Compose number parsing and its working directory; the browser fixture was corrected to use Dispatch Planning. Type-comparison paths were normalized. A confirmation mutant first exposed an incomplete fetch boundary stub; it was completed without changing the cancellation assertion. A further regression reproduced and fixed stale snapshot ownership after revocation. Release capture was made readable after docker cp preserved restrictive ownership. A collision between candidate source and evidence directories was corrected before final validation. A concurrent PO-line deployment was detected before release; the approved feature delta was frozen, rebased onto that newer live image and validated again. Concurrent workspace edits to unrelated order actions were excluded from the overlay. Prior failed-run logs are retained; no disposable databases were retained.
'''
(SERVER / 'test/dispatch-editor-control-evidence.md').write_text(report)
print(json.dumps({'tests': evidence['tests'], 'mutants': evidence['mutationKills'], 'runtimeTreeHash': tree_hash}))
