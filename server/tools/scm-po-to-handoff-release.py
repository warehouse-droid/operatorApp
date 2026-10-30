"""Scoped PO/TO policy release with unchanged runtime configuration and rollback."""
import atexit
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.request

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
RELEASE = SERVER / 'deployments/scm-po-to-handoff-20261022'
IMAGE = 'mbbs-operator-app:scm-po-to-handoff-20261022'
ROLLBACK = IMAGE + '-rollback'
FILES = ['src/smart-scm-po-handoff.js', 'src/smart-scm-planning-repository.js',
         'public/scm-smart-proposals.js', 'public/scm-smart.html']
CHECK = 'mbbs-scm-po-to-handoff-image-check'
spec = importlib.util.spec_from_file_location('handoff_release_core', SERVER / 'tools/delivery-scm-release.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.RELEASE = RELEASE


def source_hashes():
    return {name: core.sha((SERVER / name).read_bytes()) for name in FILES}


def compose(data, mode):
    args = ['sudo', '-n', 'docker', 'compose', '--project-directory', data['app']['projectDirectory'], '-p', 'mbbs-operator-app']
    for name in data['app']['configFiles'].split(','):
        args += ['-f', name]
    return args + ['-f', str(RELEASE / ('compose.' + mode + '.yml')),
                   '--env-file', str(ROOT / 'docker/env/.env')]


core.compose = compose


def current(data):
    assert core.metadata(core.APP) == data['app'], 'Live app changed; recapture before release'
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies']
    assert json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT)) == data['beforeTree']
    assert source_hashes() == data['sourceHashes'], 'Tested source changed'


def capture():
    RELEASE.mkdir(parents=True, exist_ok=False)
    app = core.metadata(core.APP)
    dependencies = [core.metadata(name) for name in core.DEPENDENCIES]
    before_tree = json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT))
    assert FILES[0] not in before_tree
    for name in FILES[1:]:
        original = core.docker('exec', core.APP, 'cat', '/app/' + name)
        baseline = subprocess.check_output(['git', 'show', 'HEAD:server/' + name], cwd=ROOT)
        assert original == baseline, 'Scoped baseline changed: ' + name
        target = RELEASE / 'before' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(original)
    hashes = source_hashes()
    core.save('manifest.json', {'at': core.now(), 'app': app, 'dependencies': dependencies,
        'authorization': 'User confirmed PO quantities count after Order Request; remaining need goes to TO planning.',
        'files': FILES, 'sourceHashes': hashes, 'beforeTree': before_tree,
        'candidateTree': {**before_tree, **hashes}})
    current(core.state())
    print(json.dumps({'captured': True, 'files': FILES, 'sourceHashes': hashes}))


def checked():
    data = core.state()
    validation = json.loads((RELEASE / 'validation.json').read_text())
    assert validation['sourceHashes'] == source_hashes() == data['sourceHashes']
    assert validation['newFailures'] == 0 and validation['passed'] >= 122
    assert validation['mutationKilled'] == validation['mutationTotal'] == 6
    assert validation['policyCoverage'] == 100
    assert validation['types'] == validation['lint'] == validation['syntax'] == 'passed'
    return data


def build():
    data = checked()
    current(data)
    core.docker('tag', data['app']['imageId'], ROLLBACK)
    stage = RELEASE / 'stage'
    for name in FILES:
        target = stage / 'overlay' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SERVER / name, target)
    (stage / 'Dockerfile').write_text('FROM ' + ROLLBACK + '\nCOPY --chown=node:node overlay/ /app/\n')
    for mode, tag in [('release', IMAGE), ('rollback', ROLLBACK)]:
        (RELEASE / ('compose.' + mode + '.yml')).write_text('services:\n  app:\n    image: ' + tag + '\n    pull_policy: never\n')
    with (RELEASE / 'build.log').open('wb') as output:
        subprocess.run(['docker', 'build', '--network=none', '--pull=false', '-t', IMAGE, str(stage)],
                       check=True, stdout=output, stderr=subprocess.STDOUT, timeout=180)
    data['candidateImageId'] = core.docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    core.save('manifest.json', data)
    core.config_check(data)
    print(json.dumps({'built': True, 'image': IMAGE}))


def image_check():
    data = checked()
    assert os.environ.get('MBBS_TEST_ARTIFACT_DIR'), 'Use the disposable retention runner'

    def cleanup():
        subprocess.run(['docker', 'rm', '-f', CHECK], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    atexit.register(cleanup)
    try:
        actual = json.loads(core.bounded(data['candidateImageId'], CHECK, 'node', '-e', core.HASH_SCRIPT))
        assert actual == data['candidateTree']
        core.save('image-check.json', {'passed': True, 'imageId': data['candidateImageId'], 'filesVerified': len(actual)})
        print(json.dumps({'imageCheck': True, 'filesVerified': len(actual)}))
    finally:
        cleanup()
        print(core.docker('ps', '--format', '{{.Names}} {{.Status}}').decode().strip())
        print(core.docker('ps', '-a', '--format', '{{.Names}} {{.Status}}').decode().strip())
        with urllib.request.urlopen('http://127.0.0.1:3000/health', timeout=10) as response:
            assert response.status == 200


def verify():
    data = checked()
    core.ready(data['candidateImageId'])
    live = core.metadata(core.APP)
    assert live['configuration'] == data['app']['configuration']
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies']
    assert json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT)) == data['candidateTree']
    for name, url in [('public/scm-smart-proposals.js', '/scm-smart-proposals.js'),
                      ('public/scm-smart.html', '/scm/smart')]:
        with urllib.request.urlopen('http://127.0.0.1:3000' + url, timeout=10) as response:
            assert response.status == 200
            assert core.sha(response.read()) == data['sourceHashes'][name]
    for args in [('ps',), ('ps', '-a')]:
        names = set(core.docker(*args, '--format', '{{.Names}}').decode().splitlines())
        assert names == {core.APP, *core.DEPENDENCIES}, names
    result = {'deployed': True, 'at': core.now(), 'image': IMAGE, 'imageId': live['imageId'],
              'sourceHashes': data['sourceHashes'], 'healthy': True, 'configurationPreserved': True,
              'dependenciesUnchanged': True, 'rollbackImage': ROLLBACK}
    core.save('deployed.json', result)
    print(json.dumps(result))


def deploy():
    data = checked()
    current(data)
    assert json.loads((RELEASE / 'image-check.json').read_text())['imageId'] == data['candidateImageId']
    core.config_check(data)
    core.assert_no_active_operations(core.preflight())
    try:
        subprocess.run(compose(data, 'release') + ['up', '-d', '--no-deps', '--no-build', 'app'], check=True, timeout=120)
        verify()
    except BaseException:
        subprocess.run(compose(data, 'rollback') + ['up', '-d', '--no-deps', '--no-build', 'app'], check=True, timeout=120)
        core.ready(data['app']['imageId'])
        raise


if __name__ == '__main__':
    os.umask(0o077)
    {'capture': capture, 'build': build, 'image-check': image_check,
     'deploy': deploy, 'verify': verify}[sys.argv[1]]()
