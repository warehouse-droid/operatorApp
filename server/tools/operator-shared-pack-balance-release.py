"""Deploy the tested shared packing balance as a scoped overlay of the live app."""
import io
import json
import os
from pathlib import Path
import re
import runpy
import shutil
import signal
import subprocess
import sys
import tarfile
import difflib

sys.dont_write_bytecode = True
SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
RELEASE = SERVER / 'deployments/operator-shared-pack-balance-20261023'
IMAGE = 'mbbs-operator-app:operator-shared-pack-balance-20261023'
ROLLBACK = IMAGE + '-rollback'
FILES = ['src/operator-load-quantity.js', 'src/delivery-repository.js', 'src/sales-order-reload.js',
         'public/operator.js', 'public/operator.html', 'public/service-worker.js']
base = runpy.run_path(str(SERVER / 'tools/ifir-integration-release.py'))
core = base['core']
core.RELEASE = RELEASE
core.docker = lambda *args, **kwargs: subprocess.check_output(['sudo', '-n', 'docker', *args], **kwargs)
tree = base['tree']


def capture():
    RELEASE.mkdir(parents=True, exist_ok=True)
    assert not any(RELEASE.iterdir()), 'Capture already exists'
    before = core.metadata(core.APP)
    dependencies = [core.metadata(name) for name in core.DEPENDENCIES]
    roots = json.loads(core.docker('exec', core.APP, 'node', '-e',
        "console.log(JSON.stringify(['src','public','migrations','contracts','package.json','package-lock.json'].filter(p=>require('node:fs').existsSync(p))))"))
    archive = core.docker('exec', core.APP, 'tar', '-cf', '-', '-C', '/app', *roots)
    original = RELEASE / 'live-before'
    original.mkdir()
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        stream.extractall(original, filter='data')
    candidate = RELEASE / 'candidate'
    shutil.copytree(original, candidate)
    patch = []
    for name in FILES:
        patch.extend(difflib.unified_diff((original / name).read_text().splitlines(True),
                     (SERVER / name).read_text().splitlines(True), fromfile='live/' + name, tofile='candidate/' + name))
        shutil.copy2(SERVER / name, candidate / name)
    (RELEASE / 'release.patch').write_text(''.join(patch))
    original_tree, candidate_tree = tree(original), tree(candidate)
    changed = sorted(name for name in original_tree.keys() | candidate_tree.keys()
                     if original_tree.get(name) != candidate_tree.get(name))
    assert changed == sorted(FILES), changed
    core.save('manifest.json', {'capturedAt': core.now(), 'authorization': 'User explicitly requested deploy.',
        'app': before, 'dependencies': dependencies, 'files': FILES,
        'beforeTree': original_tree, 'candidateTree': candidate_tree,
        'candidateTreeHash': core.sha(json.dumps(candidate_tree, sort_keys=True).encode()),
        'sourceHashes': {name: candidate_tree[name] for name in FILES}})
    current()
    print(json.dumps({'captured': True, 'changedFiles': changed, 'runtimeFiles': len(candidate_tree)}))


def current():
    data = core.state()
    assert core.metadata(core.APP) == data['app'], 'Live app changed; rebase before release'
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies']
    assert json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT)) == data['beforeTree']
    assert tree(RELEASE / 'candidate') == data['candidateTree']
    assert all(core.sha((SERVER / name).read_bytes()) == digest for name, digest in data['sourceHashes'].items())
    return data


def checked():
    data = core.state()
    validation = json.loads((RELEASE / 'validation.json').read_text())
    assert validation['passed'] and validation['sourceHashes'] == data['sourceHashes']
    assert validation['candidateTreeHash'] == data['candidateTreeHash']
    assert tree(RELEASE / 'candidate') == data['candidateTree']
    return data


