"""Scoped, reversible release of the tested Delivery workflow to the existing test site."""
import datetime
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
OUT = SERVER / 'test-artifacts/regular-stock-delivery-memo'
RELEASE = SERVER / 'deployments/regular-stock-delivery-memo-20260930'
FILES = json.loads((SERVER / 'tools/regular-stock-delivery-memo-files.json').read_text())
IMAGE = 'mbbs-operator-app:regular-stock-delivery-memo-20260930'
APP = 'mbbs-operator-app-app-1'
DEPENDENCIES = ['mbbs-operator-app-db-1', 'mbbs-operator-app-ollama-1', 'mbbs-operator-app-webhook-worker-1']
spec = importlib.util.spec_from_file_location('regular_release', SERVER / 'tools/regular-stock-v2-deploy.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.RELEASE, release.CONTAINERS, release.DEPENDENCIES = RELEASE, {'app': APP}, DEPENDENCIES
docker, digest, metadata = release.docker, release.digest, release.metadata
HASH_SCRIPT = """const fs=require('node:fs'),crypto=require('node:crypto'),hashes={};
function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const path=dir+'/'+entry.name;
 if(entry.isDirectory())walk(path);else if(entry.isFile())hashes[path]=crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex');}}
for(const dir of ['src','public','migrations'])walk(dir);console.log(JSON.stringify(hashes));"""

def save(name, value):
    (RELEASE / name).write_text(json.dumps(value, indent=2) + '\n')

def state():
    return json.loads((RELEASE / 'manifest.json').read_text())

def current(data):
    assert metadata(APP) == data['services']['app']['before'], 'Live app changed since capture'
    assert {name: metadata(name) for name in DEPENDENCIES} == data['dependencies'], 'A dependency changed'
    for file, sha in data['beforeHashes'].items():
        assert digest(docker('exec', APP, 'cat', '/app/' + file)) == sha, 'Live source changed: ' + file
    assert {file: digest((SERVER / file).read_bytes()) for file in FILES} == data['sourceHashes'], 'Tested sources changed'

def prepare():
    checks = json.loads((OUT / 'checks.json').read_text())
    assert checks['sourceHashes'] == {file: digest((SERVER / file).read_bytes()) for file in FILES}
    assert all(row['exitCode'] == 0 for row in checks['layers'])
    gauntlet = json.loads((OUT / 'all-results.json').read_text())
    assert [row['layer'] for row in gauntlet] == ['migrations', 'focused', 'regressions', 'constraints']
    assert all(row['exitCode'] == 0 for row in gauntlet)
    assert not checks['coverage']['missingFiles'] and not checks['coverage']['uncovered']
    assert all(not row['newFailures'] for row in json.loads((OUT / 'regular-stock-v2/tests-results.json').read_text()))
    os.umask(0o077)
    RELEASE.mkdir(exist_ok=False)
    before = metadata(APP)
    data = {'services': {'app': {'before': before, 'image': IMAGE}}, 'sourceHashes': checks['sourceHashes'],
            'beforeHashes': json.loads((OUT / 'baseline.json').read_text())['files'],
            'dependencies': {name: metadata(name) for name in DEPENDENCIES}}
    current(data)
    shutil.copytree(OUT / 'before', RELEASE / 'before')
    shutil.copy2(SERVER / 'test/regular-stock-delivery-memo.changes.patch', RELEASE / 'release.patch')
    stage = RELEASE / 'stage'
    for file in FILES:
        (stage / 'overlay' / file).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SERVER / file, stage / 'overlay' / file)
    assert docker('image', 'inspect', '--format', '{{.Id}}', before['image']).decode().strip() == before['imageId']
    (stage / 'Dockerfile').write_text('FROM ' + before['image'] + '\nCOPY --chown=node:node overlay/ /app/\n')
    with (RELEASE / 'build.log').open('wb') as log:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--network', 'none', '--pull=false', '-t', IMAGE, str(stage)], stdout=log, stderr=subprocess.STDOUT, check=True)
    data['services']['app']['candidateImageId'] = docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    expected = json.loads(docker('exec', APP, 'node', '-e', HASH_SCRIPT))
    expected.update(data['sourceHashes'])
    actual = json.loads(docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', IMAGE, '-e', HASH_SCRIPT))
    assert actual == expected, 'Image contains an unexpected source change'
    save('source-tree.json', expected)
    docker('run', '--rm', '--network', 'none', '-e', 'MBBS_ENV_FILE=/nonexistent', '-e', 'NETSUITE_DIRECT_ACCESS_ENABLED=false',
           '-e', 'NETSUITE_MIRROR_ROLE=disabled', '--entrypoint', 'node', IMAGE, '--input-type=module', '-e', "await import('./src/server.js');process.exit(0)")
    (RELEASE / 'compose.release.yml').write_text('services:\n  app:\n    image: ' + IMAGE + '\n')
    (RELEASE / 'compose.rollback.yml').write_text('services:\n  app:\n    image: ' + before['imageId'] + '\n')
    release.config_check(data)
    current(data)
    save('manifest.json', data)
    print(json.dumps({'prepared': True, 'sourceFiles': len(FILES), 'verifiedImageFiles': len(expected)}), flush=True)

def verify():
    data = state()
    release.core.ready(data['services']['app']['candidateImageId'])
    after = metadata(APP)
    assert after['imageId'] == data['services']['app']['candidateImageId']
    assert after['configuration'] == data['services']['app']['before']['configuration']
    assert {name: metadata(name) for name in DEPENDENCIES} == data['dependencies']
    assert json.loads(docker('exec', APP, 'node', '-e', HASH_SCRIPT)) == json.loads((RELEASE / 'source-tree.json').read_text())
    public = {}
    for file in ['health', *[file for file in FILES if file.startswith('public/')]]:
        path = {'public/sales-stock-requests.html': '/sales/stock-requests', 'public/scm-stock-requests.html': '/scm/stock-requests', 'public/scm-smart.html': '/scm/smart'}.get(file, '/' + file.removeprefix('public/'))
        request = urllib.request.Request('https://test.mbbsoperation.com' + path, headers={'User-Agent': 'Mozilla/5.0', 'Cache-Control': 'no-cache'})
        with urllib.request.urlopen(request, timeout=30) as response:
            body = response.read()
            assert response.status == 200
            if file == 'health':
                assert json.loads(body)['ok'] is True
            if file.endswith('.html'):
                body = re.sub(rb'<script type="module" src="https://static\.cloudflareinsights\.com/beacon\.min\.js/[^>]+></script>\n', b'', body)
            if file in FILES:
                assert digest(body) == data['sourceHashes'][file], file
            public[path] = {'status': response.status, 'sha256': digest(body)}
    save('public-check.json', public)
    code = (SERVER / 'tools/regular-stock-delivery-memo-live.mjs').read_text()
    code = code.replace("from '../src/", "from './src/")
    live = json.loads(docker('exec', '-i', APP, 'node', '--input-type=module', input=code.encode()))
    save('live-check.json', live)
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'image': IMAGE, 'imageId': after['imageId'],
              'configurationPreserved': True, 'workerAndDependenciesUnchanged': True, 'schemaChanged': False, 'liveCheck': live}
    save('result.json', result)
    print(json.dumps(result), flush=True)

