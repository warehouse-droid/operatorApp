"""Rehearse unchanged schema, actual shared-planner startup and rollback in isolation."""
import json
import os
from pathlib import Path
import subprocess
import time

SERVER = Path(__file__).resolve().parents[1]
RELEASE = SERVER / 'test-artifacts/bin-planner-readonly-release-20260927'
info = json.loads((RELEASE / 'manifest.json').read_text())
prefix = 'mbbs-bin-reuse-smoke-' + str(os.getpid())
network, database = prefix, prefix + '-db'
containers = []
environment = {
    'DATABASE_URL': 'postgres://mbt_test:mbt_test_password@db:5432/mbt_test',
    'MBBS_ENV_FILE': '/nonexistent', 'NODE_ENV': 'test', 'MBT_TEST_ISOLATED': '1',
    'MBT_ENABLED': 'true', 'MBT_BIN_DISPATCH_ENABLED': 'true',
    'NETSUITE_DIRECT_ACCESS_ENABLED': 'false', 'SAMSARA_WRITES_ENABLED': 'false',
    'MBT_NETSUITE_WRITES_ENABLED': 'false', 'SMART_SCM_LIVE_EXECUTION_ENABLED': 'false',
    'DISPATCH_PLANNER_ORDER_POOL_MODE': 'off',
}


def docker(*args, input=None, check=True):
    return subprocess.run(['sudo', '-n', 'docker', *args], input=input, text=True, capture_output=True, check=check, timeout=60)


def options():
    args = ['--network', network]
    for name, value in environment.items():
        args += ['-e', name + '=' + value]
    return args


def sql(statement):
    return docker('exec', '-i', database, 'psql', '-U', 'mbt_test', '-d', 'mbt_test', '-XqAt',
                  '-v', 'ON_ERROR_STOP=1', input=statement).stdout.strip()


def boot(label, images):
    running = {}
    for service, image in images.items():
        name = prefix + '-' + label + '-' + service
        containers.append(name)
        command = 'src/netsuite-order-webhook-worker.js' if service == 'webhook-worker' else 'src/server.js'
        docker('run', '-d', '--name', name, *options(), image, 'node', command)
        running[service] = name
    probe = "const r=await fetch('http://127.0.0.1:3000/health');if(!r.ok||(await r.json()).ok!==true)process.exit(1);"
    for _ in range(60):
        if docker('exec', running['app'], 'node', '--input-type=module', '-e', probe, check=False).returncode == 0:
            break
        time.sleep(0.25)
    else:
        raise RuntimeError(label + ' startup failed')
    for service, name in running.items():
        row = json.loads(docker('inspect', name).stdout)[0]
        assert row['State']['Running'] and row['RestartCount'] == 0
        logs = docker('logs', name)
        text = logs.stdout + logs.stderr
        (RELEASE / f'smoke-{label}-{service}.log').write_text(text)
        assert not any(marker in text for marker in ['SyntaxError', 'ReferenceError', 'ERR_MODULE_NOT_FOUND'])
        if service == 'webhook-worker':
            assert 'serial worker ' in text and ' started.' in text
    return running


docker('network', 'create', '--internal', network)
try:
    containers.append(database)
    docker('run', '-d', '--name', database, '--network', network, '--network-alias', 'db',
           '--tmpfs', '/var/lib/postgresql', '-e', 'POSTGRES_USER=mbt_test', '-e', 'POSTGRES_PASSWORD=mbt_test_password',
           '-e', 'POSTGRES_DB=mbt_test', 'postgres:18-alpine')
    for _ in range(50):
        if docker('exec', database, 'pg_isready', '-U', 'mbt_test', check=False).returncode == 0:
            break
        time.sleep(0.2)
    base = info['services']['app']['imageId']
    migrated = docker('run', '--rm', *options(), base, 'node', 'src/migrate.js')
    (RELEASE / 'smoke-migrate-baseline.log').write_text(migrated.stdout + migrated.stderr)
    seed = """import {createBinDispatchFixture} from './test/mbt/support/bin-dispatch-fixtures.js';
import {query,closeDb} from './src/db.js';
try{const f=await createBinDispatchFixture({label:'bin-release-migration',planDate:'2090-10-05',includePilotScope:false});
await query("UPDATE mbt_service_visits SET status='completed' WHERE service_visit_id=$1",[f.frontVisitId]);
const row=(await query('SELECT to_jsonb(v) AS snapshot FROM mbt_service_visits v WHERE service_visit_id=$1',[f.successorVisitId])).rows[0].snapshot;
console.log(JSON.stringify({visitId:f.successorVisitId,before:row}));}finally{await closeDb();}"""
    fixture = json.loads(docker('run', '--rm', '-i', *options(), '-v', str(SERVER / 'test') + ':/app/test:ro',
                                '--entrypoint', 'node', base, '--input-type=module', '-', input=seed).stdout)
    assert fixture['before']['status'] == 'tentative'
    for iteration in range(2):
        migrated = docker('run', '--rm', *options(), info['imageId'], 'node', 'src/migrate.js')
        (RELEASE / f'smoke-migrate-candidate-{iteration}.log').write_text(migrated.stdout + migrated.stderr)
    assert sql("SELECT count(*) FROM schema_migrations WHERE filename='235_mbt_bin_planning.sql';") == '1'
    after = json.loads(sql("SELECT to_jsonb(v) FROM mbt_service_visits v WHERE service_visit_id='" + fixture['visitId'] + "';"))
    assert after == fixture['before'], 'This UI correction must not backfill or change visits'
    for field, value in fixture['before'].items():
        if field not in ['status', 'revision', 'updated_at', 'updated_by']:
            assert after[field] == value, 'Migration changed existing visit field: ' + field
    assert sql("SELECT count(*) FROM mbt_bin_planning_events WHERE service_visit_id='" + fixture['visitId'] + "';") == '0'
    candidate = boot('candidate', {s: info['imageId'] for s in info['services']})
    probe = """import assert from 'node:assert/strict';
for(const path of ['/mbt/planning','/dispatch/planning'])assert.equal((await fetch('http://127.0.0.1:3000'+path)).status,200);
assert.equal((await fetch('http://127.0.0.1:3000/api/mbt/planning?planDate=2090-10-05')).status,401);
console.log(JSON.stringify({planningPages:200,anonymousPlanning:401}));"""
    assert json.loads(docker('exec', candidate['app'], 'node', '--input-type=module', '-e', probe).stdout)['planningPages'] == 200
    for name in candidate.values():
        docker('stop', '--timeout', '10', name)
    boot('rollback', {s: row['imageId'] for s, row in info['services'].items()})
    result = {'passed': True, 'candidateImageId': info['imageId'], 'candidateAppHealth': 200,
              'candidateWorkerStarted': True, 'migrationRepeatable': True, 'existingVisitsUnchanged': True,
              'requestedWindowsAndAssignmentsPreserved': True, 'rollbackAppHealth': 200,
              'rollbackWorkerStarted': True, 'network': 'internal-only'}
    (RELEASE / 'release-smoke.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result), flush=True)
finally:
    for name in reversed(containers):
        docker('rm', '-f', name, check=False)
    docker('network', 'rm', network, check=False)
