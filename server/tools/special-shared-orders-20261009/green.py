"""Run focused checks in a separate disposable database alongside the baseline."""
import json
from pathlib import Path
import signal
import subprocess

REPO = Path(__file__).resolve().parents[3]
OUT = REPO / 'server/test-artifacts/special-shared-orders-20261009'
DOCKER = ['sudo', '-n', 'docker']
PROJECT = 'mbbs-special-shared-orders-20261009'
COMPOSE = DOCKER + ['compose', '--project-name', PROJECT, '--project-directory', str(REPO),
                   '-f', str(REPO / 'docker-compose.mbt-test.yml'), '-f', str(OUT / 'compose.test.json')]
DATABASE = 'postgres://mbt_test:mbt_test_password@mbbs-special-review-db:5432/mbt_green'  # secret-scan: allow -- disposable test credentials

def run(name, args):
    with (OUT / (name + '.log')).open('w') as log:
        result = subprocess.run(args, cwd=REPO, stdout=log, stderr=subprocess.STDOUT)
    print(json.dumps({'stage': name, 'exit': result.returncode}), flush=True)
    if result.returncode:
        print((OUT / (name + '.log')).read_text()[-4000:], flush=True)
    return result.returncode

def interrupted(_signal, _frame):
    raise KeyboardInterrupt('Remove the focused test container and database')

signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
# The parent baseline runner owns the shared Compose project's final teardown.
# Register cleanup of this exact one-off runner and database before creating either.
name = PROJECT + '-focused'
try:
    assert run('green-create', COMPOSE + ['exec', '-T', 'db', 'psql', '-U', 'mbt_test', '-d', 'mbt_test', '-c', 'CREATE DATABASE mbt_green']) == 0
    assert run('green-migrate', COMPOSE + ['run', '--rm', '--no-deps', '-T', '--name', name, '-e', 'DATABASE_URL=' + DATABASE, 'migrate']) == 0
    raise SystemExit(run('green-runner', COMPOSE + ['run', '--rm', '--no-deps', '-T', '--name', name, '-e', 'DATABASE_URL=' + DATABASE,
                                               'test', 'node', 'tools/special-shared-orders-20261009/check.mjs', 'green']))
finally:
    subprocess.run(DOCKER + ['rm', '-f', '-v', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    run('green-drop', COMPOSE + ['exec', '-T', 'db', 'psql', '-U', 'mbt_test', '-d', 'mbt_test', '-c', 'DROP DATABASE IF EXISTS mbt_green WITH (FORCE)'])
    active = subprocess.check_output(DOCKER + ['ps', '--filter', 'name=' + name, '--format', '{{.Names}}']).decode().strip()
    all_containers = subprocess.check_output(DOCKER + ['ps', '-a', '--filter', 'name=' + name, '--format', '{{.Names}}']).decode().strip()
    assert not active and not all_containers
    (OUT / 'cleanup-focused.json').write_text(json.dumps({'runnerRemoved': True, 'databaseRemoved': True}))
