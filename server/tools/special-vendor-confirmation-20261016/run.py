"""Run the feature checks in the bounded standard Compose stack and always remove it."""
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]
SERVER = ROOT / 'server'
MODE = sys.argv[1]
assert MODE in ('baseline', 'baseline-static', 'red', 'focused', 'propertyred', 'finish', 'final')
RELEASE = SERVER / 'deployments/special-vendor-confirmation-20261016'
TREE = RELEASE / ('before' if MODE in ('baseline', 'baseline-static', 'red') else 'candidate')
OUT = SERVER / 'test-artifacts/special-vendor-confirmation-20261016' / ('final' if MODE == 'finish' else MODE)
OUT.mkdir(parents=True, exist_ok=True)
os.chmod(OUT, 0o777)
FILES = ['public/backorder-stock-requests.js', 'public/special-stock-workflow.js', 'public/scm-special-stock-requests.js', 'src/special-stock-request-repository.js', 'src/server.js', 'migrations/296_special_vendor_confirmation.sql']
TESTS = ['test/mbt/unit/special-customer-confirmation.test.js', 'test/mbt/unit/special-po-dispatch-stage.test.js', 'test/mbt/integration/special-customer-confirmation.test.js', 'test/mbt/integration/special-po-dispatch-stage.test.js']
hashes = {n: hashlib.sha256((TREE / n).read_bytes()).hexdigest() for n in FILES if (TREE / n).exists()}
if MODE == 'finish':
    assert json.loads((OUT / 'source.json').read_text()) == hashes, 'Runtime changed since the final suite'
else:
    (OUT / 'source.json').write_text(json.dumps(hashes, indent=2))
mounts = [f'{TREE / n}:/app/{n}:ro' for n in ('src', 'public', 'migrations', 'package.json')]
mounts += [f'{SERVER / n}:/app/{n}:ro' for n in ('test', 'tools', 'contracts', 'eslint.mbt.config.js')]
mounts += [f'{SERVER / "test-artifacts/delivery-enhancements-20261013/toolchain/node_modules"}:/app/node_modules:ro']
mounts += [f'{OUT}:/app/test-artifacts', f'{RELEASE}:/release:ro', f'{OUT.parent}:/evidence:ro']
if MODE == 'baseline':
    mounts += [f'{RELEASE / "workspace-before" / n}:/app/{n}:ro' for n in TESTS]
service = {'image': 'mbbs-operator-app:dispatch-editor-control-browser-test-20261015', 'pull_policy': 'never',
    'user': '1000:1000', 'working_dir': '/app', 'volumes': mounts,
    'labels': {'com.mbbs.lifecycle': 'disposable-test'},
    'environment': {'PLAYWRIGHT_BROWSERS_PATH': '/ms-playwright', 'XDG_CONFIG_HOME': '/tmp/config', 'XDG_CACHE_HOME': '/tmp/cache', 'BACKORDER_BROWSER_OUTPUT': 'test-artifacts/backorder-browser', 'SPECIAL_VENDOR_BROWSER_OUTPUT':'test-artifacts/browser'}}
override = OUT / 'compose.json'
override.write_text(json.dumps({'services': {'test': service, 'migrate': service,
    'db': {'labels': {'com.mbbs.lifecycle': 'disposable-test'},
           'networks': {'mbt_test_internal': {'aliases': ['mbbs-special-review-db']}}}}}))
compose = ['docker', 'compose', '--project-directory', str(ROOT), '-p', 'mbbs-special-vendor-' + MODE,
    '-f', str(ROOT / 'docker-compose.mbt-test.yml'), '-f', str(override)]


def run(name, args):
    with (OUT / (name + '.log')).open('wb') as log:
        result = subprocess.run(args, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
    print(json.dumps({'layer': name, 'exitCode': result.returncode}), flush=True)
    if result.returncode:
        print((OUT / (name + '.log')).read_text()[-6000:], flush=True)
        raise RuntimeError(name + ' failed')


def stop(_signal, _frame):
    raise KeyboardInterrupt()


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    # Register cleanup before creating any database, network, or test container.
    run('budget', ['systemd-run', '--quiet', '--wait', '--pipe', '--collect', '--slice=mbbs-tests.slice',
        '-p', 'MemoryMax=128M', '-p', 'MemorySwapMax=0', '-p', 'CPUQuota=25%', '-p', 'TasksMax=32',
        'python3', str(ROOT / 'docker/verify-memory-limits.py')])
    if MODE != 'finish':
        run('migrate', compose + ['run', '--rm', 'migrate', 'node', 'src/migrate.js'])
    run('finish-checks' if MODE == 'finish' else 'checks', compose + ['run', '--rm', *(['--no-deps'] if MODE == 'finish' else []), 'test', 'node', 'tools/special-vendor-confirmation-20261016/check.mjs', MODE])
finally:
    with (OUT / 'teardown.log').open('wb') as log:
        subprocess.run(compose + ['down', '--volumes', '--remove-orphans'], stdout=log, stderr=subprocess.STDOUT, check=True)
    for args, name in [(['ps'], 'docker-ps.log'), (['ps', '-a'], 'docker-ps-a.log')]:
        (OUT / name).write_bytes(subprocess.check_output(['docker', *args, '--format', '{{.Names}} {{.Status}}']))
    (OUT / 'production-health.json').write_bytes(subprocess.check_output(['docker', 'inspect', 'mbbs-operator-app-app-1', '--format', '{{json .State.Health.Status}}']))
    leftovers = {}
    for resource, args in [('containers', ['ps', '-aq']), ('volumes', ['volume', 'ls', '-q']), ('networks', ['network', 'ls', '-q'])]:
        leftovers[resource] = subprocess.check_output(['docker', *args, '--filter', 'label=com.docker.compose.project=mbbs-special-vendor-' + MODE]).decode().strip()
    (OUT / 'cleanup.json').write_text(json.dumps(leftovers, indent=2))
    assert not any(leftovers.values()), 'Disposable resources remain'
    assert json.loads((OUT / 'production-health.json').read_text()) == 'healthy'
    assert hashes == {n: hashlib.sha256((TREE / n).read_bytes()).hexdigest() for n in FILES if (TREE / n).exists()}, 'Source changed during verification'
    print('Teardown complete; container listings and production health saved.', flush=True)
