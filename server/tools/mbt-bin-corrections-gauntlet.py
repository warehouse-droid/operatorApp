"""Run BIN corrections in the repository's bounded disposable Compose project."""
import json
import hashlib
import os
from pathlib import Path
import signal
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
REPO = SERVER.parent
OUT = SERVER / 'test-artifacts/mbt-bin-corrections-20261015'
MODE = sys.argv[1] if len(sys.argv) > 1 else 'all'
runtime_names = ['public/mbt-frontdesk.js', 'public/mbt-frontdesk.html', 'public/mbt-planning.js',
                 'src/mbt/frontdesk-service.js', 'src/mbt/customer-charge-request-service.js',
                 'src/mbt/customer-charge-calculator.js', 'src/mbt/bin-dispatch-service.js',
                 'src/mbt/frontdesk-bin-readiness.js', 'tools/mbt-bin-cancel-undelivered.mjs']
source_hashes = {name: hashlib.sha256((SERVER / name).read_bytes()).hexdigest() for name in runtime_names}
PROJECT = 'mbbs-bin-corrections-' + str(os.getpid())
OUT.mkdir(parents=True, exist_ok=True)
run_artifacts = OUT / ('artifacts-' + MODE)
if run_artifacts.exists():
    run_artifacts.rename(OUT / ('artifacts-' + MODE + '-previous-' + str(os.getpid())))
run_artifacts.mkdir(parents=True, exist_ok=True)
(run_artifacts / 'mbt-bin-corrections-20261015').mkdir(exist_ok=True)
(OUT / ('validation.' + MODE + '.json')).unlink(missing_ok=True)
docker = ['sudo', '-n', 'docker']
toolchain = SERVER / 'test-artifacts/mbr-contract/toolchain/node_modules'
mounts = [f'{SERVER / name}:/app/{name}:ro' for name in
          ('src', 'public', 'migrations', 'test', 'tools', 'contracts', 'package.json', 'package-lock.json',
           'eslint.mbt.config.js', 'tsconfig.mbt.json', '.env.example')]
mounts += [f'{toolchain}:/app/node_modules:ro',
           f'{SERVER / "test-artifacts/mbr-contract/playwright-browsers"}:/ms-playwright:ro',
           f'{REPO}:/workspace:ro']
mounts += [f'{run_artifacts}:/app/test-artifacts']
image = 'mbbs-operator-app:mbr-signing-defaults-browser-test-20261014'
use_candidate = MODE == 'candidate' or os.environ.get('MBT_BIN_CORRECTIONS_CANDIDATE') == '1'
if use_candidate:
    prepared = json.loads((OUT / 'prepared.json').read_text())
    image = prepared['testImage']
    mounts = [mount for mount in mounts if not any(mount.endswith(f':/app/{name}:ro') for name in
              ('src', 'public', 'migrations', 'package.json', 'package-lock.json'))]
if MODE == 'baseline':
    spec = json.loads((OUT / 'spec.json').read_text())
    mounts += [f'{OUT / "baseline" / name}:/app/{name}:ro' for name in spec['baselineHashes']]
labels = {'com.mbbs.lifecycle': 'disposable-test', 'com.mbbs.task': PROJECT}
override = OUT / ('compose.' + MODE + '.json')
override.write_text(json.dumps({'services': {
    'db': {'image': 'postgres:18-alpine', 'pull_policy': 'never', 'labels': labels,
           'mem_limit': '768m', 'memswap_limit': '768m'},
    'test': {'image': image,
             'pull_policy': 'never', 'user': '1000:1000', 'entrypoint': [], 'working_dir': '/app',
             'labels': labels, 'cpus': '1.5', 'mem_limit': '2g', 'memswap_limit': '2g',
             'volumes': mounts, 'environment': {'PLAYWRIGHT_BROWSERS_PATH': '/ms-playwright',
                'XDG_CONFIG_HOME': '/tmp/bin-config', 'XDG_CACHE_HOME': '/tmp/bin-cache'}}}}, indent=2))
compose = docker + ['compose', '--profile', 'tools', '-p', PROJECT, '--project-directory', str(REPO),
                    '-f', str(REPO / 'docker-compose.mbt-test.yml'), '-f', str(override)]