def apply():
    data = state()
    current(data)
    release.config_check(data)
    active = json.loads(release.database("""SELECT json_build_object(
      'operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),
      'driverExecuting',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing'),
      'specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'),
      'stockTransferConfirming',(SELECT count(*) FROM sales_stock_transfers WHERE confirmation_status IN ('creating','approving','hydrating','printing')),
      'regularExecuting',(SELECT count(*) FROM regular_stock_handoffs WHERE status='executing'),
      'deliveryOperations',(SELECT count(*) FROM regular_stock_delivery_operations WHERE status IN ('queued','running')),
      'stockingExecuting',(SELECT count(*) FROM sales_stock_requests WHERE regular_details->'pickupTransfer'->>'status'='executing'),
      'scmExecuting',(SELECT count(*) FROM scm_smart_proposals WHERE status='executing'),
      'webhookRunning',(SELECT count(*) FROM netsuite_order_webhook_inbox WHERE status='running'))"""))
    save('active-before-release.json', active)
    assert not any(active.values()), 'Wait for active operations: ' + json.dumps(active)
    try:
        with (RELEASE / 'publish.log').open('wb') as log:
            subprocess.run(release.compose(data) + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except Exception:
        with (RELEASE / 'rollback.log').open('wb') as log:
            subprocess.run(release.compose(data, 'compose.rollback.yml') + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        release.core.ready(data['services']['app']['before']['imageId'])
        save('rollback-result.json', {'rolledBack': True})
        raise

if __name__ == '__main__':
    {'prepare': prepare, 'apply': apply, 'verify': verify}[sys.argv[1]]()
