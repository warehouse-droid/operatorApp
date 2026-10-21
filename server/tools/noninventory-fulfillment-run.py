"""Reproduce baseline/red, focused/full checks and static/mutation evidence in a disposable database."""
import hashlib
import difflib
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

SERVER = Path(__file__).resolve().parents[1]
OUT = SERVER / 'test-artifacts/noninventory-fulfillment'
FILES = ['src/delivery-repository.js', 'src/operator-netsuite-posting-targets.js', 'src/netsuite.js', 'src/sales-order-auto-fulfillment-repository.js']
TESTS = ['test/mbt/unit/noninventory-fulfillment.test.js', 'test/mbt/integration/noninventory-fulfillment.test.js']

def docker(*args, **kwargs):
    return subprocess.check_output(['sudo', '-n', 'docker', *args], **kwargs)

def hashes():
    return {file: hashlib.sha256((SERVER/file).read_bytes()).hexdigest() for file in FILES}

def changes():
    lines, patch = {}, ''
    for file in FILES:
        before, after = (OUT/'before'/file).read_text(), (SERVER/file).read_text()
        lines[file] = [line+1 for tag, _, _, start, end in difflib.SequenceMatcher(None, before.splitlines(), after.splitlines()).get_opcodes()
                       if tag in ('insert', 'replace') for line in range(start, end)]
        patch += ''.join(difflib.unified_diff(before.splitlines(True), after.splitlines(True), fromfile='a/'+file, tofile='b/'+file))
    (OUT/'changes.json').write_text(json.dumps(lines, indent=2)+'\n')
    (OUT/'release.patch').write_text(patch)

def snapshot():
    OUT.mkdir(exist_ok=True)
    before = OUT/'before'
    before.mkdir(exist_ok=False)
    for folder in ['src', 'public', 'migrations']:
        shutil.copytree(SERVER/folder, before/folder)
    (OUT/'baseline-hashes.json').write_text(json.dumps(hashes(), indent=2)+'\n')
    live = docker('exec', 'mbbs-operator-app-app-1', 'sha256sum', *['/app/'+file for file in FILES]).decode().splitlines()
    assert {line.split()[1].removeprefix('/app/'): line.split()[0] for line in live} == hashes()
    print(json.dumps({'snapshot': True, 'files': FILES}), flush=True)

def run(label, args, source=None, env=None, timeout=1800):
    command = BASE[:]
    for folder in ['src', 'public', 'migrations']:
        command += ['--mount', f'type=bind,src={(source or SERVER)/folder},dst=/app/{folder},readonly']
    for key, value in (env or {}).items():
        command += ['-e', key+'='+value]
    image = 'mbbs-regular-v2:e2e' if args == ['tools/noninventory-fulfillment-tests.mjs'] else 'mbbs-regular-v2:test'
    command += ['--entrypoint', 'node', image, *args]
    started = time.monotonic()
    with (OUT/(label+'.log')).open('wb') as output:
        result = subprocess.run(command, stdout=output, stderr=subprocess.STDOUT, timeout=timeout, cwd=SERVER)
    text = (OUT/(label+'.log')).read_text()
    counts = {key: sum(map(int, re.findall(r'^(?:#|ℹ) '+key+r' (\d+)$', text, re.M))) for key in ['tests', 'pass', 'fail', 'skipped']}
    failures = re.findall(r'^not ok \d+ - (.+)$', text, re.M)
    failures += [re.sub(r' \([\d.]+ms\)$', '', name) for name in re.findall(r'^✖ (.+)$', text, re.M) if name != 'failing tests:']
    summary = {'label': label, 'exit': result.returncode, 'seconds': round(time.monotonic()-started, 2), **counts, 'failures': failures}
    (OUT/(label+'.json')).write_text(json.dumps(summary, indent=2)+'\n')
    print(json.dumps({key: value for key, value in summary.items() if key != 'failures'}), flush=True)
    return summary

