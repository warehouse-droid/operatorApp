"""Apply the two verified static assets, with preconditions and backups."""
import hashlib
import json
from pathlib import Path
import subprocess
from urllib.request import urlopen

REPO = Path(__file__).resolve().parents[2]
BACKUP = Path('/home/ubuntu/operatorapp-deploy-backups/split-target-20260915')
CONTAINER = 'mbbs-operator-app-app-1'
FILES = ['dispatch.js', 'dispatch.html']
manifest = json.loads((BACKUP / 'hashes.json').read_text())
checks = json.loads((REPO / 'server/test-artifacts/split-target/checks.json').read_text())


def run(*args):
    return subprocess.check_output(args, text=True)


def runtime_hashes():
    result = run('docker', 'exec', CONTAINER, 'sha256sum', *[f'/app/public/{name}' for name in FILES])
    return {Path(line.split()[1]).name: line.split()[0] for line in result.splitlines()}


for filename in FILES:
    candidate_hash = hashlib.sha256((BACKUP / 'runtime-after' / filename).read_bytes()).hexdigest()
    assert candidate_hash == manifest['runtime-after'][filename]
    assert candidate_hash == checks['hashes'][f'public/{filename}']
assert runtime_hashes() == manifest['runtime-before'], 'Running assets changed; rebase before applying.'

for filename in FILES:
    run('docker', 'cp', str(BACKUP / 'runtime-after' / filename),
        f'{CONTAINER}:/app/public/.{filename}.split-target')

run('docker', 'exec', CONTAINER, 'node', '--input-type=module', '-e', '''
import { readFileSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
const manifest = JSON.parse(process.argv[1]);
const hash = file => createHash("sha256").update(readFileSync(file)).digest("hex");
for (const name of ["dispatch.js", "dispatch.html"]) {
  if (hash(`/app/public/${name}`) !== manifest["runtime-before"][name]
      || hash(`/app/public/.${name}.split-target`) !== manifest["runtime-after"][name]) {
    throw new Error("Dispatch assets changed before installation.");
  }
}
for (const name of ["dispatch.js", "dispatch.html"]) {
  renameSync(`/app/public/.${name}.split-target`, `/app/public/${name}`);
}
''', json.dumps(manifest))

assert runtime_hashes() == manifest['runtime-after']
with urlopen('http://127.0.0.1:3000/dispatch.js?split-target=20260915-v1') as response:
    assert response.status == 200
    assert hashlib.sha256(response.read()).hexdigest() == manifest['runtime-after']['dispatch.js']
with urlopen('http://127.0.0.1:3000/dispatch/planning') as response:
    planner_status = response.status
    assert planner_status == 200
    assert hashlib.sha256(response.read()).hexdigest() == manifest['runtime-after']['dispatch.html']
with urlopen('http://127.0.0.1:3000/health') as response:
    assert response.status == 200
    health = json.loads(response.read())
result = {'installed': manifest['runtime-after'], 'plannerStatus': planner_status, 'health': health}
(BACKUP / 'deployment-result.json').write_text(json.dumps(result, indent=2))
print(json.dumps(result))
