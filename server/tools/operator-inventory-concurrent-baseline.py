"""Prove unrelated Receiving failures with every inventory edit removed."""
from pathlib import Path
import hashlib
import json
import re
import subprocess

server = Path(__file__).resolve().parents[1]
release = Path('/home/ubuntu/operatorapp-deploy-backups/operator-inventory-20260923-v1')
folder = release / 'receiving-only-baseline'
folder.mkdir(exist_ok=True)
target = folder / 'operator.js'
target.write_bytes((server / 'public/operator.js').read_bytes())
patch = (release / 'release.patch').read_text()
start = patch.index('--- a/public/operator.js\n')
end = patch.find('\n--- a/', start + 1)
run = subprocess.run(['patch', '--batch', '--fuzz=0', '--reverse', str(target)], input=patch[start:end] + '\n', text=True, capture_output=True)
(folder / 'reverse.log').write_text(run.stdout + run.stderr)
run.check_returncode()
assert 'MBBSOperatorInventory' not in target.read_text()
assert 'function receiptPostingJournalKey' in target.read_text()
files = ['test/mbt/unit/operator-direct-orderline-client.test.js', 'test/mbt/unit/operator-posting-photo-client.test.js']
args = ['sudo', '-n', 'docker', 'run', '--rm', '--network', 'none', '-v', str(target) + ':/app/public/operator.js:ro']
for file in files:
    copy = folder / Path(file).name
    copy.write_bytes((server / file).read_bytes())
    args += ['-v', str(copy) + ':/app/' + file + ':ro']
args += ['--entrypoint', 'node', 'field-sales-check-2941306:latest', '--test', '--test-concurrency=1', *files]
run = subprocess.run(args, text=True, capture_output=True)
log = run.stdout + run.stderr
(folder / 'tests.log').write_text(log)
names = re.findall(r'^not ok \d+ - (.*)$', log, re.M)
assert names and all(name.startswith('receiving:') for name in names)
digest = lambda data: hashlib.sha256(data).hexdigest()
proof = {'failedTests': names, 'inventoryChangesRemoved': True, 'sourceSha256': digest(target.read_bytes()),
         'workspaceSha256': digest((server / 'public/operator.js').read_bytes()), 'testLogSha256': digest(log.encode()),
         'reason': 'Separate Receiving changes arrived during the long inventory run. These failures reproduce with the inventory patch reversed.'}
(server / 'test/support/operator-inventory-concurrent-baseline.json').write_text(json.dumps(proof, indent=2) + '\n')
print(json.dumps(proof))
