import hashlib
import json
from pathlib import Path
import re

root = Path(__file__).resolve().parents[1]
out = root / 'test-artifacts/special-workflow-review/stock-updates-20261002'
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
    'entryPoint': 'bash tools/special-stock-updates-check.sh',
    'environment': 'Existing isolated mbbs-special-review-runner; baseline fixture mbbs-special-review-db; disposable clone mbbs-special-updates-db-20261002. No production database or NetSuite writes.',
    'sourceTreeSha256': hashlib.sha256(json.dumps(checks['sourceHashes'], sort_keys=True).encode()).hexdigest(),
    'baseline': counts((out / 'baseline-tests.log').read_text()),
    'redUnitTests': counts((out / 'red-unit-tests.log').read_text()),
    'checks': checks,
    'changedLineCoverage': coverage,
    'manualMutationResults': mutations,
    'specToTests': {
        'Low inventory remains available and Sales can confirm': ['unit/special-stock-updates.test.js', 'integration/special-stock-updates.test.js', 'integration/special-stock-updates-browser.test.js'],
        'Pending Update question, reply, alert, locked stock actions and audit': ['integration/special-stock-updates.test.js', 'integration/special-stock-updates-http.test.js', 'integration/special-stock-updates-browser.test.js'],
        'Shared planning/fulfillment section, green/white containers, SCM PO reference': ['unit/special-stock-updates.test.js', 'integration/special-stock-updates-browser.test.js'],
        'Sales SO preview only and PO access remains restricted': ['unit/special-stock-updates.test.js', 'unit/special-workflow-documents.test.js'],
        'Optional customer in Sales and SCM cards/details, including resolved/pending transfer': ['unit/special-stock-updates.test.js', 'integration/stocking-customer-browser.test.js'],
        'Role, yard, hostile input, stale revision, concurrent update and transactional audit': ['integration/special-stock-updates-http.test.js', 'integration/special-stock-updates.test.js'],
        'Repeatable migration and rollback': ['integration/special-stock-updates.test.js (migration applied twice inside rollback fixtures)']
    },
    'limits': [
        'Spec approval not obtained (autonomous run); tests and implementation authored by the same agent.',
        'Full affected stock-request suite run; unrelated application suites were not run.',
        'Existing type/lint diagnostics compared against captured pre-change source; zero new findings required.',
        'Property check covers stage precedence; property-only mutations expose its limited scope. Example/API/browser tests cover the other behaviors.',
        'No dependency changes; dependency/license audit skipped. New handlers use existing database, event and permission infrastructure.',
        'No standalone formatter configured for this scoped check; lint and source-diff review used.',
        'Performance benchmarks skipped: no latency budget, remote integration or background job added.',
        'Not deployed. Migration and versioned frontend assets are included in the implementation.'
    ],
    'review': {
        'complexity': 'Shared availability predicate, information-panel renderer and order-card renderer; request and reply share one transaction with row lock and revision check.',
        'capabilityChange': 'Adds two authenticated in-app information endpoints and JSON state; no new outbound communication or remote-order operation.',
        'secrets': 'Changed source reviewed; no credentials added. Test runner contains isolated-fixture credentials only.',
        'testCorrections': ['Two older exact alert-response assertions updated to require the new pendingUpdate counter, with old counts preserved.', 'New fixtures corrected missing inventory balance and waitlist schema; test typo corrected to existing SPECIAL_ETA_REQUIRED error code.']
    }
}
(out / 'evidence.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'focused': checks['focused'], 'regression': checks['final'], 'coverage': [coverage['covered'], coverage['total']], 'mutantsKilled': sum(row['killed'] for row in mutations)}))
