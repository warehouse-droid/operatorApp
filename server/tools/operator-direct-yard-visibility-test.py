"""Verify the precise release image and clean up the bounded disposable stack."""
import json
import os
from pathlib import Path
import signal
import subprocess

SERVER = Path(__file__).resolve().parents[1]
REPO = SERVER.parent
OUT = SERVER / 'test-artifacts/operator-direct-yard-visibility'
IMAGE = 'mbbs-operator-app:operator-direct-yard-visibility-20261013'
PROJECT = 'mbbs-operator-yard-visibility-' + str(os.getpid())
PHASE = os.environ.get('VISIBILITY_TEST_PHASE', 'all')
assert PHASE in ['all', 'mutations', 'lint']
labels = {'com.mbbs.lifecycle': 'disposable-test', 'com.mbbs.task': PROJECT}
mounts = [str(SERVER / name) + ':/app/' + name + ':ro' for name in ['test', 'tools', 'migrations', 'contracts']]
mounts += [str(SERVER / name) + ':/app/' + name + ':ro' for name in ['.env.example', 'Dockerfile', 'Dockerfile.test', 'eslint.mbt.config.js', 'tsconfig.mbt.json']]
mounts += [str(SERVER / 'test-artifacts/mbr-contract/toolchain/node_modules') + ':/test-toolchain/node_modules:ro']
for filename in SERVER.glob('*.js'):
    if filename.name != 'eslint.mbt.config.js':
        mounts.append(str(filename) + ':/app/' + filename.name + ':ro')
override = OUT / ('compose-' + str(os.getpid()) + '.json')
override.write_text(json.dumps({'services': {
    'db': {'pull_policy': 'never', 'labels': labels, 'mem_limit': '512m', 'memswap_limit': '512m'},
    'test': {'image': IMAGE, 'pull_policy': 'never', 'user': '1000:1000', 'entrypoint': [],
        'working_dir': '/app', 'labels': labels, 'cpus': '1.0', 'mem_limit': '1536m', 'memswap_limit': '1536m',
        'volumes': mounts, 'environment': {'MBR_CONTRACTS_ENABLED': 'true', 'NODE_PATH': '/test-toolchain/node_modules'}}}}, indent=2))
compose = ['docker', 'compose', '--profile', 'tools', '-p', PROJECT, '--project-directory', str(REPO),
    '-f', str(REPO / 'docker-compose.mbt-test.yml'), '-f', str(override)]


def run(label, args, timeout=600):
    with (OUT / (label + '.log')).open('w') as log:
        result = subprocess.run(args, cwd=REPO, stdout=log, stderr=subprocess.STDOUT, timeout=timeout)
    print(json.dumps({'stage': label, 'exit': result.returncode}), flush=True)
    if result.returncode:
        print((OUT / (label + '.log')).read_text()[-7000:], flush=True)
        raise RuntimeError(label + ' failed')


def interrupted(_signal, _frame):
    raise KeyboardInterrupt('Test interrupted; removing disposable stack')


signal.signal(signal.SIGINT, interrupted)
signal.signal(signal.SIGTERM, interrupted)
passed = False
try:
    config = json.loads(subprocess.check_output(compose + ['config', '--format', 'json']))
    for name in ['db', 'test']:
        service = config['services'][name]
        assert service['cgroup_parent'] == 'mbbs-tests.slice' and service['init']
        assert 0 < int(service['mem_limit']) <= 2 * 1024**3 and service['memswap_limit'] == service['mem_limit']
        assert 0 < service['pids_limit'] <= 512 and service['cpus']
        assert service['labels']['com.mbbs.lifecycle'] == 'disposable-test'
        assert all('size=' in item for item in service['tmpfs'])
    if PHASE != 'lint':
        run('start-db', compose + ['up', '-d', '--wait', '--no-build', '--pull', 'never', 'db'])
        run('migrate', compose + ['run', '--rm', '--no-deps', '-T', 'test', 'npm', 'run', 'migrate'])
        run('candidate-checks', compose + ['run', '--rm', '--no-deps', '-T', 'test',
            'node', 'tools/operator-direct-yard-visibility-checks.mjs', PHASE])
    else:
        run('lint', compose + ['run', '--rm', '--no-deps', '-T', 'test',
            'node', 'tools/operator-direct-yard-visibility-lint.mjs'])
    passed = True
finally:
    run('teardown', compose + ['down', '--volumes', '--remove-orphans'], timeout=120)
    def output(args):
        return subprocess.check_output(['docker', *args], text=True).strip()
    cleanup = {'dockerPs': output(['ps', '--format', '{{.Names}} {{.Status}}']),
        'dockerPsA': output(['ps', '-a', '--format', '{{.Names}} {{.Status}}']),
        'containers': output(['ps', '-a', '--filter', 'label=com.mbbs.task=' + PROJECT, '--format', '{{.Names}}']),
        'networks': output(['network', 'ls', '--filter', 'label=com.docker.compose.project=' + PROJECT, '--format', '{{.Name}}']),
        'volumes': output(['volume', 'ls', '--filter', 'label=com.docker.compose.project=' + PROJECT, '--format', '{{.Name}}'])}
    (OUT / 'cleanup.json').write_text(json.dumps(cleanup, indent=2))
    assert not any(cleanup[key] for key in ['containers', 'networks', 'volumes'])
    if passed and PHASE != 'lint':
        prepared = json.loads((OUT / 'prepared.json').read_text())
        checked = {**prepared, 'passed': True, 'cleanupVerified': True,
            'testedImageId': json.loads(output(['image', 'inspect', IMAGE]))[0]['Id']}
        assert checked['testedImageId'] == prepared['imageId']
        (OUT / 'candidate-validation.json').write_text(json.dumps(checked, indent=2))
    print(json.dumps({'cleanup': 'complete', 'candidatePassed': passed}), flush=True)
