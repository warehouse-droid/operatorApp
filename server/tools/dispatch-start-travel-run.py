"""Run the bounded disposable gauntlet and retain only concise source evidence."""
import json
from collections import deque
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
command = ['bash', 'docker/run-isolated-tests.sh', 'node', 'tools/dispatch-start-travel-checks.mjs']
process = subprocess.Popen(command, cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
tail = deque(maxlen=90)
reports = []
prefix = 'DISPATCH_TRAVEL_EVIDENCE='
for raw in process.stdout:
    line = raw.rstrip('\n')
    tail.append(line)
    if line.startswith(('CHECK ', 'DISPATCH_TRAVEL_EVIDENCE=')):
        print(line, flush=True)
    if line.startswith(prefix):
        reports.append(json.loads(line[len(prefix):]))
status = process.wait()
if status:
    print('\n'.join(tail), flush=True)
    raise SystemExit(status)
assert len(reports) == 1 and reports[0]['passed']
target = ROOT / 'server/test/dispatch/specs/dispatch-start-travel-20261022-evidence.json'
target.write_text(json.dumps(reports[0], indent=2) + '\n')
print('Concise evidence saved; disposable runner verified teardown and production health.', flush=True)
