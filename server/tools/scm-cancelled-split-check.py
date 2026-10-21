"""Standard isolated Compose test runner; disposable DB and containers always removed."""
import json
import hashlib
import os
from pathlib import Path
import signal
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / 'server'
MODE = sys.argv[1]
assert MODE in ['red', 'red-recheck', 'final']
OUT = SERVER / 'test-artifacts/scm-cancelled-split-20261008' / MODE
RELEASE = SERVER / 'deployments/scm-cancelled-split-20261008'
TREE = RELEASE / ('before' if MODE.startswith('red') else 'candidate')
OUT.mkdir(parents=True, exist_ok=True)
os.chmod(OUT, 0o777)
def source_state():
    return {str(path.relative_to(TREE)): hashlib.sha256(path.read_bytes()).hexdigest()
            for folder in ['src', 'public', 'migrations'] for path in sorted((TREE / folder).rglob('*')) if path.is_file()}


source_before = source_state()
(OUT / 'source-state.json').write_text(json.dumps(source_before, indent=2) + '\n')
volumes = [f'{TREE / folder}:/app/{folder}:ro' for folder in ['src', 'public', 'migrations']]
volumes += [f'{SERVER / folder}:/app/{folder}:ro' for folder in ['test', 'tools']]
volumes += [f'{TREE / "package.json"}:/app/package.json:ro', f'{OUT}:/app/test-artifacts',
            f'{SERVER / "eslint.mbt.config.js"}:/app/eslint.mbt.config.js:ro',
            f'{RELEASE / "before"}:/baseline:ro']
if MODE == 'final':
    volumes += [f'{OUT.parent / "red"}:/red:ro']
service = {'image': 'mbbs-delivery-requests:static', 'pull_policy': 'never', 'volumes': volumes,
           'labels': {'com.mbbs.lifecycle': 'disposable-test'}}
override = OUT / 'compose.json'
override.write_text(json.dumps({'services': {'test': service, 'migrate': service,
    'db': {'labels': {'com.mbbs.lifecycle': 'disposable-test'}}}}))
compose = ['docker', 'compose', '--project-directory', str(ROOT), '-p', 'mbbs-cancelled-split-' + MODE,
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
    run('migrate', compose + ['run', '--rm', 'migrate', 'node', 'src/migrate.js'])
    run('checks', compose + ['run', '--rm', 'test', 'node', 'tools/scm-cancelled-split-gauntlet.mjs', MODE])
finally:
    with (OUT / 'teardown.log').open('wb') as output:
        subprocess.run(compose + ['down', '--volumes', '--remove-orphans'], stdout=output, stderr=subprocess.STDOUT, check=True)
    for args, name in [(['ps'], 'docker-ps.log'), (['ps', '-a'], 'docker-ps-a.log')]:
        (OUT / name).write_bytes(subprocess.check_output(['docker', *args, '--format', '{{.Names}} {{.Status}}']))
    remaining = subprocess.check_output(['docker', 'ps', '-a', '--filter', 'label=com.docker.compose.project=mbbs-cancelled-split-' + MODE, '--format', '{{.ID}}'])
    assert not remaining.strip(), 'Test containers remain'
    health = subprocess.check_output(['docker', 'exec', 'mbbs-operator-app-app-1', 'node', '-e', "fetch('http://127.0.0.1:3000/health').then(async r=>{if(!r.ok||!(await r.json()).ok)process.exit(1)})"])
    print('Isolated test containers, volumes and network removed; production health passed', flush=True)
    assert source_state() == source_before, 'Candidate changed during verification'