def run(label, args, timeout=1800):
    with (OUT / (MODE + '-' + label + '.log')).open('w') as output:
        result = subprocess.run(args, cwd=REPO, stdout=output, stderr=subprocess.STDOUT, timeout=timeout)
    print(json.dumps({'stage': label, 'exit': result.returncode}), flush=True)
    if result.returncode:
        print((OUT / (MODE + '-' + label + '.log')).read_text()[-9000:], flush=True)
    return result.returncode

def interrupted(_signal, _frame):
    raise KeyboardInterrupt('Interrupted; removing disposable BIN tests')

signal.signal(signal.SIGINT, interrupted)
signal.signal(signal.SIGTERM, interrupted)
code = 1
try:
    config = json.loads(subprocess.check_output(compose + ['config', '--format', 'json']))
    for name in ('db', 'test'):
        service = config['services'][name]
        assert service['cgroup_parent'] == 'mbbs-tests.slice' and service['init']
        assert 0 < int(service['mem_limit']) <= 2 * 1024**3
        assert service['memswap_limit'] == service['mem_limit']
        assert 0 < service['pids_limit'] <= 512 and service['cpus']
        assert all('size=' in entry for entry in service['tmpfs'])
    assert run('start-db', compose + ['up', '-d', '--wait', '--no-build', '--pull', 'never', 'db']) == 0
    assert run('migrate', compose + ['run', '--rm', '--no-deps', '-T', 'test', 'npm', 'run', 'migrate']) == 0
    code = run('checks', compose + ['run', '--rm', '--no-deps', '-T', 'test', 'node',
                                  'tools/mbt-bin-corrections-check.mjs', MODE])
finally:
    teardown = run('teardown', compose + ['down', '--volumes', '--remove-orphans'], timeout=120)
    residual = subprocess.check_output(docker + ['ps', '-a', '--filter', 'label=com.mbbs.task=' + PROJECT,
                                               '--format', '{{.ID}}'], text=True).split()
    if residual:
        run('remove-oneoffs', docker + ['rm', '-f', '-v', *residual], timeout=120)
        teardown = run('teardown-final', compose + ['down', '--volumes', '--remove-orphans'], timeout=120)
    def output(args):
        return subprocess.check_output(docker + args, text=True).strip()
    cleanup = {'exit': teardown,
        'dockerPs': output(['ps', '--format', '{{.Names}} {{.Status}}']),
        'dockerPsA': output(['ps', '-a', '--format', '{{.Names}} {{.Status}}']),
        'containers': output(['ps', '-a', '--filter', 'label=com.mbbs.task=' + PROJECT, '--format', '{{.Names}}']),
        'networks': output(['network', 'ls', '--filter', 'label=com.docker.compose.project=' + PROJECT, '--format', '{{.Name}}']),
        'volumes': output(['volume', 'ls', '--filter', 'label=com.docker.compose.project=' + PROJECT, '--format', '{{.Name}}'])}
    (OUT / ('cleanup.' + MODE + '.json')).write_text(json.dumps(cleanup, indent=2))
    assert teardown == 0 and not any(cleanup[key] for key in ('containers', 'networks', 'volumes'))
    health = subprocess.run(['curl', '-fsS', '--max-time', '15', 'http://127.0.0.1:3000/health'], capture_output=True, text=True)
    (OUT / ('production-health.' + MODE + '.json')).write_text(health.stdout or health.stderr)
    assert health.returncode == 0, 'Production health failed after test cleanup'
    current_hashes = {name: hashlib.sha256((SERVER / name).read_bytes()).hexdigest() for name in runtime_names}
    assert current_hashes == source_hashes, 'Runtime source changed during validation'
    (OUT / ('validation.' + MODE + '.json')).write_text(json.dumps({
        'passed': code == 0, 'cleanupVerified': True, 'sourceHashes': source_hashes}, indent=2))
    if use_candidate:
        (OUT / 'validation.candidate.json').write_text(json.dumps({
            'passed': code == 0, 'cleanupVerified': True, 'sourceHashes': source_hashes,
            'testImage': image, 'fullGauntlet': MODE == 'all'}, indent=2))
raise SystemExit(code)
