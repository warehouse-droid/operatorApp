#!/usr/bin/env python3
"""Run schedule search checks in a bounded stack and always remove its data."""
import hashlib
import difflib
import json
import os
from pathlib import Path
import signal
import shutil
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[2]
REPO = SERVER.parent
OUT = SERVER / 'test-artifacts/scm-schedule-search-20261014'
MODE = sys.argv[1] if len(sys.argv) > 1 else 'all'
assert MODE in ('red', 'baseline', 'core', 'all')
PROJECT = 'mbbs-schedule-search-' + MODE + '-' + str(os.getpid())
DOCKER = ['sudo', '-n', 'docker']
OUT.mkdir(parents=True, exist_ok=True)
if MODE == 'all':
    shutil.rmtree(OUT / 'coverage', ignore_errors=True)
    for name in ('mutations.json', 'static.json', 'changed-coverage.json', 'checks-all.json', 'validation-all.json'):
        (OUT / name).unlink(missing_ok=True)
    baseline = json.loads((OUT / 'baseline.json').read_text())
    patch = ''.join(''.join(difflib.unified_diff((OUT / 'before' / name).read_text().splitlines(True),
      (SERVER / name).read_text().splitlines(True), fromfile='a/' + name, tofile='b/' + name))
      for name in baseline['sha256'])
    (OUT / 'changes.patch').write_text(patch)
labels = {'com.mbbs.lifecycle': 'disposable-test', 'com.mbbs.task': PROJECT}
toolchain = SERVER / 'test-artifacts/mbr-contract/toolchain/node_modules'
mounts = [f'{SERVER / name}:/app/{name}:ro' for name in
          ('src', 'public', 'test', 'tools', 'migrations', 'contracts', 'package.json',
           'package-lock.json', '.env.example', 'tsconfig.mbt.json', 'eslint.mbt.config.js', '.c8rc.json')]
mounts += [f'{toolchain}:/app/node_modules:ro',
           f'{SERVER / "test-artifacts/mbr-contract/playwright-browsers"}:/ms-playwright:ro']
if MODE == 'baseline':
    baseline = json.loads((OUT / 'baseline.json').read_text())
    mounts += [f'{OUT / "before" / name}:/app/{name}:ro' for name in baseline['sha256']]
for path in SERVER.glob('*.js'):
    if path.name != 'eslint.mbt.config.js':
        mounts.append(f'{path}:/app/{path.name}:ro')
override = OUT / ('compose-' + MODE + '.json')
override.write_text(json.dumps({'services': {
    'db': {'image': 'postgres:18-alpine', 'pull_policy': 'never', 'labels': labels,
           'mem_limit': '512m', 'memswap_limit': '512m'},
    'test': {'image': 'mbbs-to-yard-test-browser:20261009', 'pull_policy': 'never',
             'user': '1000:1000', 'entrypoint': [], 'working_dir': '/app', 'labels': labels,
             'cpus': '1.0', 'mem_limit': '1536m', 'memswap_limit': '1536m',
             'volumes': mounts, 'environment': {'PLAYWRIGHT_BROWSERS_PATH': '/ms-playwright',
               'XDG_CONFIG_HOME': '/tmp/schedule-search-config', 'XDG_CACHE_HOME': '/tmp/schedule-search-cache'}}}}, indent=2))
compose = DOCKER + ['compose', '--profile', 'tools', '-p', PROJECT, '--project-directory', str(REPO),
                    '-f', str(REPO / 'docker-compose.mbt-test.yml'), '-f', str(override)]

def run(label, args, required=True, timeout=900):
    log = OUT / (MODE + '-' + label + '.log')
    with log.open('w') as output:
        result = subprocess.run(args, stdout=output, stderr=subprocess.STDOUT, cwd=REPO, timeout=timeout)
    print(json.dumps({'stage': label, 'exit': result.returncode}), flush=True)
    if result.returncode:
        print(log.read_text()[-5000:], flush=True)
        if required:
            raise RuntimeError(label + ' failed')
    return result.returncode

def interrupted(_signal, _frame):
    raise KeyboardInterrupt('Interrupted; removing disposable schedule search tests')

