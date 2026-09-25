"""Exercise both actual release images and rollback against a disposable DB."""
import datetime
import json
import os
from pathlib import Path
import subprocess
import time

SERVER = Path(__file__).resolve().parents[1]
RELEASE = SERVER / 'test-artifacts/netsuite-priority-deployment-20260925'
state = json.loads((RELEASE / 'manifest.json').read_text())
prefix = 'mbbs-priority-smoke-' + str(os.getpid())
network, db = prefix, prefix + '-db'
containers = []
env = {
    'DATABASE_URL': 'postgres://mbt_test:mbt_test_password@db:5432/mbt_test',
    'MBBS_ENV_FILE': '/nonexistent', 'NODE_ENV': 'test', 'MBT_TEST_ISOLATED': '1',
    'MBT_ENABLED': 'true', 'NETSUITE_DIRECT_ACCESS_ENABLED': 'false',
    'SAMSARA_WRITES_ENABLED': 'false', 'MBT_NETSUITE_WRITES_ENABLED': 'false',
    'SMART_SCM_LIVE_EXECUTION_ENABLED': 'false', 'DISPATCH_PLANNER_ORDER_POOL_MODE': 'off',
}


def docker(*args, input=None, check=True):
    return subprocess.run(['sudo', '-n', 'docker', *args], input=input, text=True,
                          capture_output=True, check=check, timeout=60)


def run_args():
    args = ['--network', network]
    for key, value in env.items():
        args += ['-e', key + '=' + value]
    return args


def sql(query):
    return docker('exec', '-i', db, 'psql', '-U', 'mbt_test', '-d', 'mbt_test',
                  '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', input=query).stdout.strip()


def boot(label, images):
    running = {}
    for service, image in images.items():
        container = prefix + '-' + label + '-' + service
        containers.append(container)
        command = ['node', 'src/netsuite-order-webhook-worker.js'] if service == 'webhook-worker' else ['node', 'src/server.js']
        docker('run', '-d', '--name', container, *run_args(), image, *command)
        running[service] = container
    probe = "const r=await fetch('http://127.0.0.1:3000/health');if(!r.ok||(await r.json()).ok!==true)process.exit(1);"
    for _ in range(60):
        result = docker('exec', running['app'], 'node', '--input-type=module', '-e', probe, check=False)
        if result.returncode == 0:
            break
        time.sleep(0.25)
    else:
        raise RuntimeError(label + ' app failed startup')
    for service, container in running.items():
        status = json.loads(docker('inspect', container).stdout)[0]
        assert status['State']['Running'] and status['RestartCount'] == 0
        logs = docker('logs', container)
        (RELEASE / ('smoke-' + label + '-' + service + '.log')).write_text(logs.stdout + logs.stderr)
        if service == 'webhook-worker':
            assert 'serial worker ' in logs.stdout and ' started.' in logs.stdout
    return running


docker('network', 'create', '--internal', network)
try:
    containers.append(db)
    docker('run', '-d', '--name', db, '--network', network, '--network-alias', 'db',
           '--tmpfs', '/var/lib/postgresql', '-e', 'POSTGRES_USER=mbt_test',
           '-e', 'POSTGRES_PASSWORD=mbt_test_password', '-e', 'POSTGRES_DB=mbt_test', 'postgres:18-alpine')
    for _ in range(50):
        if docker('exec', db, 'pg_isready', '-U', 'mbt_test', check=False).returncode == 0:
            break
        time.sleep(0.2)
    app_image = state['services']['app']['candidateImageId']
    for iteration in range(2):
        result = docker('run', '--rm', *run_args(), app_image, 'node', 'src/migrate.js')
        (RELEASE / f'smoke-migration-{iteration}.log').write_text(result.stdout + result.stderr)
    assert sql("SELECT count(*) FROM schema_migrations WHERE filename='227_netsuite_request_priority.sql';") == '1'
    candidate = boot('candidate', {service: row['candidateImageId'] for service, row in state['services'].items()})
    # These callbacks never call NetSuite or create a business document. They
    # prove both actual images coordinate against one DB, with Operator capacity.
    held = """import {netSuiteRequestScheduler as scheduler} from './src/netsuite-request-scheduler.js';
await scheduler.run(async()=>{console.log('background-entered');await new Promise(resolve=>setTimeout(resolve,5000));}, {priority:'background'});
console.log('background-finished');
"""
    background = subprocess.Popen(['sudo', '-n', 'docker', 'exec', '-i', candidate['webhook-worker'], 'node', '--input-type=module'],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    background.stdin.write(held)
    background.stdin.close()
    assert background.stdout.readline().strip() == 'background-entered'
    probe = """import assert from 'node:assert/strict';
import {netSuiteRequestScheduler as scheduler} from './src/netsuite-request-scheduler.js';
import {withOperatorNetSuitePriority} from './src/operator-netsuite-request-pool.js';
import {query,closeDb} from './src/db.js';
const start=performance.now();
const counts=await withOperatorNetSuitePriority(()=>scheduler.run(async()=>{
 const {rows:[row]}=await query(`SELECT count(*)::int AS total,
 count(*) FILTER(WHERE priority=0)::int AS background,
 count(*) FILTER(WHERE priority=1)::int AS operator FROM netsuite_request_queue WHERE state='running'`);
 assert.deepEqual(row,{total:2,background:1,operator:1});return row;
}));
console.log(JSON.stringify({counts,operatorCompletedWhileWorkerBackgroundHeld:true,elapsedMs:performance.now()-start}));
await closeDb();
"""
    priority = json.loads(docker('exec', '-i', candidate['app'], 'node', '--input-type=module', input=probe).stdout)
    background.wait(timeout=15)
    assert background.returncode == 0
    assert sql('SELECT count(*) FROM netsuite_request_queue;') == '0'
    for container in candidate.values():
        docker('stop', '--timeout', '10', container)
    rollback = boot('rollback', {service: row['live']['imageId'] for service, row in state['services'].items()})
    assert sql("SELECT to_regclass('public.netsuite_request_queue');") == 'netsuite_request_queue'
    result = {'passed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'network': 'internal-only', 'actualCandidateImages': {name: row['candidateImageId'] for name, row in state['services'].items()},
        'migrationRepeatable': True, 'candidateAppHealth': 200, 'candidateWorkerStarted': True,
        'crossContainerPriority': priority, 'reservationsCleaned': True,
        'rollbackAppHealthWithQueueTable': 200, 'rollbackWorkerStarted': True, 'liveNetSuiteWrites': 0}
    (RELEASE / 'release-smoke.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result), flush=True)
finally:
    for container in reversed(containers):
        docker('rm', '-f', container, check=False)
    docker('network', 'rm', network, check=False)
