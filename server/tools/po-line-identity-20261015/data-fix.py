"""Preview or apply the exact, audited retired-group PO-link repair."""
import json
from pathlib import Path
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[2]
TASK = Path(__file__).resolve().parent
OUT = SERVER / 'deployments/retired-group-po-links-20261015'
OUT.mkdir(parents=True, exist_ok=True)
mode = sys.argv[1]
assert mode in ['preview', 'apply']
args = ['sudo', '-n', 'docker', 'exec', '-i', '-e', 'RETIRED_PO_FIX_MODE=' + mode]
if mode == 'apply':
    preview = json.loads((OUT / 'preview.json').read_text())
    args += ['-e', 'RETIRED_PO_FIX_HASH=' + preview['beforeHash']]
result = subprocess.check_output(args + ['mbbs-operator-app-app-1', 'node', '--input-type=module'],
    input=(TASK / 'remove-retired-links.mjs').read_bytes())
data = json.loads(result)
(OUT / (mode + '.json')).write_text(json.dumps(data, indent=2) + '\n')
print(json.dumps({key: value for key, value in data.items() if key != 'before'}), flush=True)
