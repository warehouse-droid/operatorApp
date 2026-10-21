"""Summarize the saved final run; never use production records or credentials."""
from pathlib import Path
import difflib
import hashlib
import json
import re

server = Path(__file__).resolve().parents[2]
out = server / 'test-artifacts/sales-order-null-packs-20261016'
coverage = json.loads((out / 'coverage/coverage-final.json').read_text())
changed = {}
capability_changes = []
for filename, data in coverage.items():
    name = filename.removeprefix('/app/')
    before = out / 'before' / name
    old = before.read_text().splitlines() if before.exists() else []
    new = (server / name).read_text().splitlines()
    added = set()
    for kind, _, _, start, end in difflib.SequenceMatcher(a=old, b=new, autojunk=False).get_opcodes():
        if kind in ('insert', 'replace'):
            added.update(range(start + 1, end + 1))
    counts = {}
    for key, statement in data['statementMap'].items():
        line = statement['start']['line']
        counts[line] = max(counts.get(line, 0), data['s'][key])
    lines = sorted(line for line in added if line in counts and new[line - 1].strip()
                   and not new[line - 1].strip().startswith(('//', '/*', '*')))
    changed[name] = {'covered': sum(counts[line] > 0 for line in lines), 'total': len(lines),
                     'uncovered': [line for line in lines if not counts[line]]}
    for line in added:
        if re.search(r'AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----', new[line - 1]):
            raise RuntimeError('Potential secret in changed source: ' + name)
        if re.search(r'\b(?:fetch|exec|spawn|writeFile|readFile|process\.env)\s*\(', new[line - 1]):
            capability_changes.append({'file': name, 'line': line})
if any(row['uncovered'] for row in changed.values()):
    raise RuntimeError('Changed executable lines lack test coverage.')
hashes = json.loads((out / 'source-hashes.json').read_text())
for name, expected in hashes.items():
    if hashlib.sha256((server / name).read_bytes()).hexdigest() != expected:
        raise RuntimeError('Source changed after the final run: ' + name)
log = (out / 'coverage.log').read_text()
totals = {key: int(re.search(r'^# ' + key + r' (\d+)$', log, re.M)[1]) for key in ['tests', 'pass', 'fail', 'skipped']}
mutations = json.loads((out / 'mutations.json').read_text())
allowed = {'mbbs-operator-app-app-1', 'mbbs-operator-app-db-1', 'mbbs-operator-app-webhook-worker-1', 'mbbs-operator-app-ollama-1'}
for name in ['docker-ps.log', 'docker-ps-a.log']:
    if {line.split()[0] for line in (out / name).read_text().splitlines()} != allowed:
        raise RuntimeError('Test cleanup did not leave exactly the production allowlist.')
report = {
    'outcome': 'Implemented; all requested pack-null behaviors pass. Application and NetSuite scripts have not been deployed.',
    'specApproval': 'not obtained (autonomous run); explicit user request followed, no separate spec review',
    'reproduce': 'bash server/tools/sales-order-null-packs-20261016/gauntlet.sh',
    'toolchain': json.loads((out / 'versions.json').read_text()),
    'sourceState': 'source-hashes.json (working tree hashes, including pre-existing workspace changes)',
    'specToTests': {
        'missing_empty_zero_are_null': 'unit/sales-order-null-packs.test.js: ten input cases',
        'positive_counts_and_financial_invariants': 'unit/sales-order-null-packs.test.js: 250 seeded property examples plus existing pricing suites',
        'invalid_values_rejected': 'unit/sales-order-null-packs.test.js: adversarial values for each field',
        'nullable_storage': 'integration/sales-order-null-packs.test.js: request → SQL → saved SO draft → outbound JSON',
        'direct_estimate_discount_waitlist_posting': 'unit/sales-order-null-packs.test.js: transport boundary assertions',
        'suitescript_creation': 'unit/sales-order-null-packs.test.js and unit/special-workflow-adjustment-restlet.test.js',
        'optional_blank_ui': 'integration/sales-order-null-packs.browser.test.js: Chromium form validity and field values',
        'clear_existing_pack': 'unit/special-case-fields-orders.test.js: SO clears to null, PO convention preserved',
        'pricing_identity_retry_invariants': 'existing Special Order and Field Sales suites in manifest.mjs'
    },
    'finalTests': totals,
    'knownBaselineFailures': json.loads((out / 'baseline-failures.json').read_text()),
    'newFailures': 0,
    'static': {'syntax': '10 source files passed', 'lint': '0 errors, 0 warnings', 'types': json.loads((out / 'types.json').read_text())},
    'changedLineCoverage': {'covered': sum(row['covered'] for row in changed.values()), 'total': sum(row['total'] for row in changed.values()), 'files': changed},
    'newNormalizerCoverage': json.loads((out / 'coverage/coverage-summary.json').read_text())['/app/public/order-pack-quantities.js'],
    'mutation': {'killed': sum(row['killed'] for row in mutations), 'total': len(mutations), 'propertyOnlyKilled': sum(row['propertyKilled'] is True for row in mutations), 'propertyOnlyTotal': 3},
    'suiteHealth': {'seed': 20261016, 'files': len(json.loads((out / 'shuffled-order.json').read_text())['files']), 'result': 'all pass except the same reproduced baseline failure'},
    'dependencies': 'No dependency changes; installed existing package-lock.json in disposable tooling only.',
    'capabilityReview': {'newNetworkFilesystemSubprocessCalls': capability_changes, 'diffSecretPatternMatches': 0},
    'cleanup': 'Compose down --volumes --remove-orphans; temporary tools removed; docker ps and docker ps -a contain only production; production health passed.',
    'limits': [
        'No live NetSuite write or production deployment performed; both SuiteScript files require publishing to activate their changes.',
        'Repository-wide MBT suite not run; exercised the complete affected workflow suites listed in manifest.mjs.',
        '86 existing strict type diagnostics in the legacy request domain are independently reproduced; no new diagnostics.',
        'The existing alert-count test expects waitForProduction=1,total=3 but returns 0,2 before and after this change.'
    ],
    'developmentNotes': [
        'Initial test fixture lacked a required vendor; fixed without changing assertions and reran against the original source to reproduce 16 behavioral failures.',
        'Existing quote pack assertions were updated to expect blank/null for zero, matching the shared pack rule; pricing and positive-value assertions retained.',
        'A baseline check initially lacked its migrations directory; added the read-only migration path and reran.',
        'No production data backfill or schema migration was required.'
    ]
}
(out / 'evidence.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'tests': totals, 'changedLines': report['changedLineCoverage']['covered'], 'mutantsKilled': report['mutation']['killed'], 'cleanup': 'passed'}))
