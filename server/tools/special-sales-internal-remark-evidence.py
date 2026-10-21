import hashlib
import json
from pathlib import Path
import re

root = Path(__file__).resolve().parents[1]
out = root / 'test-artifacts/special-workflow-review/sales-internal-remark-20261003'
checks = json.loads((out / 'checks.json').read_text())
coverage = json.loads((out / 'changed-lines.json').read_text())
mutations = json.loads((out / 'mutations/results.json').read_text())
for name, digest in checks['sourceHashes'].items():
    assert hashlib.sha256((root / name).read_bytes()).hexdigest() == digest, name + ' changed after verification'
assert coverage['total'] == coverage['covered']
assert all(row['killed'] for row in mutations)
counts = lambda text: {key: int(re.search(r'^# ' + key + r' (\d+)$', text, re.M)[1]) for key in ['tests', 'pass', 'fail', 'skipped']}
report = {
    'spec': json.loads((out / 'spec.json').read_text()),
    'entryPoint': 'bash tools/special-sales-internal-remark-check.sh',
    'sourceTreeSha256': hashlib.sha256(json.dumps(checks['sourceHashes'], sort_keys=True).encode()).hexdigest(),
    'baseline': counts((out / 'baseline-tests.log').read_text()),
    'red': counts((out / 'corrected-red-tests.log').read_text()),
    'checks': checks, 'changedLineCoverage': coverage, 'manualMutationResults': mutations,
    'specToTests': {
        'Optional persisted field, legacy default and validation': ['unit/special-sales-internal-remark.test.js', 'integration/special-sales-internal-remark-http.test.js'],
        'Sales-only role, yard, audit and projection privacy': ['unit/special-sales-internal-remark.test.js', 'integration/special-sales-internal-remark-http.test.js', 'integration/special-sales-internal-remark-browser.test.js'],
        'Quote and order-document privacy, no external calls': ['unit/special-sales-internal-remark.test.js', 'integration/special-sales-internal-remark-http.test.js'],
        'Independent post-order save, closed read-only, copy and layout': ['integration/special-sales-internal-remark-browser.test.js', 'integration/special-sales-internal-remark-http.test.js'],
        'No-op, stale and concurrent saves, preservation of Note/stage/lines': ['integration/special-sales-internal-remark-http.test.js', 'integration/special-sales-internal-remark-browser.test.js'],
        'Unicode and newline preservation': ['unit/special-sales-internal-remark.test.js (200 seeded property runs)'],
        'Migration idempotence and rollback': ['integration/special-sales-internal-remark-http.test.js'],
        'Existing request behavior': ['85 affected header, case-edit, domain, policy, document, stock-update and alert regressions']
    },
    'review': {
        'complexity': 'One optional case field, one small renderer/validator module, and a revision-checked Sales endpoint. Header and independent saves share one persistence helper.',
        'capabilityChange': 'One authenticated local API route and database field/audience value. No outbound integration, dependency, or background job added.',
        'secrets': 'Scoped source diff reviewed; no credentials added. Scripts use isolated test database credentials only.',
        'corrections': [
            'User clarified Sales-only visibility; specification amended and acceptance tests updated before implementing that rule.',
            'Initial test fixtures lacked yard scope, compared raw SCM/date values with Sales HTTP JSON, and omitted required order references. Corrected fixtures were rerun against before-source: feature tests failed behaviorally.',
            'Privacy assertions use a single-line sentinel so JSON newline escaping cannot make a leakage assertion vacuous; deliberate quote-leak mutation verifies the protection.',
            'Types found missing annotations and a misplaced annotation; corrected before final run. Existing diagnostic summaries normalize abbreviated property counts to compare the same pre-existing error.',
            'Existing browser regression found duplicate customer-Note CSS hooks. Private remark now has a separate display class; assertions were unchanged.'
        ]
    },
    'limits': [
        'Spec approval not obtained (autonomous run); user explicitly confirmed Sales-only visibility. Tests and code share an author.',
        'Affected request suite run; unrelated application suites not run.',
        'Existing type/lint diagnostics compared with captured source; no new findings allowed.',
        'Property tests cover text preservation. Property-only mutation results describe that layer, not all privacy/access checks.',
        'Migration missing-file RED is structural; API/rendering RED failures are behavioral.',
        'No new dependencies: supply-chain/license audit skipped. No standalone formatter configured; lint and diff review used.',
        'No performance benchmark: no latency budget or remote operation added.',
        'Deployment status is recorded separately in deployments/special-sales-internal-remark-20261003/result.json.'
    ]
}
(out / 'evidence.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'focused': checks['focused'], 'regression': checks['final'], 'coverage': [coverage['covered'], coverage['total']], 'mutantsKilled': sum(row['killed'] for row in mutations)}))
