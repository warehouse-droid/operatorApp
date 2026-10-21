"""Publish the scoped human-only delivery conversation correction."""
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
OUT = SERVER / 'test-artifacts/delivery-conversation-only-20261013'
RELEASE = SERVER / 'deployments/delivery-conversation-only-20261013'
spec = importlib.util.spec_from_file_location('conversation_release', SERVER / 'tools/delivery-request-enhancements-deploy.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
base.RELEASE = RELEASE
base.IMAGE = 'mbbs-operator-app:delivery-conversation-only-20261013'
base.FILES = ['src/delivery-request-repository.js', 'public/delivery-requests.js', 'public/delivery-requests.html']
base.release.RELEASE = RELEASE
docker, digest, metadata = base.docker, base.digest, base.metadata
APP = base.APP


def current(data):
    assert metadata(APP) == data['services']['app']['before'], 'Live release changed; rebase the correction'
    assert {name: metadata(name) for name in base.DEPENDENCIES} == data['dependencies'], 'A dependency changed'
    assert json.loads(docker('exec', APP, 'node', '-e', base.HASH_SCRIPT)) == data['beforeTree'], 'Live source changed'
    for name, expected in data['sourceHashes'].items():
        assert digest((SERVER / name).read_bytes()) == expected, 'Workspace correction changed: ' + name
        assert digest((RELEASE / 'stage' / name).read_bytes()) == expected, 'Staged correction changed: ' + name


base.current = current


def prepare():
    os.umask(0o077)
    before = metadata(APP)
    tree = json.loads(docker('exec', APP, 'node', '-e', base.HASH_SCRIPT))
    for name in base.FILES:
        assert tree[name] == digest((OUT / 'baseline' / name).read_bytes()), 'An overlapping production change needs merging: ' + name
    RELEASE.mkdir(exist_ok=False)
    stage, patch = RELEASE / 'stage', ''
    for name in base.FILES:
        target = stage / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SERVER / name, target)
        old = (OUT / 'baseline' / name).read_text()
        patch += ''.join(difflib.unified_diff(old.splitlines(True), target.read_text().splitlines(True), fromfile='a/' + name, tofile='b/' + name))
    source = {name: digest((stage / name).read_bytes()) for name in base.FILES}
    data = {'services': {'app': {'before': before, 'image': base.IMAGE}}, 'beforeTree': tree,
            'sourceHashes': source, 'dependencies': {name: metadata(name) for name in base.DEPENDENCIES}}
    current(data)
    (RELEASE / 'runtime.patch').write_text(patch)
    base_image = 'mbbs-operator-app:delivery-conversation-only-base-20261013'
    docker('tag', before['imageId'], base_image)
    assert docker('image', 'inspect', '--format', '{{.Id}}', base_image).decode().strip() == before['imageId']
    (stage / 'Dockerfile').write_text('FROM ' + base_image + '\n' + ''.join(
        'COPY --chown=node:node ' + name + ' /app/' + name + '\n' for name in base.FILES))
    with (RELEASE / 'build.log').open('wb') as log:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--network', 'none', '--pull=false', '-t', base.IMAGE, str(stage)], stdout=log, stderr=subprocess.STDOUT, check=True)
    data['services']['app']['candidateImageId'] = docker('image', 'inspect', '--format', '{{.Id}}', base.IMAGE).decode().strip()
    base.import_check(base.IMAGE)
    assert json.loads((RELEASE / 'candidate-tree.json').read_text()) == {**tree, **source}
    (RELEASE / 'compose.release.yml').write_text('services:\n  app:\n    image: ' + base.IMAGE + '\n')
    (RELEASE / 'compose.rollback.yml').write_text('services:\n  app:\n    image: ' + before['imageId'] + '\n')
    base.release.config_check(data)
    current(data)
    base.save('manifest.json', data)
    base.capture_candidate()
    print(json.dumps({'prepared': True, 'filesChanged': len(base.FILES), 'baseImage': before['image']}), flush=True)


