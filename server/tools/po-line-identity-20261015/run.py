"""Reproduce and verify the PO line correction in bounded disposable containers."""
import difflib
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[2]
REPO = SERVER.parent
TASK = Path(__file__).resolve().parent
OUT = SERVER / 'test-artifacts/po-line-identity-20261015'
APP = 'mbbs-operator-app-app-1'
IMAGE = 'mbbs-operator-app:mbt-bin-cancellation-browser-test-20261015'
FILE = 'src/dispatch-order-target-repository.js'
TEST = 'test/dispatch/unit/dispatch-target-line-identity.test.js'
INTEGRATION = 'test/dispatch/integration/dispatch-target-line-identity.test.js'
RUNTIME = [FILE, 'src/dispatch-delivery-group-repository.js', 'public/dispatch.js', 'public/dispatch.html', 'public/mbt-planning.html']
DOCKER = ['sudo', '-n', 'docker']


def docker(*args):
    return subprocess.check_output(DOCKER + list(args))


def save(name, value):
    (OUT / name).write_text(json.dumps(value, indent=2) + '\n')


def capture():
    assert not (OUT / 'capture.json').exists(), 'Capture already exists'
    baseline = OUT / 'baseline'
    baseline.mkdir(parents=True, exist_ok=False)
    before = json.loads(docker('inspect', APP))[0]
    for name in ['src', 'public', 'migrations', 'package.json', 'package-lock.json']:
        docker('cp', APP + ':/app/' + name, str(baseline / name))
    subprocess.run(['sudo', '-n', 'chown', '-R', f'{os.getuid()}:{os.getgid()}', str(baseline)], check=True)
    assert docker('inspect', '--format', '{{.Id}}', APP).decode().strip() == before['Id']
    assert (baseline / FILE).read_bytes() == (SERVER / FILE).read_bytes(), 'Source differs from live'
    shutil.copytree(baseline, OUT / 'candidate')
    save('capture.json', {'containerId': before['Id'], 'imageId': before['Image'],
        'sourceHash': hashlib.sha256((baseline / FILE).read_bytes()).hexdigest()})
    print(json.dumps({'captured': True, 'imageId': before['Image']}), flush=True)


def interrupted(_signal, _frame):
    raise KeyboardInterrupt('Interrupted; disposing of test resources')


def cleanup(name, mode):
    remaining = docker('ps', '-aq', '--filter', 'name=^/' + name + '$').decode().split()
    if remaining:
        docker('rm', '-f', '-v', *remaining)
    active = docker('ps', '--format', '{{.Names}}\t{{.Status}}').decode()
    all_containers = docker('ps', '-a', '--format', '{{.Names}}\t{{.Status}}').decode()
    assert not docker('ps', '-aq', '--filter', 'name=^/' + name + '$').decode().strip()
    health = json.loads(docker('exec', APP, 'node', '-e',
        "fetch('http://127.0.0.1:3000/health').then(async r=>{const d=await r.json();if(!r.ok||!d.ok)process.exit(1);console.log(JSON.stringify({ok:d.ok}));})"))
    save('cleanup-' + mode + '.json', {'dockerPs': active, 'dockerPsA': all_containers,
        'taskContainers': [], 'productionHealthy': health['ok']})


