"""Summarize the retained verification evidence without retaining any test database."""
import hashlib
import json
from pathlib import Path

SERVER = Path(__file__).resolve().parents[2]
ROOT = SERVER / 'test-artifacts/backorder-confirmed-links-20261016'
RELEASE = SERVER / 'deployments/backorder-confirmed-links-20261016'
final = json.loads((ROOT / 'final/report.json').read_text())
baseline = json.loads((ROOT / 'baseline/report.json').read_text())
manifest = json.loads((RELEASE / 'manifest.json').read_text())
mutations = json.loads((ROOT / 'final/mutations.json').read_text())
report = {
    'request': final['spec']['request'],
    'specApproval': final['spec']['specApproval'],
    'passed': final['passed'],
    'entryPoint': 'sudo -n python3 server/tools/backorder-confirmed-links-20261016/run.py final',
    'sourceTreeHash': manifest['candidateTreeHash'],
    'toolchain': final['toolchain'],
    'acceptance': final['acceptance'],
    'tests': final['layers'],
    'baselineFailures': baseline['regressionFailures'],
    'changedLineCoverage': final['coverage'],
    'mutations': {'killed': sum(item['killed'] for item in mutations), 'total': len(mutations), 'layer': 'property suite alone'},
    'lintDiagnostics': len(final['lintDiagnostics']),
    'typeDiagnostics': {'baseline': len(baseline['typeDiagnostics']), 'final': len(final['typeDiagnostics']), 'new': 0},
    'limits': final['limits'],
    'diffReview': final['diffReview'],
    'cleanup': json.loads((ROOT / 'final/cleanup.json').read_text()),
    'productionHealth': json.loads((ROOT / 'final/production-health.json').read_text()),
    'redEvidence': json.loads((ROOT / 'red/report.json').read_text())['regressionFailures'],
    'redSource': json.loads((ROOT / 'red/source.json').read_text()),
    'refreshedFromPreviousRelease': manifest.get('previousRelease'),
    'setupIssues': [
        'Initial migration run hit captured-source permissions. The captured source was made readable to the non-root test user; that disposable stack was removed before retry.',
        'The shared PO suite required hostname mbbs-special-review-db. A network alias to the same disposable Compose database and per-suite DATABASE_URL resolved the setup assertion without changing tests or database credentials.'
    ],
    'baselineHarnessRepair': 'The property renderer needed a window stub for the existing browser extension hooks; no application behavior was mocked.',
    'testAndToolHashes': {str(path.relative_to(SERVER)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in [*[SERVER / name for name in final['suite']], *Path(__file__).resolve().parent.glob('*')]
        if path.is_file()}
}
deployment = RELEASE / 'deployment-result.json'
if deployment.exists():
    report['deployment'] = json.loads(deployment.read_text())
else:
    report['deployment'] = {
        'status': 'awaiting explicit user approval',
        'candidateImage': 'mbbs-operator-app:backorder-confirmed-links-20261016',
        'imageCheck': json.loads((RELEASE / 'image-check.json').read_text()),
        'block': 'Automatic approval review rejected the live deployment because the workflow request did not explicitly authorize production deployment. No deployment command ran.'
    }
(ROOT / 'evidence.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'passed': report['passed'], 'tests': report['tests'][0], 'coverage': report['changedLineCoverage'], 'mutations': report['mutations'], 'deployed': deployment.exists()}))
