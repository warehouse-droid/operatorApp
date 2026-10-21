"""Bounded disposable Compose validation for date-plan editor controls."""
from pathlib import Path
import json
import hashlib
import os
import signal
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
OUT = SERVER / 'test-artifacts/dispatch-editor-control-20261015'
MODE = sys.argv[1] if len(sys.argv) > 1 else 'all'
PROJECT = 'mbbs-editor-control-' + str(os.getpid())
OUT.mkdir(parents=True, exist_ok=True)
ARTIFACTS = OUT / MODE
if ARTIFACTS.exists():
    ARTIFACTS.rename(OUT / (MODE + '-attempt-' + str(os.getpid())))
ARTIFACTS.mkdir(parents=True, exist_ok=True)
docker = ['sudo', '-n', 'docker']
mounts = [f'{SERVER / name}:/app/{name}:ro' for name in
          ['src', 'public', 'migrations', 'test', 'tools', 'contracts', 'package.json', 'package-lock.json', 'eslint.mbt.config.js', '.env.example']]
mounts += [f'{SERVER / "test-artifacts/mbr-contract/toolchain/node_modules"}:/app/node_modules:ro',
           f'{SERVER / "test-artifacts/mbr-contract/playwright-browsers"}:/ms-playwright:ro',
           f'{ROOT}:/workspace:ro', f'{ARTIFACTS}:/app/test-artifacts']
override = OUT / ('compose.' + MODE + '.json')
labels = {'com.mbbs.lifecycle': 'disposable-test', 'com.mbbs.task': PROJECT}
runtime_files = json.loads((OUT / 'runtime-files.json').read_text())
def source_hashes():
    source_root = OUT / 'candidate-source' if MODE == 'candidate' else SERVER
    return {name: hashlib.sha256((source_root / name).read_bytes()).hexdigest() for name in runtime_files}
before_hashes = source_hashes()
image = 'mbbs-operator-app:mbt-bin-cancellation-browser-test-20261015'
candidate = OUT / 'candidate-source'
if MODE == 'candidate':
    prepared = json.loads((OUT / 'prepared.json').read_text())
    image = prepared['testImage']
    assert before_hashes == prepared['sourceHashes'], 'Candidate source differs from the prepared image'
    assert (candidate / 'package.json').is_file(), 'Prepared candidate source is missing'
    mounts = [m for m in mounts if not any(m.endswith(f':/app/{name}:ro') for name in ['src', 'public', 'migrations', 'package.json', 'package-lock.json'])]
    mounts += [f'{candidate / name}:/app/{name}:ro' for name in ['src', 'public', 'migrations', 'package.json', 'package-lock.json']]
override.write_text(json.dumps({'services': {
    'db': {'image': 'postgres:18-alpine', 'pull_policy': 'never', 'labels': labels},
    'test': {'image': image, 'pull_policy': 'never', 'user': f'{os.getuid()}:{os.getgid()}',
             'entrypoint': [], 'working_dir': '/app', 'labels': labels, 'volumes': mounts,
             'environment': {'PLAYWRIGHT_BROWSERS_PATH': '/ms-playwright'}}}}, indent=2))
compose = docker + ['compose', '--profile', 'tools', '-p', PROJECT, '--project-directory', str(ROOT),
                    '-f', str(ROOT / 'docker-compose.mbt-test.yml'), '-f', str(override)]

def run(label, args, timeout=900):
    with (ARTIFACTS / (label + '.log')).open('w') as output:
        result = subprocess.run(args, cwd=ROOT, stdout=output, stderr=subprocess.STDOUT, timeout=timeout)
    print(json.dumps({'stage': label, 'exit': result.returncode}), flush=True)
    if result.returncode:
        print((ARTIFACTS / (label + '.log')).read_text()[-12000:], flush=True)
    return result.returncode

def interrupted(_signal, _frame):
    raise KeyboardInterrupt('Removing disposable editor-control tests')

signal.signal(signal.SIGINT, interrupted)
signal.signal(signal.SIGTERM, interrupted)
code = 1
try:
    config = json.loads(subprocess.check_output(compose + ['config', '--format', 'json']))
    for name in ['db', 'test']:
        service = config['services'][name]
        assert service['cgroup_parent'] == 'mbbs-tests.slice' and service['init']
        assert 0 < int(service['mem_limit']) <= 2 * 1024**3 and service['memswap_limit'] == service['mem_limit']
        assert 0 < service['pids_limit'] <= 512 and service['cpus']
        assert all('size=' in item for item in service['tmpfs'])
    assert run('start', compose + ['up', '-d', '--wait', '--no-build', '--pull', 'never', 'db']) == 0
    assert run('migrate', compose + ['run', '--rm', '--no-deps', '-T', 'test', 'npm', 'run', 'migrate']) == 0
    code = run('checks', compose + ['run', '--rm', '--no-deps', '-T', 'test', 'node', 'tools/dispatch-editor-control-suite.mjs', MODE])
finally:
    teardown = run('teardown', compose + ['down', '--volumes', '--remove-orphans'], timeout=120)
    def output(args):
        return subprocess.check_output(docker + args, text=True).strip()
    residual = output(['ps', '-a', '--filter', 'label=com.mbbs.task=' + PROJECT, '--format', '{{.ID}}']).split()
    if residual:
        run('remove-oneoffs', docker + ['rm', '-f', '-v', *residual], timeout=120)
        teardown = run('teardown-final', compose + ['down', '--volumes', '--remove-orphans'], timeout=120)
    cleanup = {'exit': teardown,
        'dockerPs': output(['ps', '--format', '{{.Names}} {{.Status}}']),
        'dockerPsA': output(['ps', '-a', '--format', '{{.Names}} {{.Status}}']),
        'containers': output(['ps', '-a', '--filter', 'label=com.mbbs.task=' + PROJECT, '--format', '{{.Names}}']),
        'networks': output(['network', 'ls', '--filter', 'label=com.docker.compose.project=' + PROJECT, '--format', '{{.Name}}']),
        'volumes': output(['volume', 'ls', '--filter', 'label=com.docker.compose.project=' + PROJECT, '--format', '{{.Name}}'])}
    (ARTIFACTS / 'cleanup.json').write_text(json.dumps(cleanup, indent=2))
    assert teardown == 0 and not any(cleanup[key] for key in ['containers', 'networks', 'volumes'])
    health = subprocess.run(['curl', '-fsS', '--max-time', '15', 'http://127.0.0.1:3000/health'], capture_output=True, text=True)
    (ARTIFACTS / 'production-health.json').write_text(health.stdout or health.stderr)
    assert health.returncode == 0
    assert source_hashes() == before_hashes, 'Runtime source changed during checks'
    (OUT / ('validation.' + MODE + '.json')).write_text(json.dumps({
        'passed': code == 0, 'cleanupVerified': True, 'sourceHashes': before_hashes}, indent=2))
raise SystemExit(code)
