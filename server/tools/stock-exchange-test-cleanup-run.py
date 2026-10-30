#!/usr/bin/env python3
"""Run the user-approved SE-000001 cleanup with a retained operational audit."""
import datetime
import hashlib
import json
from pathlib import Path
import subprocess
import sys

mode = sys.argv[1]
assert mode in ('plan', 'apply')
server = Path(__file__).resolve().parents[1]
source = (server / 'tools/stock-exchange-deleted-test-cleanup.mjs').read_text()
command = ['sudo', '-n', 'docker', 'exec', '-i', '-w', '/app', 'mbbs-operator-app-app-1',
    'node', '--input-type=module', '-'] + (['--apply'] if mode == 'apply' else [])
result = subprocess.run(command, input=source.replace("'../src/", "'./src/"), text=True, capture_output=True)
if result.returncode:
    print(result.stdout)
    print(result.stderr)
    raise SystemExit(result.returncode)
report = json.loads(result.stdout.strip().splitlines()[-1])
audit = {'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'mode': mode,
    'sourceHash': hashlib.sha256(source.encode()).hexdigest(), 'result': report,
    'authorization': 'User explicitly approved cleanup of SE-000001 and its deleted IT00582 transfer link.'}
out = server / 'deployments/return-exchange-layout-20261029'
out.mkdir(parents=True, exist_ok=True)
(out / f'se000001-cleanup-{mode}.json').write_text(json.dumps(audit, indent=2) + '\n')
print(json.dumps(audit))
