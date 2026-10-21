"""Stream the minimal read-only history fixture; never print raw captured data."""
import hashlib
import json
from pathlib import Path
import subprocess

TASK = Path(__file__).resolve().parent
OUT = TASK.parents[1] / 'test-artifacts/po-line-identity-20261015'
destination = OUT / 'history-fixture.jsonl'
assert not destination.exists(), 'Retain the original capture; do not overwrite it'
with destination.open('wb') as output, (OUT / 'history-capture.log').open('wb') as errors:
    result = subprocess.run(['sudo', '-n', 'docker', 'exec', '-i', 'mbbs-operator-app-app-1',
        'node', '--input-type=module'], input=(TASK / 'history-capture.mjs').read_bytes(),
        stdout=output, stderr=errors)
assert result.returncode == 0, (OUT / 'history-capture.log').read_text()
last = None
with destination.open() as source:
    for line in source:
        last = json.loads(line)
assert last and last['kind'] == 'end' and last['complete'] is True
metadata = {'sha256': hashlib.file_digest(destination.open('rb'), 'sha256').hexdigest(),
    'bytes': destination.stat().st_size, **last}
(OUT / 'history-capture.json').write_text(json.dumps(metadata, indent=2) + '\n')
print(json.dumps(metadata), flush=True)
