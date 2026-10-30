"""Deploy only the verified CO Operator files on the current live image."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
RELEASE = SERVER / 'deployments/co-operator-20261027'
IMAGE = 'mbbs-operator-app:co-operator-20261027'
ROLLBACK = IMAGE + '-rollback'
spec = importlib.util.spec_from_file_location('co_release_base', SERVER / 'tools/ifir-integration-release.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
core = base.core
core.RELEASE = RELEASE
BEFORE = {
    'src/delivery-repository.js': '3002a7052ba4163df1ab93097567a527358e926948fceefa3005a74d6423f535',
    'src/co-source-packing-handoff.js': 'ac35d4219de3c56b6bb731b7a94766ebf2d40cc64c303c6d7f757d15be0fbc8f',
    'src/receiving-repository.js': 'fd35cbf34d2be103ba330fa06787a84e6634abe48a34d034daa99c40d853d6b9',
    'public/operator.js': 'a0967265722c2b4d76e0b08a88a47e93b78987fce523f6106f901c9f3cbc9352',
    'src/operator-co-routing.js': None,
    'src/co-source-receipt.js': None,
}


def current(data):
    assert core.metadata(core.APP) == data['app'], 'Live app changed during preparation'
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies']
    assert json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT)) == data['beforeTree']
    assert all(core.sha((SERVER / name).read_bytes()) == data['candidateTree'][name] for name in BEFORE)


def prepare():
    os.umask(0o077)
    RELEASE.mkdir(parents=True, exist_ok=False)
    app = core.metadata(core.APP)
    before = json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT))
    assert {name: before.get(name) for name in BEFORE} == BEFORE, 'CO baseline changed'
    after = {**before, **{name: core.sha((SERVER / name).read_bytes()) for name in BEFORE}}
    assert before['package-lock.json'] == core.sha((SERVER / 'package-lock.json').read_bytes()), 'Test/runtime lockfiles differ'
    live_package = json.loads(core.docker('exec', core.APP, 'cat', '/app/package.json'))
    test_package = json.loads((SERVER / 'package.json').read_text())
    assert all(live_package.get(key) == test_package.get(key) for key in ['dependencies', 'devDependencies', 'type', 'engines'])
    stage = RELEASE / 'stage'
    for name in BEFORE:
        target = stage / 'overlay' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SERVER / name, target)
    core.docker('tag', app['imageId'], ROLLBACK)
    (stage / 'Dockerfile').write_text('FROM ' + ROLLBACK + '\nCOPY --chown=node:node overlay/ /app/\n')
    for mode, image in [('release', IMAGE), ('rollback', ROLLBACK)]:
        (RELEASE / ('compose.' + mode + '.yml')).write_text('services:\n  app:\n    image: ' + image + '\n    pull_policy: never\n')
    with (RELEASE / 'build.log').open('wb') as output:
        subprocess.run(['docker', 'build', '--network', 'none', '--pull=false', '-t', IMAGE, str(stage)],
                       stdout=output, stderr=subprocess.STDOUT, check=True, timeout=180)
    data = {'app': app, 'dependencies': [core.metadata(name) for name in core.DEPENDENCIES],
            'beforeTree': before, 'candidateTree': after, 'files': list(BEFORE),
            'candidateTreeHash': core.sha(json.dumps(after, sort_keys=True).encode()),
            'candidateImageId': core.docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()}
    current(data)
    core.save('manifest.json', data)
    core.config_check(data)
    print(json.dumps({'prepared': True, 'image': data['candidateImageId'], 'changedFiles': list(BEFORE)}))


def verify():
    data = core.state()
    core.ready(data['candidateImageId'])
    actual = core.metadata(core.APP)
    assert actual['configuration'] == data['app']['configuration']
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies']
    assert json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT)) == data['candidateTree']
    result = {'deployed': True, 'at': core.now(), 'imageId': actual['imageId'],
              'configurationPreserved': True, 'dependenciesUnchanged': True, 'changedFiles': list(BEFORE)}
    core.save('deployment-result.json', result)
    print(json.dumps(result))


def apply():
    data = core.state()
    current(data)
    validation = json.loads((RELEASE / 'validation-passed.json').read_text())
    assert validation['passed'] and validation['imageId'] == data['candidateImageId']
    assert validation['candidateTreeHash'] == data['candidateTreeHash']
    core.config_check(data)
    core.assert_no_active_operations(core.preflight())
    current(data)
    args = ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app']
    try:
        with (RELEASE / 'cutover.log').open('wb') as output:
            subprocess.run(core.compose(data, 'release') + args, cwd=ROOT, stdout=output,
                           stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except BaseException:
        with (RELEASE / 'rollback.log').open('wb') as output:
            subprocess.run(core.compose(data, 'rollback') + args, cwd=ROOT, stdout=output,
                           stderr=subprocess.STDOUT, check=True, timeout=60)
        core.ready(data['app']['imageId'])
        core.save('rollback-result.json', {'at': core.now(), 'restoredImageId': data['app']['imageId']})
        raise


if __name__ == '__main__':
    {'prepare': prepare, 'apply': apply, 'verify': verify}[sys.argv[1]]()
