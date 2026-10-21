"""Isolated production-baseline/candidate checks; never mounts production credentials."""
import argparse
import hashlib
import io
import json
import subprocess
import tarfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / 'server'
OUT = SERVER / 'test-artifacts/regular-stock-kit'
FILES = json.loads((SERVER / 'tools/regular-stock-kit-spec.json').read_text())['setup']['runtimeFiles']
APP = 'mbbs-operator-app-app-1'


def docker(*args):
    return subprocess.check_output(['sudo', '-n', 'docker', *args])


def capture():
    OUT.mkdir(parents=True, exist_ok=True)
    baseline = OUT / 'live-before'
    assert not baseline.exists(), 'Baseline already captured'
    baseline.mkdir()
    before = json.loads(docker('inspect', APP))[0]
    for path in ['src', 'public', 'migrations', 'package.json', 'package-lock.json']:
        with tarfile.open(fileobj=io.BytesIO(docker('cp', APP + ':/app/' + path, '-'))) as archive:
            archive.extractall(baseline, filter='data')
    assert json.loads(docker('inspect', APP))[0]['Id'] == before['Id']
    for file in FILES:
        assert (baseline / file).read_bytes() == (SERVER / file).read_bytes(), file + ' differs from production'
    (OUT / 'baseline.json').write_text(json.dumps({
        'imageId': before['Image'], 'containerId': before['Id'],
        'packageSha256': hashlib.sha256((SERVER / 'package.json').read_bytes()).hexdigest(),
        'runtimeHashes': {file: hashlib.sha256((baseline / file).read_bytes()).hexdigest() for file in FILES}
    }, indent=2) + '\n')
    print(json.dumps({'baselineCaptured': True, 'runtimeFiles': len(FILES)}), flush=True)


def rebase():
    previous = json.loads((OUT / 'baseline.json').read_text())
    target = OUT / 'live-rebased'
    before = json.loads(docker('inspect', APP))[0]
    if not target.exists():
        target.mkdir()
        for path in ['src', 'public', 'migrations', 'package.json', 'package-lock.json']:
            with tarfile.open(fileobj=io.BytesIO(docker('cp', APP + ':/app/' + path, '-'))) as archive:
                archive.extractall(target, filter='data')
    else:
        assert previous.get('treeDirectory') == 'live-rebased' and before['Id'] == previous['containerId'], 'Rebase capture changed'
    assert json.loads(docker('inspect', APP))[0]['Id'] == before['Id']
    for file in FILES:
        assert hashlib.sha256((target / file).read_bytes()).hexdigest() == previous['runtimeHashes'][file], 'Overlapping live update: ' + file
    if not (OUT / 'baseline-original.json').exists():
        (OUT / 'baseline-original.json').write_text(json.dumps(previous, indent=2) + '\n')
    updated = {**previous, 'imageId': before['Image'], 'containerId': before['Id'], 'treeDirectory': 'live-rebased'}
    (OUT / 'baseline.json').write_text(json.dumps(updated, indent=2) + '\n')
    changed = [str(file.relative_to(target)) for folder in ['src', 'public', 'migrations'] for file in (target / folder).rglob('*')
               if file.is_file() and (not (OUT / 'live-before' / file.relative_to(target)).exists()
                  or (OUT / 'live-before' / file.relative_to(target)).read_bytes() != file.read_bytes())]
    (OUT / 'rebase.json').write_text(json.dumps({'newImageId': before['Image'], 'unrelatedChanges': changed}, indent=2) + '\n')
    print(json.dumps({'rebased': True, 'runtimeOverlap': False, 'unrelatedChanges': changed}), flush=True)