def verify():
    base.verify()
    data = json.loads((RELEASE / 'manifest.json').read_text())
    tree = json.loads((RELEASE / 'candidate-tree.json').read_text())
    driver = {name: value for name, value in data['beforeTree'].items()
              if name.startswith('public/driver') or name.startswith('src/driver')}
    assert all(tree[name] == value for name, value in driver.items()), 'Driver runtime changed'
    script = """import assert from 'node:assert/strict';
for(const origin of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
 for(const team of ['sales','dispatch']) {
  const page=await fetch(origin+'/'+team+'/delivery-requests');assert.equal(page.status,200);
  assert.match(await page.text(),/delivery-requests.js\\?v=20261013-conversation-messages-v2/);
 }
 assert.equal((await fetch(origin+'/api/driver/client-version')).status,200);
 assert.match(await(await fetch(origin+'/driver-service-worker.js')).text(),/DRIVER_CACHE_PREFIX}v45/);
}
console.log(JSON.stringify({conversationAssetVersion:'20261013-conversation-messages-v2',driverCache:'v45'}));"""
    checks = json.loads(docker('exec', '-i', APP, 'node', '--input-type=module', input=script.encode()))
    result = json.loads((RELEASE / 'result.json').read_text())
    result.update({'humanConversationOnly': True, 'auditHistoryPreserved': True, 'driverRuntimePreserved': True, **checks})
    base.save('result.json', result)
    print(json.dumps(checks), flush=True)


def apply():
    data = json.loads((RELEASE / 'manifest.json').read_text())
    evidence = json.loads((OUT / 'final/results/evidence.json').read_text())
    assert all(row['exitCode'] == 0 for row in evidence['layers']), 'Candidate verification failed'
    assert evidence['coverage']['covered'] == evidence['coverage']['total'], 'Changed lines are not covered'
    assert evidence['mutations']['restored'] and all(row['killed'] for row in evidence['mutations']['mutants']), 'Mutation verification failed'
    assert (OUT / 'final/teardown.log').read_text().endswith('teardown_exit=0\n'), 'Disposable teardown failed'
    tree = json.loads((RELEASE / 'candidate-tree.json').read_text())
    for name, expected in evidence['sourceHashes'].items():
        assert tree[name] == expected, 'Tested candidate source changed: ' + name
    current(data)
    base.release.config_check(data)
    active = json.loads(base.release.database("""BEGIN READ ONLY;
SELECT json_build_object(
 'operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),
 'driverExecuting',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing'),
 'specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'),
 'stockTransferConfirming',(SELECT count(*) FROM sales_stock_transfers WHERE confirmation_status IN ('creating','approving','hydrating','printing')),
 'regularExecuting',(SELECT count(*) FROM regular_stock_handoffs WHERE status='executing'),
 'deliveryOperations',(SELECT count(*) FROM regular_stock_delivery_operations WHERE status IN ('queued','running')),
 'scmExecuting',(SELECT count(*) FROM scm_smart_proposals WHERE status='executing'));
ROLLBACK;""").removeprefix('BEGIN\n').removesuffix('\nROLLBACK'))
    base.save('active-before-release.json', active)
    assert not any(active.values()), 'Wait for active operations: ' + json.dumps(active)
    current(data)
    try:
        with (RELEASE / 'publish.log').open('wb') as log:
            subprocess.run(base.release.compose(data) + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except Exception:
        with (RELEASE / 'rollback.log').open('wb') as log:
            subprocess.run(base.release.compose(data, 'compose.rollback.yml') + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        base.release.core.ready(data['services']['app']['before']['imageId'])
        base.save('rollback-result.json', {'rolledBack': True})
        raise


if __name__ == '__main__':
    {'prepare': prepare, 'apply': apply, 'verify': verify}[sys.argv[1]]()
