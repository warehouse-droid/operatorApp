"""Prepare the one-file cross-date regroup correction; deploy is a separate action."""
import importlib.util
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('regroup_release', SERVER / 'tools/dispatch-start-travel-release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.RELEASE = SERVER / 'deployments/dispatch-regroup-20261028'
release.core.RELEASE = release.RELEASE
release.IMAGE = 'mbbs-operator-app:dispatch-regroup-20261028'
release.ROLLBACK = release.IMAGE + '-rollback'
release.FILES = ['src/dispatch-delivery-group-repository.js']
BASELINE_HASH = 'ea1803dc4d9d7cc389800bf2b29e231f9e69f5f24f4919ebbb36bd9cab2bd28d'
EVIDENCE = SERVER / 'test/dispatch-cross-plan-regroup-evidence.json'


def checked():
    data = release.core.state()
    evidence = json.loads(EVIDENCE.read_text())
    expected = {release.FILES[0]: evidence['sourceHash']}
    assert evidence['passed'] and evidence['focused']['status'] == 0
    assert evidence['regressions']['failures'] == evidence['baseline']['failures']
    assert all(row['killed'] for row in evidence['mutations'])
    assert data['candidateHashes'] == expected == release.hashes(SERVER)
    assert expected == release.hashes(release.RELEASE / 'candidate')
    return data


def capture():
    core = release.core
    release.RELEASE.mkdir(parents=True, exist_ok=False)
    app = core.metadata(core.APP)
    dependencies = [core.metadata(name) for name in core.DEPENDENCIES]
    before = core.docker('exec', core.APP, 'cat', '/app/' + release.FILES[0])
    assert core.sha(before) == BASELINE_HASH, 'Live source changed; rebase before preparing'
    target = release.RELEASE / 'before' / release.FILES[0]
    target.parent.mkdir(parents=True)
    target.write_bytes(before)
    assert core.metadata(core.APP) == app
    core.save('manifest.json', {'capturedAt': core.now(), 'app': app, 'dependencies': dependencies,
        'files': release.FILES, 'beforeHashes': {release.FILES[0]: BASELINE_HASH},
        'authorization': 'Source correction and candidate preparation for reported GOA-10979-10980 save failure; live deployment pending.',
        'businessDataChanges': False})
    print(json.dumps({'captured': True, 'files': release.FILES, 'baseImageId': app['imageId']}))


def verify():
    core = release.core
    data = checked()
    core.ready(data['candidateImageId'])
    actual = core.metadata(core.APP)
    assert actual['configuration'] == data['app']['configuration']
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies']
    for name in release.FILES:
        assert core.sha(core.docker('exec', core.APP, 'cat', '/app/' + name)) == data['candidateHashes'][name]
    result = {'deployed': True, 'at': core.now(), 'image': release.IMAGE,
        'imageId': actual['imageId'], 'healthy': True, 'configurationPreserved': True,
        'dependenciesUnchanged': True, 'businessDataChanges': False, 'rollbackImage': release.ROLLBACK}
    core.save('deployed.json', result)
    print(json.dumps(result))


release.checked = checked
release.verify = verify

if __name__ == '__main__':
    command = sys.argv[1]
    if command == 'prepare':
        capture()
        release.prepare()
        release.build()
    else:
        {'deploy': release.deploy, 'verify': verify}[command]()