def check(mode):
    network = 'mbbs-regular-kit-' + mode + '-internal'
    database = 'mbbs-regular-kit-' + mode + '-db'
    layers = []
    target = OUT / mode
    target.mkdir(parents=True, exist_ok=True)
    baseline = OUT / json.loads((OUT / 'baseline.json').read_text()).get('treeDirectory', 'live-before')
    assert baseline.exists()
    try:
        subnet = {'baseline': '10.246.121.0/24', 'red': '10.246.122.0/24', 'final': '10.246.123.0/24', 'rebased': '10.246.124.0/24', 'baseline-random': '10.246.125.0/24', 'fixture-proof': '10.246.126.0/24', 'order': '10.246.127.0/24'}[mode]
        docker('network', 'create', '--internal', '--subnet', subnet, network)
        image = json.loads(docker('inspect', 'mbbs-regular-v2-db-1'))[0]['Image']
        docker('run', '-d', '--name', database, '--network', network, '--network-alias', 'db',
               '--tmpfs', '/var/lib/postgresql', '-e', 'POSTGRES_DB=mbt_test', '-e', 'POSTGRES_USER=mbt_test',
               '-e', 'POSTGRES_PASSWORD=mbt_test_password', '-e', 'PGDATA=/var/lib/postgresql/data', image)
        for _ in range(60):
            if subprocess.run(['sudo', '-n', 'docker', 'exec', database, 'pg_isready', '-U', 'mbt_test', '-d', 'mbt_test'], capture_output=True).returncode == 0:
                break
            time.sleep(.5)
        else:
            raise RuntimeError('Disposable database failed to start')
        args = ['sudo', '-n', 'docker', 'run', '--rm', '--network', network, '--read-only',
                '--tmpfs', '/tmp:uid=1000,gid=1000,mode=1777', '--tmpfs', '/app/data:uid=1000,gid=1000,mode=0700']
        env = {'NODE_ENV': 'test', 'MBT_TEST_ISOLATED': '1', 'MBBS_ENV_FILE': '.env.mbt-test-does-not-exist',
               'DATABASE_URL': 'postgres://mbt_test:mbt_test_password@db:5432/mbt_test', 'MBT_ENABLED': 'true',
               'NETSUITE_DIRECT_ACCESS_ENABLED': 'false', 'NETSUITE_MIRROR_ROLE': 'disabled',
               'SMART_SCM_LIVE_EXECUTION_ENABLED': 'false', 'NETSUITE_WEBHOOK_SECRET': 'mbt_test_webhook_stress_secret',
               'SAMSARA_WRITES_ENABLED': 'false', 'SALES_PUBLIC_ACCESS_ENABLED': 'false',
               'DISPATCH_PLANNER_ORDER_POOL_MODE': 'off', 'DISPATCH_PLANNER_COMMAND_MODE': 'off',
               'OLLAMA_BASE_URL': 'http://127.0.0.1:9'}
        for key, value in env.items():
            args += ['-e', key + '=' + value]
        for folder in ['src', 'public', 'migrations']:
            args += ['-v', str(baseline / folder) + ':/app/' + folder + ':ro']
        if mode in ['final', 'rebased', 'order']:
            for file in FILES:
                args += ['-v', str(SERVER / file) + ':/app/' + file + ':ro']
        for path in ['tools', 'test', 'package.json']:
            args += ['-v', str(SERVER / path) + ':/app/' + path + ':ro']
        args += ['-v', str(target) + ':/app/test-artifacts']
        commands = [('migrations', ['node', 'src/migrate.js'])]
        if mode == 'red':
            commands += [('kit-red', ['node', '--test', '--test-concurrency=1', 'test/mbt/unit/regular-stock-kit.test.js', 'test/mbt/integration/regular-stock-kit.test.js'])]
        elif mode == 'baseline-random':
            commands += [('random-order', ['node', 'tools/regular-stock-kit-suite.mjs', 'baseline', '--shuffle', '--include-kit-red'])]
        elif mode == 'fixture-proof':
            commands += [('fixture-proof', ['node', 'tools/regular-stock-kit-fixture-proof.mjs'])]
        elif mode == 'order':
            commands += [('random-order', ['node', 'tools/regular-stock-kit-suite.mjs', 'final', '--shuffle'])]
        else:
            commands += [('regressions', ['node', 'tools/regular-stock-kit-suite.mjs', 'final' if mode == 'rebased' else mode])]
        if mode == 'rebased':
            commands += [('random-order', ['node', 'tools/regular-stock-kit-suite.mjs', 'final', '--shuffle'])]
        if mode == 'final':
            commands += [('kit-gauntlet', ['node', 'tools/regular-stock-kit-gauntlet.mjs'])]
        for name, command in commands:
            started = time.monotonic()
            with (target / (name + '.log')).open('wb') as log:
                result = subprocess.run(args + ['mbbs-regular-v2:test'] + command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
            row = {'layer': name, 'exitCode': result.returncode, 'seconds': round(time.monotonic() - started, 2)}
            layers.append(row)
            (target / 'layers.json').write_text(json.dumps(layers, indent=2) + '\n')
            print(json.dumps(row), flush=True)
            assert result.returncode == (1 if mode == 'red' and name == 'kit-red' else 0), 'Inspect ' + str(target / (name + '.log'))
    finally:
        subprocess.run(['sudo', '-n', 'docker', 'rm', '-f', database], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(['sudo', '-n', 'docker', 'network', 'rm', network], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['capture', 'rebase', 'baseline', 'baseline-random', 'red', 'final', 'rebased', 'fixture-proof', 'order'])
    mode = parser.parse_args().mode
    capture() if mode == 'capture' else rebase() if mode == 'rebase' else check(mode)
