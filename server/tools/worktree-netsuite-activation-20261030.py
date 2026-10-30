"""Read-only NetSuite activation/version inventory, using existing application auth."""
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / 'server'
entries = []
for file in sorted([*SERVER.glob('netsuite*.js'), *(SERVER / 'netsuite/pallet-payment').glob('ppa_*.js')]):
    kind = re.search(r'@NScriptType\s+(\w+)', file.read_text())
    entries.append({'path': str(file.relative_to(SERVER)), 'name': file.name.lower(),
                    'type': kind[1] if kind else 'library'})
result = subprocess.run(['docker', 'exec', '-i', '-w', '/app', 'mbbs-operator-app-app-1',
    'node', '--input-type=module', '-', json.dumps(entries)],
    input=(SERVER / 'tools/worktree-netsuite-activation-20261030.mjs').read_bytes(),
    capture_output=True, timeout=180, check=True)
report = json.loads(result.stdout.decode().splitlines()[-1])
path = SERVER / 'test/whole-worktree-deployment-20261030-netsuite.json'
path.write_text(json.dumps(report, indent=2) + '\n')
path.chmod(0o644)
print(json.dumps({'metadata': report.get('metadata'), 'endpoints': report['endpoints'],
    'inventory': [{'path': row['path'], 'status': row['status']} for row in report['inventory']]}))
