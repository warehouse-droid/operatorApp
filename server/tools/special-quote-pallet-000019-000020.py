from pathlib import Path
import base64
import json
import subprocess
import sys

server = Path(__file__).resolve().parents[1]
source = (server / 'tools/special-quote-pallet-000019-000020.mjs').read_text()
source = source.replace("from '../src/", "from 'file:///app/src/")
parser = base64.b64encode((server / 'test/field-sales/pdf-text.js').read_bytes()).decode()
source = source.replace("import { pdfText } from '../test/field-sales/pdf-text.js';", f"const {{pdfText}}=await import('data:text/javascript;base64,{parser}');")
apply = '--apply' in sys.argv
command = ['sudo', '-n', 'docker', 'exec', '-i', '-w', '/app', 'mbbs-operator-app-app-1', 'node', '--input-type=module', '-']
if apply:
    command.append('--apply')
result = subprocess.run(command, input=source.encode(), capture_output=True)
if result.returncode:
    print(result.stderr.decode(), end='')
    raise SystemExit(result.returncode)
report = json.loads(result.stdout)
output = server / 'test-artifacts/special-quote-pallet-000019-000020-20261001'
output.mkdir(parents=True, exist_ok=True)
(output / ('applied.json' if apply else 'preflight.json')).write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
