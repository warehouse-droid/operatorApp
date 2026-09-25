"""Release only the tested receiving-screen correction over the current image."""
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
spec = importlib.util.spec_from_file_location('receipt_release_core', SERVER / 'tools/operator-display-settings-deploy.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
CHECKS = SERVER / 'test-artifacts/receiving-posting-status'
core.RELEASE = CHECKS / 'release'
core.BEFORE = CHECKS / 'before'
core.FILES = core.EXISTING = ['public/operator.html', 'public/operator.js', 'public/service-worker.js']
core.ADDED = []
core.IMAGE = 'mbbs-operator-app:receiving-posting-status-20260923-v1'
core.ROLLBACK = 'mbbs-operator-app:rollback-receiving-posting-status-20260923-v1'
VERSION = '20260923-receipt-status-v1'


def prepare():
    os.umask(0o077)
    core.RELEASE.mkdir(parents=True, exist_ok=False)
    state = {'app': core.metadata(core.APP), 'dependencies': [core.metadata(name) for name in core.DEPENDENCIES]}
    baseline = core.RELEASE / 'baseline'
    baseline.mkdir()
    public = baseline / 'public'
    public.mkdir()
    archive = core.docker('exec', core.APP, 'tar', '-C', '/app/public', '-cf', '-', '.')
    with tarfile.open(fileobj=io.BytesIO(archive)) as captured:
        captured.extractall(public, filter='data')
    assert core.metadata(core.APP) == state['app'], 'Live app changed during capture'
    candidate = core.RELEASE / 'candidate'
    shutil.copytree(baseline, candidate)
    name = 'public/operator.js'
    old = (core.BEFORE / name).read_text()
    new = (SERVER / name).read_text()
    patch = ''.join(difflib.unified_diff(old.splitlines(True), new.splitlines(True), fromfile='a/' + name, tofile='b/' + name))
    (core.RELEASE / 'receiving.patch').write_text(patch)
    result = subprocess.run(['patch', '--batch', '--fuzz=0', '-p1', '-d', str(candidate)], input=patch, text=True, capture_output=True)
    (core.RELEASE / 'patch.log').write_text(result.stdout + result.stderr)
    assert result.returncode == 0, 'Receiving patch requires review'
    for file in ['public/operator.html', 'public/service-worker.js']:
        text = (candidate / file).read_text()
        text, count = re.subn(r'/operator\.js\?v=[^"\s]+', '/operator.js?v=' + VERSION, text)
        assert count == 1
        if file.endswith('service-worker.js'):
            text, count = re.subn(r'const CACHE_NAME = "[^"]+";', 'const CACHE_NAME = "mbbs-yard-operator-' + VERSION + '";', text)
            assert count == 1
        (candidate / file).write_text(text)
    for file in candidate.rglob('*.orig'):
        file.unlink()
    before, after = core.files_at(baseline), core.files_at(candidate)
    changed = sorted(file for file in after if after[file] != before.get(file))
    assert changed == core.FILES, 'Unexpected release scope'
    state.update({'image': core.IMAGE, 'before': {file: before[file] for file in core.FILES},
                  'after': {file: after[file] for file in core.FILES},
                  'workspace': {file: core.digest((SERVER / file).read_bytes()) for file in core.FILES}, 'changedFiles': changed})
    for file in core.FILES:
        target = core.RELEASE / 'stage' / file
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(candidate / file, target)
    (core.RELEASE / 'compose.release.yml').write_text('services:\n  app:\n    image: ' + core.IMAGE + '\n')
    (core.RELEASE / 'compose.rollback.yml').write_text('services:\n  app:\n    image: ' + state['app']['imageId'] + '\n')
    core.save('manifest.json', state)
    print(json.dumps({'prepared': True, 'changedFiles': changed, 'baseImage': state['app']['imageId']}))


def validate():
    state = core.manifest()
    core.current(state)
    gate = json.loads((CHECKS / 'verification.json').read_text())
    assert gate['passed'] and gate['sources'] == state['workspace'], 'Final source verification required'
    assert gate['candidateSources'] == state['after'], 'Release candidate verification required'
    core.save('verified.json', {'passed': True, 'imageId': state['candidateImageId'], 'sources': state['after']})
    print(json.dumps({'verified': True, 'imageId': state['candidateImageId']}))


def verify():
    state = core.manifest()
    core.ready(state['candidateImageId'])
    current = core.metadata(core.APP)
    assert current['configuration'] == state['app']['configuration'], 'Runtime configuration changed'
    assert [core.metadata(name) for name in core.DEPENDENCIES] == state['dependencies'], 'Other services changed'
    actual = core.docker('exec', core.APP, 'sha256sum', *['/app/' + name for name in core.FILES]).decode().splitlines()
    assert {line.split()[1].removeprefix('/app/'): line.split()[0] for line in actual} == state['after']
    script = """import assert from 'node:assert/strict'; import crypto from 'node:crypto';
const files = FILES;
for (const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
  for (const [file, expected] of Object.entries(files)) {
    const response = await fetch(base + '/' + file.replace('public/',''), {headers:{'Cache-Control':'no-cache'}});
    assert.equal(response.status,200,file);
    assert.equal(crypto.createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'),expected,file);
  }
  const health=await fetch(base+'/health'); assert.equal(health.status,200); assert.equal((await health.json()).ok,true);
}
console.log(JSON.stringify({localHealth:200,publicHealth:200,publicAssetsVerified:3}));
""".replace('FILES', json.dumps(state['after']))
    probes = json.loads(core.docker('exec', '-i', core.APP, 'node', '--input-type=module', input=script.encode()))
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'imageId': current['imageId'], 'files': core.FILES, 'configurationPreserved': True,
              'otherServicesUnchanged': True, **probes}
    core.save('deployment-result.json', result)
    print(json.dumps(result))