def unit(mode):
    baseline = mode in ['record-red', 'static-baseline']
    source = OUT / ('runtime-baseline' if mode == 'static-baseline' else 'baseline' if baseline else 'candidate')
    if not baseline and not (OUT / 'runtime-capture.json').exists():
        for filename in RUNTIME:
            shutil.copyfile(SERVER / filename, source / filename)
    name = 'mbbs-po-line-identity-' + mode
    memory = '2g' if mode == 'static-baseline' else '1g'
    args = DOCKER + ['run', '--rm', '--init', '--name', name, '--workdir=/app', '--network=none', '--read-only',
        '--cgroup-parent=mbbs-tests.slice', '--memory=' + memory, '--memory-swap=' + memory, '--cpus=1', '--pids-limit=256',
        '--tmpfs', '/tmp:size=256m,mode=1777', '--tmpfs', '/app/data:size=32m,uid=1000,gid=1000,mode=0700',
        '--label', 'com.mbbs.lifecycle=disposable-test', '--label', 'com.mbbs.task=po-line-identity-20261015',
        '-e', 'NODE_ENV=test', '-e', 'MBBS_ENV_FILE=.env.mbt-test-does-not-exist',
        '-e', 'MBT_TEST_ISOLATED=1', '-e', 'PLAYWRIGHT_BROWSERS_PATH=/ms-playwright']
    for folder in ['src', 'public', 'migrations']:
        args += ['-v', f'{source / folder}:/app/{folder}:ro']
    for folder in ['test', 'tools', 'contracts']:
        args += ['-v', f'{SERVER / folder}:/app/{folder}:ro']
    for filename in ['package.json', 'package-lock.json', 'eslint.mbt.config.js', 'tsconfig.mbt.json', '.c8rc.json']:
        args += ['-v', f'{SERVER / filename}:/app/{filename}:ro']
    args += ['-v', f'{SERVER / "test-artifacts/operator-to-yard-flow-tooling/node_modules"}:/app/node_modules:ro',
        '-v', f'{OUT}:/evidence', '--entrypoint', 'node', IMAGE]
    # Teardown is installed before the first container can be created.
    try:
        log = OUT / (mode + '.log')
        with log.open('w') as output:
            command = ['tools/po-line-identity-20261015/check.mjs', 'baseline-static'] if mode == 'static-baseline' else ['tools/po-line-identity-20261015/browser.mjs'] if mode == 'browser' else ['node_modules/c8/bin/c8.js', '--all=false', '--check-coverage=false',
                '--include=' + FILE, '--temp-directory=/tmp/po-line-c8', '--report-dir=/evidence/coverage-' + mode,
                '--reporter=json', '--reporter=text', 'node', '--test', '--test-concurrency=1',
                *(['test/dispatch/frontend/dispatch-ungroup-po-warning.test.js'] if mode == 'warning-red' else [TEST])]
            result = subprocess.run(args + command,
                stdout=output, stderr=subprocess.STDOUT, cwd=REPO)
        lines = log.read_text().splitlines()
        summary = {'exitCode': result.returncode, 'sourceHash': hashlib.sha256((source / FILE).read_bytes()).hexdigest(),
            'summary': [line for line in lines if line.startswith(('# tests', '# pass', '# fail', '# skipped'))],
            'failures': [line for line in lines if line.startswith('not ok')]}
        save(('browser-run' if mode == 'browser' else mode) + '.json', summary)
        print(json.dumps(summary), flush=True)
        print('\n'.join(lines[-16:]), flush=True)
        return result.returncode
    finally:
        cleanup(name, mode)


