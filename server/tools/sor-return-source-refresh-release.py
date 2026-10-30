"""Release only the validated SOR refresh overlay, with automatic rollback."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
RELEASE = SERVER / 'deployments/sor-return-source-refresh-20261023'
IMAGE = 'mbbs-operator-app:sor-return-source-refresh-20261023'
ROLLBACK = IMAGE + '-rollback'
FILES = json.loads((SERVER / 'tools/sor-return-source-refresh-files.json').read_text())
spec = importlib.util.spec_from_file_location('sor_release_core', SERVER / 'tools/delivery-scm-release.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.RELEASE = RELEASE


def checked():
    evidence = json.loads((SERVER / 'test/sor-return-source-refresh-evidence.json').read_text())
    hashes = {name: core.sha((SERVER / name).read_bytes()) for name in FILES}
    assert evidence['passed'] and evidence['sourceHashes'] == hashes
    assert len(evidence['mutations']) == 5 and all(m['killed'] for m in evidence['mutations'])
    assert not evidence['changedLineCoverage']['uncovered'], 'Changed executable lines need coverage'
    return evidence, hashes


def prepare():
    evidence, hashes = checked()
    capture = json.loads((RELEASE / 'capture.json').read_text())
    app = core.metadata(core.APP)
    assert app['imageId'] == capture['imageId'] == evidence['runtimeBaseImage']
    for name, data in capture['files'].items():
        assert core.sha(core.docker('exec', core.APP, 'cat', '/app/' + name)) == data['live']
    data = {'app': app, 'dependencies': [core.metadata(name) for name in core.DEPENDENCIES],
            'files': FILES, 'candidateHashes': hashes, 'authorization':
            'User requested repairing SOR00248 first, then automatically updating returns from source changes.'}
    stage = RELEASE / 'stage'
    for name in FILES:
        target = stage / 'overlay' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SERVER / name, target)
    core.docker('tag', app['imageId'], ROLLBACK)
    (stage / 'Dockerfile').write_text('FROM ' + ROLLBACK + '\nCOPY --chown=node:node overlay/ /app/\n')
    for mode, tag in [('release', IMAGE), ('rollback', ROLLBACK)]:
        (RELEASE / ('compose.' + mode + '.yml')).write_text('services:\n  app:\n    image: ' + tag + '\n    pull_policy: never\n')
    result = subprocess.run(['docker', 'build', '--network=none', '--pull=false', '-t', IMAGE, str(stage)],
                            capture_output=True, timeout=180)
    assert result.returncode == 0, result.stdout.decode() + result.stderr.decode()
    data['candidateImageId'] = core.docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    core.save('manifest.json', data)
    core.config_check(data)
    print(json.dumps({'prepared': True, 'image': IMAGE, 'files': FILES}), flush=True)


def verify():
    _, hashes = checked()
    data = core.state()
    core.ready(data['candidateImageId'])
    actual = core.metadata(core.APP)
    assert actual['configuration'] == data['app']['configuration']
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies']
    expected = {**json.loads((RELEASE / 'runtime-source-hashes.json').read_text()), **hashes}
    raw = core.docker('exec', core.APP, 'sha256sum', *['/app/' + name for name in expected]).decode().splitlines()
    observed = {line.split()[1].removeprefix('/app/'): line.split()[0] for line in raw}
    assert observed == expected
    result = {'deployed': True, 'at': core.now(), 'image': IMAGE, 'imageId': actual['imageId'],
              'healthy': True, 'configurationPreserved': True, 'dependenciesUnchanged': True,
              'runtimeFilesVerified': len(expected), 'rollbackImage': ROLLBACK}
    core.save('deployed.json', result)
    print(json.dumps(result), flush=True)


def deploy():
    checked()
    data = core.state()
    assert core.metadata(core.APP) == data['app'], 'Live app changed; revalidate before cutover'
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies']
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
    os.umask(0o077)
    {'prepare': prepare, 'deploy': deploy, 'verify': verify}[sys.argv[1]]()