signal.signal(signal.SIGINT, interrupted)
signal.signal(signal.SIGTERM, interrupted)
passed = False
try:
    config = json.loads(subprocess.check_output(compose + ['config', '--format', 'json']))
    for name in ('db', 'test'):
        service = config['services'][name]
        assert service['cgroup_parent'] == 'mbbs-tests.slice' and service['init']
        assert 0 < int(service['mem_limit']) <= 2 * 1024**3 and service['memswap_limit'] == service['mem_limit']
        assert 0 < service['pids_limit'] <= 512 and 0 < float(service['cpus']) <= 2
        assert service['labels']['com.mbbs.lifecycle'] == 'disposable-test'
        assert all('size=' in entry for entry in service['tmpfs'])
    assert subprocess.check_output(['systemctl', 'show', 'mbbs-tests.slice', '-p', 'MemoryMax', '--value'], text=True).strip() == '4294967296'
    run('start-db', compose + ['up', '-d', '--wait', '--no-build', '--pull', 'never', 'db'])
    run('migrate', compose + ['run', '--rm', '--no-deps', '-T', 'test', 'node', 'src/migrate.js'])
    run('checks', compose + ['run', '--rm', '--no-deps', '-T', 'test', 'node',
        'tools/scm-schedule-search-20261014/check.mjs', MODE])
    if MODE == 'all':
        run('changed-coverage', ['python3', str(Path(__file__).parent / 'coverage.py')])
    passed = True
finally:
    teardown = run('teardown', compose + ['down', '--volumes', '--remove-orphans'], required=False, timeout=120)
    residual = subprocess.check_output(DOCKER + ['ps', '-aq', '--filter', 'label=com.mbbs.task=' + PROJECT], text=True).split()
    if residual:
        run('remove-oneoffs', DOCKER + ['rm', '-f', '-v', *residual], timeout=120)
        teardown = run('teardown-final', compose + ['down', '--volumes', '--remove-orphans'], timeout=120)
    def output(args):
        return subprocess.check_output(DOCKER + args, text=True).strip()
    status = {'teardownExit': teardown,
      'dockerPs': output(['ps', '--format', '{{.Names}} {{.Status}}']),
      'dockerPsA': output(['ps', '-a', '--format', '{{.Names}} {{.Status}}']),
      'containers': output(['ps', '-a', '--filter', 'label=com.mbbs.task=' + PROJECT, '--format', '{{.Names}}']),
      'allDisposableContainers': output(['ps', '-a', '--filter', 'label=com.mbbs.lifecycle=disposable-test', '--format', '{{.Names}}']),
      'networks': output(['network', 'ls', '--filter', 'label=com.docker.compose.project=' + PROJECT, '--format', '{{.Name}}']),
      'volumes': output(['volume', 'ls', '--filter', 'label=com.docker.compose.project=' + PROJECT, '--format', '{{.Name}}'])}
    health = subprocess.run(['curl', '-fsS', '--max-time', '15', 'http://127.0.0.1:3000/health'], capture_output=True, text=True)
    status['productionHealthy'] = health.returncode == 0 and json.loads(health.stdout).get('ok') is True
    (OUT / ('cleanup-' + MODE + '.json')).write_text(json.dumps(status, indent=2) + '\n')
    assert teardown == 0 and not any(status[key] for key in ('containers', 'networks', 'volumes'))
    assert status['productionHealthy']
    if passed:
        files = sorted(set(SERVER.glob('tools/scm-schedule-search-20261014/*')) | {
          SERVER / name for name in ['src/scm-order-visibility.js', 'src/server.js', 'src/dispatch-repository.js',
            'public/scm-schedule.js', 'public/scm-schedule.html', 'test/dispatch/frontend/scm-schedule-search.test.js',
            'test/mbt/integration/scm-schedule-search.test.js', 'test/scm-schedule-search-spec.md']})
        hashes = {str(path.relative_to(SERVER)): hashlib.sha256(path.read_bytes()).hexdigest() for path in files if path.is_file()}
        (OUT / ('validation-' + MODE + '.json')).write_text(json.dumps({'passed': True,
          'cleanupVerified': True, 'sourceHashes': hashes}, indent=2) + '\n')
    print(json.dumps({'cleanup': 'complete', 'productionHealth': 'passed', 'checksPassed': passed}), flush=True)
