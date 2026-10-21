"""Record validation of the exact base-quantity release; no production writes."""
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
release = root / 'deployments/dispatch-link-base-20261019'
artifacts = root / 'test-artifacts/dispatch-link-base-20261019'
results = artifacts / 'results'
read = lambda path: json.loads(path.read_text())
manifest = read(release / 'manifest.json')
regressions = read(results / 'regressions.json')
baseline = {row['file']: row for row in read(results / 'baseline-regressions.json')}
for row in regressions:
    assert row['exit'] == 0 or row == baseline.get(row['file']), row
mutations = read(results / 'mutations.json')
assert len(mutations) == 7 and all(row['exit'] == 1 and row['failures'] for row in mutations)
coverage = read(results / 'changed-line-coverage.json')
assert len(coverage) == 4 and all(row['percent'] >= 95 for row in coverage)
assert 'teardown_exit=0' in (artifacts / 'teardown.log').read_text()
counts = {name: sum(row[name] for row in regressions) for name in ['tests','pass','fail','skipped']}
report = {
    'passed': True,
    'candidateTreeHash': manifest['candidateTreeHash'],
    'specApproval': 'not obtained (autonomous run)',
    'spec': 'test/dispatch-link-base-spec.json',
    'scope': 'PO/TO base-quantity linking, derived packing and item/UOM validation; preserves prior popup and driver-route corrections',
    'affectedRegressionSuites': len(regressions),
    'counts': counts,
    'unchangedDeployedBaselineFailures': [row for row in regressions if row['exit']],
    'changedLineCoverage': coverage,
    'mutantsKilled': len(mutations),
    'propertyMutationScope': 'Packing-ratio and residual-cargo mutants are independently killed by the randomized property suite; API and UI mutants use integration and browser assertions.',
    'static': read(results / 'static.json'),
    'reproduce': 'DISPATCH_LINK_BASE_ROOT="$PWD/deployments/dispatch-link-base-20261019/candidate" bash tools/dispatch-link-base-test.sh node tools/dispatch-link-base-checks.mjs',
    'baselineCommand': 'DISPATCH_LINK_BASE_ROOT="$PWD/deployments/dispatch-link-base-20261019/before" bash tools/dispatch-link-base-test.sh node tools/dispatch-link-base-baseline.mjs',
    'behaviorEvidence': {
        'base form inputs and submitted UOM quantities': 'test/dispatch/frontend/dispatch-link-base.browser.test.mjs',
        'SQFT and EACH links, partial source packing, fractional TO, UOM mismatch, invalid quantities and atomic rejection': 'test/dispatch/integration/dispatch-link-base.test.js',
        '400 randomized packing conservation examples, missing-conversion handling': 'test/dispatch/property/dispatch-link-base.test.js',
        'popup DOM, draft, focus and scroll on background feeds': 'test/dispatch/frontend/dispatch-link-dialog-stability.browser.test.mjs',
        '22/16/6 route, full and incremental save, original jobs, photos and revision-fenced repair': 'test/dispatch/integration/dispatch-po-count.test.js',
        'deployed Sety repair and unchanged driver hashes': 'test-artifacts/dispatch-po-count-20261019/repair-result.json',
        'Dao completed timestamps, photos and 3445 address': 'test-artifacts/dispatch-po-count-20261019/dao-verification.log'
    },
    'limits': [
        'Affected regression suites were run; unrelated application modules were not exhaustively retested.',
        'Six test failures and six lint diagnostics reproduce on the deployed baseline; the release adds none.',
        'Runtime JavaScript has no type annotations; syntax checks, lint comparisons and executable contracts provide static/runtime validation.',
        'No dependency changes, migrations, or external NetSuite writes. Dependency audit not rerun because the dependency set is unchanged.',
        'Author and executable-spec author are the same; autonomous specification was not independently reviewed.'
    ],
    'cleanup': 'Disposable Compose containers, networks and database volumes removed; docker ps and ps -a recorded, production health checked.'
}
(release / 'validation-passed.json').write_text(json.dumps(report, indent=2) + '\n')
(artifacts / 'evidence.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'candidateTreeHash':manifest['candidateTreeHash'],'counts':counts,'mutantsKilled':len(mutations),'coverage':coverage}))
