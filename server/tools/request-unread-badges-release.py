"""Publish the request conversation badges as an app-only, reversible overlay."""
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
import urllib.request

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
RELEASE = SERVER / 'deployments/request-unread-badges-20261026'
IMAGE = 'mbbs-operator-app:request-unread-badges-20261026'
ROLLBACK = IMAGE + '-rollback'
FILES = ['public/request-unread-badge.js', 'public/request-unread-badge.css',
         'public/stock-request-conversation.js', 'public/delivery-requests.js',
         'public/sales-stock-requests.html', 'public/scm-stock-requests.html',
         'public/delivery-requests.html', 'src/delivery-request-repository.js']
spec = importlib.util.spec_from_file_location('badge_release_core', SERVER / 'tools/delivery-scm-release.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.RELEASE = RELEASE


def hashes(root):
    return {name: core.sha((root / name).read_bytes()) for name in FILES if (root / name).exists()}


def prepare():
    RELEASE.mkdir(parents=True, exist_ok=False)
    app = core.metadata(core.APP)
    dependencies = [core.metadata(name) for name in core.DEPENDENCIES]
    before_tree = json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT))
    before = RELEASE / 'before'
    before.mkdir()
    existing = [name for name in FILES if name in before_tree]
    archive = core.docker('exec', core.APP, 'tar', '-cf', '-', '-C', '/app', *existing)
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        stream.extractall(before, filter='data')
    candidate = RELEASE / 'candidate'
    shutil.copytree(before, candidate)
    patch = ''
    for name in FILES:
        current = (SERVER / name).read_text()
        if 'request-unread-badge.' in name:
            assert name not in before_tree, 'Badge asset already exists in production'
            original = ''
        elif name.endswith('.html'):
            original = ''.join(line for line in current.splitlines(True) if '/request-unread-badge.' not in line)
            original = original.replace('/stock-request-conversation.js?v=20261026-unread', '/stock-request-conversation.js?v=20261016-followup')
            original = original.replace('/delivery-requests.js?v=20261026-unread', '/delivery-requests.js?v=20261016-expiry')
        else:
            original = subprocess.check_output(['git', 'show', 'HEAD:server/' + name], cwd=ROOT).decode()
        patch += ''.join(difflib.unified_diff(original.splitlines(True), current.splitlines(True),
            fromfile='a/' + name if original else '/dev/null', tofile='b/' + name))
    (RELEASE / 'feature.patch').write_text(patch)
    applied = subprocess.run(['patch', '--batch', '--fuzz=0', '--no-backup-if-mismatch', '-p1', '-d', str(candidate)],
                             input=patch, text=True, capture_output=True)
    assert applied.returncode == 0, applied.stdout + applied.stderr
    candidate_hashes = hashes(candidate)
    assert candidate_hashes == hashes(SERVER), 'Live overlay differs from tested source; review before publishing'
    assert core.metadata(core.APP) == app, 'Live application changed during preparation'
    assert json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT)) == before_tree
    core.save('manifest.json', {'preparedAt': core.now(), 'app': app, 'dependencies': dependencies,
        'request': 'Red unread-message count badges on Special, Stock and Delivery request cards, with a quarter overlapping the top-right corner.',
        'files': FILES, 'beforeTree': before_tree, 'candidateTree': {**before_tree, **candidate_hashes},
        'candidateHashes': candidate_hashes, 'workspaceHashes': hashes(SERVER)})
    print(json.dumps({'prepared': True, 'files': len(FILES), 'matchesTestedSource': True}))


def checked():
    data = core.state()
    evidence = json.loads((SERVER / 'test/request-unread-badges-evidence.json').read_text())
    assert evidence['passed'] and evidence['sourceHashes'] == data['candidateHashes']
    assert hashes(SERVER) == data['workspaceHashes']
    assert hashes(RELEASE / 'candidate') == data['candidateHashes']
    return data


def current(data):
    assert core.metadata(core.APP) == data['app'], 'Live application changed; recapture required'
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies']
    assert json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT)) == data['beforeTree']


def build():
    data = checked()
    current(data)
    core.docker('tag', data['app']['imageId'], ROLLBACK)
    stage = RELEASE / 'stage'
    shutil.copytree(RELEASE / 'candidate', stage / 'overlay')
    (stage / 'Dockerfile').write_text('FROM ' + ROLLBACK + '\nCOPY --chown=node:node overlay/ /app/\n')
    for mode, tag in [('release', IMAGE), ('rollback', ROLLBACK)]:
        (RELEASE / ('compose.' + mode + '.yml')).write_text('services:\n  app:\n    image: ' + tag + '\n    pull_policy: never\n')
    result = subprocess.run(['docker', 'build', '--network=none', '--pull=false', '-t', IMAGE, str(stage)], capture_output=True, timeout=180)
    assert result.returncode == 0, result.stdout.decode() + result.stderr.decode()
    data['candidateImageId'] = core.docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    core.save('manifest.json', data)
    core.config_check(data)
    print(json.dumps({'built': True, 'image': IMAGE}))


def check_image():
    assert os.environ.get('MBBS_TEST_ARTIFACT_DIR'), 'Run image checks through docker/retention/retention.py run'
    data = checked()
    name = 'mbbs-unread-badge-check-' + str(os.getpid())
    try:
        actual = json.loads(core.bounded(data['candidateImageId'], name, 'node', '-e', core.HASH_SCRIPT))
        assert actual == data['candidateTree'], 'Built runtime differs from the reviewed overlay'
        core.save('image-check.json', {'passed': True, 'imageId': data['candidateImageId'], 'runtimeFiles': len(actual)})
    finally:
        subprocess.run(['docker', 'rm', '-fv', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for args in [('ps',), ('ps', '-a')]:
            print(core.docker(*args, '--format', '{{.Names}} {{.Status}}').decode())
        assert not core.docker('ps', '-aq', '--filter', 'name=^/' + name + '$').strip()
        with urllib.request.urlopen('http://127.0.0.1:3000/health', timeout=5) as response:
            assert response.status == 200
    print(json.dumps({'imageChecked': True, 'runtimeFiles': len(actual)}))


def verify():
    data = checked()
    core.ready(data['candidateImageId'])
    actual = core.metadata(core.APP)
    assert actual['configuration'] == data['app']['configuration'], 'Runtime configuration changed'
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies']
    assert json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT)) == data['candidateTree']
    for name, expected in data['candidateHashes'].items():
        if name.startswith('public/'):
            with urllib.request.urlopen('http://127.0.0.1:3000/' + name.removeprefix('public/'), timeout=10) as response:
                assert response.status == 200 and core.sha(response.read()) == expected
    core.save('deployed.json', {'deployed': True, 'at': core.now(), 'image': IMAGE, 'imageId': actual['imageId'],
        'healthy': True, 'configurationPreserved': True, 'dependenciesUnchanged': True,
        'filesVerified': len(FILES), 'runtimeFilesVerified': len(data['candidateTree']), 'rollbackImage': ROLLBACK})
    core.save('containers.json', {key: core.docker(*args, '--format', '{{.Names}} {{.Status}}').decode().splitlines()
        for key, args in [('running', ['ps']), ('all', ['ps', '-a'])]})
    print(json.dumps({'deployed': True, 'healthy': True, 'filesVerified': len(FILES)}))


def deploy():
    data = checked()
    current(data)
    validation = json.loads((RELEASE / 'image-check.json').read_text())
    assert validation['passed'] and validation['imageId'] == data['candidateImageId']
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
    {'prepare': prepare, 'build': build, 'check-image': check_image, 'deploy': deploy, 'verify': verify}[sys.argv[1]]()
