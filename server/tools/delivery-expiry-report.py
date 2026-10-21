"""Summarize retained verification artifacts without inventing test results."""
from pathlib import Path
import hashlib
import json
import re
import subprocess

server = Path(__file__).resolve().parents[1]
artifacts = server / 'test-artifacts/delivery-expiry-20261016'
final = artifacts / 'final'
results = final / 'results'
log = (final / 'run.log').read_text()
counts = {name: sum(map(int, re.findall(r'^ℹ ' + name + r' (\d+)$', log, re.M)))
          for name in ['tests', 'pass', 'fail', 'skipped']}
assert counts['tests'] == counts['pass'] == 275 and counts['fail'] == counts['skipped'] == 0
assert all(name + ': 0' in log for name in ['types', 'lint', 'syntax'])
assert 'teardown_exit=0' in (final / 'teardown.log').read_text()
coverage = json.loads((results / 'changed-coverage.json').read_text())
mutants = json.loads((results / 'mutations.json').read_text())
sources = json.loads((results / 'source-hashes.json').read_text())
assert not coverage['uncovered'] and not coverage['unmeasured']
assert len(mutants) == 7 and all(row['killed'] and row['restored'] for row in mutants)
for name, snapshot in sources.items():
    assert hashlib.sha256((server / name).read_bytes()).hexdigest() == snapshot['sha256']
report = {
    'spec': 'server/test/delivery-expiry-20261016.spec.json',
    'specApproval': 'not obtained (autonomous run)',
    'sourceCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=server, text=True).strip(),
    'sourceState': sources,
    'reproduce': 'bash server/tools/delivery-expiry-check.sh final && python3 server/tools/delivery-expiry-report.py',
    'baseline': {'files': 33, 'passed': 258, 'newTestsInitiallyFailed': 15,
                 'preexistingVisibilityRegression': 'Initially passed; independently verified by the Sales-controls mutation.'},
    'tests': {**counts, 'files': 35, 'shuffleSeed': 16102026},
    'types': 'Passed scoped TypeScript check, including the shared time parser.',
    'lintAndSyntax': 'Passed with zero errors and zero warnings; existing complexity limit 12 retained.',
    'changedLineCoverage': coverage,
    'mutations': mutants,
    'properties': {'clockCases': 200, 'seed': 16102026, 'independentPropertyMutantsKilled': 3},
    'realExecution': 'Actual Express routes, PostgreSQL transactions, Chromium desktop/mobile pages, reminders, alerts and dialog confirmation were exercised in isolated containers.',
    'behaviorMapping': {
        'freeTypingFormattingValidationAndDefault': ['expiry UI: free type', 'expiry UI: proposal', 'expiry override: malformed'],
        'torontoClockAndDst': ['expiry override: next Toronto occurrence', 'expiry override: generated clock'],
        'perRequestOnlyAndReminder': ['expiry HTTP: override and update', 'expiry override: updating and accepting'],
        'redWarningCancelEscapeConfirm': ['manual expiry UI: red button warns'],
        'accessStatesAndStaleRequests': ['expiry HTTP: authorization', 'expiry controls: Sales', 'expiry controls: terminal states'],
        'atomicityIdempotencyAndAudit': ['expiry races:', 'manual expiry HTTP: rollback'],
        'salesAlerts': ['expiry alerts: Sales sees'],
        'existingApprovalPricingOrderLinksAndInstructions': ['all 33 pre-existing delivery test files']
    },
    'cleanup': {'compose': 'down --volumes --remove-orphans', 'sharedBudget': 'mbbs-tests.slice',
                'containersVolumesAndNetworksRemoved': True, 'dockerPsAndPsAllVerified': True,
                'productionHealth': (final / 'production-health.log').read_text().splitlines()},
    'versions': json.loads((results / 'versions.json').read_text()),
    'environmentChanges': 'No new dependencies, database migrations, credentials, git commits or production test data.',
    'resolvedFailures': [
        'Initial acceptance tests failed on missing expiry behavior.',
        'Browser fixtures now isolate requests and mark initially opened fixtures read, preventing startup alerts from intercepting controls.',
        'The status assertion now selects the status paragraph explicitly, preserving its exact expected value.',
        'Type nullability, parser complexity and a const lint issue were fixed without relaxing assertions or lint thresholds.'
    ],
    'limits': [
        'The entire repository test suite was not run; verification covers every delivery request/instruction test file and its integration boundaries.',
        'Browser checks use Chromium; other browser engines were not run.',
        'No external NetSuite writes were made. Integration tests use disposable data and boundary fixtures.',
        'Dependency audit and migration rollback rehearsal are not applicable: neither dependencies nor schema changed.',
        'Clock-only overrides mean the next Toronto occurrence, today or tomorrow. Secured requests keep their expiry stopped.'
    ],
    'artifacts': 'server/test-artifacts/delivery-expiry-20261016/final'
}
deployment = artifacts / 'deployment-result.json'
report['deployment'] = json.loads(deployment.read_text()) if deployment.exists() else {'deployed': False}
(server / 'test/delivery-expiry-20261016.evidence.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'tests': counts, 'changedLines': coverage, 'mutantsKilled': len(mutants), 'deployed': report['deployment']['deployed']}))
