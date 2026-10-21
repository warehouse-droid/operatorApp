"""Run real PostgreSQL cache fence and authenticated endpoint checks in isolation."""
import json
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'test-artifacts/special-status-following-20261005'
NET = 'mbbs-special-status-following-test-net'
DB = 'mbbs-special-status-following-test-db'
RUNNER = 'mbbs-special-status-following-db-runner'
IMAGE = 'sha256:b36611e8d01bdd5cef6e030735a25fe0f8bc0ac2fa4d02de331fb66946029242'
PG = 'postgres:18-alpine@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15'


def call(args, **kwargs):
    return subprocess.run(['docker', *args], capture_output=True, text=True, **kwargs)


budget = ['--init', '--cgroup-parent=mbbs-tests.slice', '--memory=1g', '--memory-swap=1g',
          '--cpus=1', '--pids-limit=512', '--label', 'com.mbbs.lifecycle=disposable-test']
try:
    call(['network', 'create', '--internal', NET], check=True)
    call(['run', '--rm', '-d', '--name', DB, '--network', NET, '--network-alias', 'status-db', *budget,
          '--tmpfs', '/var/lib/postgresql:rw,size=512m', '--tmpfs', '/tmp:rw,size=64m',
          '-e', 'POSTGRES_DB=mbt_verify', '-e', 'POSTGRES_USER=status_test', '-e', 'POSTGRES_PASSWORD=status_test',
          PG, '-c', 'max_locks_per_transaction=512'], check=True)
    for _ in range(30):
        if call(['exec', DB, 'pg_isready', '-U', 'status_test', '-d', 'mbt_verify']).returncode == 0:
            break
        time.sleep(1)
    else:
        raise RuntimeError('Isolated PostgreSQL did not become ready')
    args = ['run', '--rm', '--name', RUNNER, '--network', NET, *budget, '--workdir', '/app', '--tmpfs', '/tmp:rw,size=512m',
            '-e', 'DATABASE_URL=postgres://status_test:status_test@status-db:5432/mbt_verify',
            '-e', 'NODE_ENV=test', '-e', 'MBT_TEST_ISOLATED=1', '-e', 'NETSUITE_DIRECT_ACCESS_ENABLED=false',
            '-e', 'NETSUITE_MIRROR_ROLE=source', '-e', 'MBBS_ENV_FILE=.env.special-status-tests']
    for directory in ['src', 'public', 'test', 'tools', 'migrations']:
        args += ['--mount', f'type=bind,src={ROOT / directory},dst=/app/{directory},readonly']
    for filename in ['package.json', 'netsuite-smart-scm-picking-ticket-restlet.js']:
        args += ['--mount', f'type=bind,src={ROOT / filename},dst=/app/{filename},readonly']
    args += ['--mount', f'type=bind,src={ROOT / "tools/special-status-following-20261005/test.env"},dst=/app/.env.special-status-tests,readonly',
             '--mount', f'type=bind,src={OUT},dst=/app/test-artifacts/special-status-following-20261005', IMAGE,
             'node', 'tools/special-status-following-20261005/db_gauntlet.mjs']
    result = call(args)
    (OUT / 'db-runner.log').write_text(result.stdout + result.stderr)
    print(json.dumps({'exitCode': result.returncode, 'output': (result.stdout + result.stderr)[-5000:]}))
    if result.returncode:
        raise RuntimeError('Database gauntlet failed')
finally:
    for name in [RUNNER, DB]:
        call(['rm', '-f', '-v', name])
    call(['network', 'rm', NET])
