"""Publish the opening-travel display fix without changing Driver jobs."""
import importlib.util
import json
from pathlib import Path
import sys
import urllib.request

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('release', SERVER / 'tools/dispatch-start-travel-release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.RELEASE = SERVER / 'deployments/dispatch-delivery-start-20261022'
release.core.RELEASE = release.RELEASE
release.IMAGE = 'mbbs-operator-app:dispatch-delivery-start-20261022'
release.ROLLBACK = release.IMAGE + '-rollback'
release.FILES = ['public/dispatch.js', 'public/dispatch.html', 'src/dispatch-forecast-service.js']


def checked():
    data = release.core.state()
    evidence = json.loads((SERVER / 'test/dispatch/specs/dispatch-delivery-start-20261022-evidence.json').read_text())
    assert evidence['passed'] and evidence['newFailures'] == 0
    assert evidence['sourceHashes'] == data['candidateHashes'] == release.hashes(SERVER) == release.hashes(release.RELEASE / 'candidate')
    return data


def verify():
    data = checked()
    core = release.core
    core.ready(data['candidateImageId'])
    actual = core.metadata(core.APP)
    assert actual['configuration'] == data['app']['configuration']
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies']
    for name in release.FILES:
        assert core.sha(core.docker('exec', core.APP, 'cat', '/app/' + name)) == data['candidateHashes'][name]
        if name.startswith('public/'):
            with urllib.request.urlopen('http://127.0.0.1:3000/' + name.removeprefix('public/'), timeout=10) as response:
                assert response.status == 200 and core.sha(response.read()) == data['candidateHashes'][name]
    containers = {key: core.docker(*args, '--format', '{{.Names}} {{.Status}}').decode().splitlines()
        for key, args in [('running', ['ps']), ('all', ['ps', '-a'])]}
    for rows in containers.values():
        assert {row.split()[0] for row in rows} == {core.APP, *core.DEPENDENCIES}
    result = {'deployed': True, 'at': core.now(), 'image': release.IMAGE, 'imageId': actual['imageId'],
        'healthy': True, 'configurationPreserved': True, 'dependenciesUnchanged': True,
        'filesVerified': len(release.FILES), 'rollbackImage': release.ROLLBACK}
    core.save('containers.json', containers)
    core.save('deployed.json', result)
    print(json.dumps(result))


release.checked = checked
release.verify = verify

if __name__ == '__main__':
    command = sys.argv[1]
    if command == 'capture':
        release.capture()
        data = release.core.state()
        data['authorization'] = ('User authorized deploying dispatch fixes and reports missing opening travel '
            'from GOA-9886-9887 to SOB122739 in Li Load 4.')
        release.core.save('manifest.json', data)
    else:
        {'prepare': release.prepare, 'build': release.build,
         'deploy': release.deploy, 'verify': verify}[command]()
