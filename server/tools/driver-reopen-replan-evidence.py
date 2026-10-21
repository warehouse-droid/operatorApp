"""Record exact-candidate evidence after both disposable test runs complete."""
import datetime
import hashlib
import json
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1]
RELEASE = SERVER / 'deployments/driver-reopen-replan-20261006'
ARTIFACT = SERVER / 'test-artifacts/driver-reopen-replan-20261006'
manifest = json.loads((RELEASE / 'manifest.json').read_text())
runtime = {str(path.relative_to(RELEASE / 'candidate')): hashlib.sha256(path.read_bytes()).hexdigest()
    for folder in ['src', 'public', 'migrations']
    for path in sorted((RELEASE / 'candidate' / folder).rglob('*')) if path.is_file()}
assert runtime == manifest['candidateTree'], 'Validated candidate contents changed'
assert hashlib.sha256(json.dumps(runtime, sort_keys=True).encode()).hexdigest() == manifest['candidateTreeHash']
result_path = ARTIFACT / 'results/driver-reopen-replan-final/result.json'
assert result_path.stat().st_mtime >= datetime.datetime.fromisoformat(manifest['capturedAt']).timestamp(), 'Checks predate the current candidate capture'
result = json.loads(result_path.read_text())
assert result['passed'] and result['core']['pass'] == 7 and result['core']['fail'] == 0
assert result['preexistingAdjacentFailures'] == 1
assert result['changedLinesExecuted'] == result['changedLinesTotal'] == 12
assert result['mutantsKilled'] == result['mutantsTotal'] == 6
assert result['newTypeDiagnostics'] == result['newLintDiagnostics'] == 0
migration_path = ARTIFACT / 'migration-final.log'
assert migration_path.stat().st_mtime >= result_path.stat().st_mtime, 'Migration rehearsal must follow the final checks'
migration = [json.loads(line) for line in migration_path.read_text().splitlines()
    if line.startswith('{"migrationRollback"')]
assert len(migration) == 1 and all(value == 'passed' for value in migration[0].values())
assert 'teardown_exit=0' in (ARTIFACT / 'teardown.log').read_text()
versions = json.loads((ARTIFACT / 'results/driver-reopen-replan-current-static/versions.json').read_text())
validation = {'passed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'candidateTreeHash': manifest['candidateTreeHash'], 'changedFiles': manifest['files'],
    'regressions': result, 'migration': migration[0], 'versions': versions}
(RELEASE / 'validation-passed.json').write_text(json.dumps(validation, indent=2) + '\n')
(ARTIFACT / 'validation-passed.json').write_text(json.dumps(validation, indent=2) + '\n')
print(json.dumps({'passed': True, 'candidateTreeHash': manifest['candidateTreeHash'],
    'coreTestsPassed': 7, 'mutantsKilled': 6, 'migrationRollback': 'passed'}))
