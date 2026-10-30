"""Publish the two-file initial-travel guard fix over the captured live image."""
import difflib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import urllib.request

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
RELEASE = SERVER / 'deployments/dispatch-start-travel-20261022'
IMAGE = 'mbbs-operator-app:dispatch-start-travel-20261022'
ROLLBACK = IMAGE + '-rollback'
FILES = ['public/dispatch.js', 'public/dispatch.html']
spec = importlib.util.spec_from_file_location('dispatch_travel_release_core', SERVER / 'tools/delivery-scm-release.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.RELEASE = RELEASE


def hashes(root):
    return {name: core.sha((root / name).read_bytes()) for name in FILES}


def capture():
    RELEASE.mkdir(parents=True, exist_ok=False)
    app = core.metadata(core.APP)
    dependencies = [core.metadata(name) for name in core.DEPENDENCIES]
    before = RELEASE / 'before'
    before.mkdir()
    archive = core.docker('exec', core.APP, 'tar', '-cf', '-', '-C', '/app', *FILES)
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        stream.extractall(before, filter='data')
    assert hashes(before) == hashes(SERVER), 'Workspace and deployed dispatch assets differ; rebase first'
    assert core.metadata(core.APP) == app
    core.save('manifest.json', {'capturedAt': core.now(), 'app': app, 'dependencies': dependencies,
        'files': FILES, 'beforeHashes': hashes(before),
        'authorization': 'User requests fixing protected stop 6 in today\'s Dao Load 2.'})
    print(json.dumps({'captured': True, 'files': FILES, 'baseImageId': app['imageId']}))


def prepare():
    data = core.state()
    assert core.metadata(core.APP) == data['app'], 'Live app changed; recapture required'
    candidate = RELEASE / 'candidate'
    candidate.mkdir(exist_ok=True)
    patch = ''
    for name in FILES:
        target = candidate / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SERVER / name, target)
        patch += ''.join(difflib.unified_diff((RELEASE / 'before' / name).read_text().splitlines(True),
            target.read_text().splitlines(True), fromfile='a/' + name, tofile='b/' + name))
    (RELEASE / 'release.patch').write_text(patch)
    data['candidateHashes'] = hashes(candidate)
    assert all(data['beforeHashes'][name] != data['candidateHashes'][name] for name in FILES)
    core.save('manifest.json', data)
    print(json.dumps({'prepared': True, 'files': FILES, 'candidateHashes': data['candidateHashes']}))


def checked():
    data = core.state()
    evidence = json.loads((SERVER / 'test/dispatch/specs/dispatch-start-travel-20261022-evidence.json').read_text())
    assert evidence['passed'] and evidence['newFailures'] == 0
    assert evidence['sourceHashes'] == data['candidateHashes'] == hashes(SERVER) == hashes(RELEASE / 'candidate')
    assert evidence['mutations']['killed'] == evidence['mutations']['total']
    return data


def current(data):
    assert core.metadata(core.APP) == data['app'], 'Live app changed; recapture required'
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies']


def build():
    data = checked()
    current(data)
    core.docker('tag', data['app']['imageId'], ROLLBACK)
    stage = RELEASE / 'stage'
    shutil.copytree(RELEASE / 'candidate', stage / 'overlay', dirs_exist_ok=True)
    (stage / 'Dockerfile').write_text('FROM ' + ROLLBACK + '\nCOPY --chown=node:node overlay/ /app/\n')
    for mode, tag in [('release', IMAGE), ('rollback', ROLLBACK)]:
        (RELEASE / ('compose.' + mode + '.yml')).write_text('services:\n  app:\n    image: ' + tag + '\n    pull_policy: never\n')
    result = subprocess.run(['docker', 'build', '--network=none', '--pull=false', '-t', IMAGE, str(stage)],
                            capture_output=True, timeout=180)
    assert result.returncode == 0, result.stdout.decode() + result.stderr.decode()
    data['candidateImageId'] = core.docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    core.save('manifest.json', data)
    core.config_check(data)
    print(json.dumps({'built': True, 'image': IMAGE, 'files': FILES}))


def verify():
    data = checked()
    core.ready(data['candidateImageId'])
    actual = core.metadata(core.APP)
    assert actual['configuration'] == data['app']['configuration'], 'Runtime configuration changed'
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies']
    for name in FILES:
        assert core.sha(core.docker('exec', core.APP, 'cat', '/app/' + name)) == data['candidateHashes'][name]
        with urllib.request.urlopen('http://127.0.0.1:3000/' + name.removeprefix('public/'), timeout=10) as response:
            assert response.status == 200 and core.sha(response.read()) == data['candidateHashes'][name]
    containers = {key: core.docker(*args, '--format', '{{.Names}} {{.Status}}').decode().splitlines()
        for key, args in [('running', ['ps']), ('all', ['ps', '-a'])]}
    for rows in containers.values():
        assert {row.split()[0] for row in rows} == {core.APP, *core.DEPENDENCIES}
    result = {'deployed': True, 'at': core.now(), 'image': IMAGE, 'imageId': actual['imageId'],
        'healthy': True, 'configurationPreserved': True, 'dependenciesUnchanged': True,
        'filesVerified': len(FILES), 'rollbackImage': ROLLBACK}
    core.save('containers.json', containers)
    core.save('deployed.json', result)
    print(json.dumps(result))


def deploy():
    data = checked()
    current(data)
    core.config_check(data)
    core.assert_no_active_operations(core.preflight())
    try:
        subprocess.run(core.compose(data, 'release') + ['up', '-d', '--no-deps', '--no-build', 'app'], check=True, timeout=120)
        verify()
    except BaseException:
        subprocess.run(core.compose(data, 'rollback') + ['up', '-d', '--no-deps', '--no-build', 'app'], check=True, timeout=120)
        core.ready(data['app']['imageId'])
        raise


if __name__ == '__main__':
    {'capture': capture, 'prepare': prepare, 'build': build, 'deploy': deploy, 'verify': verify}[sys.argv[1]]()
