"""Scoped reversible app release with source, configuration and read-only verification."""
import datetime
import difflib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
OUT = SERVER / 'test-artifacts/regular-stock-150-sales'
BACKUP = Path('/home/ubuntu/operatorapp-investigations/regular-stock-150-sales-20261005')
RELEASE = BACKUP / 'release'
FILES = json.loads((SERVER / 'tools/regular-stock-150-sales-files.json').read_text())
APP = 'mbbs-operator-app-app-1'
DEPENDENCIES = ['mbbs-operator-app-db-1', 'mbbs-operator-app-ollama-1', 'mbbs-operator-app-webhook-worker-1']
IMAGE = 'mbbs-operator-app:regular-stock-150-sales-20261005'
spec = importlib.util.spec_from_file_location('sales150_release', SERVER / 'tools/regular-stock-v2-deploy.py')
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
    assert metadata(APP) == data['services']['app']['before'], 'Running app changed since preparation'
    assert {name: metadata(name) for name in DEPENDENCIES} == data['dependencies'], 'Dependency changed'
    for file, sha in data['beforeHashes'].items():
        assert digest(docker('exec', APP, 'cat', '/app/' + file)) == sha, 'Runtime source changed: ' + file
    assert {file: digest((SERVER / file).read_bytes()) for file in FILES} == data['sourceHashes'], 'Tested source changed'

