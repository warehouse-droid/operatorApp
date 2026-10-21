"""Assemble the recorded test, cleanup and live release evidence."""
import json
from pathlib import Path

SERVER = Path(__file__).resolve().parents[2]
evidence = SERVER / 'test-artifacts/backorder-po-recheck-20261019'
release = SERVER / 'deployments/backorder-po-recheck-20261019'

def read(path):
    return json.loads(path.read_text())

report = read(evidence / 'final/report.json')
assert report['passed']
report['baseline'] = read(evidence / 'baseline/report.json')['regressionFailures']
report['red'] = read(evidence / 'red/report.json')['layers'][0]
report['cleanup'] = read(evidence / 'final/cleanup.json')
assert not any(report['cleanup'].values())
report['mutations'] = read(evidence / 'final/mutations.json')
deployed = (release / 'deployment-result.json').exists()
report['deployment'] = read(release / 'deployment-result.json') if deployed else {
    'deployed': False, 'prepared': True, 'approval': read(release / 'deployment-approval.json'),
    'imageCheck': read(release / 'image-check.json')
}
report['caseBefore'] = read(release / 'case-before.json')
report['caseAfter'] = read(release / 'case-after.json') if deployed else None
report['rebase'] = read(release / 'rebase.json') if (release / 'rebase.json').exists() else None
if deployed:
    assert report['caseAfter']['scmPoLinkVisible'] is True
    if report['rebase']:
        manifest = read(release / 'manifest.json')
        assert all(manifest['candidateTree'].get(name) == digest
                   for name, digest in report['rebase']['preservedFiles'].items())
report['reproduce'] = 'python3 server/tools/backorder-po-recheck-20261019/run.py final'
report['review'] = {
    'specApproval': 'not obtained (autonomous run)',
    'failureModel': report['spec']['failureModel'],
    'adversarialPass': 'Forged SO identity, unfinished stock checks, explicit request_update, invalid order kinds, resolved lines, stale revisions and unauthorized role tested.',
    'complexity': 'One existing material scan; no new database query or remote call.',
    'setupIssue': 'The first budget check required sudo for systemd-run; corrected before any test stack started.',
    'verificationIssue': 'The first final run killed a mutant, but its reporter expected AssertionError instead of the property runner wrapper. The reporter now recognizes the counterexample format and rejects syntax/import failures; the complete final check was rerun.',
    'scope': 'One shared browser/server workflow file; no migration, production data edit or dependency change.',
    'limits': 'No independent human spec review. Four pre-existing browser failures remain and are listed in baseline. Unrelated repository suites were not run.'
}
(evidence / 'evidence.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'report': str(evidence / 'evidence.json'), 'layers': report['layers'],
    'coverage': report['coverage'], 'mutantsKilled': len(report['mutations']),
    'deployed': deployed,
    'livePoLinkVisible': report['caseAfter']['scmPoLinkVisible'] if deployed else False}, indent=2))
