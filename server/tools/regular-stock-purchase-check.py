"""Reproduce the Purchase gauntlet in disposable PostgreSQL and Node containers.

Prerequisites: Dockerfile.test test-base and test-e2e images tagged
mbbs-regular-v2:test and mbbs-regular-v2:e2e, plus the existing isolated test
runner/database containers. No production database or network is used.
"""
import hashlib
import json
import subprocess
import time
import uuid
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1]
OUT = SERVER / 'test-artifacts/regular-stock-purchase'
OUT.mkdir(parents=True, exist_ok=True)

def docker(*args):
    return subprocess.check_output(['sudo', '-n', 'docker', *args])

runner = json.loads(docker('inspect', 'mbbs-regular-v2-runner'))[0]
environment = dict(value.split('=', 1) for value in runner['Config']['Env'])
assert environment['MBT_TEST_ISOLATED'] == '1'
assert environment['NETSUITE_DIRECT_ACCESS_ENABLED'] == 'false'
environment['DATABASE_URL'] = 'postgres://mbt_test:mbt_test_password@db:5432/mbt_test'
database_image = json.loads(docker('inspect', 'mbbs-regular-v2-db-1'))[0]['Image']
images = {name: json.loads(docker('image', 'inspect', name))[0]['Id']
          for name in ['mbbs-regular-v2:test', 'mbbs-regular-v2:e2e']}
files = json.loads((SERVER / 'tools/regular-stock-purchase-files.json').read_text())
files += [str(path.relative_to(SERVER)) for path in (SERVER / 'tools').glob('regular-stock-purchase*')]
files += [str(path.relative_to(SERVER)) for path in (SERVER / 'test/mbt').glob('*/regular-stock-purchase*.js')]
files += ['test/regular-stock-purchase-spec.md', 'test/regular-stock-purchase.changes.patch',
          'package.json', 'package-lock.json']
hashes = {file: hashlib.sha256((SERVER / file).read_bytes()).hexdigest() for file in sorted(set(files))}
tree_hash = hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest()
report = {'sourceTreeSha256': tree_hash, 'files': hashes, 'images': images,
          'databaseImage': database_image, 'layers': []}
name = 'mbbs-purchase-gauntlet-' + uuid.uuid4().hex[:10]
network, database = name + '-internal', name + '-db'

def layer(name, command, browser=False, extra_environment=None):
    arguments = ['sudo', '-n', 'docker', 'run', '--rm', '--network', network,
                 '--read-only', '--tmpfs', '/tmp:uid=1000,gid=1000,mode=1777',
                 '--tmpfs', '/app/data:uid=1000,gid=1000,mode=0700']
    for key, value in {**environment, **(extra_environment or {})}.items():
        arguments += ['-e', key + '=' + value]
    for path in ['src', 'public', 'migrations', 'tools', 'test', 'package.json', 'package-lock.json']:
        arguments += ['-v', str(SERVER / path) + ':/app/' + path + ':ro']
    arguments += ['-v', str(OUT) + ':/app/test-artifacts',
                  '-v', str(OUT) + ':/app/test-artifacts/regular-stock-purchase']
    image = images['mbbs-regular-v2:e2e' if browser else 'mbbs-regular-v2:test']
    started = time.monotonic()
    with (OUT / (name + '.log')).open('wb') as log:
        result = subprocess.run(arguments + [image] + command, cwd=SERVER,
                                stdout=log, stderr=subprocess.STDOUT)
    record = {'layer': name, 'exitCode': result.returncode,
              'seconds': round(time.monotonic() - started, 2)}
    report['layers'].append(record)
    (OUT / 'gauntlet.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(record), flush=True)
    assert result.returncode == 0, 'Inspect ' + str(OUT / (name + '.log'))

try:
    docker('network', 'create', '--internal', network)
    docker('run', '-d', '--name', database, '--network', network, '--network-alias', 'db',
           '--tmpfs', '/var/lib/postgresql', '-e', 'POSTGRES_DB=mbt_test',
           '-e', 'POSTGRES_USER=mbt_test', '-e', 'POSTGRES_PASSWORD=mbt_test_password',
           '-e', 'PGDATA=/var/lib/postgresql/data', database_image)
    for attempt in range(60):
        ready = subprocess.run(['sudo', '-n', 'docker', 'exec', database, 'pg_isready',
                                '-U', 'mbt_test', '-d', 'mbt_test'], capture_output=True)
        if ready.returncode == 0:
            break
        time.sleep(.5)
    else:
        raise RuntimeError('Disposable PostgreSQL failed to start')
    layer('migrations', ['node', 'src/migrate.js'])
    layer('static', ['node', 'tools/regular-stock-purchase-static.mjs'])
    layer('regression-coverage', ['node', 'tools/regular-stock-purchase-coverage.mjs', '--collect'])
    (OUT / 'regression-ordered.json').write_bytes((OUT / 'regression.json').read_bytes())
    (OUT / 'regression-ordered.log').write_bytes((OUT / 'regression.log').read_bytes())
    layer('randomized-regression', ['node', 'tools/regular-stock-purchase-tests.mjs'],
          extra_environment={'REGULAR_PURCHASE_SUITE_SEED': '20260930'})
    (OUT / 'regression-randomized.json').write_bytes((OUT / 'regression.json').read_bytes())
    (OUT / 'regression-randomized.log').write_bytes((OUT / 'regression.log').read_bytes())
    layer('mutations', ['node', 'tools/regular-stock-purchase-mutations.mjs'])
    raw = OUT / 'browser-node-v8-final'
    if raw.exists():
        for artifact in raw.glob('coverage-*.json'):
            artifact.unlink()
    layer('browser', ['node', 'tools/regular-stock-purchase-browser.mjs'], browser=True,
          extra_environment={'NODE_V8_COVERAGE': '/app/test-artifacts/regular-stock-purchase/browser-node-v8-final'})
    layer('browser-server-coverage', ['node', 'tools/regular-stock-purchase-coverage.mjs', '--collect-browser'])
    layer('changed-lines', ['node', 'tools/regular-stock-purchase-coverage.mjs'])
    layer('secrets', ['node', 'test/support/scan-diff-secrets.mjs', '--unified-diff',
                     'test/regular-stock-purchase.changes.patch',
                     *[file for file in files if file.startswith('tools/regular-stock-purchase')
                       or file.startswith('test/mbt/')]])
    assert all(hashlib.sha256((SERVER / file).read_bytes()).hexdigest() == digest
               for file, digest in hashes.items()), 'Source changed during the final gauntlet'
    report['complete'] = True
    (OUT / 'gauntlet.json').write_text(json.dumps(report, indent=2) + '\n')
finally:
    subprocess.run(['sudo', '-n', 'docker', 'rm', '-f', database],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(['sudo', '-n', 'docker', 'network', 'rm', network],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
