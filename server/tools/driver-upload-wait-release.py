#!/usr/bin/env python3
"""Deploy only the verified driver upload module and its two cache references."""
import atexit
import difflib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tarfile
import urllib.request

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
RELEASE = SERVER / 'deployments/driver-upload-wait-20261023'
FILES = ['public/driver-upload.js', 'public/driver.html', 'public/driver-service-worker.js']
IMAGE = 'mbbs-operator-app:driver-upload-wait-20261023'
ROLLBACK = IMAGE + '-rollback'
CHECK_NAME = 'mbbs-upload-wait-image-' + str(os.getpid())
spec = importlib.util.spec_from_file_location('upload_wait_release_core', SERVER / 'tools/delivery-scm-release.py')
core = importlib.util.module_from_spec(spec)
sys.dont_write_bytecode = True
spec.loader.exec_module(core)
core.RELEASE, core.IMAGE, core.ROLLBACK = RELEASE, IMAGE, ROLLBACK


def evidence():
    value = json.loads((SERVER / 'test/driver-upload-wait-evidence.json').read_text())
    assert value['passed'] is True
    assert value['coverage']['uncovered'] == []
    assert len(value['browser']) == 4
    for name, digest in value['hashes'].items():
        assert core.sha((SERVER / name).read_bytes()) == digest, 'Verified source changed: ' + name
    return value


def live_tree():
    return json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT))


def current(data):
    assert core.metadata(core.APP) == data['app'], 'Application changed; recapture before deployment'
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies']
    assert live_tree() == data['beforeTree'], 'Live source changed'
    for name in FILES:
        assert core.sha((RELEASE / 'candidate' / name).read_bytes()) == data['candidateTree'][name]
        assert core.sha((SERVER / name).read_bytes()) == data['candidateTree'][name]
    evidence()


def capture():
    verified = evidence()
    RELEASE.mkdir(parents=True, exist_ok=False)
    before = core.metadata(core.APP)
    dependencies = [core.metadata(name) for name in core.DEPENDENCIES]
    before_tree = live_tree()
    archive = core.docker('exec', core.APP, 'tar', '-cf', '-', '-C', '/app', *FILES)
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        stream.extractall(RELEASE / 'before', filter='data')
    assert core.metadata(core.APP) == before
    original_upload = subprocess.check_output(['git', 'show', 'HEAD:server/public/driver-upload.js'], cwd=ROOT)
    assert core.sha(original_upload) == before_tree[FILES[0]], 'Upload baseline changed'
    patch = ''
    for name in FILES:
        original = (RELEASE / 'before' / name).read_text()
        desired = (SERVER / name).read_text()
        if name != FILES[0]:
            expected = original.replace('/driver-upload.js?v=20261016-driver-reconnect-v1',
                                        '/driver-upload.js?v=20261023-driver-upload-wait-v1')
            if name.endswith('worker.js'):
                expected = expected.replace('${DRIVER_CACHE_PREFIX}v49`', '${DRIVER_CACHE_PREFIX}v50`')
                expected = expected.replace('${DRIVER_CACHE_PREFIX}refresh-v49`', '${DRIVER_CACHE_PREFIX}refresh-v50`')
            assert expected == desired, 'Unrelated cache/shell changes: ' + name
        target = RELEASE / 'candidate' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(desired)
        patch += ''.join(difflib.unified_diff(original.splitlines(True), desired.splitlines(True),
                                             fromfile='a/' + name, tofile='b/' + name))
    candidate_tree = {**before_tree, **{name: verified['hashes'][name] for name in FILES}}
    assert sorted(name for name in before_tree if before_tree[name] != candidate_tree[name]) == sorted(FILES)
    data = {'capturedAt': core.now(), 'app': before, 'dependencies': dependencies, 'files': FILES,
            'beforeTree': before_tree, 'candidateTree': candidate_tree,
            'evidenceHash': core.sha((SERVER / 'test/driver-upload-wait-evidence.json').read_bytes())}
    core.save('manifest.json', data)
    (RELEASE / 'upload.patch').write_text(patch)
    for mode, tag in [('release', IMAGE), ('rollback', ROLLBACK)]:
        (RELEASE / ('compose.' + mode + '.yml')).write_text('services:\n  app:\n    image: ' + tag + '\n    pull_policy: never\n')
    current(data)
    print(json.dumps({'captured': True, 'changedFiles': FILES, 'preservedRuntimeFiles': len(before_tree) - 3}))


