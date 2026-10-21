"""Run only the explicitly authorized Special Item operational corrections."""
from pathlib import Path
import re
import subprocess
import sys

server = Path(__file__).resolve().parents[1]
target, mode = sys.argv[1:]
assert target in ('000007', '000009') and mode in ('preflight', 'apply', 'verify', 'check')
if target == '000007':
    source = (server / 'tools/special-workflow-discount-convert-000007.mjs').read_text()
else:
    source = subprocess.check_output(['sudo', '-n', 'docker', 'exec', 'mbbs-operator-app-app-1', 'cat', '/app/src/netsuite.js']).decode()
    source = re.sub(r'((?:from\s+|import\s*\()\s*)([\'"])(\./[^\'"]+)\2',
                    lambda m: m[1] + m[2] + 'file:///app/src/' + m[3][2:] + m[2], source)
    source += (server / 'tools/special-workflow-rest-orders-recover-000009.mjs').read_text()
result = subprocess.run(['sudo', '-n', 'docker', 'exec', '-i', '-w', '/app', 'mbbs-operator-app-app-1', 'node',
                         *(['--check'] if mode == 'check' else []), '--input-type=module', '-', mode], input=source.encode())
raise SystemExit(result.returncode)
