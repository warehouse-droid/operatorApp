"""Start the exact app and worker image against an isolated, empty database."""
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import time

spec = importlib.util.spec_from_file_location('deployment', Path(__file__).with_name('order-update-save-deploy.py'))
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)
run, inspect, save = deployment.run, deployment.inspect, deployment.save
release = deployment.RELEASE
image = deployment.read('manifest.json')['imageId']
network = f'order-update-image-smoke-{os.getpid()}'
database, application, worker = [network + suffix for suffix in ['-db', '-app', '-worker']]

try:
    for attempt in range(10):
        block = secrets.randbelow(8192) * 8
        result = subprocess.run(['docker', 'network', 'create', '--internal', '--subnet',
                                 f'10.244.{block // 256}.{block % 256}/29', network], capture_output=True)
        if result.returncode == 0: break
    else: raise RuntimeError('Could not allocate disposable test network')
    run('docker', 'run', '-d', '--name', database, '--network', network, '--network-alias', 'db',
        '--tmpfs', '/var/lib/postgresql', '-e', 'POSTGRES_USER=mbt_test', '-e', 'POSTGRES_PASSWORD=mbt_test_password',
        '-e', 'POSTGRES_DB=mbt_test', 'postgres:18-alpine')
    for _ in range(30):
        result = subprocess.run(['docker', 'exec', database, 'pg_isready', '-U', 'mbt_test', '-d', 'mbt_test'], capture_output=True)
        if result.returncode == 0: break
        time.sleep(1)
    else: raise RuntimeError('Disposable database failed to start')
    env = ['-e', 'DATABASE_URL=postgres://mbt_test:mbt_test_password@db:5432/mbt_test',
           '-e', 'MBBS_ENV_FILE=/nonexistent', '-e', 'NODE_ENV=test', '-e', 'MBT_TEST_ISOLATED=1']
    with (release / 'image-migration.log').open('wb') as output:
        subprocess.run(['docker', 'run', '--rm', '--network', network, *env, '--entrypoint', 'node', image, 'src/migrate.js'],
                       stdout=output, stderr=subprocess.STDOUT, check=True)
    for name, entry in [(application, 'src/server.js'), (worker, 'src/netsuite-order-webhook-worker.js')]:
        run('docker', 'run', '-d', '--name', name, '--network', network, *env, '--entrypoint', 'node', image, entry)
    probe = "fetch('http://127.0.0.1:3000/health').then(async r=>{if(!r.ok||(await r.json()).ok!==true)process.exit(1)}).catch(()=>process.exit(1))"
    for _ in range(40):
        result = subprocess.run(['docker', 'exec', application, 'node', '-e', probe], capture_output=True)
        if result.returncode == 0: break
        time.sleep(0.5)
    else: raise RuntimeError('Candidate app failed health check')
    time.sleep(6)
    for name, label in [(application, 'app'), (worker, 'worker')]:
        assert inspect(name)[0]['State']['Running'], label
        logs = run('docker', 'logs', name, stderr=subprocess.STDOUT).decode()
        (release / f'image-{label}-startup.log').write_text(logs)
        assert not re.search(r'SyntaxError|ReferenceError|ERR_MODULE_NOT_FOUND|Dispatch maintenance (?:sweep )?failed', logs), label
        if label == 'worker': assert 'NetSuite order webhook serial worker' in logs and 'started.' in logs
    schema = run('docker', 'exec', database, 'psql', '-U', 'mbt_test', '-d', 'mbt_test', '-At', '-c',
                 "SELECT filename FROM schema_migrations WHERE filename='205_dispatch_plan_maintenance.sql'").decode().strip()
    assert schema == deployment.MIGRATION
    save('image-smoke.json', {'passed': True, 'imageId': image, 'appHealth': 200, 'workerStarted': True,
                              'migration': schema, 'externalNetwork': False})
    print(json.dumps({'passed': True, 'appHealth': 200, 'workerStarted': True}), flush=True)
finally:
    subprocess.run(['docker', 'rm', '-f', application, worker, database], capture_output=True)
    subprocess.run(['docker', 'network', 'rm', network], capture_output=True)
