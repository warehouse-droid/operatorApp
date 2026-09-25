"""Read-only discovery of current SOR deliveries and NetSuite item metadata."""
import base64
import json
from pathlib import Path
import subprocess
root=Path(__file__).resolve().parents[1]
source=(root/'tools/sor-rentals-live-read.mjs').read_text()
policy='data:text/javascript;base64,'+base64.b64encode((root/'src/sor-rental-policy.js').read_bytes()).decode()
source=source.replace("/* SOR_POLICY_MODULE */ ''",json.dumps(policy))
result=subprocess.run(['sudo','-n','docker','exec','-i','mbbs-operator-app-app-1','node','--input-type=module'],input=source,text=True,capture_output=True)
if result.returncode:
    print(result.stderr)
    raise SystemExit(result.returncode)
data=json.loads(result.stdout)
(root/'test-artifacts/sor-rentals/live-preflight.json').write_text(json.dumps(data,indent=2))
print(json.dumps({key:value for key,value in data.items() if key!='metadata'},indent=2))
