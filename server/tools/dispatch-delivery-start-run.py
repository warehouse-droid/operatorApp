"""Run disposable verification and preserve only concise source evidence."""
from collections import deque
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
artifact = os.environ.get('MBBS_TEST_ARTIFACT_DIR')
if artifact:
    shutil.copy2(ROOT / 'server/deployments/dispatch-delivery-start-20261022/before/public/dispatch.js',
                 Path(artifact) / 'baseline-dispatch.js')
    os.chdir(ROOT)
    os.execvp('bash', ['bash', 'docker/run-isolated-tests.sh', 'node', 'tools/dispatch-delivery-start-checks.mjs'])
command = [sys.executable, 'docker/retention/retention.py', 'run', '--', sys.executable, str(Path(__file__).resolve())]
process = subprocess.Popen(command, cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
tail = deque(maxlen=70)
reports = []
prefix = 'DISPATCH_DELIVERY_START_EVIDENCE='
for raw in process.stdout:
    line = raw.rstrip('\n')
    tail.append(line)
    if line.startswith(('CHECK ', prefix)):
        print(line, flush=True)
    if line.startswith(prefix):
        reports.append(json.loads(line[len(prefix):]))
status = process.wait()
if status:
    print('\n'.join(tail), flush=True)
    raise SystemExit(status)
assert len(reports) == 1 and reports[0]['passed']
target = ROOT / 'server/test/dispatch/specs/dispatch-delivery-start-20261022-evidence.json'
target.write_text(json.dumps(reports[0], indent=2) + '\n')
print('Evidence saved after disposable cleanup and production health checks.', flush=True)
