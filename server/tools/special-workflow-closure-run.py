"""Run only the existing SCM-confirmed SPREQ-000007 closure review."""
from pathlib import Path
import re
import subprocess
import sys

mode = sys.argv[1]
assert mode in ('preflight', 'apply', 'verify', 'check')
source = subprocess.check_output(['sudo', '-n', 'docker', 'exec', 'mbbs-operator-app-app-1', 'cat', '/app/src/netsuite.js']).decode()
source = re.sub(r'((?:from\s+|import\s*\()\s*)([\'"])(\./[^\'"]+)\2',
                lambda m: m[1] + m[2] + 'file:///app/src/' + m[3][2:] + m[2], source)
source += Path(__file__).with_name('special-workflow-closure-retry-000007.mjs').read_text()
result = subprocess.run(['sudo', '-n', 'docker', 'exec', '-i', '-w', '/app', 'mbbs-operator-app-app-1',
                         'node', *(['--check'] if mode == 'check' else []), '--input-type=module', '-', mode], input=source.encode())
raise SystemExit(result.returncode)
