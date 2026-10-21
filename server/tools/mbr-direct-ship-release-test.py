"""Verify actual combined image in the standard bounded disposable test stack."""
import json
import os
from pathlib import Path
import signal
import subprocess

SERVER = Path(__file__).resolve().parents[1]
REPO = SERVER.parent
OUT = SERVER / 'test-artifacts/mbr-direct-ship-release'
PRODUCTION_IMAGE = 'mbbs-operator-app:mbr-direct-ship-20261013'
MODE = os.environ.get('MBR_RELEASE_TEST_MODE', 'core')
assert MODE in ['core', 'browser']
IMAGE = PRODUCTION_IMAGE if MODE == 'core' else 'mbbs-operator-app:mbr-direct-ship-browser-test-20261013'
PROJECT = 'mbbs-mbr-direct-ship-' + MODE + '-' + str(os.getpid())
labels = {'com.mbbs.lifecycle': 'disposable-test', 'com.mbbs.task': PROJECT}
mounts = [str(SERVER / name) + ':/app/' + name + ':ro' for name in ['test', 'tools', 'migrations', 'contracts']]
mounts += [str(SERVER / name) + ':/app/' + name + ':ro' for name in ['.env.example', 'Dockerfile', 'Dockerfile.test', 'eslint.mbt.config.js', 'tsconfig.mbt.json']]
mounts += [str(SERVER / 'test-artifacts/mbr-contract/toolchain/node_modules') + ':/test-toolchain/node_modules:ro',
    str(SERVER / 'test-artifacts/mbr-contract/playwright-browsers') + ':/ms-playwright:ro']
for filename in SERVER.glob('*.js'):
    if filename.name != 'eslint.mbt.config.js':
        mounts.append(str(filename) + ':/app/' + filename.name + ':ro')
# Production dependencies and runtime files are inherited from the actual image.
# Existing test-only packages are resolved through NODE_PATH and explicit paths.
override = OUT / ('compose.' + MODE + '.json')
override.write_text(json.dumps({'services': {
    'db': {'pull_policy': 'never', 'labels': labels, 'mem_limit': '512m', 'memswap_limit': '512m'},
    'test': {'image': IMAGE, 'pull_policy': 'never', 'user': '1000:1000', 'entrypoint': [],
        'working_dir': '/app', 'labels': labels, 'cpus': '1.0', 'mem_limit': '1536m', 'memswap_limit': '1536m',
        'volumes': mounts, 'environment': {'MBR_CONTRACTS_ENABLED': 'true',
            'NODE_PATH': '/test-toolchain/node_modules', 'PLAYWRIGHT_BROWSERS_PATH': '/ms-playwright',
            'XDG_CONFIG_HOME': '/tmp/mbr-chromium-config', 'XDG_CACHE_HOME': '/tmp/mbr-chromium-cache'}}}}, indent=2))
compose = ['docker', 'compose', '--profile', 'tools', '-p', PROJECT, '--project-directory', str(REPO),
    '-f', str(REPO / 'docker-compose.mbt-test.yml'), '-f', str(override)]


def run(label, args, timeout=600):
    with (OUT / (MODE + '-' + label + '.log')).open('w') as log:
        result = subprocess.run(args, cwd=REPO, stdout=log, stderr=subprocess.STDOUT, timeout=timeout)
    print(json.dumps({'stage': label, 'exit': result.returncode}), flush=True)
    if result.returncode:
        print((OUT / (MODE + '-' + label + '.log')).read_text()[-5000:], flush=True)
        raise RuntimeError(label + ' failed')


def interrupted(_signal, _frame):
    raise KeyboardInterrupt('Release test interrupted; removing disposable stack')


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
    run('start-db', compose + ['up', '-d', '--wait', '--no-build', '--pull', 'never', 'db'])
    run('migrate', compose + ['run', '--rm', '--no-deps', '-T', 'test', 'npm', 'run', 'migrate'])
    # ESM test dependencies use a /tmp fixture root and symlink the actual runtime.
    # Test-only toolchain packages are added without replacing production packages.
    run('candidate-checks', compose + ['run', '--rm', '--no-deps', '-T', 'test',
        'node', 'tools/mbr-direct-ship-release-checks.mjs', MODE])
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
    (OUT / ('cleanup.' + MODE + '.json')).write_text(json.dumps(cleanup, indent=2))
    assert not any(cleanup[key] for key in ['containers', 'networks', 'volumes'])
    if passed:
        prepared = json.loads((OUT / 'prepared.json').read_text())
        checked = {**prepared, 'passed': True, 'cleanupVerified': True, 'testMode': MODE,
            'testedImage': IMAGE, 'testedImageId': json.loads(output(['image', 'inspect', IMAGE]))[0]['Id']}
        if MODE == 'core':
            assert checked['testedImageId'] == prepared['imageId']
        (OUT / ('candidate-validation.' + MODE + '.json')).write_text(json.dumps(checked, indent=2))
        records = [OUT / ('candidate-validation.' + mode + '.json') for mode in ['core', 'browser']]
        if all(path.exists() for path in records):
            validations = [json.loads(path.read_text()) for path in records]
            assert all(value['passed'] and value['cleanupVerified'] and value['imageId'] == prepared['imageId']
                and value['sourceHashes'] == prepared['sourceHashes'] for value in validations)
            (OUT / 'candidate-validation.json').write_text(json.dumps({**prepared,
                'passed': True, 'cleanupVerified': True, 'validations': validations}, indent=2))
    print(json.dumps({'cleanup': 'complete', 'candidatePassed': passed}), flush=True)
