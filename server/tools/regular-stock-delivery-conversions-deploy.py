"""Publish the tested conversion correction as an overlay of the captured live image."""
import datetime
import difflib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / 'server'
OUT = SERVER / 'test-artifacts/regular-stock-delivery-conversions'
RELEASE = SERVER / 'deployments/regular-stock-delivery-conversions-20261001'
IMAGE = 'mbbs-operator-app:regular-stock-delivery-conversions-20261001'
APP = 'mbbs-operator-app-app-1'
FILES = json.loads((SERVER / 'tools/regular-stock-delivery-conversions-spec.json').read_text())['setup']['runtimeFiles']
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
    assert metadata(APP) == data['services']['app']['before'], 'Live app changed; rebase release'
    assert {name: metadata(name) for name in DEPENDENCIES} == data['dependencies'], 'Dependency changed'
    for file in FILES:
        assert digest((SERVER / file).read_bytes()) == data['sourceHashes'][file], 'Validated source changed: ' + file
        assert digest(docker('exec', APP, 'cat', '/app/' + file)) == data['beforeHashes'][file], 'Live source changed: ' + file


def prepare():
    os.umask(0o077)
    checks = json.loads((OUT / 'final/checks.json').read_text())
    assert checks['tests'] == checks['passed'] and all(row['exitCode'] == 0 for row in checks['layers'])
    assert all(row['exitCode'] == 0 for row in json.loads((OUT / 'final/layers.json').read_text()))
    baseline = json.loads((OUT / 'baseline.json').read_text())
    if baseline.get('treeDirectory'):
        assert all(row['exitCode'] == 0 for row in json.loads((OUT / 'rebased/layers.json').read_text()))
        combined = json.loads((OUT / 'rebased/regressions.json').read_text())
        assert combined['tests'] == combined['passed'] and combined['exitCode'] == 0
    assert digest((SERVER / 'package.json').read_bytes()) == baseline['packageSha256'], 'Dependencies changed'
    before = metadata(APP)
    assert before['imageId'] == baseline['imageId'] and before['id'] == baseline['containerId'], 'Captured production changed'
    RELEASE.mkdir(exist_ok=True)
    assert not (RELEASE / 'manifest.json').exists(), 'Release already prepared'
    data = {'services': {'app': {'before': before, 'image': IMAGE}}, 'beforeHashes': baseline['runtimeHashes'],
            'sourceHashes': checks['sourceHashes'], 'dependencies': {name: metadata(name) for name in DEPENDENCIES}}
    current(data)
    stage = RELEASE / 'stage'
    patch = ''
    for file in FILES:
        target = stage / file
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SERVER / file, target)
        original = OUT / baseline.get('treeDirectory', 'live-before') / file
        patch += ''.join(difflib.unified_diff(original.read_text().splitlines(True), target.read_text().splitlines(True), fromfile='a/' + file, tofile='b/' + file))
    (RELEASE / 'runtime.patch').write_text(patch)
    assert docker('image', 'inspect', '--format', '{{.Id}}', before['image']).decode().strip() == before['imageId']
    (stage / 'Dockerfile').write_text('FROM ' + before['image'] + '\n' + ''.join('COPY --chown=node:node ' + file + ' /app/' + file + '\n' for file in FILES))
    with (RELEASE / 'build.log').open('wb') as log:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--network', 'none', '--pull=false', '-t', IMAGE, str(stage)], stdout=log, stderr=subprocess.STDOUT, check=True)
    data['services']['app']['candidateImageId'] = docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    expected = json.loads(docker('exec', APP, 'node', '-e', HASH_SCRIPT))
    expected.update(data['sourceHashes'])
    actual = json.loads(docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', IMAGE, '-e', HASH_SCRIPT))
    assert actual == expected, 'Unexpected image source changes'
    save('source-tree.json', expected)
    docker('run', '--rm', '--network', 'none', '-e', 'MBBS_ENV_FILE=/nonexistent', '-e', 'NETSUITE_DIRECT_ACCESS_ENABLED=false',
           '-e', 'NETSUITE_MIRROR_ROLE=disabled', '--entrypoint', 'node', IMAGE, '--input-type=module', '-e', "await import('./src/server.js');process.exit(0)")
    (RELEASE / 'compose.release.yml').write_text('services:\n  app:\n    image: ' + IMAGE + '\n')
    (RELEASE / 'compose.rollback.yml').write_text('services:\n  app:\n    image: ' + before['imageId'] + '\n')
    release.config_check(data)
    current(data)
    save('manifest.json', data)
    print(json.dumps({'prepared': True, 'runtimeFilesChanged': len(FILES), 'imageFilesVerified': len(expected)}), flush=True)


def verify():
    data = state()
    release.core.ready(data['services']['app']['candidateImageId'])
    after = metadata(APP)
    assert after['configuration'] == data['services']['app']['before']['configuration']
    assert {name: metadata(name) for name in DEPENDENCIES} == data['dependencies']
    assert json.loads(docker('exec', APP, 'node', '-e', HASH_SCRIPT)) == json.loads((RELEASE / 'source-tree.json').read_text())
    script = (SERVER / 'tools/regular-stock-delivery-conversions-live.mjs').read_text().replace("from '../src/", "from './src/")
    live = json.loads(docker('exec', '-i', APP, 'node', '--input-type=module', input=script.encode()))
    save('live-preview.json', live)
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'imageId': after['imageId'], 'configurationPreserved': True, 'workerAndDependenciesUnchanged': True,
              'schemaChanged': False, 'runtimeFilesChanged': len(FILES), 'livePreview': live}
    save('result.json', result)
    print(json.dumps(result), flush=True)


def apply():
    data = state()
    current(data)
    release.config_check(data)
    active = json.loads(release.database("""BEGIN READ ONLY;
SELECT json_build_object(
 'operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),
 'driverExecuting',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing'),
 'specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'),
 'stockTransferConfirming',(SELECT count(*) FROM sales_stock_transfers WHERE confirmation_status IN ('creating','approving','hydrating','printing')),
 'regularExecuting',(SELECT count(*) FROM regular_stock_handoffs WHERE status='executing'),
 'deliveryOperations',(SELECT count(*) FROM regular_stock_delivery_operations WHERE status IN ('queued','running')),
 'scmExecuting',(SELECT count(*) FROM scm_smart_proposals WHERE status='executing'),
 'webhookRunning',(SELECT count(*) FROM netsuite_order_webhook_inbox WHERE status='running'));
ROLLBACK;""").removeprefix('BEGIN\n').removesuffix('\nROLLBACK'))
    save('active-before-release.json', active)
    assert not any(active.values()), 'Wait for active work: ' + json.dumps(active)
    current(data)
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


def retry():
    data = state()
    assert json.loads((RELEASE / 'rollback-result.json').read_text())['rolledBack']
    before = metadata(APP)
    original = data['services']['app']['before']
    assert before['imageId'] == original['imageId'] and before['configuration'] == original['configuration'], 'Rollback state changed'
    assert {name: metadata(name) for name in DEPENDENCIES} == data['dependencies']
    expected = json.loads((RELEASE / 'source-tree.json').read_text())
    expected.update(data['beforeHashes'])
    assert json.loads(docker('exec', APP, 'node', '-e', HASH_SCRIPT)) == expected
    assert docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip() == data['services']['app']['candidateImageId']
    save('manifest-before-retry.json', data)
    data['services']['app']['before'] = before
    current(data)
    release.config_check(data)
    save('manifest.json', data)
    apply()


if __name__ == '__main__':
    {'prepare': prepare, 'apply': apply, 'verify': verify, 'retry': retry}[sys.argv[1]]()