def cleanup_check():
    subprocess.run(['docker', 'rm', '-fv', CHECK_NAME], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for args in [('ps',), ('ps', '-a')]:
        print(core.docker(*args, '--format', '{{.Names}} {{.Status}}').decode(), end='')
    assert not core.docker('ps', '-aq', '--filter', 'name=^/' + CHECK_NAME + '$').strip()
    with urllib.request.urlopen('http://127.0.0.1:3000/health', timeout=5) as response:
        assert response.status == 200


def build():
    data = core.state()
    current(data)
    stage = RELEASE / 'stage'
    shutil.copytree(RELEASE / 'candidate', stage / 'overlay', dirs_exist_ok=True)
    core.docker('tag', data['app']['imageId'], ROLLBACK)
    (stage / 'Dockerfile').write_text('FROM ' + ROLLBACK + '\nCOPY --chown=node:node overlay/ /app/\n')
    with (RELEASE / 'build.log').open('wb') as output:
        subprocess.run(['docker', 'build', '--network=none', '--pull=false', '-t', IMAGE, str(stage)],
                       stdout=output, stderr=subprocess.STDOUT, check=True, timeout=180)
    image_id = core.docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    # Registered before the disposable image check. No production mounts, network, or secrets.
    atexit.register(cleanup_check)
    signal.signal(signal.SIGTERM, lambda signum, _frame: sys.exit(128 + signum))
    actual = json.loads(core.docker('run', '--rm', '--name', CHECK_NAME, '--init', '--network=none', '--read-only',
        '--label', 'com.mbbs.lifecycle=disposable-test', '--cgroup-parent=mbbs-tests.slice',
        '--memory=256m', '--memory-swap=256m', '--cpus=0.5', '--pids-limit=128',
        '--tmpfs', '/tmp:rw,nosuid,nodev,size=16m', '--env', 'NODE_ENV=test',
        '--env', 'MBBS_ENV_FILE=/nonexistent', '--entrypoint', 'node', image_id, '-e', core.HASH_SCRIPT))
    assert actual == data['candidateTree'], 'Image differs from verified candidate'
    current(data)
    data['candidateImageId'] = image_id
    core.save('manifest.json', data)
    core.config_check(data)
    core.save('image-check.json', {'passed': True, 'imageId': image_id, 'runtimeFilesVerified': len(actual)})
    print(json.dumps({'built': True, 'imageId': image_id, 'runtimeFilesVerified': len(actual)}))


def verify():
    data = core.state()
    core.ready(data['candidateImageId'])
    live = core.metadata(core.APP)
    assert live['configuration'] == data['app']['configuration']
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies']
    assert live_tree() == data['candidateTree']
    public = {name: data['candidateTree'][name] for name in FILES}
    checked = core.http_check(public, [])
    result = {'deployed': True, 'at': core.now(), 'imageId': live['imageId'], 'changedFiles': FILES,
              'runtimeFilesVerified': len(data['candidateTree']), 'configurationPreserved': True,
              'dependenciesUnchanged': True, 'http': checked,
              'assetVersion': '20261023-driver-upload-wait-v1', 'driverShellCache': 50}
    core.save('deployment-result.json', result)
    print(json.dumps(result))


def apply():
    data = core.state()
    current(data)
    check = json.loads((RELEASE / 'image-check.json').read_text())
    assert check['passed'] and check['imageId'] == data['candidateImageId']
    assert core.docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip() == data['candidateImageId']
    core.config_check(data)
    core.assert_no_active_operations(core.preflight())
    current(data)
    command = ['up', '-d', '--no-deps', '--no-build', '--force-recreate', 'app']
    try:
        with (RELEASE / 'apply.log').open('wb') as output:
            subprocess.run(core.compose(data, 'release') + command, cwd=ROOT, stdout=output,
                           stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except BaseException:
        live_image = core.metadata(core.APP)['imageId']
        if live_image in (data['candidateImageId'], data['app']['imageId']):
            with (RELEASE / 'rollback.log').open('wb') as output:
                subprocess.run(core.compose(data, 'rollback') + command, cwd=ROOT, stdout=output,
                               stderr=subprocess.STDOUT, check=True, timeout=60)
            core.ready(data['app']['imageId'])
            core.save('rollback-result.json', {'restoredAt': core.now(), 'imageId': data['app']['imageId']})
        raise


if __name__ == '__main__':
    if sys.argv[1] == 'build' and not os.environ.get('MBBS_TEST_ARTIFACT_DIR'):
        os.execv(sys.executable, [sys.executable, str(ROOT / 'docker/retention/retention.py'),
                 'run', '--', sys.executable, str(Path(__file__).resolve()), 'build'])
    {'capture': capture, 'build': build, 'apply': apply, 'verify': verify}[sys.argv[1]]()
