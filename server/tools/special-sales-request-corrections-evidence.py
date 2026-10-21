import hashlib
import json
from pathlib import Path
import re

root = Path(__file__).resolve().parents[1]
out = root / 'test-artifacts/special-workflow-review/sales-request-corrections-20261003'
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
    'entryPoint': 'bash tools/special-sales-request-corrections-check.sh',
    'sourceTreeSha256': hashlib.sha256(json.dumps(checks['sourceHashes'], sort_keys=True).encode()).hexdigest(),
    'baseline': counts((out / 'baseline-tests.log').read_text()),
    'red': counts((out / 'red-tests.log').read_text()),
    'checks': checks, 'changedLineCoverage': coverage, 'manualMutationResults': mutations,
    'specToTests': {
        'QUOTE': ['unit/special-sales-request-corrections.test.js (sanitized SPREQ-000028 amounts and 150 seeded eligibility cases)', 'integration/special-sales-request-corrections-http.test.js (real saved quote PDF)'],
        'EDIT': ['unit/special-sales-request-corrections.test.js (100 seeded fee edits)', 'integration/special-sales-request-corrections-http.test.js', 'integration/special-sales-request-corrections-browser.test.js'],
        'GUARDS': ['integration/special-sales-request-corrections-http.test.js (real role, yard, revision, closure, atomic rollback)', 'integration/special-case-edits-http.test.js (concurrency and existing edit guards)'],
        'NOTES': ['unit/special-sales-request-corrections.test.js (escape and quote privacy)', 'integration/special-sales-request-corrections-browser.test.js (open, issued and closed views)', 'unit/special-sales-internal-remark.test.js (header privacy regression)']
    },
    'review': {
        'complexity': 'Existing case-lines endpoint and transaction extended with one optional delivery fee; pure read-only note renderer; material quote filter.',
        'capabilityChange': 'No endpoint, schema, dependency, outbound request or background job added. No duplicate edit buttons.',
        'secrets': 'Scoped patch reviewed; only isolated test database credentials in verification tools.',
        'corrections': ['Initial test invocation omitted the installed browser path. Baseline and red tests were rerun with /browsers; original logs retained.', 'Expected discount totals corrected to the existing half-up discount rounding rule.', 'The missing-master-item test now clears references from its own completed fixtures before removing the isolated test item; foreign key enforcement remains enabled.', 'Dynamic import changed to the established URL pattern to avoid introducing a type diagnostic; browser test uses window.getComputedStyle explicitly.'],
        'userSteering': 'The existing Edit case lines action edits both PALLET and delivery fee. No additional PALLET edit action was implemented.'
    },
    'limits': ['Spec approval not obtained (autonomous run); tests and code share an author.', 'Affected suites were run; unrelated application suites were not.', 'Existing type/lint diagnostics compared to the captured source; zero new findings allowed.', 'Browser tests use controlled API responses; API tests use the real app and isolated PostgreSQL. External order services are blocked in tests.', 'Live verification is read-only. Closed SPREQ-000028 was not edited or reopened.'],
    'decision': 'GO when the frozen candidate passes its acceptance tests and live health/asset checks.'
}
(out / 'evidence.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'decision': report['decision'], 'regression': checks['final'], 'focused': checks['focused'], 'changedLines': coverage['covered'], 'mutantsKilled': len(mutations)}))
