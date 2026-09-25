"""Deploy only the two verified backend filtering changes over the live image."""
import datetime
import difflib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('split_group_release', ROOT / 'tools/rejected-edit-lifecycle-deploy.py')
previous = importlib.util.module_from_spec(spec)
spec.loader.exec_module(previous)
core = previous.core
release = previous.release
core.RELEASE = Path('/home/ubuntu/operatorapp-deploy-backups/split-group-pickup-20260924-v1')
core.BEFORE = ROOT / 'test-artifacts/split-group-pickup/before'
core.FILES = core.EXISTING = ['src/dispatch-order-catalog-repository.js','src/server.js']
core.ADDED = []
core.IMAGE = 'mbbs-operator-app:split-group-pickup-20260924-v1'
core.ROLLBACK = 'mbbs-operator-app:rollback-split-group-pickup-20260924-v1'
ART = ROOT / 'test-artifacts/split-group-pickup'


def prepare():
    core.RELEASE.mkdir(parents=True, exist_ok=False)
    state = {'app': core.metadata(core.APP), 'dependencies': [core.metadata(name) for name in core.DEPENDENCIES]}
    baseline = core.RELEASE / 'baseline'
    baseline.mkdir()
    archive = core.docker('exec', core.APP, 'tar', '-C', '/app', '-cf', '-', 'src','public','migrations','package.json','package-lock.json')
    with tarfile.open(fileobj=io.BytesIO(archive)) as captured:
        captured.extractall(baseline, filter='data')
    assert core.metadata(core.APP) == state['app']
    candidate = core.RELEASE / 'candidate'
    shutil.copytree(baseline, candidate)
    patch = ''
    for file in core.FILES:
        patch += ''.join(difflib.unified_diff((core.BEFORE / file).read_text().splitlines(True),
                         (ROOT / file).read_text().splitlines(True), fromfile='a/' + file, tofile='b/' + file))
    (core.RELEASE / 'release.patch').write_text(patch)
    result = subprocess.run(['patch','--batch','--fuzz=0','-p1','-d',str(candidate)], input=patch, text=True, capture_output=True)
    (core.RELEASE / 'patch.log').write_text(result.stdout + result.stderr)
    assert result.returncode == 0, 'Patch requires review'
    for file in candidate.rglob('*.orig'):
        if not (baseline / file.relative_to(candidate)).exists():
            file.unlink()
    before, after = core.files_at(baseline), core.files_at(candidate)
    changed = sorted(file for file in before.keys() | after.keys() if before.get(file) != after.get(file))
    assert changed == core.FILES
    state.update({'image': core.IMAGE, 'before': {file: before[file] for file in changed},
                  'after': {file: after[file] for file in changed}, 'workspace': {file: core.digest((ROOT / file).read_bytes()) for file in changed},
                  'unchangedSources': {file: value for file, value in before.items() if file not in changed}, 'changedFiles': changed})
    for file in changed:
        target = core.RELEASE / 'stage' / file
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(candidate / file, target)
    (core.RELEASE / 'compose.release.yml').write_text('services:\n  app:\n    image: ' + core.IMAGE + '\n')
    (core.RELEASE / 'compose.rollback.yml').write_text('services:\n  app:\n    image: ' + state['app']['imageId'] + '\n')
    core.save('manifest.json', state)
    print(json.dumps({'prepared': True, 'files': changed}))


def validate():
    state = core.manifest()
    core.current(state)
    checks = json.loads((ART / 'verification.json').read_text())
    assert checks['passed'] and checks['workspace'] == state['workspace'] and checks['candidateSources'] == state['after']
    core.save('verified.json', {'passed': True, 'imageId': state['candidateImageId'], 'sources': state['after']})
    print(json.dumps({'verified': True}))


def verify():
    state = core.manifest()
    core.ready(state['candidateImageId'])
    actual = core.metadata(core.APP)
    assert actual['configuration'] == state['app']['configuration']
    assert [core.metadata(name) for name in core.DEPENDENCIES] == state['dependencies']
    expected = {**state['unchangedSources'], **state['after']}
    hashes = core.docker('exec', core.APP, 'sha256sum', *['/app/' + file for file in expected]).decode().splitlines()
    assert {line.split()[1].removeprefix('/app/'): line.split()[0] for line in hashes} == expected
    script = "for (const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {const r=await fetch(base+'/health');if(r.status!==200||(await r.json()).ok!==true)process.exit(1);}"
    core.docker('exec','-i',core.APP,'node','--input-type=module',input=script.encode())
    probe = json.loads(core.docker('exec','-i',core.APP,'node','--input-type=module',input=(ROOT / 'tools/split-group-pickup-live.mjs').read_bytes()))
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'imageId': state['candidateImageId'],
              'files': core.FILES, 'verifiedFiles': len(expected), 'configurationPreserved': True, 'otherServicesUnchanged': True,
              'publicHealth': 200, 'localHealth': 200, 'live': probe}
    core.save('deployment-result.json', result)
    print(json.dumps(result))


def apply():
    release.verify = verify
    release.apply()


if __name__ == '__main__':
    os.umask(0o077)
    {'prepare': prepare, 'build': core.build, 'validate': validate, 'apply': apply, 'verify': verify}[sys.argv[1]]()
