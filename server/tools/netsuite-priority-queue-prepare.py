"""Record a tested, undeployed revision and a combined review patch."""
import datetime
import difflib
import hashlib
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
ART = ROOT / 'test-artifacts/netsuite-priority-queue'
name = sys.argv[1]
assert re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,79}', name)
candidate, baseline = ART / name, ART / 'baseline'
report = json.loads((ART / 'regression.json').read_text())
assert report['candidate'] == name and not report['newFailures'] and not report['newFailedFiles']
assert report['checks']['passed'] and report['deployed'] is False
files = list(report['checks']['sourceHashes']) + ['migrations/227_netsuite_request_priority.sql']
assert all((ROOT / file).read_bytes() == (candidate / file).read_bytes() for file in files)
assert all((ROOT / file).read_bytes() == (baseline / file).read_bytes() for file in ['package.json', 'package-lock.json'])

patch, base_hashes = '', {}
for file in files + ['test/mbt/unit/smart-scm-created-po-service.test.js']:
    exists = (baseline / file).exists()
    before = (baseline / file).read_text() if exists else ''
    if file == 'src/netsuite.js':
        # Include the earlier prepared-but-undeployed bypass, too. Without it,
        # SQL could still wait in the old local FIFO before reaching the limiter.
        prefix = 'export async function suiteql(q, params = [], options = {}) {\n  const run = () => runSuiteql(q, params, options);\n'
        branch = '  if (isOperatorNetSuiteRequest()) {return run();}\n'
        assert before.count(prefix + branch) == 1
        before = before.replace(prefix + branch, prefix)
    base_hashes[file] = hashlib.sha256(before.encode()).hexdigest() if exists else None
    after = (candidate / file).read_text()
    for line in difflib.unified_diff(before.splitlines(True), after.splitlines(True),
                                     fromfile='a/' + file if exists else '/dev/null', tofile='b/' + file):
        patch += line if line.endswith('\n') else line + '\n\\ No newline at end of file\n'
added = '\n'.join(line for line in patch.splitlines() if line.startswith('+') and not line.startswith('+++'))
assert not re.search(r'BEGIN (?:RSA |EC )?PRIVATE KEY|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}', added)
(ART / 'prepared-combined.patch').write_text(patch)
test_file = 'test/mbt/unit/smart-scm-created-po-service.test.js'
assert [line for line in (baseline / test_file).read_text().splitlines() if 'assert.' in line] == [
    line for line in (candidate / test_file).read_text().splitlines() if 'assert.' in line]
manifest = {'status': 'prepared_not_deployed', 'candidate': name, 'deployed': False,
            'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'sourceTreeHash': report['sourceTreeHash'],
            'runtime': {file: hashlib.sha256((candidate / file).read_bytes()).hexdigest() for file in files},
            'reviewPatch': 'prepared-combined.patch', 'patchBaseHashes': base_hashes,
            'includesPriorUndeployedSuiteqlBypass': True, 'dependenciesChanged': False,
            'productionDatabaseModified': False, 'liveNetSuiteRequestsSent': False,
            'poRegressionAssertionsUnchanged': True,
            'futureRolloutServices': ['app', 'webhook-worker'], 'migration': '227_netsuite_request_priority.sql'}
(ART / 'prepared-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({'status': manifest['status'], 'candidate': name, 'deployed': False}))
