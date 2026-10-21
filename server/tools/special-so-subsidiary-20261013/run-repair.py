"""Perform the explicitly authorized customer correction and normal SO creation."""
from pathlib import Path
import json
import subprocess
import time

SERVER = Path(__file__).resolve().parents[2]
OUT = SERVER / 'test-artifacts/special-so-subsidiary-20261013'
script = Path(__file__).with_name('repair-79.mjs').read_text()
if (OUT / 'repair.log').exists():
    (OUT / 'repair.log').rename(OUT / ('repair-attempt-' + str(time.time_ns()) + '.log'))
with (OUT / 'repair.log').open('w') as log:
    result = subprocess.run(['sudo', '-n', 'docker', 'exec', '-i', 'mbbs-operator-app-app-1',
                             'node', '--input-type=module'], input=script, text=True,
                            stdout=log, stderr=subprocess.STDOUT, timeout=180)
print((OUT / 'repair.log').read_text(), flush=True)
if result.returncode:
    raise SystemExit(result.returncode)
records = [json.loads(line) for line in (OUT / 'repair.log').read_text().splitlines() if line.startswith('{')]
assert records[-1]['success'] is True
(OUT / 'result.json').write_text(json.dumps(records[-1], indent=2) + '\n')
