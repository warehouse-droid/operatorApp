"""Run printing checks using the standard isolated, bounded Compose project."""
import json
from pathlib import Path
import signal
import subprocess

TASK = Path(__file__).resolve().parent
SERVER = TASK.parents[1]
ROOT = SERVER.parent
OUT = SERVER / 'test-artifacts/so-printing-pickup-20261015'
PROJECT = 'mbbs-so-printing-pickup-20261015'
capture = json.loads((TASK / 'capture.json').read_text())
labels = {'com.mbbs.lifecycle': 'disposable-test', 'com.mbbs.task': PROJECT}
mounts = [f'{TASK / "candidate" / file}:/app/{file}:ro' for file in capture['files']]
mounts += [f'{SERVER / "test/dispatch/integration/sales-printing-pickup.test.js"}:/app/test/dispatch/integration/sales-printing-pickup.test.js:ro',
           f'{SERVER / "src/sales-portal-harness.js"}:/app/src/sales-portal-harness.js:ro']
service = {'image': capture['image'], 'pull_policy': 'never', 'labels': labels, 'volumes': mounts}
config_path = OUT / 'compose.json'
config_path.write_text(json.dumps({'services': {'db': {'labels': labels}, 'test': service, 'migrate': service}}, indent=2) + '\n')
docker = ['sudo', '-n', 'docker']
compose = docker + ['compose', '-p', PROJECT, '--project-directory', str(ROOT),
                    '-f', str(ROOT / 'docker-compose.mbt-test.yml'), '-f', str(config_path)]


def run(label, args, timeout=180):
    with (OUT / (label + '.log')).open('w') as log:
        result = subprocess.run(args, stdout=log, stderr=subprocess.STDOUT, cwd=ROOT, timeout=timeout)
    print(json.dumps({'stage': label, 'exit': result.returncode}), flush=True)
    if result.returncode:
        print((OUT / (label + '.log')).read_text()[-6000:], flush=True)
    return result.returncode


def interrupted(_signal, _frame):
    raise KeyboardInterrupt('Removing disposable printing tests')


signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
try:
    effective = json.loads(subprocess.check_output(compose + ['--profile', 'tools', 'config', '--format', 'json']))
    for name in ['db', 'test', 'migrate']:
        service_config = effective['services'][name]
        assert service_config['cgroup_parent'] == 'mbbs-tests.slice' and service_config['init'] is True
        assert 0 < int(service_config['mem_limit']) <= 2 * 1024 ** 3
        assert service_config['memswap_limit'] == service_config['mem_limit']
        assert 0 < int(service_config['pids_limit']) <= 512 and float(service_config['cpus']) <= 2
        assert all('size=' in entry for entry in service_config['tmpfs'])
    assert run('database', compose + ['up', '-d', '--wait', '--no-build', '--pull', 'never', 'db']) == 0
    assert run('migrations', compose + ['run', '--rm', '--no-deps', '-T', 'migrate', 'node', 'src/migrate.js']) == 0
    assert run('pickup-integration', compose + ['run', '--rm', '--no-deps', '-T', 'test',
        'node', '--test', '--test-concurrency=1', 'test/dispatch/integration/sales-printing-pickup.test.js']) == 0
    assert run('sales-portal-regression', compose + ['run', '--rm', '--no-deps', '-T', 'test',
        'node', 'src/sales-portal-harness.js']) == 0
finally:
    down = run('teardown', compose + ['down', '--volumes', '--remove-orphans'])
    residual = subprocess.check_output(docker + ['ps', '-aq', '--filter', 'label=com.mbbs.task=' + PROJECT]).decode().split()
    if residual:
        run('residual-cleanup', docker + ['rm', '-f', '-v', *residual])
        down = run('teardown-retry', compose + ['down', '--volumes', '--remove-orphans'])
    def listing(*args):
        return subprocess.check_output(docker + list(args)).decode().strip()
    cleanup = {'teardownExit': down,
        'dockerPs': listing('ps', '--format', '{{.Names}} {{.Status}}'),
        'dockerPsA': listing('ps', '-a', '--format', '{{.Names}} {{.Status}}'),
        'ownContainers': listing('ps', '-a', '--filter', 'label=com.mbbs.task=' + PROJECT, '--format', '{{.Names}}'),
        'networks': listing('network', 'ls', '--filter', 'label=com.docker.compose.project=' + PROJECT, '--format', '{{.Name}}'),
        'volumes': listing('volume', 'ls', '--filter', 'label=com.docker.compose.project=' + PROJECT, '--format', '{{.Name}}')}
    cleanup['productionHealthy'] = json.loads(subprocess.check_output(['curl', '-fsS', 'http://127.0.0.1:3000/health']))['ok']
    (OUT / 'cleanup.json').write_text(json.dumps(cleanup, indent=2) + '\n')
    assert down == 0 and not cleanup['ownContainers'] and not cleanup['networks'] and not cleanup['volumes']
    assert cleanup['productionHealthy']
    print(json.dumps({'cleanup': 'complete', 'productionHealthy': True}), flush=True)
