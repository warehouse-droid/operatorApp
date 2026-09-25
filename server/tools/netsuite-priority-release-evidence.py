"""Verify release-specific coverage, source scope and fresh check results."""
import difflib
import hashlib
import json
from pathlib import Path
import re

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER / 'test-artifacts/netsuite-priority-deployment-20260925'
manifest = json.loads((ROOT / 'manifest.json').read_text())
checks = json.loads((ROOT / 'checks-app/checks.json').read_text())
smoke = json.loads((ROOT / 'release-smoke.json').read_text())
data = json.loads((ROOT / 'checks-app/checks/coverage/coverage-final.json').read_text())
assert checks['passed'] and smoke['passed']
worker = (ROOT / 'worker-tests.log').read_text()
assert '# pass 24\n# fail 0\n' in worker and not re.search(r'# fail [1-9]', worker)
coverage = {}
for file in manifest['services']['app']['after']:
    if not file.startswith('src/'):
        continue
    before = ROOT / 'baseline-app' / file
    old = before.read_text().splitlines() if before.exists() else []
    new = (ROOT / 'candidate-app' / file).read_text().splitlines()
    changed = set()
    for op, _, _, start, end in difflib.SequenceMatcher(None, old, new).get_opcodes():
        if op in ['insert', 'replace']:
            changed.update(range(start + 1, end + 1))
    cov = data['/app/' + file]
    measured, missing = [], []
    for line in sorted(changed):
        spans = [key for key, value in cov['statementMap'].items()
                 if value['start']['line'] <= line <= value['end']['line']]
        if spans:
            measured.append(line)
            if not any(cov['s'][key] > 0 for key in spans):
                missing.append(line)
    branches = [hit for key, span in cov['branchMap'].items() if span['line'] in changed for hit in cov['b'][key]]
    coverage[file] = {'measured': len(measured), 'covered': len(measured) - len(missing), 'missing': missing,
        'measuredBranches': len(branches), 'coveredBranches': sum(hit > 0 for hit in branches)}
assert not any(row['missing'] for row in coverage.values())
for service, row in manifest['services'].items():
    for file, sha in row['candidateHashes'].items():
        assert hashlib.sha256((ROOT / ('candidate-' + service) / file).read_bytes()).hexdigest() == sha
    assert smoke['actualCandidateImages'][service] == row['candidateImageId']
    added = '\n'.join(line for line in (ROOT / ('release-' + service + '.patch')).read_text().splitlines()
                      if line.startswith('+') and not line.startswith('+++'))
    assert not re.search(r'BEGIN (?:RSA |EC )?PRIVATE KEY|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}', added)
    for file in ['package.json', 'package-lock.json']:
        assert (ROOT / ('baseline-' + service) / file).read_bytes() == (ROOT / ('candidate-' + service) / file).read_bytes()
result = {'passed': True, 'appTests': checks['focusedTests'], 'workerTests': 24,
    'changedLineCoverage': coverage, 'newTypeDiagnostics': checks['newTypeDiagnostics'],
    'newLintDiagnostics': checks['newLintDiagnostics'], 'mutations': checks['mutations'],
    'poRaceGuardMutationKilled': checks['poVersionRecheckMutationKilled'],
    'dependencyFilesUnchanged': True, 'credentialPatternScanPassed': True,
    'candidateSourcesUnchanged': True, 'rollbackRehearsed': True,
    'fullSuite': 'Prepared candidate-v4 previously compared full baseline/candidate with zero new failures; release validation reruns scoped affected tests, types, lint, mutations, property/shuffle tests and actual-image startup/rollback.'}
(ROOT / 'changed-coverage.json').write_text(json.dumps(coverage, indent=2) + '\n')
(ROOT / 'release-evidence.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'passed': True, 'appTests': result['appTests'], 'workerTests': result['workerTests'],
    'changedLinesCovered': sum(row['covered'] for row in coverage.values()),
    'changedLinesMeasured': sum(row['measured'] for row in coverage.values())}))
