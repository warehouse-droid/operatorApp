"""Run direct-shipment checks against a private, internal-only production copy."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
ARTIFACT = ROOT / 'test-artifacts/direct-ship-lifecycle-20260925'
LATEST_BACKUP = ROOT / 'test-artifacts/direct-ship-deployment-20260926-v2/postgres-before.dump'
SNAPSHOT = Path(os.environ.get('DIRECT_SHIP_SNAPSHOT', str(LATEST_BACKUP if LATEST_BACKUP.is_file() else ARTIFACT / 'production-snapshot.dump')))
FROZEN_SOURCE = ROOT / 'test-artifacts/direct-ship-deployment-20260926-v2/source'
SOURCE = FROZEN_SOURCE if FROZEN_SOURCE.is_dir() else ROOT
MANIFEST = FROZEN_SOURCE.parent / 'manifest.json'
IMAGE = os.environ.get('DIRECT_SHIP_REPLAY_IMAGE') or (
    json.loads(MANIFEST.read_text())['imageId'] if MANIFEST.is_file() else 'field-sales-check-2941306:latest')
NETWORK = 'mbbs-direct-ship-replay-' + str(os.getpid())
DATABASE = NETWORK + '-db'


def docker(*args, **kwargs):
    return subprocess.run(['sudo', '-n', 'docker', *args], check=True, **kwargs)


def run():
    assert SNAPSHOT.is_file() and SNAPSHOT.stat().st_size > 1_000_000
    docker('image', 'inspect', IMAGE, stdout=subprocess.DEVNULL)
    docker('network', 'create', '--internal', NETWORK, stdout=subprocess.DEVNULL)
    try:
        docker('run', '-d', '--name', DATABASE, '--network', NETWORK, '--network-alias', 'db',
               '--tmpfs', '/var/lib/postgresql', '-e', 'POSTGRES_USER=mbt_test',
               '-e', 'POSTGRES_PASSWORD=mbt_test_password', '-e', 'POSTGRES_DB=mbt_test',
               'postgres:18-alpine', stdout=subprocess.DEVNULL)
        for _ in range(60):
            ready = subprocess.run(['sudo', '-n', 'docker', 'exec', DATABASE, 'pg_isready', '-U', 'mbt_test'],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if ready.returncode == 0:
                break
            time.sleep(.5)
        with SNAPSHOT.open('rb') as data, (ARTIFACT / 'replay-restore.log').open('wb') as output:
            docker('exec', '-i', DATABASE, 'pg_restore', '-U', 'mbt_test', '-d', 'mbt_test',
                   '--no-owner', '--no-acl', '--exit-on-error', stdin=data, stdout=output, stderr=subprocess.STDOUT)
        args = ['run', '--rm', '--pull', 'never', '--user', '0:0', '--network', NETWORK, '--cpus=2', '--ipc=host']
        environment = {
            'DATABASE_URL': 'postgres://mbt_test:mbt_test_password@db:5432/mbt_test',
            'MBBS_ENV_FILE': '/nonexistent', 'NODE_ENV': 'test', 'MBT_TEST_ISOLATED': '1', 'MBT_ENABLED': 'true',
            'NETSUITE_DIRECT_ACCESS_ENABLED': 'false', 'SAMSARA_WRITES_ENABLED': 'false',
            'MBT_NETSUITE_WRITES_ENABLED': 'false', 'SMART_SCM_LIVE_EXECUTION_ENABLED': 'false',
            'DISPATCH_PLANNER_ORDER_POOL_MODE': 'off', 'MBBS_SERVER_ROOT': '/app', 'MBBS_REPO_ROOT': '/workspace',
            'DIRECT_SHIP_SNAPSHOT_NAME': str(SNAPSHOT.relative_to(ROOT)),
        }
        for key, value in environment.items():
            args += ['-e', key + '=' + value]
        for directory in ['src', 'public', 'migrations', 'tools', 'test', 'contracts']:
            base = ROOT if directory in ['tools', 'test'] else SOURCE
            args += ['-v', f'{base / directory}:/app/{directory}:ro']
        args += ['-v', f'{ROOT}:/workspace/server:ro', '-v', f'{ARTIFACT}:/app/test-artifacts']
        args += ['--entrypoint', 'node', IMAGE]
        with (ARTIFACT / 'replay-migrate.log').open('wb') as output:
            docker(*args, 'src/migrate.js', stdout=output, stderr=subprocess.STDOUT)
        print(json.dumps({'productionCopyReady': True, 'network': 'internal-only', 'runtimeImage': IMAGE}), flush=True)
        docker(*args, *(sys.argv[1:] or ['tools/direct-ship-replay.mjs']))
    finally:
        subprocess.run(['sudo', '-n', 'docker', 'rm', '-f', DATABASE], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(['sudo', '-n', 'docker', 'network', 'rm', NETWORK], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == '__main__':
    run()
