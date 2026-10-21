"""Write the evidence report from final logs, never from estimated results."""
import difflib
import hashlib
import json
from pathlib import Path

TASK = Path(__file__).resolve().parent
SERVER = TASK.parents[1]
OUT = SERVER / 'test-artifacts/split-quantity-20261020'
FILES = json.loads((TASK / 'files.json').read_text())
read = lambda name: json.loads((OUT / name).read_text())
final, baseline = read('final.json'), read('baseline.json')
static, browser, mutants, health = read('static.json'), read('browser/result.json'), read('mutations.json'), read('health.json')
coverage = read('changed-coverage.json')
source = read('verified-source.json')
assert final['tests'] and sorted(final['failures']) == sorted(baseline['failures'])
assert not static['newTypes'] and not static['newLint'] and not static['testLint']
assert not coverage['missing'] and not browser['pageErrors']
assert len(mutants) == 9 and all(row['killed'] for row in mutants)
assert all(row.get('propertyOnly', {'killed': True})['killed'] for row in mutants)
assert all(health[key] == final[key] for key in ['tests', 'pass', 'fail', 'skipped'])
for name, expected in source.items():
    assert hashlib.sha256((TASK / 'candidate' / name).read_bytes()).hexdigest() == expected
cleanup = {}
for mode in ['baseline', 'static', 'final', 'browser', 'mutations', 'health']:
    item = read('cleanup-' + mode + '.json')
    assert item['teardownExit'] == 0 and item['productionHealthy']
    assert not item['ownTestContainers'] and not item['networks'] and not item['volumes']
    cleanup[mode] = 'removed containers, disposable storage and networks; production healthy'
patch = ''
for name in FILES:
    before = (TASK / 'baseline' / name).read_text() if (TASK / 'baseline' / name).exists() else ''
    after = (TASK / 'candidate' / name).read_text()
    patch += ''.join(difflib.unified_diff(before.splitlines(True), after.splitlines(True),
                                        fromfile='a/' + name, tofile='b/' + name))
(OUT / 'release.patch').write_text(patch)
assert (TASK / 'baseline/package-lock.json').read_bytes() == (TASK / 'candidate/package-lock.json').read_bytes()
assert (TASK / 'baseline/package.json').read_bytes() == (TASK / 'candidate/package.json').read_bytes()
summary = {
    **final,
    'specApproval': 'not obtained (autonomous run)',
    'newFailures': [],
    'baselineFailures': baseline['failures'],
    'baselineTests': baseline['tests'],
    'hashes': {name: source[name] for name in FILES},
    'sourceTreeHash': hashlib.sha256(json.dumps(source, sort_keys=True).encode()).hexdigest(),
    'changedLineCoverage': {'covered': sum(row['covered'] for row in coverage['files'].values()),
                            'total': sum(row['total'] for row in coverage['files'].values()), 'missing': coverage['missing']},
    'mutations': {'killed': len(mutants), 'total': len(mutants),
                  'propertyOnlyKilled': sum(bool(row.get('propertyOnly', {}).get('killed')) for row in mutants),
                  'scope': 'Properties cover arithmetic and client conservation; API wiring, recovery and packing are covered by focused scenario mutants.'},
    'static': static,
    'browser': browser,
    'suiteHealth': {'seed': health['seed'], 'tests': health['tests'], 'pass': health['pass'], 'fail': health['fail']},
    'cleanup': cleanup,
    'specMapping': [
        {'acceptance': [1, 2, 5], 'tests': ['split-quantity-validation.test.js (frontend)', 'split-quantity-validation.browser.test.mjs']},
        {'acceptance': [3, 4, 9, 12], 'tests': ['split-quantity-validation.test.js (unit and integration)']},
        {'acceptance': [6, 7, 10, 11], 'tests': ['split-quantity-validation.test.js (integration)', 'split-quantity-validation-http.test.js']},
        {'acceptance': [8], 'tests': ['unfinished-sales-resplit tests', 'registered-split-planning tests', 'retained-history-save tests', 'driver-completion-split-isolation tests']}
    ],
    'capabilityReview': 'Existing database reads and transaction locks only. No new dependency, external network call, environment access, migration or credential.',
    'complexityReview': 'Pure per-line validation, source/family lookup, and UI feedback are separate functions; save paths each add one awaited guard.',
    'limitations': [
        'Spec review by a second human was not obtained; automated evidence does not prove the specification is complete.',
        'The relevant dispatch split, history and recovery suite was run. The entire MBT/business application suite was not run for this scoped fix.',
        'The pre-existing blank-address test fails on both captured baseline and candidate; no assertion was relaxed.',
        'Static checking retains pre-existing type diagnostics, with zero new diagnostics.',
        'Browser API responses use fixtures; separate authenticated HTTP tests exercise both real server routes with a disposable PostgreSQL database.',
        'Global coverage is not a release threshold; the report measures changed executable lines and preserves full branch reports.'
    ],
    'resolvedFailures': [
        'Original implementation accepted short and excessive splits; RED run recorded the failures.',
        'Browser fixture initially omitted operatorStatus; corrected fixture then reproduced enabled confirmation with missing quantities.',
        'Local-only transfer line IDs initially failed; added stable row identity support after a failing test.',
        'HTTP initially archived rejected quantities as recovery drafts (202); explicit exclusion now returns 409 with no history/audit writes.',
        'New code type diagnostics were resolved; baseline type environment now includes the same shared contracts and tool declarations.'
    ],
    'reproduce': 'python3 server/tools/split-quantity-20261020/verify.py'
}
(OUT / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps({key: summary[key] for key in ['tests', 'pass', 'fail', 'newFailures', 'changedLineCoverage', 'mutations', 'sourceTreeHash']}))
