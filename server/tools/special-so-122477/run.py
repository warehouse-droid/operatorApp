"""Capture live SO/request evidence privately and print only a concise summary."""
import datetime
import json
import os
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[3]
STATE = pathlib.Path('/home/ubuntu/operatorapp-deploy-backups/special-so-122477-20261010')
os.umask(0o077)
STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
mode = sys.argv[1]
assert mode in ['inspect', 'preflight', 'recover', 'verify']
name = 'inspect' if mode == 'inspect' else 'recover'
program = (pathlib.Path(__file__).parent / f'{name}.mjs').read_text()
result = subprocess.run(['sudo','-n','docker','exec','-i','-e',f'SO122477_RECOVERY_MODE={mode}','-w','/app','mbbs-operator-app-app-1',
                         'node','--input-type=module'], input=program, text=True, capture_output=True)
stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
(STATE / f'{mode}-{stamp}.private.log').write_text(result.stdout + result.stderr)
if result.returncode:
    print(json.dumps({'failed': True, 'mode': mode, 'savedPrivateLog': str(STATE / f'{mode}-{stamp}.private.log')}))
    sys.exit(result.returncode)
data = None
for line in reversed(result.stdout.splitlines()):
    try:
        value = json.loads(line)
    except json.JSONDecodeError:
        continue
    if isinstance(value,dict) and value.get('kind','').startswith('special-so-122477-'):
        data = value
        break
assert data is not None, 'Expected structured evidence; private logs retained.'
(STATE / f'{mode}-{stamp}.private.json').write_text(json.dumps(data,indent=2)+'\n')
print(json.dumps(data['summary']))
