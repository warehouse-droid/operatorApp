"""Run the user-authorized Custom/-15% REST test on SOB121380 only."""
from pathlib import Path
import hashlib
import json
import re
import subprocess
import sys

server = Path(__file__).resolve().parents[1]
mode = sys.argv[1]
if mode == 'evidence':
    names = ['SOB121380-rest-percent', 'SOB121380-rest-percent-numeric', 'SOB121380-rest-percent-amount']
    script = "const fs=require('node:fs');const names=" + json.dumps(names) + ";const out={};for(const name of names){for(const suffix of ['-before.private.json','-result.json']){out[name+suffix]=fs.readFileSync('/tmp/'+name+suffix,'utf8');}}process.stdout.write(JSON.stringify(out));"
    saved = subprocess.run(['sudo', '-n', 'docker', 'exec', '-i', 'mbbs-operator-app-app-1', 'node', '-'],
                           input=script.encode(), capture_output=True, check=True)
    destination = server / 'test-artifacts/special-workflow-review/rest-percent'
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    for name, contents in json.loads(saved.stdout).items():
        target = destination / name
        target.write_text(contents)
        target.chmod(0o600)
    files = [Path(__file__), server / 'tools/special-workflow-rest-percent-probe.mjs',
             server / 'test/special-workflow-rest-orders-spec.md']
    hashes = {str(path.relative_to(server)): hashlib.sha256(path.read_bytes()).hexdigest() for path in files}
    (destination / 'source-manifest.json').write_text(json.dumps(hashes, indent=2) + '\n')
    print(json.dumps({'archived': True, 'directory': str(destination), 'sourceFiles': len(hashes)}))
    raise SystemExit(0)
assert mode in ('prepare', 'apply', 'verify', 'prepare-numeric', 'apply-numeric', 'verify-numeric',
                'prepare-amount', 'apply-amount', 'verify-amount', 'check')
source = (server / 'src/netsuite.js').read_text()
source = re.sub(r'from ([\'"])(\./[^\'"]+)\1', lambda m: 'from ' + m[1] + 'file:///app/src/' + m[2][2:] + m[1], source)
source += (server / 'tools/special-workflow-rest-percent-probe.mjs').read_text().replace('PROBE_MODE', repr(mode))
result = subprocess.run(['sudo', '-n', 'docker', 'exec', '-i', '-w', '/app', 'mbbs-operator-app-app-1', 'node',
                         *(['--check'] if mode == 'check' else []), '--input-type=module', '-'], input=source.encode())
raise SystemExit(result.returncode)
