"""Scoped PO item weight release, using the existing immutable-image cutover/rollback machinery."""
import datetime
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('release', SERVER / 'tools/operator-display-deploy.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
core = release.core
core.RELEASE = Path('/home/ubuntu/operatorapp-deploy-backups/po-item-weight-20260918-v1')
core.BEFORE = Path('/home/ubuntu/po-item-weight-baseline-20260918')
core.IMAGE = 'mbbs-operator-app:po-item-weight-20260918-v1'
core.ROLLBACK = 'mbbs-operator-app:rollback-po-item-weight-20260918-v1'
catalog = (SERVER / 'tools/po-item-weight-files.mjs').read_text()
core.FILES = sorted(re.findall(r"'([^']+)'", catalog.split('export const added')[0]))
core.ADDED = ['src/purchase-order-weight-refresh.js']
core.EXISTING = sorted(set(core.FILES) - set(core.ADDED))


def source_gate():
    folder = SERVER / 'test-artifacts/po-item-weight/final'
    for file, expected in json.loads((folder / 'source.json').read_text()).items():
        assert core.digest((SERVER / file).read_bytes()) == expected, 'Verified source changed: ' + file
    assert json.loads((folder / 'full-comparison.json').read_text())['unexpected'] == []
    assert all(row['killed'] for row in json.loads((folder / 'mutations.json').read_text()))
    assert all(not row['missing'] for row in json.loads((folder / 'changed-coverage.json').read_text()))
    assert json.loads((folder / 'static.json').read_text())['newDiagnostics'] == []


def prepare():
    core.prepare()
    candidate = core.RELEASE / 'candidate'
    for name in ['test', 'tools', 'contracts']:
        (candidate / name).symlink_to(SERVER / name, target_is_directory=True)
    for pattern in ['*.js', '*.json', 'Dockerfile*']:
        for path in SERVER.glob(pattern):
            if not (candidate / path.name).exists():
                shutil.copy2(path, candidate / path.name)


def check():
    source_gate()
    state = core.manifest()
    core.current(state)
    env = {**os.environ, 'DISPLAY_FIX_SOURCE_ROOT': str(core.RELEASE / 'candidate')}
    tests = re.findall(r"'([^']+)'", catalog.split('export const tests = ')[1])
    with (core.RELEASE / 'candidate-focused.log').open('wb') as output:
        subprocess.run(['sudo', '-n', '--preserve-env=DISPLAY_FIX_SOURCE_ROOT', 'bash', 'tools/operator-display-test.sh',
                        'db', 'node', '--test', '--test-concurrency=1', *tests], cwd=SERVER, env=env,
                       stdout=output, stderr=subprocess.STDOUT, check=True)
    core.current(state)
    core.save('verified.json', {'passed': True, 'imageId': state['candidateImageId'], 'sources': state['after']})
    print(json.dumps({'candidateTestsPassed': True}), flush=True)


def live(after=False):
    state = core.manifest()
    runtime = json.loads(core.docker('inspect', core.APP))[0]
    environment = core.RELEASE / 'live-env.private'
    environment.write_text('\n'.join(runtime['Config']['Env']) + '\n')
    environment.chmod(0o600)
    network = next(iter(runtime['NetworkSettings']['Networks']))
    image_id = runtime['Image'] if after else state['candidateImageId']
    try:
        output = core.docker('run', '--rm', '--network', network, '--volumes-from', core.APP + ':ro',
            '--env-file', str(environment), '-v', str(SERVER / 'tools/po-item-weight-live.mjs') + ':/app/tools/po-item-weight-live.mjs:ro',
            '--entrypoint', 'node', image_id, '/app/tools/po-item-weight-live.mjs').decode()
        result = json.loads(output.strip().splitlines()[-1])
        core.save('live-after.json' if after else 'live-before.json', {**result, 'imageId': image_id})
        print(json.dumps({'passed': result['passed'], 'readOnly': True, 'remainingMismatches': len(result['remaining']), 'lineCount': result['parentAndSplitLineCount'], 'imageId': image_id}), flush=True)
        return result
    finally:
        environment.unlink()


def verify():
    state = core.manifest()
    core.ready(state['candidateImageId'])
    after = core.metadata(core.APP)
    assert after['configuration'] == state['app']['configuration'], 'Application configuration changed'
    assert [core.metadata(name) for name in core.DEPENDENCIES] == state['dependencies'], 'Dependency changed'
    actual = core.docker('exec', core.APP, 'sha256sum', *['/app/' + file for file in core.FILES]).decode().splitlines()
    assert {line.split()[1].removeprefix('/app/'): line.split()[0] for line in actual} == state['after']
    probe = """import assert from 'node:assert/strict';
for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
  const response=await fetch(base+'/health'); assert.equal(response.status,200); assert.equal((await response.json()).ok,true);
  assert.equal((await fetch(base+'/api/delivery/orders?locationId=1')).status,401);
}
console.log(JSON.stringify({health:200,anonymousDelivery:401}));"""
    http = json.loads(core.docker('exec', '-i', core.APP, 'node', '--input-type=module', input=probe.encode()))
    data = live(after=True)
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'image': core.IMAGE,
              'imageId': after['imageId'], 'configurationPreserved': True, 'dependenciesUnchanged': True,
              'readOnlyOrderCheck': data['passed'], **http}
    core.save('deployment-result.json', result)
    print(json.dumps(result), flush=True)


def refresh_live():
    result = json.loads(core.docker('exec', '-i', '-w', '/app/src', core.APP, 'node', '--input-type=module', '-', '--refresh',
        input=(SERVER / 'tools/po-item-weight-live.mjs').read_bytes()))
    assert result['remaining'] == [] and result['protectedFieldsUnchanged']
    core.save('live-refresh.json', result)
    print(json.dumps({'refreshed': True, 'updated': result['correction']['updated'],
        'lineCount': result['parentAndSplitLineCount'], 'protectedFieldsUnchanged': True}), flush=True)


release.source_gate = source_gate
release.live = live
release.verify = verify
if __name__ == '__main__':
    os.umask(0o077)
    {'prepare': prepare, 'build': core.build, 'check': check, 'preflight': live, 'apply': release.apply, 'verify': verify, 'refresh': refresh_live}[sys.argv[1]]()
