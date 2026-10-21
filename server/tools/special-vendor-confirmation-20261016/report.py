"""Summarize the fresh bounded run without hiding inherited failures."""
import json
from pathlib import Path
root = Path(__file__).resolve().parents[2]
folder = root / 'test-artifacts/special-vendor-confirmation-20261016'
report = json.loads((folder / 'final/report.json').read_text())
assert report['passed']
cleanup = json.loads((folder / 'final/cleanup.json').read_text())
assert not any(cleanup.values())
manifest = json.loads((root / 'deployments/special-vendor-confirmation-20261016/manifest.json').read_text())
assert report['source'] == {name: manifest['candidateTree'][name] for name in manifest['files']}
mutations = json.loads((folder / 'final/mutations.json').read_text())
assert all(row['killed'] for row in mutations)
results = [r for r in report['layers'] if r['name'].startswith('suite')]
acceptance = [
 'Special accepted materials and PO alone stay Await Customer Confirmation until the actual SO link',
 'SCM records PO sent once with server time, actor, persisted stage and an audit event',
 'PO sent before SO is linked preserves customer waiting and later becomes vendor waiting',
 'SCM action rejects wrong role, anonymous, missing PO, terminal cases and pending edits',
 'racing SCM acknowledgements save exactly one event and one revision',
 'same PO relink preserves sent evidence and another PO cannot replace it',
 'migration reapply and view rollback preserve sent metadata and order data',
 'SCM browser button saves the real request and Sales sees the waiting status after reload',
 'Special accepted stock and ETA decisions without SO keep Await Customer Confirmation',
 'sent linked PO waits for the vendor until its existing dispatch handoff',
 'terminal and pending-information states retain precedence over vendor acknowledgement',
 'vendor waiting label and filter are available to both Special queues',
 'regular Backorder confirmation and SO skips retain their existing milestones',
 'the vendor waiting filter is limited to Special requests'
]
log = (folder / 'final/suite-db.log').read_text()
for name in acceptance:
    assert any(line.startswith('ok ') and line.endswith(' - ' + name) for line in log.splitlines()), name
value = {'passed': True, 'sourceTreeHash': manifest['candidateTreeHash'], 'specApproval': 'not obtained (autonomous run)',
 'tests': sum(r['tests'] for r in results), 'passedTests': sum(r['passed'] for r in results),
 'existingFailures': report['regressionFailures'], 'newFailures': report['newFailures'],
 'newTypeDiagnostics': report['newTypes'], 'newLintDiagnostics': report['newLint'],
 'changedLineCoverage': report['coverage'], 'mutations': mutations,
 'acceptance': [{'test': name, 'passed': True} for name in acceptance],
 'cleanup': cleanup, 'productionHealthAfterTests': json.loads((folder / 'final/production-health.json').read_text()),
 'toolchain': report['toolchain'], 'knownLimits': report['limits'],
 'reproduce': 'sudo -n python3 server/tools/special-vendor-confirmation-20261016/run.py final',
 'deployed': False,
 'verificationNotes': [
  'Initial fixture assumptions were corrected: workflow identity is immutable and linked POs cannot be replaced. Actual API-created Backorders and the existing PO conflict rule are tested.',
  'Browser verification waits for the selected request and checks the actual POST response; unrelated synthetic PO-reference alerts are acknowledged before interacting with the Sales filter.',
  'The existing test-only accepted-ETA skip milestone was restored after a regression property failed; the Special-only stage is excluded from Backorder filters.',
  'The final regression run and static checks passed their baseline comparisons. The mutation/coverage tail was resumed after correcting fast-check log parsing; runtime and acceptance assertions stayed unchanged, checked against source hashes.',
  'Text diff alignment assigned repeated route-ending statements to the unchanged preceding handler. Exact unchanged-route comparison identifies the added handler lines; proof is saved in deployments/special-vendor-confirmation-20261016/coverage-line-alignment.json.',
  'Reproduction uses the existing bounded browser test image and toolchain paths recorded in run.py; tool versions and the complete runtime source tree hash are recorded here.'
 ]}

deployment = root / 'deployments/special-vendor-confirmation-20261016/deployment-result.json'
if deployment.exists():
    value['deployment'] = json.loads(deployment.read_text())
    value['deployed'] = value['deployment']['deployed']
(folder / 'evidence.json').write_text(json.dumps(value, indent=2) + '\n')
print(json.dumps({k: value[k] for k in ['tests','passedTests','newFailures','changedLineCoverage','deployed']}))