def repository(mode):
    project = 'mbbs-po-line-identity-' + ('final' if mode == 'verify-final' else mode)
    source = OUT / ('runtime-baseline' if mode in ['regression-baseline', 'history-baseline'] else 'candidate')
    if mode not in ['regression-baseline', 'history-baseline'] and not (OUT / 'runtime-capture.json').exists():
        for filename in RUNTIME:
            shutil.copyfile(SERVER / filename, source / filename)
    volumes = [f'{source / folder}:/app/{folder}:ro' for folder in ['src', 'public', 'migrations']]
    volumes += [f'{SERVER / folder}:/app/{folder}:ro' for folder in ['test', 'tools', 'contracts']]
    volumes += [f'{SERVER / filename}:/app/{filename}:ro' for filename in ['package.json', 'package-lock.json',
        '.c8rc.json', 'eslint.mbt.config.js', 'tsconfig.mbt.json']]
    volumes += [f'{SERVER / "test-artifacts/operator-to-yard-flow-tooling/node_modules"}:/app/node_modules:ro',
        f'{SERVER / "test-artifacts"}:/app/test-artifacts', f'{OUT}:/evidence']
    if mode == 'integration-red':
        volumes += [f'{OUT / "record-release.js"}:/app/{FILE}:ro']
    labels = {'com.mbbs.lifecycle': 'disposable-test', 'com.mbbs.task': project}
    service = {'image': IMAGE, 'pull_policy': 'never', 'working_dir': '/app', 'user': '1000:1000',
        'entrypoint': [], 'volumes': volumes, 'labels': labels,
        'environment': {'PLAYWRIGHT_BROWSERS_PATH': '/ms-playwright', 'PO_IDENTITY_MODE': mode}}
    config = OUT / ('compose-' + mode + '.json')
    config.write_text(json.dumps({'services': {'db': {'labels': labels}, 'test': service, 'migrate': service}}, indent=2) + '\n')
    compose = DOCKER + ['compose', '--project-name', project, '--project-directory', str(REPO),
        '-f', str(REPO / 'docker-compose.mbt-test.yml'), '-f', str(config)]

    def run(label, args, expect=True):
        with (OUT / (label + '.log')).open('w') as log:
            result = subprocess.run(args, stdout=log, stderr=subprocess.STDOUT, cwd=REPO)
        print(json.dumps({'stage': label, 'exitCode': result.returncode}), flush=True)
        if expect and result.returncode:
            print((OUT / (label + '.log')).read_text()[-5000:], flush=True)
            raise RuntimeError('Failed: ' + label)
        return result.returncode

    def test(args, label, expect=True, extra=None):
        return run(label, compose + ['run', '--rm', '--no-deps', '-T', *(extra or []), 'test', *args], expect)

    # Teardown is registered before any network, container or database exists.
    try:
        effective = json.loads(subprocess.check_output(compose + ['--profile', 'tools', 'config', '--format', 'json']))
        for name in ['db', 'test', 'migrate']:
            item = effective['services'][name]
            assert item['cgroup_parent'] == 'mbbs-tests.slice' and item['init'] is True
            assert 0 < int(item['mem_limit']) <= 2 * 1024 ** 3
            assert item['memswap_limit'] == item['mem_limit']
            assert 0 < int(item['pids_limit']) <= 512 and 0 < float(item['cpus']) <= 2
            assert all('size=' in entry for entry in item['tmpfs'])
        assert subprocess.check_output(['systemctl', 'show', 'mbbs-tests.slice', '-p', 'MemoryMax', '--value']).decode().strip() == '4294967296'
        run(mode + '-db', compose + ['up', '-d', '--wait', '--no-build', '--pull', 'never', 'db'])
        run(mode + '-migrate', compose + ['run', '--rm', '--no-deps', '-T', 'migrate', 'node', 'src/migrate.js'])
        if mode in ['history-baseline', 'history-candidate']:
            test(['node', 'tools/po-line-identity-20261015/history-replay.mjs'], mode)
            return 0
        if mode == 'integration-red':
            code = test(['node', '--test', '--test-concurrency=1', TEST, INTEGRATION], mode, expect=False)
            print((OUT / (mode + '.log')).read_text()[-1800:], flush=True)
            return code
        if mode != 'verify-final':
            test(['node', 'tools/po-line-identity-20261015/check.mjs', mode], mode)
        if mode in ['final', 'verify-final', 'regression-final']:
            test(['node', 'tools/po-line-identity-20261015/browser.mjs'], 'browser')
            test(['node', 'tools/po-line-identity-20261015/pickup-card-reproduction.mjs', 'fixed'], 'pickup-fixed')
            if mode != 'regression-final':
                test(['node', 'tools/po-line-identity-20261015/check.mjs', 'mutations'], 'mutations')
            test(['node', 'tools/po-line-identity-20261015/check.mjs', 'focused'], 'final-fresh')
            run('changed-coverage', ['python3', str(TASK / 'coverage.py')])
            test(['node', 'tools/po-line-identity-20261015/check.mjs', 'summary'], 'summary')
        return 0
    finally:
        teardown = run('teardown-' + mode, compose + ['down', '--volumes', '--remove-orphans'], expect=False)
        residual = docker('ps', '-aq', '--filter', 'label=com.mbbs.task=' + project).decode().split()
        if residual:
            docker('rm', '-f', '-v', *residual)
            teardown = run('teardown-retry-' + mode, compose + ['down', '--volumes', '--remove-orphans'], expect=False)
        active = docker('ps', '--format', '{{.Names}}\t{{.Status}}').decode()
        all_containers = docker('ps', '-a', '--format', '{{.Names}}\t{{.Status}}').decode()
        networks = docker('network', 'ls', '--filter', 'label=com.docker.compose.project=' + project, '--format', '{{.Name}}').decode().strip()
        volumes_left = docker('volume', 'ls', '--filter', 'label=com.docker.compose.project=' + project, '--format', '{{.Name}}').decode().strip()
        health = json.loads(docker('exec', APP, 'node', '-e',
            "fetch('http://127.0.0.1:3000/health').then(async r=>{const d=await r.json();if(!r.ok||!d.ok)process.exit(1);console.log(JSON.stringify({ok:d.ok}));})"))
        save('cleanup-' + mode + '.json', {'teardownExit': teardown, 'dockerPs': active, 'dockerPsA': all_containers,
            'taskContainers': [], 'networks': networks, 'volumes': volumes_left, 'productionHealthy': health['ok']})
        if mode == 'verify-final':
            shutil.copyfile(OUT / 'cleanup-verify-final.json', OUT / 'cleanup-final.json')
        assert teardown == 0 and not networks and not volumes_left and health['ok'] is True


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGTERM, interrupted)
    mode = sys.argv[1]
    if mode == 'capture':
        capture()
    elif mode in ['integration-red', 'regression-baseline', 'focused', 'final', 'verify-final', 'regression-final', 'history-baseline', 'history-candidate']:
        raise SystemExit(repository(mode))
    else:
        assert mode in ['record-red', 'record-green', 'general-red', 'warning-red', 'browser', 'static-baseline']
        raise SystemExit(unit(mode))
