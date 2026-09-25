"""Patch the verified rollback fix over the captured live image, with rollback."""
import datetime
import difflib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('rejection_release', SERVER / 'tools/receiving-posting-status-deploy.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
core = release.core
core.RELEASE = Path('/home/ubuntu/operatorapp-deploy-backups/rejected-edit-lifecycle-20260923-v1')
core.BEFORE = SERVER / 'test-artifacts/rejected-edit-lifecycle/before'
core.FILES = core.EXISTING = ['public/dispatch.html', 'public/dispatch.js']
core.ADDED = []
core.IMAGE = 'mbbs-operator-app:rejected-edit-lifecycle-20260923-v1'
core.ROLLBACK = 'mbbs-operator-app:rollback-rejected-edit-lifecycle-20260923-v1'
CHECKS = SERVER / 'test-artifacts/rejected-edit-lifecycle'
VERSION = '20260923-split-retirement-fix-v1'


def prepare():
    core.RELEASE.mkdir(parents=True, exist_ok=False)
    state = {'app': core.metadata(core.APP), 'dependencies': [core.metadata(name) for name in core.DEPENDENCIES]}
    baseline = core.RELEASE / 'baseline'
    baseline.mkdir()
    archive = core.docker('exec', core.APP, 'tar', '-C', '/app', '-cf', '-', 'src', 'public', 'migrations', 'package.json', 'package-lock.json')
    with tarfile.open(fileobj=io.BytesIO(archive)) as captured:
        captured.extractall(baseline, filter='data')
    assert core.metadata(core.APP) == state['app'], 'Live app changed during capture'
    candidate = core.RELEASE / 'candidate'
    shutil.copytree(baseline, candidate)
    name = 'public/dispatch.js'
    old, new = (core.BEFORE / name).read_text(), (SERVER / name).read_text()
    patch = ''.join(difflib.unified_diff(old.splitlines(True), new.splitlines(True), fromfile='a/' + name, tofile='b/' + name))
    (core.RELEASE / 'release.patch').write_text(patch)
    result = subprocess.run(['patch', '--batch', '--fuzz=0', '-p1', '-d', str(candidate)], input=patch, text=True, capture_output=True)
    (core.RELEASE / 'patch.log').write_text(result.stdout + result.stderr)
    assert result.returncode == 0, 'Patch requires review'
    html = candidate / 'public/dispatch.html'
    value, count = re.subn(r'/dispatch\.js\?v=[^"\s]+', '/dispatch.js?v=' + VERSION, html.read_text())
    assert count == 1
    html.write_text(value)
    for extra in candidate.rglob('*.orig'):
        extra.unlink()
    before, after = core.files_at(baseline), core.files_at(candidate)
    changed = sorted(file for file in before.keys() | after.keys() if before.get(file) != after.get(file))
    assert changed == core.FILES
    state.update({'image': core.IMAGE, 'before': {file: before[file] for file in changed},
        'after': {file: after[file] for file in changed}, 'workspace': {file: core.digest((SERVER / file).read_bytes()) for file in changed},
        'unchangedSources': {file: value for file, value in before.items() if file not in changed}, 'changedFiles': changed})
    for file in changed:
        destination = core.RELEASE / 'stage' / file
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(candidate / file, destination)
    (core.RELEASE / 'compose.release.yml').write_text('services:\n  app:\n    image: ' + core.IMAGE + '\n')
    (core.RELEASE / 'compose.rollback.yml').write_text('services:\n  app:\n    image: ' + state['app']['imageId'] + '\n')
    core.save('manifest.json', state)
    print(json.dumps({'prepared': True, 'changedFiles': changed, 'baseImage': state['app']['imageId']}))


def validate():
    state = core.manifest()
    core.current(state)
    gate = json.loads((CHECKS / 'verification.json').read_text())
    assert gate['passed'] and gate['workspace'] == state['workspace']
    assert gate['candidateSources'] == state['after']
    core.save('verified.json', {'passed': True, 'imageId': state['candidateImageId'], 'sources': state['after']})
    print(json.dumps({'verified': True, 'imageId': state['candidateImageId']}))


def verify():
    state = core.manifest()
    core.ready(state['candidateImageId'])
    actual = core.metadata(core.APP)
    assert actual['configuration'] == state['app']['configuration']
    assert [core.metadata(name) for name in core.DEPENDENCIES] == state['dependencies']
    expected = {**state['unchangedSources'], **state['after']}
    hashes = core.docker('exec', core.APP, 'sha256sum', *['/app/' + name for name in expected]).decode().splitlines()
    assert {line.split()[1].removeprefix('/app/'): line.split()[0] for line in hashes} == expected
    script = """import assert from 'node:assert/strict'; import crypto from 'node:crypto';
const files=FILES;
for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
  for(const [file,expected] of Object.entries(files)) {
    const r=await fetch(base+'/'+file.replace('public/',''),{headers:{'Cache-Control':'no-cache'}});
    assert.equal(r.status,200);assert.equal(crypto.createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex'),expected);
  }
  const r=await fetch(base+'/health');assert.equal(r.status,200);assert.equal((await r.json()).ok,true);
}
console.log(JSON.stringify({localHealth:200,publicHealth:200,assetsVerified:true}));""".replace('FILES', json.dumps(state['after']))
    checks = json.loads(core.docker('exec', '-i', core.APP, 'node', '--input-type=module', input=script.encode()))
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'imageId': actual['imageId'],
        'files': core.FILES, 'verifiedFiles': len(expected), 'configurationPreserved': True, 'otherServicesUnchanged': True, **checks}
    core.save('deployment-result.json', result)
    print(json.dumps(result))


def apply():
    release.verify = verify
    release.apply()


if __name__ == '__main__':
    os.umask(0o077)
    {'prepare': prepare, 'build': core.build, 'validate': validate, 'apply': apply, 'verify': verify}[sys.argv[1]]()