def apply():
    state = core.manifest()
    core.current(state)
    assert json.loads((core.RELEASE / 'verified.json').read_text()) == {
        'passed': True, 'imageId': state['candidateImageId'], 'sources': state['after']}
    assert core.docker('image', 'inspect', '--format', '{{.Id}}', core.IMAGE).decode().strip() == state['candidateImageId']
    resolved = json.loads(subprocess.check_output(core.compose(state, 'compose.release.yml') + ['config', '--format', 'json'], cwd=core.ROOT))['services']['app']
    image = json.loads(core.docker('image', 'inspect', core.IMAGE))[0]['Config']
    running = json.loads(core.docker('inspect', core.APP))[0]['Config']
    expected_env = dict(entry.split('=', 1) for entry in image['Env'])
    expected_env.update({key: str(value) for key, value in resolved.get('environment', {}).items()})
    assert expected_env == dict(entry.split('=', 1) for entry in running['Env']), 'Compose environment drift'
    for field, key in [('Cmd','command'), ('Entrypoint','entrypoint'), ('User','user'), ('WorkingDir','working_dir')]:
        assert (image.get(field) if resolved.get(key) is None else resolved[key]) == running.get(field), 'Compose startup drift'
    assert core.database("SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing');").strip() == '0', 'Posting active; wait for an idle cutover'
    core.current(state)
    command = ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app']
    try:
        with (core.RELEASE / 'cutover.log').open('wb') as output:
            subprocess.run(core.compose(state, 'compose.release.yml') + command, cwd=core.ROOT, stdout=output, stderr=subprocess.STDOUT, check=True, timeout=100)
        verify()
    except Exception:
        with (core.RELEASE / 'rollback.log').open('wb') as output:
            subprocess.run(core.compose(state, 'compose.rollback.yml') + command, cwd=core.ROOT, stdout=output, stderr=subprocess.STDOUT, check=True, timeout=100)
        core.ready(state['app']['imageId'])
        core.save('rolled-back.json', {'at': datetime.datetime.now(datetime.timezone.utc).isoformat()})
        raise


if __name__ == '__main__':
    os.umask(0o077)
    {'prepare': prepare, 'build': core.build, 'validate': validate, 'apply': apply, 'verify': verify}[sys.argv[1]]()