def prepare():
    checks = json.loads((OUT / 'checks.json').read_text())
    assert checks['sourceHashes'] == {file: digest((SERVER / file).read_bytes()) for file in FILES}
    assert all(row['exitCode'] == 0 for row in checks['layers'])
    assert checks['coverage']['uncovered'] == [] and checks['coverage']['missingFiles'] == []
    assert all(row['killed'] for row in checks['mutants'])
    assert json.loads((OUT / 'final-tests-summary.json').read_text())['newFailures'] == []
    assert all(row['exitCode'] == 0 for row in json.loads((OUT / 'all-results.json').read_text()))
    assert json.loads((OUT / 'browser.json').read_text())['pageErrors'] == []
    os.umask(0o077)
    initial = json.loads((BACKUP / 'container.private.json').read_text())[0]
    before = metadata(APP)
    data = {'services': {'app': {'before': before, 'image': IMAGE}}, 'sourceHashes': checks['sourceHashes'],
        'beforeHashes': {file: digest((BACKUP / 'baseline' / file).read_bytes()) for file in FILES if (BACKUP / 'baseline' / file).exists()},
        'dependencies': {name: metadata(name) for name in DEPENDENCIES},
        'preservedConcurrentRelease': before['id'] != initial['Id'] or before['imageId'] != initial['Image']}
    # A concurrent release is safe only when every existing scoped file still
    # matches the captured baseline; the overlay preserves all other files.
    current(data)
    for file in set(FILES) - set(data['beforeHashes']):
        docker('exec', APP, 'node', '-e', "process.exit(Number(require('node:fs').existsSync(process.argv[1])))", '/app/' + file)
    captured = json.loads(docker('inspect', APP))
    assert captured[0]['Id'] == before['id'] and captured[0]['Image'] == before['imageId']
    (BACKUP / 'container-current.private.json').write_text(json.dumps(captured))
    RELEASE.mkdir(exist_ok=False)
    stage = RELEASE / 'stage'
    patch = ''
    for file in FILES:
        target = stage / 'overlay' / file
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SERVER / file, target)
        original = BACKUP / 'baseline' / file
        patch += ''.join(difflib.unified_diff(original.read_text().splitlines(True) if original.exists() else [],
            (SERVER / file).read_text().splitlines(True), fromfile='a/' + file, tofile='b/' + file))
    (RELEASE / 'release.patch').write_text(patch)
    base_image = 'mbbs-operator-app:sales150-base-' + before['imageId'].split(':')[1][:12]
    docker('tag', before['imageId'], base_image)
    (stage / 'Dockerfile').write_text('FROM ' + base_image + '\nCOPY --chown=node:node overlay/ /app/\n')
    with (RELEASE / 'build.log').open('wb') as log:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--network', 'none', '--pull=false', '-t', IMAGE, str(stage)],
            stdout=log, stderr=subprocess.STDOUT, check=True)
    data['services']['app']['candidateImageId'] = docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    expected = json.loads(docker('exec', APP, 'node', '-e', HASH_SCRIPT))
    expected.update(data['sourceHashes'])
    actual = json.loads(docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', IMAGE, '-e', HASH_SCRIPT))
    assert actual == expected, 'Candidate contains changes outside the scoped files'
    save('source-tree.json', expected)
    docker('run', '--rm', '--network', 'none', '-e', 'MBBS_ENV_FILE=/nonexistent', '-e', 'NETSUITE_DIRECT_ACCESS_ENABLED=false',
        '-e', 'NETSUITE_MIRROR_ROLE=disabled', '--entrypoint', 'node', IMAGE, '--input-type=module', '-e',
        "await import('./src/server.js');process.exit(0)")
    (RELEASE / 'compose.release.yml').write_text('services:\n  app:\n    image: ' + IMAGE + '\n')
    (RELEASE / 'compose.rollback.yml').write_text('services:\n  app:\n    image: ' + before['imageId'] + '\n')
    release.config_check(data)
    current(data)
    save('manifest.json', data)
    print(json.dumps({'prepared': True, 'sourceFiles': len(FILES), 'verifiedImageFiles': len(expected), 'schemaChanges': 0}), flush=True)

def verify():
    data = state()
    release.core.ready(data['services']['app']['candidateImageId'])
    after = metadata(APP)
    assert after['imageId'] == data['services']['app']['candidateImageId']
    assert after['configuration'] == data['services']['app']['before']['configuration']
    assert {name: metadata(name) for name in DEPENDENCIES} == data['dependencies']
    assert json.loads(docker('exec', APP, 'node', '-e', HASH_SCRIPT)) == json.loads((RELEASE / 'source-tree.json').read_text())
    code = (SERVER / 'tools/regular-stock-150-sales-live.mjs').read_text().replace("from '../src/", "from './src/")
    live = json.loads(docker('exec', '-i', APP, 'node', '--input-type=module', input=code.encode()))
    save('live-check.json', live)
    public = {}
    for path, file in [('/health', None), ('/sales-stock-requests.js', 'public/sales-stock-requests.js')]:
        request = urllib.request.Request('https://test.mbbsoperation.com' + path,
            headers={'User-Agent': 'Mozilla/5.0', 'Cache-Control': 'no-cache'})
        with urllib.request.urlopen(request, timeout=30) as response:
            body = response.read()
            assert response.status == 200
            if file:
                assert digest(body) == data['sourceHashes'][file]
            else:
                assert json.loads(body)['ok'] is True
            public[path] = {'status': response.status, 'sha256': digest(body)}
    request = urllib.request.Request('https://test.mbbsoperation.com/sales/stock-requests',
        headers={'User-Agent': 'Mozilla/5.0', 'Cache-Control': 'no-cache'})
    with urllib.request.urlopen(request, timeout=30) as response:
        assert response.status == 200 and b'sales150=20261005-v1' in response.read()
    save('public-check.json', public)
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'image': IMAGE,
        'configurationPreserved': True, 'dependenciesPreserved': True, 'schemaChanges': 0, 'liveCheck': live}
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
      'scmExecuting',(SELECT count(*) FROM scm_smart_proposals WHERE status='executing'))"""))
    save('active-before-release.json', active)
    assert not any(active.values()), 'Wait for active operations: ' + json.dumps(active)
    try:
        with (RELEASE / 'publish.log').open('wb') as log:
            subprocess.run(release.compose(data) + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'],
                cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except Exception:
        with (RELEASE / 'rollback.log').open('wb') as log:
            subprocess.run(release.compose(data, 'compose.rollback.yml') + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'],
                cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        release.core.ready(data['services']['app']['before']['imageId'])
        save('rollback-result.json', {'rolledBack': True})
        raise

if __name__ == '__main__':
    {'prepare': prepare, 'apply': apply, 'verify': verify}[sys.argv[1]]()
