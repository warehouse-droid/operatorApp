"""Capture the current deployed baseline for the scoped REST order correction."""
from pathlib import Path
import json
import subprocess

server = Path(__file__).resolve().parents[1]
out = server / 'test-artifacts/special-workflow-review/rest-orders'
files = ['public/special-stock-pricing.js', 'src/special-stock-request-netsuite.js',
         'src/special-stock-adjustment-adapter.js', 'src/special-stock-rest-orders.js',
         'src/netsuite.js', 'src/special-stock-request-service.js', 'src/special-stock-request-repository.js']
out.mkdir(parents=True, exist_ok=False)
for file in files:
    result = subprocess.run(['sudo', '-n', 'docker', 'exec', 'mbbs-operator-app-app-1', 'cat', '/app/' + file], capture_output=True)
    if file == 'src/special-stock-rest-orders.js':
        assert result.returncode != 0
        continue
    assert result.returncode == 0
    target = out / 'baseline' / file
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(result.stdout)
(out / 'runtime-files.json').write_text(json.dumps(files, indent=2) + '\n')
print(json.dumps({'captured': True, 'files': len(files) - 1}))
