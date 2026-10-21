"""Run the exact, user-confirmed existing-SO reference recovery and keep audit evidence."""
import json
from datetime import datetime, timezone
from pathlib import Path
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[2]
OUT = SERVER / 'test-artifacts/special-so-preview-20261006'
PRIVATE = Path('/home/ubuntu/operatorapp-investigations/special-so-preview-20261006/private')
PRIVATE.mkdir(parents=True, exist_ok=True, mode=0o700)
PRIVATE.chmod(0o700)
mode = sys.argv[1]
assert mode in ['preflight', 'apply']
approved = json.loads((OUT / 'live-before.json').read_text())
assert approved['requestRef'] == 'SPREQ-000030' and approved['orderRef'] == 'SOB122131'
script = (SERVER / 'tools/special-so-preview-20261006/recover.mjs').read_text().replace(
    'const approved = APPROVED_SNAPSHOT;', 'const approved = ' + json.dumps(approved) + ';')
result = subprocess.run(['docker', 'exec', '-i', '-w', '/app', 'mbbs-operator-app-app-1', 'node', '--input-type=module', '-', mode],
                        input=script, capture_output=True, text=True)
(OUT / ('recovery-' + mode + '.log')).write_text(result.stdout + result.stderr)
print(result.stdout or result.stderr, flush=True)
try:
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = subprocess.run(['docker', 'cp', 'mbbs-operator-app-app-1:/tmp/special-so-000030-recovery-before.json',
                             str(PRIVATE / ('before-' + mode + '-' + stamp + '.json'))], capture_output=True)
    if result.returncode:
        raise SystemExit(result.returncode)
    backup.check_returncode()
    if mode == 'apply' and result.returncode == 0:
        subprocess.run(['docker', 'cp', 'mbbs-operator-app-app-1:/tmp/special-so-000030-preview.pdf',
                        str(PRIVATE / 'SOB122131.pdf')], check=True, capture_output=True)
finally:
    subprocess.run(['docker', 'exec', 'mbbs-operator-app-app-1', 'rm', '-f',
                    '/tmp/special-so-000030-recovery-before.json', '/tmp/special-so-000030-preview.pdf'], check=True, capture_output=True)
raise SystemExit(result.returncode)
