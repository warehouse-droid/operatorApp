"""Standard isolated Compose test runner; disposable DB and containers always removed."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / 'server'
MODE = sys.argv[1]
assert MODE in ['red', 'final', 'probe', 'proofs']
OUT = SERVER / 'test-artifacts/regular-stock-so-scope-20261008' / MODE
RELEASE = SERVER / 'deployments/regular-stock-so-scope-20261008'
TREE = RELEASE / ('before' if MODE in ['red', 'probe'] else 'candidate')
OUT.mkdir(parents=True, exist_ok=True)
os.chmod(OUT, 0o777)
volumes = [f'{TREE / folder}:/app/{folder}:ro' for folder in ['src', 'public', 'migrations']]
volumes += [f'{SERVER / folder}:/app/{folder}:ro' for folder in ['test', 'tools']]
volumes += [f'{TREE / "package.json"}:/app/package.json:ro', f'{OUT}:/app/test-artifacts',
            f'{SERVER / "eslint.mbt.config.js"}:/app/eslint.mbt.config.js:ro',
            f'{RELEASE / "before"}:/baseline:ro']
if MODE in ['final', 'proofs']:
    volumes += [f'{OUT.parent / "red"}:/red:ro']
if MODE == 'proofs':
    volumes += [f'{OUT.parent / "final"}:/final:ro']
service = {'image': 'mbbs-delivery-requests:static', 'pull_policy': 'never', 'volumes': volumes,
           'labels': {'com.mbbs.lifecycle': 'disposable-test'}}
override = OUT / 'compose.json'
override.write_text(json.dumps({'services': {'test': service, 'migrate': service,
    'db': {'labels': {'com.mbbs.lifecycle': 'disposable-test'}}}}))
compose = ['docker', 'compose', '--project-directory', str(ROOT), '-p', 'mbbs-so-scope-' + MODE,
           '-f', str(ROOT / 'docker-compose.mbt-test.yml'), '-f', str(override)]


def run(name, args, expected=0):
    with (OUT / (name + '.log')).open('wb') as output:
        result = subprocess.run(args, cwd=ROOT, stdout=output, stderr=subprocess.STDOUT)
    print(json.dumps({'layer': name, 'exitCode': result.returncode}), flush=True)
    if result.returncode != expected:
        print((OUT / (name + '.log')).read_text()[-8000:], flush=True)
        raise RuntimeError(name + ' failed')


def stop(_signal, _frame):
    raise KeyboardInterrupt()


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    # Teardown is registered before the first container starts.
    if MODE == 'probe':
        run('toolchain', compose + ['run', '--rm', '--no-deps', 'test', 'node', '--input-type=module', '-e',
            "import fs from 'node:fs';console.log(process.version);for(const name of ['fast-check','c8','eslint','typescript','playwright']){try{console.log(name,JSON.parse(fs.readFileSync('node_modules/'+name+'/package.json')).version)}catch{console.log(name,'unavailable')}}"])
    else:
        run('migrate', compose + ['run', '--rm', 'migrate', 'node', 'src/migrate.js'])
        script = 'tools/regular-stock-so-scope-proofs.mjs' if MODE == 'proofs' else 'tools/regular-stock-so-scope-gauntlet.mjs'
        run('checks', compose + ['run', '--rm', 'test', 'node', script, MODE])
finally:
    with (OUT / 'teardown.log').open('wb') as output:
        subprocess.run(compose + ['down', '--volumes', '--remove-orphans'], stdout=output, stderr=subprocess.STDOUT, check=True)
    for args, name in [(['ps'], 'docker-ps.log'), (['ps', '-a'], 'docker-ps-a.log')]:
        (OUT / name).write_bytes(subprocess.check_output(['docker', *args, '--format', '{{.Names}} {{.Status}}']))
    print('Isolated test containers, volumes and network removed', flush=True)
