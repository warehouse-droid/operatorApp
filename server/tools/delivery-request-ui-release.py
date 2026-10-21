"""Release only the tested delivery UI and status filter over the live image."""
import atexit
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile

SERVER = Path(__file__).resolve().parents[1]
ARTIFACT = SERVER / 'test-artifacts/delivery-requests-ui-20261006'
RELEASE = SERVER / 'deployments/delivery-request-ui-20261006'
spec = importlib.util.spec_from_file_location('delivery_release_helpers', SERVER / 'tools/delivery-scm-release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.RELEASE = RELEASE
release.IMAGE = 'mbbs-operator-app:delivery-request-ui-20261006'
release.ROLLBACK = release.IMAGE + '-rollback'
release.READ_NAME = 'mbbs-delivery-ui-baseline-reader'
release.CHECK_NAME = 'mbbs-delivery-ui-image-check'


def capture():
    RELEASE.mkdir(exist_ok=False)
    before = release.metadata(release.APP)
    dependencies = [release.metadata(n) for n in release.DEPENDENCIES]
    baseline = RELEASE / 'before'
    baseline.mkdir()
    archive = release.docker('exec', release.APP, 'tar', '-cf', '-', '-C', '/app',
                            'src', 'public', 'migrations', 'package.json', 'package-lock.json')
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        stream.extractall(baseline, filter='data')
    assert release.metadata(release.APP) == before, 'Live app changed during capture'
    candidate = RELEASE / 'candidate'
    shutil.copytree(baseline, candidate)
    for path in [candidate, *candidate.rglob('*')]:
        os.chown(path, 1000, 1000)
    old = json.loads((ARTIFACT / 'before.json').read_text())
    for name, digest in old.items():
        assert release.sha((baseline / name).read_bytes()) == digest, 'Live baseline differs: ' + name
        shutil.copy2(SERVER / name, candidate / name)
    before_tree, after_tree = release.files_at(baseline), release.files_at(candidate)
    changed = sorted(n for n in before_tree.keys() | after_tree.keys() if before_tree.get(n) != after_tree.get(n))
    assert changed == sorted(old), 'Unexpected release scope'
    release.save('manifest.json', {'capturedAt': release.now(), 'app': before, 'dependencies': dependencies,
        'files': changed, 'beforeTree': before_tree, 'candidateTree': after_tree,
        'candidateTreeHash': release.sha(json.dumps(after_tree, sort_keys=True).encode()),
        'workspace': {n: release.sha((SERVER / n).read_bytes()) for n in changed},
        'packages': {n: release.sha((candidate / n).read_bytes()) for n in ['package.json', 'package-lock.json']}})
    print(json.dumps({'captured': True, 'changedFiles': changed}), flush=True)


def verify():
    data = release.state()
    release.ready(data['candidateImageId'])
    live = release.metadata(release.APP)
    assert live['imageId'] == data['candidateImageId']
    assert live['configuration'] == data['app']['configuration'], 'Application configuration changed'
    assert [release.metadata(n) for n in release.DEPENDENCIES] == data['dependencies'], 'A dependency changed'
    assert json.loads(release.docker('exec', release.APP, 'node', '-e', release.HASH_SCRIPT)) == data['candidateTree']
    public = {n: data['candidateTree'][n] for n in data['files'] if n.startswith('public/')}
    checked = release.http_check(public, ['/api/sales/delivery-requests', '/api/dispatch/delivery-requests'])
    release.save('deployment-result.json', {'deployed': True, 'at': release.now(), 'image': release.IMAGE,
        'imageId': live['imageId'], 'candidateTreeHash': data['candidateTreeHash'],
        'runtimeFilesVerified': len(data['candidateTree']), 'changedFiles': data['files'],
        'configurationPreserved': True, 'workerAndDependenciesUnchanged': True, 'schemaChanged': False,
        'http': checked})
    print(json.dumps({'deployed': True, 'http': checked}), flush=True)


def refresh_candidate():
    data = release.state()
    assert 'candidateImageId' not in data, 'Cannot edit a built candidate'
    assert release.metadata(release.APP) == data['app'], 'Live app changed'
    assert json.loads(release.docker('exec', release.APP, 'node', '-e', release.HASH_SCRIPT)) == data['beforeTree']
    for name in data['files']:
        shutil.copy2(SERVER / name, RELEASE / 'candidate' / name)
    tree = release.files_at(RELEASE / 'candidate')
    assert sorted(name for name in data['beforeTree'] if data['beforeTree'][name] != tree[name]) == data['files']
    data.update(candidateTree=tree, candidateTreeHash=release.sha(json.dumps(tree, sort_keys=True).encode()),
                workspace={n: release.sha((SERVER / n).read_bytes()) for n in data['files']})
    release.save('manifest.json', data)
    print(json.dumps({'refreshed': True, 'candidateTreeHash': data['candidateTreeHash']}), flush=True)


def apply():
    data = release.state()
    release.current(data)
    check = json.loads((RELEASE / 'image-check.json').read_text())
    assert check['passed'] and check['imageId'] == data['candidateImageId']
    release.config_check(data)
    release.assert_no_active_operations(release.preflight())
    leases = release.edit_lease_identities()
    args = ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app']
    try:
        with (RELEASE / 'cutover.log').open('wb') as output:
            subprocess.run(release.compose(data, 'release') + args, cwd=SERVER.parent,
                           stdout=output, stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
        after = release.edit_lease_identities()
        release.save('editing-lease-result.json', {'before': leases, 'after': after,
                                                  'retained': set(leases) <= set(after)})
    except BaseException:
        with (RELEASE / 'rollback.log').open('wb') as output:
            subprocess.run(release.compose(data, 'rollback') + args, cwd=SERVER.parent,
                           stdout=output, stderr=subprocess.STDOUT, check=True, timeout=60)
        release.ready(data['app']['imageId'])
        release.save('rollback-result.json', {'restoredImageId': data['app']['imageId']})
        raise


if __name__ == '__main__':
    atexit.register(release.cleanup_manual)
    {'capture': capture, 'refresh-candidate': refresh_candidate, 'build': release.build, 'apply': apply, 'verify': verify}[sys.argv[1]]()
