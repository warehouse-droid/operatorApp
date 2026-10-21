"""Verify the combined live release and retain reproducible evidence, without changing business data."""
import importlib.util
import json
from pathlib import Path
import re

SERVER = Path(__file__).resolve().parents[1]
RELEASE = SERVER / 'deployments/special-po-warning-20261019'
ARTIFACTS = SERVER / 'test-artifacts/special-po-warning-20261019/results'

def read(path):
    return json.loads(path.read_text())

def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, SERVER / 'tools' / filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value

app = module('po_warning_app', 'special-po-warning-release.py')
worker = module('po_warning_worker', 'special-po-warning-worker-release.py')
live = {}
for name, release in [('app', app), ('worker', worker)]:
    data = release.r.state()
    release.r.ready(data['candidateImageId'])
    state = release.r.metadata(release.r.APP)
    assert state['imageId'] == data['candidateImageId']
    assert state['configuration'] == data['app']['configuration']
    actual = json.loads(release.r.docker('exec', release.r.APP, 'node', '-e', release.r.HASH_SCRIPT))
    assert actual == data['candidateTree']
    live[name] = {'imageId': state['imageId'], 'sourceTreeHash': data['candidateTreeHash'],
                  'configurationPreserved': True, 'runtimeFilesVerified': len(actual)}
for dependency in worker.r.state()['dependencies']:
    names = [worker.r.DB, 'mbbs-operator-app-ollama-1']
    assert any(worker.r.metadata(name) == dependency for name in names)

expected = {'mbbs-operator-app-app-1', 'mbbs-operator-app-webhook-worker-1',
            'mbbs-operator-app-db-1', 'mbbs-operator-app-ollama-1'}
other_containers = set()
for args, filename in [(['ps'], 'final-docker-ps.log'), (['ps', '-a'], 'final-docker-ps-a.log')]:
    rows = app.r.docker(*args, '--format', '{{.Names}}').decode().splitlines()
    assert expected.issubset(set(rows)), rows
    assert not any(name.startswith('mbbs-special-po-warning') for name in rows), rows
    other_containers.update(set(rows) - expected)
    (RELEASE / filename).write_text('\n'.join(rows) + '\n')
for kind, field in [('network', '{{.Name}}'), ('volume', '{{.Name}}')]:
    assert not app.r.docker(kind, 'ls', '--filter', 'label=com.docker.compose.project=mbbs-special-po-warning-test', '--format', field).strip()

script = """import {getSpecialStockCase} from './src/special-stock-request-repository.js';
import {closeDb} from './src/db.js';
try { const d=await getSpecialStockCase(265,{audience:'scm'});
console.log(JSON.stringify({requestRef:d.requestRef,revision:d.revision,attention:d.attention,
attentionReason:d.attentionReason,salesOrderRef:d.salesOrderRef,salesOrderApproved:d.salesOrderApproved,
purchaseOrderId:d.purchaseOrderId,purchaseOrderOperationStatus:d.purchaseOrderOperationStatus,
quantityReviewPending:d.quantityReviewPending})); } finally {await closeDb();} """
request = json.loads(app.r.docker('exec', '-i', app.r.APP, 'node', '--input-type=module', input=script.encode()))
assert request['requestRef'] == 'SPREQ-000111' and not request['attention']

counts = {name: int(value) for name, value in re.findall(r'^# (tests|pass|fail|skipped) (\d+)$',
    (RELEASE / 'rebase-validation.log').read_text(), re.M)}
assert counts == {'tests': 42, 'pass': 42, 'fail': 0, 'skipped': 0}
coverage = read(ARTIFACTS / 'rebase-coverage/coverage-final.json')
changed = read(RELEASE / 'changed-lines.json')
covered = []
for filename in [name for name in changed if name.startswith('src/')]:
    report = coverage['/app/' + filename]
    lines = {}
    for key, statement in report['statementMap'].items():
        line = statement['start']['line']
        lines[line] = max(lines.get(line, 0), report['s'][key])
    executable = [line for line in changed[filename] if line in lines]
    assert all(lines[line] > 0 for line in executable)
    covered.append({'file': filename, 'changedExecutableLines': len(executable), 'covered': len(executable)})

evidence = {
    'completedAt': app.r.now(), 'spec': read(RELEASE / 'spec.json'), 'live': live,
    'repair': read(RELEASE / 'request-repair.json'), 'finalRequest': request,
    'finalCandidateChecks': counts, 'workerChecks': read(ARTIFACTS / 'worker-validation.json'),
    'affectedSuite': read(ARTIFACTS / 'final-regressions.json'),
    'baselineFailures': [row for row in read(ARTIFACTS / 'baseline-regressions.json') if row['exit']],
    'static': read(ARTIFACTS / 'static.json'), 'finalChangedLineCoverage': covered,
    'mutations': read(ARTIFACTS / 'mutations.json'), 'propertyMutationLimits': read(ARTIFACTS / 'property-mutations.json'),
    'preservedConcurrentDeployment': read(RELEASE / 'capture.json')['preservedExternalChanges'],
    'reproduce': 'sudo -n bash server/tools/special-po-warning-reproduce.sh',
    'cleanup': {'taskTestContainersRemoved': True, 'taskDisposableVolumesRemoved': True, 'taskTestNetworksRemoved': True,
                'dockerPsAndPsAVerified': True, 'productionHealthy': True,
                'otherActiveTaskContainers': sorted(other_containers),
                'otherTaskNote': 'Independently started active tests are recorded and left to their owning task; they were not stopped or removed by this task.'},
    'limits': [
        'Affected workflow suites were run; the repository-wide application suite was not run. The same 17 failures were present before and after this change.',
        'The broad JavaScript type check did not complete under its bounded run. Changed modules were checked with noResolve: 739 existing diagnostics before and after, no new diagnostics.',
        'The UI change only corrects explanatory copy; it has syntax/lint checks, without a new browser test or changed-line browser coverage.',
        'Quantity properties alone kill one of five faults; example-based integration tests kill the other faults. No general property-only guarantee is claimed.',
        'No live NetSuite PO was created as a test. Isolated integration used real repositories and simulated NetSuite network responses.',
        'No dependencies changed, so dependency audit and license recheck were not applicable. Runtime diff adds no new external capability.',
        'Existing row-locking and operation-ownership code is unchanged; no new multi-process stress suite was added.'
    ],
    'specMapping': {
        'approvedCorrectionAndPreservedSO': 'special-po-warning.test.js: approved local correction creates a PO from the current review without rewriting the SO',
        'webhookDoesNotRelock': 'special-po-warning.test.js: SO reconciliation cannot recreate a warning lock during locally adjusted PO creation',
        'noDuplicatePO': 'special-po-warning.test.js: a locally adjusted PO with an uncertain submission is recovered without resubmission',
        'realLocksRemain': 'special-po-warning.test.js: unadjusted SO mismatches and pending adjustments still prevent PO creation; special-order-rejection-unlock.test.js',
        'quantityInvariant': 'special-po-warning.test.js: property: approved local quantities remain independent of the historical SO snapshot',
        'targetedLiveRelease': 'request-repair.json; finalRequest; live source and configuration verification'
    }
}
(RELEASE / 'EVIDENCE.json').write_text(json.dumps(evidence, indent=2) + '\n')
print(json.dumps({'complete': True, 'request': request, 'finalTests': counts, 'coverage': covered, 'cleanup': evidence['cleanup']}))
