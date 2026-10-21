"""Scoped repair runner; private evidence is retained without printing source records."""
import base64
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
OUT = Path('/home/ubuntu/operatorapp-investigations/order-fulfillment-repair-20261003')
os.umask(0o077)
mode = sys.argv[1]
assert mode in ['snapshot', 'rehearse', 'apply', 'verify']
def module(name, replacements=None):
    source = (ROOT/name).read_text().replace("'/app/", "'file:///app/")
    for old,new in (replacements or {}).items():
        source = source.replace(old,new)
    return 'data:text/javascript;base64,' + base64.b64encode(source.encode()).decode()
evidence = module('evidence.mjs')
repair = module('repair.mjs', {'./evidence.mjs':evidence})
source = (ROOT/'run.mjs').read_text().replace('./repair.mjs',repair)
result = subprocess.run(['docker','exec','-i','-e','INCIDENT_REPAIR_MODE='+mode,'mbbs-operator-app-app-1','node','--input-type=module'], input=source, text=True, capture_output=True, timeout=240)
(OUT/(mode+'.stderr')).write_text(result.stderr)
if result.returncode:
    # Inline module URLs can be large. Preserve details privately and print only useful lines.
    lines = [line for line in result.stderr.splitlines() if len(line)<1800]
    print('\n'.join(lines[-35:]))
    raise SystemExit(result.returncode)
report = json.loads(result.stdout)
(OUT/(mode+'.json')).write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({key:report[key] for key in ['mode','result','repeated','verified','views','rollbackVerified','recordWrites'] if key in report},indent=2))
