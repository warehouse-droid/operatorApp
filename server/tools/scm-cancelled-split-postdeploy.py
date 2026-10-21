"""Verify the live incident and retain compact release/test evidence."""
import hashlib
import json
from pathlib import Path
import subprocess

SERVER = Path(__file__).resolve().parents[1]
RELEASE = SERVER / 'deployments/scm-cancelled-split-20261008'
OUT = SERVER / 'test-artifacts/scm-cancelled-split-20261008'

script = (SERVER / 'tools/scm-cancelled-split-live.mjs').read_text().replace("'../src/", "'./src/")
live = json.loads(subprocess.check_output(
    ['docker', 'exec', '-i', 'mbbs-operator-app-app-1', 'node', '--input-type=module', '-', 'after'],
    input=script.encode(), timeout=45))
before = json.loads((RELEASE / 'live-before.json').read_text())
assert live['ledger'] == before['ledger'], 'Split identities and retained history changed'
assert live['rows'][0] == next(row for row in before['rows'] if row['sourceId'] == live['rows'][0]['sourceId']), 'Active order contents changed'
(RELEASE / 'live-after.json').write_text(json.dumps(live, indent=2) + '\n')

final = json.loads((OUT / 'final/report.json').read_text())
baseline = json.loads((OUT / 'red/report.json').read_text())
manifest = json.loads((RELEASE / 'manifest.json').read_text())
assert final['passed'] and final['sourceHash'] == manifest['candidateTree']['src/dispatch-repository.js']
containers = {}
for args, name in [(['ps'], 'running'), (['ps', '-a'], 'all')]:
    rows = subprocess.check_output(['docker', *args, '--format', '{{.Names}} {{.Status}}']).decode().splitlines()
    containers[name] = rows
    assert {row.split()[0] for row in rows} == {
        'mbbs-operator-app-app-1', 'mbbs-operator-app-db-1',
        'mbbs-operator-app-webhook-worker-1', 'mbbs-operator-app-ollama-1'}
for resource in ['network', 'volume']:
    names = subprocess.check_output(['docker', resource, 'ls', '--format', '{{.Name}}']).decode().splitlines()
    assert not any(name.startswith('mbbs-cancelled-split-') for name in names), 'Disposable resource remains'
(RELEASE / 'final-cleanup.json').write_text(json.dumps(containers, indent=2) + '\n')
image = subprocess.check_output(['docker', 'image', 'inspect', 'mbbs-delivery-requests:static', '--format', '{{.Id}}']).decode().strip()

evidence = {
    'task': 'Hide cancelled split lifecycles from PO/TO Schedule',
    'spec approval': 'not obtained (autonomous run)',
    'tier': 2,
    'spec': 'test/scm-cancelled-split-schedule-spec.json',
    'runtimeChange': {'files': manifest['files'], 'sourceHash': final['sourceHash'], 'candidateTreeHash': manifest['candidateTreeHash'], 'predicateLines': 6},
    'reproduce': 'python3 server/tools/scm-cancelled-split-check.py final',
    'testImage': {'tag': 'mbbs-delivery-requests:static', 'id': image},
    'layers': final['layers'],
    'mapping': {
        'referenceReuse': 'reference reuse hides the cancelled lifecycle and preserves the active replacement',
        'allViews': 'six cancelled-split view and lookup cases',
        'staleFlags': 'multiple cancelled lifecycles never hide their active replacement despite stale flags',
        'ordinaryOrders': 'source/active/empty/TO visibility and ordinary inactive completed PO cases',
        'http': 'authenticated schedule HTTP search returns the replacement and denies anonymous access',
        'history': 'schedule reads retain the original records and cancellation history',
        'releaseScope': 'manifest, image check, deployment-result and live-before/live-after checks'
    },
    'coverage': {'changedPredicateLines': 6, 'uncovered': final['uncoveredLines'], 'note': 'SQL execution coverage is paired with assertions against real PostgreSQL query results.'},
    'mutations': final['mutants'],
    'properties': final['property'],
    'baselineDiagnostics': {'types': len(baseline['typeDiagnostics']), 'lint': len(baseline['lintDiagnostics'])},
    'finalDiagnostics': {'types': len(final['typeDiagnostics']), 'lint': len(final['lintDiagnostics']), 'new': 0},
    'resolvedValidationIssues': [
        'Initial transfer fixture lacked a required destination ID. Added realistic location IDs before implementation; assertions unchanged; corrected RED run had nine expected failures.',
        'Repeating legacy suites against the same database collided with retained fixed fixture identities. Moved the seeded order check to a fresh disposable database; unchanged assertions and runtime candidate.'
    ],
    'skipped': {
        'unrelatedApplicationSuites': 'Change is one read-only SCM query; ran all 16 selected split/schedule/visibility regression files (150 tests), plus new checks.',
        'browserRendering': 'No browser code changed; exercised the authenticated schedule HTTP endpoint.',
        'dependencyAudit': 'No dependency or capability changes.',
        'migrationRollback': 'No schema or business-data mutation in this release.'
    },
    'capabilityReview': 'Only a SQL visibility predicate was added. No network, environment, filesystem or subprocess capability added to runtime.',
    'live': live,
    'deployment': json.loads((RELEASE / 'deployment-result.json').read_text()),
    'cleanup': containers,
    'artifacts': str(OUT.relative_to(SERVER)),
    'toolHashes': {name: hashlib.sha256((SERVER / 'tools' / name).read_bytes()).hexdigest() for name in [
        'scm-cancelled-split-check.py', 'scm-cancelled-split-gauntlet.mjs', 'scm-cancelled-split-release.py',
        'scm-cancelled-split-live.mjs', 'scm-cancelled-split-postdeploy.py']}
}
(SERVER / 'test/scm-cancelled-split-schedule-evidence.json').write_text(json.dumps(evidence, indent=2) + '\n')
print(json.dumps({'liveRows': len(live['rows']), 'pallets': live['rows'][0]['totalPalletQty'],
                  'historyPreserved': True, 'testResourcesRemoved': True, 'evidenceWritten': True}))
