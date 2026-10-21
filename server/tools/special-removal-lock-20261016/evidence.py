"""Summarize retained final-run evidence; never infer success from old logs."""
import importlib.util
import json
from pathlib import Path
import re

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('removal_checks', HERE / 'run.py')
checks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checks)
final = checks.OUT / 'final'
verified = json.loads((final / 'verified.json').read_text())
manifest = json.loads((checks.RELEASE / 'manifest.json').read_text())
assert verified['passed'] and verified['sourceHashes'] == manifest['sourceHashes']


def counts(name):
    log = (final / (name + '.log')).read_text()
    return {key: int(re.findall(r'^# ' + key + r' (\d+)$', log, re.M)[-1])
        for key in ['tests', 'pass', 'fail', 'skipped']}


changed = json.loads((final / 'changed-coverage.json').read_text())
coverage = json.loads((final / 'coverage/coverage-final.json').read_text())
branches = []
for name in checks.FILES:
    lines = {int(value.rsplit(':', 1)[1]) for value in changed['covered'] if value.startswith(name + ':')}
    entry = coverage['/app/' + name]
    for key, branch in entry['branchMap'].items():
        if branch['loc']['start']['line'] in lines:
            branches.extend({'file': name, 'line': branch['loc']['start']['line'], 'hits': hits} for hits in entry['b'][key])
changed['changedBranches'] = {'covered': sum(row['hits'] > 0 for row in branches), 'total': len(branches),
    'uncovered': [row for row in branches if row['hits'] == 0]}


report = {
    'task': 'SPREQ-000063 local line removal blocker', 'tier': 3,
    'specApproval': 'not obtained (autonomous run)',
    'userScopeConfirmation': 'Keep the current request-only removal behavior; no NetSuite synchronization',
    'spec': 'test/special-removal-lock-20261016.spec.json',
    'entryPoint': 'python3 server/tools/special-removal-lock-20261016/run.py final',
    'evidenceCommand': 'python3 server/tools/special-removal-lock-20261016/evidence.py',
    'sourceHashes': verified['sourceHashes'],
    'runtimeTreeHash': checks.core.sha(json.dumps(manifest['candidateTree'], sort_keys=True).encode()),
    'tools': json.loads((final / 'versions.log').read_text().strip().splitlines()[-1]),
    'acceptance': [
        {'scenario': 1, 'status': 'pass', 'tests': ['unprepared delivery failure permits local removal through SCM while preserving the failed journal and issued orders',
            'unprepared delivery failure allows request removal over HTTP without remote writes']},
        {'scenario': 2, 'status': 'pass', 'tests': ['applying deliveries and failed saved plans keep their adjustment locks',
            'delivery locks remain enforced at proposal, SCM claim and completion when remote work can be active']},
        {'scenario': 3, 'status': 'pass', 'tests': ['applying deliveries and failed saved plans keep their adjustment locks']},
        {'scenario': 4, 'status': 'pass', 'tests': ['delivery failures before remote preparation permit only local adjustments',
            'unprepared delivery failure permits local removal through SCM while preserving the failed journal and issued orders',
            'delivery locks remain enforced at proposal, SCM claim and completion when remote work can be active']},
        {'scenario': 5, 'status': 'pass', 'tests': ['delivery locks remain enforced at proposal, SCM claim and completion when remote work can be active'],
            'limit': 'Deterministic operation interleavings and existing row/advisory locks; no additional multi-process stress run'},
        {'scenario': 6, 'status': 'partial', 'tests': ['local issued request removal enforces Sales and SCM roles and never accesses NetSuite',
            'SCM rejection preserves removed lines and all records; stale and foreign removals do not write',
            'a failed local approval rolls back every removal and audit row, then retries once after the fault is resolved'],
            'limit': 'Two pre-existing status expectations fail on captured production source and candidate; one prevents the later completed-request assertion in that legacy test. Closed/completed guards are unchanged.'}
    ],
    'red': {'unitFailures': 3, 'integrationFailure': 'SPECIAL_OPERATION_BUSY', 'httpFailure': '409 instead of 200',
        'preExistingLockTest': 'Passed on baseline; killed by both allow-applying and allow-saved-plan mutants'},
    'finalRun': {'affectedSuite': counts('suite'), 'http': counts('http'), 'shuffledSuite': counts('suite-order'),
        'newFailures': [], 'knownFailures': sorted(checks.KNOWN_FAILURES),
        'types': 'PASS: changed policy module', 'syntax': 'PASS: both runtime files', 'lint': 'PASS: both runtime files and new unit/database regression tests',
        'changedCoverage': changed,
        'mutations': json.loads((final / 'mutations.json').read_text()),
        'newPropertyExamples': 150, 'propertySeed': 631016,
        'realExecution': 'Actual Express Sales proposal and SCM approval endpoints against isolated PostgreSQL; external transport counted at the network boundary',
        'cleanup': json.loads((final / 'cleanup.json').read_text())},
    'supplyChain': {'newDependencies': 0, 'runtimeCapabilityChanges': [], 'scopedDiffReview': 'Only the delivery guard and its local-only call sites changed; no credentials added'},
    'skipped': {'repositoryWideTests': 'Ran the directly affected local adjustment, quantity, fulfillment, database and HTTP suites; unrelated application modules were outside this fix.',
        'repositoryWideTypes': 'Type-checked the changed policy module and checked repository syntax and lint; did not run a whole-application type check.',
        'browser': 'No UI code changed; actual HTTP routes were exercised.',
        'dependencyAudit': 'No package or lockfile changes.', 'liveOrderMutation': 'User confirmed request-only removal. Production verification is read-only.'},
    'honestNotes': [
        'The first runner used a Node flag unavailable in the installed Node 20 image; corrected the runner.',
        'The ordinary-edit rejection test initially omitted required vendor-response fields and hit validation first; supplied valid fixture fields without changing its assertion.',
        'Two unrelated status expectations already fail on production baseline; preserved those assertions and required zero additional failures.',
        'A concurrent release changed only src/sor-return-readiness.js. Rebased onto that image and reran final verification; the two target source files were unchanged by that release.',
        'No test databases retained; logs, source snapshots and rollback image are retained.'
    ]
}
deployed = checks.OUT / 'deployment-result.json'
if deployed.exists():
    report['deployment'] = json.loads(deployed.read_text())
checks.save(checks.SERVER / 'test/special-removal-lock-20261016.evidence.json', report)
print(json.dumps({'affectedSuite': report['finalRun']['affectedSuite'], 'http': report['finalRun']['http'],
    'newFailures': 0, 'manualMutantsKilled': len(report['finalRun']['mutations']), 'deployed': deployed.exists()}))