def validate():
    data = current()
    tests = ['test/mbt/unit/operator-shared-pack-balance.test.js',
             'test/mbt/integration/operator-shared-pack-balance.test.js',
             'test/mbt/integration/operator-shared-pack-balance-browser.test.js',
             'test/mbt/unit/operator-yard-assets.test.js']
    test_hashes = {name: core.sha((SERVER / name).read_bytes()) for name in tests}
    command = 'node --test --test-concurrency=1 ' + ' '.join(tests) + ' && node src/sales-order-reload-harness.js'
    environment = dict(os.environ, DISPATCH_SOURCE_RUNTIME=str(RELEASE / 'candidate'),
        DISPATCH_SOURCE_MIGRATIONS=str(RELEASE / 'candidate/migrations'), DISPATCH_SOURCE_SKIP_BUILD='1')
    result = subprocess.run(['bash', 'docker/run-dispatch-source-tests.sh', 'sh', '-c', command],
        cwd=ROOT, env=environment, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if result.returncode:
        print('\n'.join(result.stdout.splitlines()[-100:]))
        raise RuntimeError('Candidate validation failed: ' + str(result.returncode))
    current()
    assert test_hashes == {name: core.sha((SERVER / name).read_bytes()) for name in tests}
    summary = [line for line in result.stdout.splitlines()
               if re.match(r'^# (tests|pass|fail|cancelled|skipped|duration_ms) ', line)]
    core.save('validation.json', {'passed': True, 'at': core.now(), 'command': command,
        'sourceHashes': data['sourceHashes'], 'candidateTreeHash': data['candidateTreeHash'],
        'testHashes': test_hashes, 'summary': summary, 'reloadHarnessPassed': True})
    print('\n'.join(summary))
    print('Candidate tests, reload harness, disposable teardown and production health passed.')


def build():
    data = checked()
    current()
    core.docker('tag', data['app']['imageId'], ROLLBACK)
    stage = RELEASE / 'stage'
    for name in FILES:
        target = stage / 'overlay' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(RELEASE / 'candidate' / name, target)
    (stage / 'Dockerfile').write_text('FROM ' + ROLLBACK + '\nCOPY --chown=node:node overlay/ /app/\n')
    for mode, image in [('release', IMAGE), ('rollback', ROLLBACK)]:
        (RELEASE / ('compose.' + mode + '.yml')).write_text('services:\n  app:\n    image: ' + image + '\n    pull_policy: never\n')
    with (RELEASE / 'build-audit.log').open('wb') as output:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--network=none', '--pull=false', '-t', IMAGE, str(stage)],
                       check=True, stdout=output, stderr=subprocess.STDOUT, timeout=180)
    data['candidateImageId'] = core.docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    core.save('manifest.json', data)
    core.config_check(data)
    print(json.dumps({'built': IMAGE, 'imageId': data['candidateImageId']}))


def image_check():
    assert os.environ.get('MBBS_TEST_ARTIFACT_DIR'), 'Use the disposable retention runner'
    data = checked()
    name = 'mbbs-shared-pack-image-check-' + str(os.getpid())
    def interrupted(_number, _frame):
        raise SystemExit(130)
    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGTERM, interrupted)
    try:
        actual = json.loads(core.bounded(data['candidateImageId'], name, 'node', '-e', core.HASH_SCRIPT))
        assert actual == data['candidateTree'], 'Built runtime differs from tested candidate'
        core.bounded(data['candidateImageId'], name, 'node', '--input-type=module', '-e',
                     "await import('./src/server.js');process.exit(0)")
        core.save('image-check.json', {'passed': True, 'imageId': data['candidateImageId'], 'runtimeFiles': len(actual)})
    finally:
        subprocess.run(['sudo', '-n', 'docker', 'rm', '-fv', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for args in [('ps',), ('ps', '-a')]:
            print(core.docker(*args, '--format', '{{.Names}} {{.Status}}').decode().strip())
        assert not core.docker('ps', '-aq', '--filter', 'name=^/' + name + '$').strip()
    print(json.dumps({'imageCheck': 'passed'}))


def verify():
    data = checked()
    core.ready(data['candidateImageId'])
    actual = core.metadata(core.APP)
    assert actual['configuration'] == data['app']['configuration']
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies']
    assert json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT)) == data['candidateTree']
    assets = {name: digest for name, digest in data['sourceHashes'].items() if name.startswith('public/')}
    http = core.http_check(assets, ['/api/delivery/orders', '/api/customer-pickup/config'])
    containers = {label: core.docker(*args, '--format', '{{.Names}} {{.Status}}').decode().splitlines()
        for label, args in [('running', ['ps']), ('all', ['ps', '-a'])]}
    for rows in containers.values():
        assert {row.split()[0] for row in rows} == {core.APP, *core.DEPENDENCIES}
    core.save('containers.json', containers)
    result = {'deployed': True, 'at': core.now(), 'image': IMAGE, 'imageId': actual['imageId'],
        'runtimeFilesVerified': len(data['candidateTree']), 'files': FILES,
        'configurationPreserved': True, 'dependenciesUnchanged': True, 'http': http, 'rollbackImage': ROLLBACK}
    core.save('deployed.json', result)
    print(json.dumps(result))


def deploy():
    data = checked()
    current()
    check = json.loads((RELEASE / 'image-check.json').read_text())
    assert check['passed'] and check['imageId'] == data['candidateImageId']
    assert core.docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip() == data['candidateImageId']
    core.config_check(data)
    core.assert_no_active_operations(core.preflight())
    try:
        subprocess.run(core.compose(data, 'release') + ['up', '-d', '--no-deps', '--no-build', 'app'], check=True, timeout=120)
        verify()
    except BaseException:
        if core.metadata(core.APP)['imageId'] == data['candidateImageId']:
            subprocess.run(core.compose(data, 'rollback') + ['up', '-d', '--no-deps', '--no-build', 'app'], check=True, timeout=120)
            core.ready(data['app']['imageId'])
            core.save('rollback-audit.json', {'at': core.now(), 'restoredImage': data['app']['imageId'], 'healthy': True})
        raise


if __name__ == '__main__':
    os.umask(0o077)
    {'capture': capture, 'validate': validate, 'build': build, 'image-check': image_check,
     'deploy': deploy, 'verify': verify}[sys.argv[1]]()
