"""Capture and publish the tested scoped registered sales split validation overlay."""
import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
RELEASE = SERVER / 'deployments/registered-split-planning-20261007'
spec = importlib.util.spec_from_file_location('release_helpers', SERVER / 'tools/delivery-scm-release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.RELEASE = RELEASE
release.IMAGE = 'mbbs-operator-app:registered-split-planning-20261007'
release.ROLLBACK = release.IMAGE + '-rollback'
release.READ_NAME = 'mbbs-registered-split-baseline-reader'
release.CHECK_NAME = 'mbbs-registered-split-image-check'
FILES = ['src/dispatch-fulfilled-so-repository.js']


def capture():
    RELEASE.mkdir(parents=True, exist_ok=False)
    app = release.metadata(release.APP)
    dependencies = [release.metadata(name) for name in release.DEPENDENCIES]
    before = RELEASE / 'before'
    before.mkdir()
    archive = release.docker('exec', release.APP, 'tar', '-cf', '-', '-C', '/app',
        'src', 'public', 'migrations', 'package.json', 'package-lock.json')
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        stream.extractall(before, filter='data')
    for path in before.rglob('*'):
        path.chmod(path.stat().st_mode | (0o055 if path.is_dir() else 0o044))
    assert release.metadata(release.APP) == app, 'Live application changed during capture'
    shutil.copytree(before, RELEASE / 'candidate')
    workspace = RELEASE / 'workspace-before'
    workspace.mkdir()
    for name in FILES:
        if (SERVER / name).exists():
            target = workspace / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(SERVER / name, target)
    release.save('capture.json', {'app': app, 'dependencies': dependencies,
        'beforeTree': release.files_at(before), 'capturedAt': release.now()})
    print(json.dumps({'captured': True, 'imageId': app['imageId']}))


def stage():
    data = json.loads((RELEASE / 'capture.json').read_text())
    assert release.metadata(release.APP) == data['app'], 'Live application changed; recapture required'
    before, candidate = RELEASE / 'before', RELEASE / 'candidate'
    for name in FILES:
        target = candidate / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SERVER / name, target)
    tree = release.files_at(candidate)
    changed = sorted(n for n in data['beforeTree'].keys() | tree.keys()
        if data['beforeTree'].get(n) != tree.get(n))
    assert changed == sorted(FILES), 'Unexpected runtime scope'
    manifest = {**data, 'files': FILES, 'candidateTree': tree,
        'candidateTreeHash': release.sha(json.dumps(tree, sort_keys=True).encode()),
        'workspace': {n: release.sha((SERVER / n).read_bytes()) for n in FILES},
        'packages': {n: release.sha((candidate / n).read_bytes()) for n in ['package.json', 'package-lock.json']}}
    release.save('manifest.json', manifest)
    release.current(manifest)
    print(json.dumps({'staged': True, 'files': FILES, 'candidateTreeHash': manifest['candidateTreeHash']}))



def apply():
    data = release.state()
    release.current(data)
    check = json.loads((RELEASE / 'image-check.json').read_text())
    assert check['passed'] and check['imageId'] == data['candidateImageId']
    release.config_check(data)
    release.assert_no_active_operations(release.preflight())
    release.save('edit-leases-before.json', release.edit_lease_identities())
    args = ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app']
    try:
        with (RELEASE / 'cutover.log').open('wb') as output:
            subprocess.run(release.compose(data, 'release') + args, cwd=ROOT,
                stdout=output, stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
        release.save('edit-leases-after.json', release.edit_lease_identities())
    except BaseException:
        with (RELEASE / 'rollback.log').open('wb') as output:
            subprocess.run(release.compose(data, 'rollback') + args, cwd=ROOT,
                stdout=output, stderr=subprocess.STDOUT, check=True, timeout=60)
        release.ready(data['app']['imageId'])
        raise


def verify():
    data = release.state()
    release.ready(data['candidateImageId'])
    live = release.metadata(release.APP)
    assert live['imageId'] == data['candidateImageId']
    assert live['configuration'] == data['app']['configuration']
    assert [release.metadata(n) for n in release.DEPENDENCIES] == data['dependencies']
    assert json.loads(release.docker('exec', release.APP, 'node', '-e', release.HASH_SCRIPT)) == data['candidateTree']
    proof = json.loads(release.docker('exec', '-i', release.APP, 'node', '--input-type=module',
        input=(SERVER / 'tools/registered-split-planning-live.mjs').read_bytes(), timeout=60))
    assert proof['passed'] and proof['readOnly'] and not proof['planningRestricted']
    release.save('live-verification.json', proof)
    http = release.http_check({'public/dispatch.js': data['candidateTree']['public/dispatch.js']}, ['/api/dispatch/orders'])
    release.save('deployment-result.json', {'deployed': True, 'at': release.now(),
        'imageId': live['imageId'], 'candidateTreeHash': data['candidateTreeHash'], 'changedFiles': FILES,
        'configurationPreserved': True, 'dependentContainersUnchanged': True, 'http': http})
    print(json.dumps({'deployed': True, 'groupPlanningRestricted': proof['planningRestricted'], 'http': http}))


if __name__ == '__main__':
    action = sys.argv[1]
    if action in {'capture', 'stage', 'apply', 'verify'}:
        globals()[action]()
    elif action == 'build':
        release.build()
    else:
        raise SystemExit('Unsupported release action')
