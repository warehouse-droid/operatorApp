"""Summarize the final reproducible resplit verification without retaining test data."""
import hashlib
import json
from pathlib import Path

SERVER = Path(__file__).resolve().parents[2]
TASK = Path(__file__).resolve().parent
OUT = SERVER / 'test-artifacts/unfinished-split-20261012'
read = lambda name: json.loads((OUT / name).read_text())
summary, static, coverage = read('summary.json'), read('static.json'), read('changed-coverage.json')
mutants, baseline, cleanup = read('mutations.json'), read('regression-baseline.json'), read('cleanup-final.json')
primary = next(row for row in summary['results'] if row['label'] == 'final-primary')
assert primary['tests'] == primary['pass'] == 40 and not primary['fail']
assert not baseline['newFailures'] and not summary['newFailures']
assert not static['newTypes'] and not static['newLint'] and not static['testMessages']
assert not coverage['missing'] and len(mutants) == 6 and all(row['killed'] for row in mutants)
assert cleanup['teardownExit'] == 0 and cleanup['productionHealthy'] and not cleanup['testContainers'] and not cleanup['networks'] and not cleanup['volumes']
changed = sum(row['changedExecutable'] for row in coverage['files'])
covered = sum(row['covered'] for row in coverage['files'])
versions = {name: json.loads((SERVER / 'test-artifacts/operator-to-yard-flow-tooling/node_modules' / name / 'package.json').read_text())['version'] for name in ['typescript', 'eslint', 'c8', 'fast-check', '@playwright/test']}
manifest = {name: hashlib.sha256((TASK / name).read_bytes()).hexdigest() for name in ['run.py', 'check.mjs', 'mutations.mjs', 'coverage.py', 'deploy.py', 'live.mjs', 'capability.mjs', 'files.json', 'evidence.py']}
(OUT / 'tooling-manifest.json').write_text(json.dumps({'node': summary['node'], 'toolHashes': manifest,
    'baseImage': (OUT / 'live-base-image.txt').read_text().strip(), 'sourceHash': summary['sourceHash'],
    'toolVersions': versions, 'reusedDependencies': 'Pinned tooling from operator-to-yard-flow-tooling; no packages changed'}, indent=2) + '\n')
report = f'''# Unfinished Sales Order resplit evidence

The existing action on an unfinished SO split opens the existing Split editor. Replacing S2 creates the next root-family references and retires only S2. Completed S1 remains retained. No additional button, database migration or dependency was introduced.

Spec approval: not obtained (autonomous run). Spec: `test/unfinished-sales-resplit-spec.md`.

| Layer | Final result |
| --- | --- |
| Focused acceptance, adversarial, HTTP, browser and real PostgreSQL lock tests | {primary['pass']}/{primary['tests']} passed |
| Reordered focused files | 40/40 passed |
| Relevant regression comparison | {summary['tests'] - 80} checks; {summary['fail']} existing failures; zero new failures |
| Changed executable lines | {covered}/{changed} covered |
| Types | {static['baselineTypes']} baseline, {static['currentTypes']} current, zero new diagnostics |
| Runtime and new test lint | zero new diagnostics |
| Manual non-equivalent mutants | {len(mutants)}/{len(mutants)} killed |
| Properties alone | {sum(bool(row.get('property') and row['property']['killed']) for row in mutants)} relevant mutants killed |
| Disposable test cleanup | all test containers, databases, project networks and volumes removed; both Docker listings checked; live application healthy |

Acceptance mapping: root S3-S5 references, quantities, conversions and hostile allocations are covered by the unit examples and deterministic fast-check property; real replacement/history/link preservation, numbering, stale native/global quantities, exact retry, rollback and operator/Driver lock races are covered by `unfinished-sales-resplit.test.js`; private role/edit-lease requirements and expiry after lock waiting are covered by `unfinished-sales-resplit-http.test.js`; action count, actual quantity editor, saved completed route and failure retention are covered by the browser suite. Existing first-level splitting, packing splitting restrictions, completed-prefix handling, address isolation, cross-date conflicts, registered splits and Control reopen are included in the regression comparison.

Known baseline failures: five hover-unit-fixture tests fail identically on baseline and candidate because their VM fixture omits `findStop`; the real-browser hover/split regression passes. Separately, `unmaterialized splits can save, replace, clear, and pin the parent address` fails identically on captured live and candidate code with `DISPATCH_ADDRESS_REQUIRED` when its fixture attempts a blank address. No assertion was weakened or skipped.

Corrections during verification: the initial browser fixture wrongly omitted its completed S1 from the expected save and compared unnormalized route metadata; it now requires S1 and exact preservation of the normalized JSON wire payload. PostgreSQL returns exact numeric text `109`, so the rollback expectation uses that representation. A numbering mutant initially survived properties despite being killed by examples; the strengthened property requires exact next references and unchanged native S1 records. The lease-expiry race was observed failing before its server fix. Final checks were rerun after the last source and test edit.

Reproduce all verification: `sudo -n python3 tools/unfinished-split-20261012/run.py final`. Generate this report: `python3 tools/unfinished-split-20261012/evidence.py`. Source hash: `{summary['sourceHash']}`. Runtime/test/support hashes are in `summary.json`; tooling hashes and Node version are in `tooling-manifest.json`.

Limits: the full repository suite and unrelated external NetSuite integration suites were not run; the nine relevant regression files were compared to the captured live baseline. No external NetSuite write or actual customer order split was used for verification. Dependency audits were not rerun because dependencies did not change. Tests demonstrate the stated constraints, not an exhaustive proof. Production release uses only the verified overlays on the captured live image and retains rollback artifacts.
'''
(SERVER / 'test/unfinished-sales-resplit-evidence.md').write_text(report)
(OUT / 'evidence.md').write_text(report)
print(json.dumps({'primary': primary['pass'], 'totalChecks': summary['tests'], 'knownFailures': summary['fail'],
    'newFailures': 0, 'changedCovered': covered, 'changedExecutable': changed, 'mutantsKilled': len(mutants)}))
