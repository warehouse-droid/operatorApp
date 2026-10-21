"""Run only the specifically user-authorized local close; transport is read-only."""
from pathlib import Path
import subprocess
import sys

server=Path(__file__).resolve().parents[1]
mode=sys.argv[1]
assert mode in ('preflight','apply','verify')
source=(server/'tools/special-local-closure-000011.mjs').read_text().replace("from '../src/","from 'file:///app/src/")
result=subprocess.run(['sudo','-n','docker','exec','-i','-w','/app','mbbs-operator-app-app-1',
    'node','--input-type=module','-',mode],input=source.encode())
raise SystemExit(result.returncode)
