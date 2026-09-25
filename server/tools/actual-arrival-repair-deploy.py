"""Release only the actual-arrival repair over the captured live application."""
import argparse
import datetime
import difflib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
RELEASE = SERVER / 'test-artifacts/actual-arrival-repair/deployment'
BASELINE = SERVER / 'test-artifacts/actual-arrival-repair/baseline'
FILES = json.loads((SERVER / 'tools/actual-arrival-repair-files.json').read_text())['production']
ADDED = ['src/dispatch-actual-arrival-evidence.js', 'tools/actual-arrival-backfill.mjs']
EXISTING = [name for name in FILES if name not in ADDED]
IMAGE = 'mbbs-operator-app:actual-arrival-20260920-v2'
ROLLBACK = 'mbbs-operator-app:rollback-actual-arrival-20260920-v2'
spec = importlib.util.spec_from_file_location('arrival_release', SERVER / 'tools/field-sales-deploy.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
core = release.core
for module in [release, core]:
    module.RELEASE, module.IMAGE, module.ROLLBACK, module.FILES = RELEASE, IMAGE, ROLLBACK, FILES
core.EXISTING, core.ADDED = EXISTING, ADDED
APP, DEPENDENCIES = release.APP, release.DEPENDENCIES
docker, save, digest = core.docker, core.save, release.digest


def prepare():
    RELEASE.mkdir(parents=True, exist_ok=False)
    state = {'app': core.metadata(APP), 'dependencies': [core.metadata(n) for n in DEPENDENCIES]}
    baseline = RELEASE / 'baseline'
    baseline.mkdir()
    for name in ['src', 'public', 'migrations', 'package.json', 'package-lock.json']:
        docker('cp', APP + ':/app/' + name, str(baseline / name))
    assert core.metadata(APP) == state['app'], 'Application changed during capture'
    refresh(state)


def refresh(state=None):
    state = state or core.manifest()
    assert core.metadata(APP) == state['app'], 'Application changed; rebase the repair'
    baseline, candidate = RELEASE / 'baseline', RELEASE / 'candidate'
    if candidate.exists(): shutil.rmtree(candidate)
    shutil.copytree(baseline, candidate)
    patch = ''
    for name in EXISTING:
        if name == 'public/dispatch.html':
            old = (baseline / name).read_text()
            new, count = re.subn(r'/dispatch\.js\?v=[^"\s]+', '/dispatch.js?v=20260920-actual-arrival-v2', old)
            assert count == 1
        else:
            old, new = (BASELINE / name).read_text(), (SERVER / name).read_text()
        patch += ''.join(difflib.unified_diff(old.splitlines(True), new.splitlines(True), fromfile='a/' + name, tofile='b/' + name))
    (RELEASE / 'release.patch').write_text(patch)
    applied = subprocess.run(['patch', '--batch', '--fuzz=0', '-p1', '-d', str(candidate)], input=patch, text=True, capture_output=True)
    (RELEASE / 'patch.log').write_text(applied.stdout + applied.stderr)
    assert applied.returncode == 0, 'Scoped patch failed; review patch.log'
    for name in ADDED:
        target = candidate / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SERVER / name, target)
    for item in candidate.rglob('*.orig'): item.unlink()
    before = {name: digest(baseline / name) for name in EXISTING}
    after = {name: digest(candidate / name) for name in FILES}
    for name, sha in core.files_at(candidate).items():
        if name not in FILES: assert sha == digest(baseline / name), 'Unrelated live file changed: ' + name
    state.update({'before': before, 'after': after, 'workspace': {name: digest(SERVER / name) for name in FILES},
                  'changedFiles': FILES, 'scope': 'Actual arrival evidence, reconstruction, display and authorized historical recalculation only'})
    stage = RELEASE / 'stage'
    for name in FILES:
        (stage / name).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(candidate / name, stage / name)
    for label, image in [('release', IMAGE), ('rollback', ROLLBACK)]:
        (RELEASE / f'compose.{label}.yml').write_text(f'services:\n  app:\n    image: {image}\n    pull_policy: never\n')
    save('manifest.json', state)
    print(json.dumps({'prepared': True, 'files': FILES, 'baseImage': state['app']['imageId']}), flush=True)


def build():
    core.build()


def verify():
    state = core.manifest()
    core.ready(state['candidateImageId'])
    after = core.metadata(APP)
    assert after['configuration'] == state['app']['configuration'], 'Service configuration changed'
    assert [core.metadata(n) for n in DEPENDENCIES] == state['dependencies'], 'Another service changed'
    actual = docker('exec', APP, 'sha256sum', *['/app/' + name for name in FILES]).decode().splitlines()
    assert {line.split()[1].removeprefix('/app/'): line.split()[0] for line in actual} == state['after']
    script = """import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
const expected=EXPECTED;let checks=0;
for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
 const health=await fetch(base+'/health');assert.equal(health.status,200);assert.equal((await health.json()).ok,true);checks++;
 for(const [file,sha] of Object.entries(expected)){const r=await fetch(base+'/'+file.replace(/^public\\//,''),{headers:{'Cache-Control':'no-cache'}});assert.equal(r.status,200);assert.equal(createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex'),sha);checks++;}
 assert.equal((await fetch(base+'/api/dispatch/actual-arrivals/drivers?date=2026-09-19')).status,401);checks++;
}console.log(JSON.stringify({passed:true,checks}));
""".replace('EXPECTED', json.dumps({name: sha for name, sha in state['after'].items() if name.startswith('public/')}))
    checks = json.loads(docker('exec', '-i', APP, 'node', '--input-type=module', input=script.encode()))
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'image': IMAGE,
              'imageId': after['imageId'], 'configurationPreserved': True, 'otherServicesUnchanged': True,
              'runtimeFilesVerified': len(FILES), 'liveChecks': checks}
    save('deployment-result.json', result)
    print(json.dumps(result), flush=True)


def apply():
    state = core.manifest()
    core.current(state)
    verified = json.loads((RELEASE / 'verified.json').read_text())
    assert verified['passed'] and verified['imageId'] == state['candidateImageId']
    release.config_gate(state)
    assert not any(release.preflight().values()), 'Wait for an idle application cutover'
    command = ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app']
    try:
        with (RELEASE / 'cutover.log').open('wb') as output:
            subprocess.run(core.compose(state, 'compose.release.yml') + command, cwd=ROOT, stdout=output, stderr=subprocess.STDOUT, check=True, timeout=100)
        verify()
    except Exception:
        with (RELEASE / 'rollback.log').open('wb') as output:
            subprocess.run(core.compose(state, 'compose.rollback.yml') + command, cwd=ROOT, stdout=output, stderr=subprocess.STDOUT, check=True, timeout=100)
        core.ready(state['app']['imageId'])
        raise


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['prepare', 'refresh', 'build', 'apply', 'verify'])
    globals()[parser.parse_args().action]()
