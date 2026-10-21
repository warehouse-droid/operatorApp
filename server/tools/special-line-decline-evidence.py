import hashlib
import json
from pathlib import Path
import re

root = Path(__file__).resolve().parents[1]
out = root / 'test-artifacts/special-workflow-review/line-decline-20261003'
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
    'entryPoint': 'bash tools/special-line-decline-check.sh',
    'sourceTreeSha256': hashlib.sha256(json.dumps(checks['sourceHashes'], sort_keys=True).encode()).hexdigest(),
    'baseline': counts((out / 'baseline-tests.log').read_text()),
    'red': counts((out / 'red-tests.log').read_text()),
    'checks': checks, 'changedLineCoverage': coverage, 'manualMutationResults': mutations,
    'specToTests': {
        'REVERSIBLE': ['unit/special-line-decline.test.js (decision validation, SCM revision restoration, 150 seeded plans)', 'integration/special-line-decline-http.test.js (real transactions, historic declines and changed stock response)'],
        'STATUS': ['integration/special-line-decline-http.test.js (raw status, detail stage, SQL view and both Sales/SCM stage filters)'],
        'QUOTE_AND_ORDERS': ['unit/special-line-decline.test.js (revoked material absent from old draft)', 'integration/special-line-decline-http.test.js (real PDF, draft review gates and resave)'],
        'GUARDS': ['integration/special-line-decline-http.test.js (role, yard, revision, closure, concurrency, no-op, rollback and migration rehearsal)'],
        'UI': ['integration/special-line-decline-browser.test.js (desktop/mobile location, staging, cancel, conflict, notes and typed charge values)']
    },
    'review': {
        'complexity': 'Extend the existing editor and case-lines transaction with optional reversible decisions, a revision-bound stage snapshot and an order-draft review flag.',
        'capabilityChange': 'Two additive JSON columns and a compatible SQL stage view. No new endpoint, dependencies or outbound request. App-only release.',
        'secrets': 'Scoped patch reviewed; only isolated test database credentials in verification tools.',
        'corrections': ['Baseline and red fixtures needed the current auth migration (operators.email); initial schema-mismatch logs retained and both suites rerun successfully.', 'The SO fixture now passes six native pieces for three packages with conversion two, as required by the existing conversion contract.', 'A failing boundary test showed that editing an already declined material dropped its staged decision during the review reset. The plan now reapplies the decline and revokes it to pending against the new stock response.'],
        'userSteering': 'Decline and Revoke decline replace the requested removal action. Saved lines never disappear. No deletion code was implemented.'
    },
    'limits': ['Spec approval not obtained (autonomous run); tests and code share an author.', 'Affected suites were run; unrelated application suites were not.', 'Existing type/lint diagnostics compared to the captured source; zero new findings allowed.', 'Browser tests use controlled API responses; API tests use the real app and isolated PostgreSQL. External order services are blocked in tests.', 'Live verification is read-only. Closed SPREQ-000028 was not edited or reopened.'],
    'decision': 'GO when the frozen candidate passes its acceptance tests and live health/asset checks.'
}
(out / 'evidence.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'decision': report['decision'], 'regression': checks['final'], 'focused': checks['focused'], 'changedLines': coverage['covered'], 'mutantsKilled': len(mutations)}))
