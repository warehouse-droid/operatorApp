"""Isolated checks. No production environment or external network is mounted."""
import json
import difflib
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1]
OUT = SERVER / 'test-artifacts/regular-stock-delivery-memo'
OUT.mkdir(parents=True, exist_ok=True)
docker = lambda *args: subprocess.check_output(['sudo', '-n', 'docker', *args])
runner = json.loads(docker('inspect', 'mbbs-regular-v2-runner'))[0]
env = dict(value.split('=', 1) for value in runner['Config']['Env'])
assert env['MBT_TEST_ISOLATED'] == '1' and env['NETSUITE_DIRECT_ACCESS_ENABLED'] == 'false'
network = 'mbbs-delivery-memo-internal-' + str(os.getpid())
db = 'mbbs-delivery-memo-db-' + str(os.getpid())
mode = sys.argv[1] if len(sys.argv) > 1 else 'all'
files = json.loads((SERVER / 'tools/regular-stock-delivery-memo-files.json').read_text())
patch = ''
changed = {}
for file in files:
    old_path = OUT / 'before' / file
    old = old_path.read_text().splitlines(True) if old_path.exists() else []
    new = (SERVER / file).read_text().splitlines(True) if (SERVER / file).exists() else []
    patch += ''.join(difflib.unified_diff(old, new, fromfile='a/server/' + file, tofile='b/server/' + file))
    changed[file] = [number + 1 for tag, _a, _b, start, end in difflib.SequenceMatcher(None, old, new).get_opcodes()
                     if tag in ('insert', 'replace') for number in range(start, end)]
(SERVER / 'test/regular-stock-delivery-memo.changes.patch').write_text(patch)
(OUT / 'changed-source-lines.json').write_text(json.dumps(changed, indent=2))
if mode == 'all':
    for name in ['checks.json', 'browser.json', 'browser-coverage.json', 'changed-lines.json']:
        (OUT / name).unlink(missing_ok=True)
    shutil.rmtree(OUT / 'coverage', ignore_errors=True)
layers = []
try:
    docker('network', 'create', '--internal', network)
    docker('run', '-d', '--name', db, '--network', network, '--network-alias', 'db', '--tmpfs', '/var/lib/postgresql',
           '-e', 'POSTGRES_DB=mbt_test', '-e', 'POSTGRES_USER=mbt_test', '-e', 'POSTGRES_PASSWORD=mbt_test_password',
           '-e', 'PGDATA=/var/lib/postgresql/data', 'postgres:18-alpine')
    for attempt in range(60):
        if subprocess.run(['sudo', '-n', 'docker', 'exec', db, 'pg_isready', '-U', 'mbt_test', '-d', 'mbt_test'], capture_output=True).returncode == 0:
            break
        time.sleep(.5)
    else:
        raise RuntimeError('Disposable database did not start')
    args = ['sudo', '-n', 'docker', 'run', '--rm', '--network', network, '--read-only',
            '--tmpfs', '/tmp:uid=1000,gid=1000,mode=1777', '--tmpfs', '/app/data:uid=1000,gid=1000,mode=0700']
    for key, value in env.items():
        args += ['-e', key + '=' + value]
    for path in ['src', 'public', 'migrations', 'tools', 'test', 'package.json']:
        args += ['-v', str(SERVER / path) + ':/app/' + path + ':ro']
    args += ['-v', str(OUT) + ':/app/test-artifacts']
    focused = ['node', '--test', '--test-concurrency=1', 'test/mbt/unit/regular-stock-delivery-memo.test.js',
               'test/mbt/integration/regular-stock-external-workflow.test.js']
    commands = [('migrations', ['node', 'src/migrate.js']), ('focused', focused)]
    if mode == 'all':
        commands += [('regressions', ['node', 'node_modules/c8/bin/c8.js', '--all=false', '--check-coverage=false',
                                     *['--include=' + file for file in files if file.endswith('.js')], '--reporter=json', '--reporter=text-summary',
                                     '--reports-dir=test-artifacts/coverage', '--temp-directory=/tmp/delivery-coverage',
                                     'node', 'tools/regular-stock-v2-tests.mjs']),
                     ('constraints', ['node', 'tools/regular-stock-delivery-memo-check.mjs'])]
    if mode == 'constraints':
        commands = [commands[0], ('constraints', ['node', 'tools/regular-stock-delivery-memo-check.mjs'])]
    for name, command in commands:
        started = time.monotonic()
        log_path = OUT / (mode + '-' + name + '.log')
        with log_path.open('wb') as log:
            result = subprocess.run(args + ['mbbs-regular-v2:test'] + command,
                                    cwd=SERVER, stdout=log, stderr=subprocess.STDOUT)
        record = {'layer': name, 'exitCode': result.returncode, 'seconds': round(time.monotonic() - started, 2)}
        layers.append(record)
        print(json.dumps(record), flush=True)
        (OUT / (mode + '-results.json')).write_text(json.dumps(layers, indent=2) + '\n')
        if result.returncode:
            print(log_path.read_text()[-9000:], flush=True)
            sys.exit(result.returncode)
finally:
    subprocess.run(['sudo', '-n', 'docker', 'rm', '-f', db], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(['sudo', '-n', 'docker', 'network', 'rm', network], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
