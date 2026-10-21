"""Apply the authorized local unit correction after its isolated database checks."""
from pathlib import Path
import hashlib
import json
import subprocess

TASK = Path(__file__).resolve().parent
SERVER = TASK.parents[1]
OUT = SERVER / 'test-artifacts/som06964-release-20261015'
checks = json.loads((OUT / 'green.json').read_text())
assert checks['exit'] == 0 and checks['fail'] == 0 and checks['tests'] >= 12
cleanup = json.loads((OUT / 'cleanup-green.json').read_text())
assert cleanup['productionHealthy'] and not cleanup['ownTestContainers']
for file, expected in json.loads((TASK / 'hold-tested-inputs.json').read_text()).items():
    assert hashlib.sha256((SERVER / file).read_bytes()).hexdigest() == expected
sql = (SERVER / 'migrations/292_sales_order_line_sync_holds.sql').read_text()
assert sql == (TASK / 'candidate/migrations/292_sales_order_line_sync_holds.sql').read_text()
source = 'const verifiedHoldMigration = ' + json.dumps(sql) + ';\n' + (TASK / 'correct-unit.mjs').read_text()
result = subprocess.run(['sudo', '-n', 'docker', 'exec', '-i', '-w', '/app', 'mbbs-operator-app-app-1',
                         'node', '--input-type=module'], input=source.encode(), capture_output=True, timeout=100)
(OUT / 'unit-correction.stderr.log').write_bytes(result.stderr)
if result.returncode:
    print(result.stderr.decode()[-4000:])
    raise SystemExit(result.returncode)
data = json.loads(result.stdout)
(OUT / 'unit-correction.json').write_text(json.dumps(data, indent=2) + '\n')
print(json.dumps({k: v for k, v in data.items() if k not in ['before', 'after']}))
