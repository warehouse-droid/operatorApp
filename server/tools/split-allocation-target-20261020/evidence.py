"""Build release evidence from the final checks and captured source."""
import difflib
import hashlib
import json
from pathlib import Path

TASK = Path(__file__).resolve().parent
SERVER = TASK.parents[1]
OUT = SERVER / 'test-artifacts/split-allocation-target-20261020'
FILES = json.loads((TASK / 'files.json').read_text())
read = lambda name: json.loads((OUT / name).read_text())
final, baseline, static = read('final.json'), read('baseline.json'), read('static.json')
coverage, mutants, health, source = read('changed-coverage.json'), read('mutations.json'), read('health.json'), read('verified-source.json')
assert final['tests'] and sorted(final['failures']) == sorted(baseline['failures'])
assert not static['newTypes'] and not static['newLint'] and not static['testLint']
assert not coverage['missing']
assert len(mutants) == 3 and all(row['killed'] and row['propertyOnly']['killed'] for row in mutants)
assert all(health[key] == final[key] for key in ['tests', 'pass', 'fail', 'skipped'])
for name, expected in source.items():
    assert hashlib.sha256((TASK / 'candidate' / name).read_bytes()).hexdigest() == expected
cleanup = {}
for mode in ['baseline', 'static', 'final', 'mutations', 'health']:
    item = read('cleanup-' + mode + '.json')
    assert item['teardownExit'] == 0 and item['productionHealthy']
    assert not item['ownTestContainers'] and not item['networks'] and not item['volumes']
    cleanup[mode] = 'containers, storage and networks removed; production healthy'
patch = ''
for name in FILES:
    patch += ''.join(difflib.unified_diff((TASK / 'baseline' / name).read_text().splitlines(True),
        (TASK / 'candidate' / name).read_text().splitlines(True), fromfile='a/' + name, tofile='b/' + name))
(OUT / 'release.patch').write_text(patch)
summary = {
    **final, 'newFailures': [], 'baselineFailures': baseline['failures'], 'baselineTests': baseline['tests'],
    'hashes': {name: source[name] for name in FILES},
    'sourceTreeHash': hashlib.sha256(json.dumps(source, sort_keys=True).encode()).hexdigest(),
    'specApproval': 'not obtained (autonomous run)',
    'changedLineCoverage': {'covered': sum(row['covered'] for row in coverage['files'].values()),
        'total': sum(row['total'] for row in coverage['files'].values())},
    'static': static, 'mutations': mutants,
    'suiteHealth': {key: health[key] for key in ['seed', 'tests', 'pass', 'fail', 'skipped']},
    'cleanup': cleanup,
    'specMapping': {
        '1': 'completed sibling group PO allocation regression and seeded property',
        '2': 'selected child allocation remains blocked; existing PO/TO and execution/packing regressions',
        '3': 'new group-allocation tests, numbering regression, off-by-one mutation',
        '4': 'authenticated HTTP group-allocation resplit and retry regression',
        '5': 'selected-allocation rejection and existing unfinished-sales-resplit atomic rollback/retry tests',
        '6': 'live read-only allocation/quantity verification in deployment-result.json'
    },
    'capabilities': 'One existing helper call receives the selected split reference. No dependencies, migration, new capability, external call or production data change.',
    'complexity': 'One argument changed; the existing numbering helper already resolves the family root separately from the allocation check.',
    'limitations': [
        'Autonomous specification was not reviewed by a second human.',
        'The full relevant split, allocation, history, recovery and quantity regression set ran; unrelated MBT/application suites were not rerun.',
        'Existing baseline failures remain explicitly listed and unchanged.',
        'No browser code changed; existing browser regressions ran, and the new behavior was exercised through the real authenticated HTTP endpoint.',
        'Production checks are read-only; the user has not supplied quantities for an actual S4 split.'
    ],
    'reproduce': 'python3 server/tools/split-allocation-target-20261020/verify.py'
}
(OUT / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps({key: summary[key] for key in ['tests', 'pass', 'fail', 'newFailures', 'changedLineCoverage', 'sourceTreeHash']}))