def isolated(mode):
    global BASE
    network = f'mbbs-noninventory-{mode}-internal-{os.getpid()}'
    db = f'mbbs-noninventory-{mode}-db-{os.getpid()}'
    network_ids = docker('network', 'ls', '-q').decode().split()
    networks = json.loads(docker('network', 'inspect', *network_ids))
    allocated = [ipaddress.ip_network(item['Subnet']) for row in networks for item in (row['IPAM'].get('Config') or [])
                 if item.get('Subnet') and ipaddress.ip_network(item['Subnet']).version == 4]
    subnet = next(block for block in ipaddress.ip_network('10.253.0.0/16').subnets(new_prefix=28)
                  if not any(block.overlaps(existing) for existing in allocated))
    docker('network', 'create', '--internal', '--subnet', str(subnet), network)
    try:
        docker('run', '-d', '--name', db, '--network', network, '--network-alias', 'db', '--tmpfs', '/var/lib/postgresql',
               '-e', 'POSTGRES_DB=mbt_test', '-e', 'POSTGRES_USER=mbt_test', '-e', 'POSTGRES_PASSWORD=mbt_test_password',
               '-e', 'PGDATA=/var/lib/postgresql/data', 'postgres:18-alpine')
        for _ in range(60):
            if subprocess.run(['sudo', '-n', 'docker', 'exec', db, 'pg_isready', '-U', 'mbt_test', '-d', 'mbt_test'], capture_output=True).returncode == 0:
                break
            time.sleep(.5)
        else:
            raise RuntimeError('Disposable database did not start')
        BASE = ['sudo', '-n', 'docker', 'run', '--rm', '--network', network,
                '--tmpfs', '/tmp:uid=1000,gid=1000,mode=1777', '--tmpfs', '/app/data:uid=1000,gid=1000,mode=0700',
                '-e', 'DATABASE_URL=postgres://mbt_test:mbt_test_password@db:5432/mbt_test',
                '-e', 'MBT_TEST_ISOLATED=1', '-e', 'NODE_ENV=test', '-e', 'NETSUITE_DIRECT_ACCESS_ENABLED=false',
                '-e', 'NETSUITE_MIRROR_ROLE=disabled', '-e', 'SMART_SCM_LIVE_EXECUTION_ENABLED=false',
                '-e', 'MBT_NETSUITE_WRITES_ENABLED=false', '-e', 'SAMSARA_WRITES_ENABLED=false']
        for folder in ['test', 'tools']:
            BASE += ['--mount', f'type=bind,src={SERVER/folder},dst=/app/{folder},readonly']
        BASE += ['--mount', f'type=bind,src={SERVER/"package.json"},dst=/app/package.json,readonly',
                 '--mount', f'type=bind,src={OUT},dst=/app/test-artifacts/noninventory-fulfillment']
        # Existing suite writes artifacts at several subpaths; use this run's isolated root.
        BASE += ['--mount', f'type=bind,src={OUT/"artifacts"},dst=/app/test-artifacts']
        source = OUT/'before' if mode in ['baseline', 'red'] else SERVER
        assert run(mode+'-migrate', ['src/migrate.js'], source)['exit'] == 0
        if mode == 'baseline':
            red = run('red', ['--test', '--test-concurrency=1', *TESTS], source)
            assert red['exit'] == 1 and red['fail'] > 0
            run('baseline-full', ['tools/noninventory-fulfillment-tests.mjs'], source)
        elif mode == 'red':
            red = run('red', ['--test', '--test-concurrency=1', *TESTS], source)
            assert red['exit'] == 1 and red['fail'] > 0
        elif mode == 'focused':
            coverage = OUT/'coverage'; coverage.mkdir(exist_ok=True)
            for file in coverage.glob('*.json'): file.unlink()
            assert run('focused', ['--test', '--test-concurrency=1', *TESTS], env={'NODE_V8_COVERAGE': '/app/test-artifacts/noninventory-fulfillment/coverage'})['exit'] == 0
        elif mode == 'check':
            changes()
            assert run('static', ['tools/noninventory-fulfillment-checks.mjs', 'static'])['exit'] == 0
            assert run('mutations', ['tools/noninventory-fulfillment-checks.mjs', 'mutations'])['exit'] == 0
        elif mode == 'final':
            changes()
            coverage = OUT/'coverage'; coverage.mkdir(exist_ok=True)
            for file in coverage.glob('*.json'): file.unlink()
            assert run('focused', ['--test', '--test-concurrency=1', *TESTS], env={'NODE_V8_COVERAGE': '/app/test-artifacts/noninventory-fulfillment/coverage'})['exit'] == 0
            current = run('final-full', ['tools/noninventory-fulfillment-tests.mjs'])
            before_text = (OUT/'baseline-full.log').read_text()
            before = json.loads((OUT/'baseline-full.json').read_text())
            before['failures'] = re.findall(r'^not ok \d+ - (.+)$', before_text, re.M)
            before['failures'] += [re.sub(r' \([\d.]+ms\)$', '', name) for name in re.findall(r'^✖ (.+)$', before_text, re.M) if name != 'failing tests:']
            before.update({key: sum(map(int, re.findall(r'^(?:#|ℹ) '+key+r' (\d+)$', before_text, re.M))) for key in ['tests', 'pass', 'fail', 'skipped']})
            (OUT/'baseline-full.json').write_text(json.dumps(before, indent=2)+'\n')
            assert current['exit'] in [0, 1] and before['exit'] in [0, 1], 'Incomplete regression run'
            assert current['tests'] == before['tests'], 'Regression test count changed'
            assert sorted(current['failures']) == sorted(before['failures']), 'New or changed full-suite failures'
            assert run('reverse-focused', ['--test', '--test-concurrency=1', *reversed(TESTS)])['exit'] == 0
            assert run('static', ['tools/noninventory-fulfillment-checks.mjs', 'static'])['exit'] == 0
            assert run('mutations', ['tools/noninventory-fulfillment-checks.mjs', 'mutations'])['exit'] == 0
            (OUT/'verified-hashes.json').write_text(json.dumps(hashes(), indent=2)+'\n')
        else:
            raise ValueError(mode)
    finally:
        subprocess.run(['sudo', '-n', 'docker', 'rm', '-f', db], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(['sudo', '-n', 'docker', 'network', 'rm', network], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

if __name__ == '__main__':
    OUT.mkdir(exist_ok=True)
    (OUT/'artifacts').mkdir(exist_ok=True)
    os.chmod(OUT/'artifacts', 0o777)
    if sys.argv[1] == 'snapshot': snapshot()
    else: isolated(sys.argv[1])
