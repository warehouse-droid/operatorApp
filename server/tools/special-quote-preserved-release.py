"""Release the saved-quote availability change over the current live application."""
from pathlib import Path
import difflib
import importlib.util
import io
import json
import shutil
import subprocess
import sys
import tarfile

spec = importlib.util.spec_from_file_location('release_core', Path(__file__).with_name('mbt-bin-corrections-release.py'))
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.OUT = core.SERVER / 'test-artifacts/special-quote-preserved-20261015'
core.RELEASE = core.SERVER / 'deployments/special-quote-preserved-20261015'
core.IMAGE = 'mbbs-operator-app:special-quote-preserved-20261015'
core.BASE_IMAGE = 'mbbs-operator-app:special-quote-preserved-rollback-20261015'
FILES = ['public/special-stock-documents.js', 'public/sales-special-stock-requests.js',
         'public/scm-special-stock-requests.js', 'src/special-stock-documents.js']


def prepare():
    assert not (core.RELEASE / 'state.json').exists(), 'Release already prepared'
    state = {key: core.metadata(name) for key, name in [('app', core.APP), ('worker', core.WORKER), ('db', core.DB)]}
    live = core.RELEASE / 'before'
    live.mkdir(parents=True)
    archive = subprocess.check_output(['sudo', '-n', 'docker', 'exec', core.APP,
        'tar', '-C', '/app', '-cf', '-', 'src', 'public', 'package.json', 'package-lock.json'])
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        stream.extractall(live, filter='data')
    assert core.metadata(core.APP) == state['app'], 'Live application changed during capture'
    candidate = core.OUT / 'candidate-source'
    shutil.copytree(live, candidate)
    context = core.RELEASE / 'context'
    patch = []
    for name in FILES:
        before = live / name
        result = subprocess.run(['git', 'merge-file', '-p', str(before),
            str(core.OUT / 'before' / name), str(core.SERVER / name)], capture_output=True)
        assert result.returncode == 0, 'Review merge conflict: ' + name
        target = context / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(result.stdout)
        (candidate / name).write_bytes(result.stdout)
        patch.extend(difflib.unified_diff(before.read_text().splitlines(keepends=True),
            target.read_text().splitlines(keepends=True), fromfile='production/' + name, tofile='candidate/' + name))
    (core.OUT / 'production.patch').write_text(''.join(patch))
    core.save(core.RELEASE / 'state.json', state)
    core.docker('tag', state['app']['imageId'], core.BASE_IMAGE)
    (context / '.dockerignore').write_text('/Dockerfile\n/.dockerignore\n')
    (context / 'Dockerfile').write_text('FROM ' + core.BASE_IMAGE + '\nCOPY --link . /app/\n')
    core.logged('candidate-build', ['sudo', '-n', 'docker', 'build', '--network=none', '-t', core.IMAGE, str(context)])
    core.save(core.OUT / 'prepared.json', {'image': core.IMAGE,
        'imageId': json.loads(core.docker('image', 'inspect', core.IMAGE))[0]['Id'],
        'sourceHashes': {name: core.sha(context / name) for name in FILES}})
    core.save(core.RELEASE / 'compose.release.json', {'services': {'app': {'image': core.IMAGE}}})
    core.save(core.RELEASE / 'compose.rollback.json', {'services': {'app': {'image': core.BASE_IMAGE}}})
    print(json.dumps({'prepared': core.IMAGE, 'runtimeFiles': len(FILES)}))


def verify():
    prepared = json.loads((core.OUT / 'prepared.json').read_text())
    for name, digest in prepared['sourceHashes'].items():
        assert core.docker('exec', core.APP, 'sha256sum', '/app/' + name).split()[0] == digest, name
    for path in ['/health', '/sales/stock-requests', '/scm/stock-requests',
                 '/special-stock-documents.js', '/sales-special-stock-requests.js', '/scm-special-stock-requests.js']:
        subprocess.run(['curl', '-fsS', '--max-time', '15', '-o', '/dev/null', 'http://127.0.0.1:3000' + path], check=True)
    core.save(core.OUT / 'live-verification.json', {'sourceHashesVerified': True, 'httpChecksPassed': True})


def deploy():
    state = json.loads((core.RELEASE / 'state.json').read_text())
    prepared = json.loads((core.OUT / 'prepared.json').read_text())
    validated = json.loads((core.OUT / 'validation.json').read_text())
    assert validated['passed'] and validated['cleanupVerified']
    assert validated['sourceHashes'] == prepared['sourceHashes']
    assert json.loads(core.docker('image', 'inspect', core.IMAGE))[0]['Id'] == prepared['imageId']
    for name, digest in prepared['sourceHashes'].items():
        assert core.sha(core.OUT / 'candidate-source' / name) == digest
        assert core.sha(core.RELEASE / 'context' / name) == digest
    for key, name in [('app', core.APP), ('worker', core.WORKER), ('db', core.DB)]:
        assert core.metadata(name) == state[key], 'Live application changed; rebase required: ' + key
    try:
        core.logged('production-deploy', core.compose(state, core.RELEASE / 'compose.release.json') +
            ['up', '-d', '--no-deps', '--no-build', 'app'])
        assert core.health(), 'Application health did not recover'
        current = core.metadata(core.APP)
        assert current['imageId'] == prepared['imageId']
        assert current['configurationHash'] == state['app']['configurationHash']
        assert core.metadata(core.WORKER) == state['worker'] and core.metadata(core.DB) == state['db']
        verify()
    except BaseException:
        if core.metadata(core.APP)['imageId'] in [prepared['imageId'], state['app']['imageId']]:
            core.logged('production-rollback', core.compose(state, core.RELEASE / 'compose.rollback.json') +
                ['up', '-d', '--no-deps', '--no-build', 'app'])
            assert core.health(), 'Rollback health failed'
        raise
    core.save(core.OUT / 'deployment.json', {'image': core.IMAGE, 'imageId': prepared['imageId'],
        'healthy': True, 'otherServicesPreserved': True, 'configurationPreserved': True})
    print(json.dumps({'deployed': core.IMAGE, 'healthy': True}))


if __name__ == '__main__':
    {'prepare': prepare, 'deploy': deploy, 'verify': verify}[sys.argv[1]]()
