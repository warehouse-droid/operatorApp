"""Publish the customer-name requirement as an app-only overlay with rollback."""
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
RELEASE = SERVER / 'deployments/backorder-customer-required-20261022'
IMAGE = 'mbbs-operator-app:backorder-customer-required-20261022'
ROLLBACK = IMAGE + '-rollback'
FILES = [
    'src/special-stock-request-domain.js', 'src/backorder-request-service.js',
    'src/stocking-backorder-conversion.js', 'public/regular-stock-ui.js',
    'public/backorder-stock-requests.js', 'public/stocking-backorder-conversion-ui.js',
    'public/sales-stock-requests.js', 'public/scm-stock-requests.js',
    'public/sales-stock-requests.html', 'public/scm-stock-requests.html',
]
spec = importlib.util.spec_from_file_location('backorder_release_core', SERVER / 'tools/delivery-scm-release.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.RELEASE = RELEASE


def hashes(root):
    return {name: core.sha((root / name).read_bytes()) for name in FILES}


def capture():
    assert not (RELEASE / 'manifest.json').exists(), 'Release already captured'
    RELEASE.mkdir(parents=True, exist_ok=True)
    app = core.metadata(core.APP)
    dependencies = [core.metadata(name) for name in core.DEPENDENCIES]
    before = RELEASE / 'before'
    before.mkdir(exist_ok=True)
    archive = core.docker('exec', core.APP, 'tar', '-cf', '-', '-C', '/app', *FILES)
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        stream.extractall(before, filter='data')
    candidate = RELEASE / 'candidate'
    if candidate.exists():
        shutil.rmtree(candidate)
    shutil.copytree(before, candidate)
    patch = subprocess.check_output(['git', 'diff', '--relative=server', '--',
                                     *['server/' + name for name in FILES]], cwd=ROOT)
    (RELEASE / 'release.patch').write_bytes(patch)
    result = subprocess.run(['patch', '--batch', '--fuzz=0', '-p1', '-d', str(candidate)],
                            input=patch, capture_output=True)
    assert result.returncode == 0, result.stdout.decode() + result.stderr.decode()
    for path in candidate.rglob('*.orig'):
        path.unlink()
    assert core.metadata(core.APP) == app, 'Live image changed during capture'
    core.save('manifest.json', {'capturedAt': core.now(), 'app': app, 'dependencies': dependencies,
        'authorization': 'User requires a customer name for regular stock Backorder requests from now on.',
        'files': FILES, 'beforeHashes': hashes(before), 'candidateHashes': hashes(candidate),
        'workspaceHashes': hashes(SERVER)})
    print(json.dumps({'captured': True, 'files': len(FILES), 'baseImageId': app['imageId']}))


def current(data):
    assert core.metadata(core.APP) == data['app'], 'Live application changed; recapture required'
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies']
    assert hashes(RELEASE / 'candidate') == data['candidateHashes']
    assert hashes(SERVER) == data['workspaceHashes'], 'Workspace source changed since capture'


def checked():
    data = core.state()
    evidence = json.loads((SERVER / 'test/backorder-customer-required-evidence.json').read_text())
    assert evidence['passed'] and evidence['failures'] == 0
    assert evidence['sourceHashes'] == data['candidateHashes'], 'Tested source changed'
    return data


def build():
    data = checked()
    current(data)
    core.docker('tag', data['app']['imageId'], ROLLBACK)
    stage = RELEASE / 'stage'
    shutil.copytree(RELEASE / 'candidate', stage / 'overlay')
    (stage / 'Dockerfile').write_text('FROM ' + ROLLBACK + '\nCOPY --chown=node:node overlay/ /app/\n')
    for mode, tag in [('release', IMAGE), ('rollback', ROLLBACK)]:
        (RELEASE / ('compose.' + mode + '.yml')).write_text('services:\n  app:\n    image: ' + tag + '\n    pull_policy: never\n')
    result = subprocess.run(['docker', 'build', '--network=none', '--pull=false', '-t', IMAGE, str(stage)],
                            capture_output=True, timeout=180)
    assert result.returncode == 0, result.stdout.decode() + result.stderr.decode()
    data['candidateImageId'] = core.docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    core.save('manifest.json', data)
    core.config_check(data)
    print(json.dumps({'built': True, 'image': IMAGE}))


def verify():
    data = checked()
    core.ready(data['candidateImageId'])
    actual = core.metadata(core.APP)
    assert actual['configuration'] == data['app']['configuration'], 'Runtime configuration changed'
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies']
    for name in FILES:
        assert core.sha(core.docker('exec', core.APP, 'cat', '/app/' + name)) == data['candidateHashes'][name]
        if name.startswith('public/'):
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
        subprocess.run(core.compose(data, 'release') + ['up', '-d', '--no-deps', '--no-build', 'app'],
                       check=True, timeout=120)
        verify()
    except BaseException:
        subprocess.run(core.compose(data, 'rollback') + ['up', '-d', '--no-deps', '--no-build', 'app'],
                       check=True, timeout=120)
        core.ready(data['app']['imageId'])
        raise


if __name__ == '__main__':
    {'capture': capture, 'build': build, 'deploy': deploy, 'verify': verify}[sys.argv[1]]()
