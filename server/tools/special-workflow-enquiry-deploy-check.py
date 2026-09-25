"""Exercise the frozen app and worker images on the existing isolated database."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import time

spec = importlib.util.spec_from_file_location('special_release', Path(__file__).with_name('special-workflow-enquiry-deploy.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
os.umask(0o077)
release.current()
manifest = release.read('manifest.json')
root, server, docker = release.RELEASE, release.SERVER, release.docker
tooling = root / 'tooling'
tooling.mkdir(exist_ok=True)
if not (tooling / 'node_modules').exists():
    docker('cp', 'mbbs-special-review-runner:/app/node_modules', str(tooling / 'node_modules'))
env = dict(value.split('=', 1) for value in release.inspect('mbbs-special-review-runner')[0]['Config']['Env'])
env.update(NODE_ENV='test', MBT_TEST_ISOLATED='1', MBT_ENABLED='true', NETSUITE_DIRECT_ACCESS_ENABLED='false',
           DATABASE_URL='postgres://mbt_test:special_review_only@mbbs-special-review-db:5432/mbt_verify',
           SPECIAL_WORKFLOW_OUTPUT='test-artifacts/special-workflow-enquiry/final', PLAYWRIGHT_BROWSERS_PATH='/browsers', SPECIAL_STOCK_PICKUP_METHOD_ID='1')
env_args = [item for key, value in env.items() for item in ['-e', key + '=' + value]]
worker_tests = [
    'test/mbt/unit/special-stock-request-domain.red.test.js', 'test/mbt/unit/special-stock-request-netsuite.red.test.js',
    'test/mbt/unit/special-stock-request-policy.red.test.js', 'test/mbt/unit/special-stock-request-service.red.test.js',
    'test/mbt/property/special-stock-request-domain.property.test.js', 'test/mbt/unit/special-workflow-review.test.js',
    'test/mbt/unit/special-workflow-order-sync.test.js', 'test/mbt/unit/special-workflow-adapter.test.js', 'test/mbt/unit/special-workflow-deploy-readiness.test.js',
    'test/mbt/integration/special-workflow-review.test.js', 'test/mbt/integration/special-stock-request-workflow.red.test.js',
    'test/mbt/integration/special-stock-request-http.red.test.js', 'test/mbt/integration/special-stock-request-dispatch-guard.red.test.js'
]
worker_tests += ['test/mbt/unit/special-workflow-pricing.test.js','test/mbt/unit/special-workflow-quantity-adapter.test.js','test/mbt/unit/special-workflow-quantity-service.test.js','test/mbt/integration/special-workflow-pricing.test.js','test/mbt/integration/special-workflow-pricing-http.test.js']
worker_tests += ['test/mbt/unit/special-workflow-polish.test.js', 'test/mbt/integration/special-workflow-polish.test.js', 'test/mbt/integration/special-workflow-polish-http.test.js']
worker_tests += ['test/mbt/unit/special-workflow-enquiry.test.js','test/mbt/integration/special-workflow-enquiry.test.js']
for role, row in manifest['services'].items():
    name = 'mbbs-special-enquiry-release-' + role + '-check'
    artifacts = root / (role + '-artifacts')
    (artifacts / 'special-workflow-review').mkdir(parents=True, exist_ok=True)
    shutil.copy2(server / 'test-artifacts/special-workflow-review/records.json', artifacts / 'special-workflow-review/records.json')
    subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    candidate = root / (role + '-candidate')
    mounts = [item for file in ['src', 'public', 'migrations', 'package.json', 'package-lock.json']
              for item in ['-v', str(candidate / file) + ':/app/' + file + ':ro']]
    # The browser tooling image supplies Chromium's OS libraries. These mounted
    # files were hash-verified against the actual release image in build().
    docker('run', '-d', '--name', name, '--network', 'mbbs-special-review', '--no-healthcheck', '--user', '0',
           *env_args, *mounts, '-v', str(server / 'test') + ':/app/test:ro', '-v', str(server / 'tools') + ':/app/tools:ro',
           '-v', str(tooling / 'node_modules') + ':/app/node_modules:ro', '-v', str(artifacts) + ':/app/test-artifacts',
           '-v', '/tmp/return-batch-playwright:/browsers:ro', '--entrypoint', 'tail', 'mbbs-return-batch-browser-test:20260918', '-f', '/dev/null')
    if role == 'app':
        docker('exec', '-e', 'DATABASE_URL=postgres://mbt_test:special_review_only@mbbs-special-review-db:5432/mbt_test', name, 'node', 'tools/special-workflow-enquiry-migrate.mjs')
        docker('exec', '-d', '-e', 'DATABASE_URL=postgres://mbt_test:special_review_only@mbbs-special-review-db:5432/mbt_test', name,
               'sh', '-c', 'node tools/special-workflow-review-app.mjs > test-artifacts/review-app.log 2>&1')
        for _ in range(30):
            result = subprocess.run(['docker', 'exec', name, 'node', '-e', "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], capture_output=True)
            if not result.returncode:
                break
            time.sleep(1)
        else:
            raise RuntimeError('Candidate review app did not start')
        command = ['node', 'tools/special-workflow-enquiry-gauntlet.mjs']
    else:
        command = ['node', '--test', '--test-concurrency=1', *worker_tests]
    with (root / (role + '-checks.log')).open('wb') as output:
        subprocess.run(['docker', 'exec', name, *command], stdout=output, stderr=subprocess.STDOUT, check=True)
    print(json.dumps({'passed': role, 'imageId': row['imageId']}), flush=True)
    # Import and serve with the actual production image's own node_modules.
    smoke = """import assert from 'node:assert/strict';import {once} from 'node:events';
const {app}=await import('./src/server.js');const {closeDb}=await import('./src/db.js');
const listener=app.listen(0,'127.0.0.1');await once(listener,'listening');
const response=await fetch('http://127.0.0.1:'+listener.address().port+'/health');assert.equal(response.status,200);assert.equal((await response.json()).ok,true);
listener.closeAllConnections();await new Promise(resolve=>listener.close(resolve));await closeDb();console.log('Production dependency smoke passed');process.exit(0);"""
    with (root / (role + '-production-smoke.log')).open('wb') as output:
        subprocess.run(['docker', 'run', '--rm', '--network', 'mbbs-special-review', '--no-healthcheck', *env_args,
                        '--entrypoint', 'node', row['imageId'], '--input-type=module', '-e', smoke], stdout=output, stderr=subprocess.STDOUT, timeout=60, check=True)
release.current()
release.config_gate()
release.save('verified.json', {'passed': True, 'images': {role: row['imageId'] for role, row in manifest['services'].items()}})
print('Frozen application and worker candidates verified; production is unchanged.', flush=True)
