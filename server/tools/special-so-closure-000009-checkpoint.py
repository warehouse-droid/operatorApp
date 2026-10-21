"""Preserve the immutable case-64 recovery checkpoint across a scoped app release."""
from pathlib import Path
import hashlib
import json
import subprocess
import sys

remote = '/tmp/special-so-only-closure-000009.private.json'
local = Path(__file__).resolve().parents[1] / 'test-artifacts/special-operation-progress/closure-checkpoint.private.json'
mode = sys.argv[1]
assert mode in ('backup', 'restore')
if mode == 'backup':
    data = subprocess.check_output(['sudo', '-n', 'docker', 'exec', 'mbbs-operator-app-app-1', 'cat', remote])
    if local.exists():
        assert local.read_bytes() == data
    else:
        local.touch(mode=0o600, exist_ok=False)
        local.write_bytes(data)
else:
    data = local.read_bytes()
    checkpoint = json.loads(data)
    assert checkpoint['plan']['orders'][0]['id'] == 1017268
    script = "const fs=require('fs');const data=fs.readFileSync(0),path='/tmp/special-so-only-closure-000009.private.json';if(fs.existsSync(path)){require('assert').deepStrictEqual(fs.readFileSync(path),data);}else fs.writeFileSync(path,data,{mode:0o600,flag:'wx'});"
    subprocess.run(['sudo', '-n', 'docker', 'exec', '-i', 'mbbs-operator-app-app-1', 'node', '-e', script], input=data, check=True)
print(json.dumps({'checkpoint': mode, 'sha256': hashlib.sha256(data).hexdigest()}))
