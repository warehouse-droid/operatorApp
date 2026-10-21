"""Scoped runtime-only release for cancelled SCM split schedule visibility."""
import atexit
import difflib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile

SERVER = Path(__file__).resolve().parents[1]
RELEASE = SERVER / 'deployments/scm-cancelled-split-20261008'
spec = importlib.util.spec_from_file_location('release_helpers', SERVER / 'tools/delivery-scm-release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.RELEASE = RELEASE
release.IMAGE = 'mbbs-operator-app:scm-cancelled-split-20261008'
release.ROLLBACK = release.IMAGE + '-rollback'
release.READ_NAME = 'mbbs-cancelled-split-reader'
release.CHECK_NAME = 'mbbs-cancelled-split-image-check'
FILE = 'src/dispatch-repository.js'


def capture():
    RELEASE.mkdir(parents=True, exist_ok=False)
    before = release.metadata(release.APP)
    dependencies = [release.metadata(name) for name in release.DEPENDENCIES]
    baseline = RELEASE / 'before'
    baseline.mkdir()
    archive = release.docker('exec', release.APP, 'tar', '-cf', '-', '-C', '/app',
                             'src', 'public', 'migrations', 'package.json', 'package-lock.json')
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        stream.extractall(baseline, filter='data')
    assert release.metadata(release.APP) == before
    workspace = RELEASE / 'workspace-before' / FILE
    workspace.parent.mkdir(parents=True)
    shutil.copy2(SERVER / FILE, workspace)
    shutil.copytree(baseline, RELEASE / 'candidate')
    release.save('capture.json', {'app': before, 'dependencies': dependencies})
    print(json.dumps({'captured': True, 'workspaceMatchesLive': workspace.read_bytes() == (baseline / FILE).read_bytes()}), flush=True)


def prepare():
    patch = ''.join(difflib.unified_diff(
        (RELEASE / 'workspace-before' / FILE).read_text().splitlines(True),
        (SERVER / FILE).read_text().splitlines(True), fromfile='a/' + FILE, tofile='b/' + FILE))
    shutil.rmtree(RELEASE / 'candidate')
    shutil.copytree(RELEASE / 'before', RELEASE / 'candidate')
    release.apply_patch(RELEASE / 'candidate', patch, 'feature')
    before_tree = release.files_at(RELEASE / 'before')
    candidate_tree = release.files_at(RELEASE / 'candidate')
    changed = [name for name in candidate_tree if before_tree.get(name) != candidate_tree[name]]
    assert changed == [FILE], changed
    data = {**json.loads((RELEASE / 'capture.json').read_text()), 'files': changed,
            'beforeTree': before_tree, 'candidateTree': candidate_tree,
            'candidateTreeHash': release.sha(json.dumps(candidate_tree, sort_keys=True).encode()),
            'workspace': {FILE: release.sha((SERVER / FILE).read_bytes())}}
    release.save('manifest.json', data)
    release.current(data)
    print('Prepared one-file candidate', flush=True)


def validated():
    data = release.state()
    out = SERVER / 'test-artifacts/scm-cancelled-split-20261008/final'
    report = json.loads((out / 'report.json').read_text())
    assert report['passed'] and report['sourceHash'] == data['candidateTree'][FILE]
    assert json.loads((out / 'source-state.json').read_text()) == data['candidateTree']
    assert report['uncoveredLines'] == [] and all(row['killed'] for row in report['mutants'])
    release.current(data)
    release.save('validation-passed.json', {'passed': True, 'candidateTreeHash': data['candidateTreeHash'], 'report': report})
    print('Exact candidate validation recorded', flush=True)


def verify():
    data = release.state()
    release.ready(data['candidateImageId'])
    live = release.metadata(release.APP)
    assert live['imageId'] == data['candidateImageId']
    assert live['configuration'] == data['app']['configuration']
    assert [release.metadata(name) for name in release.DEPENDENCIES] == data['dependencies']
    assert json.loads(release.docker('exec', release.APP, 'node', '-e', release.HASH_SCRIPT)) == data['candidateTree']
    http = release.http_check({}, ['/api/scm/schedule', '/api/sales/schedule'])
    result = {'deployed': True, 'at': release.now(), 'imageId': live['imageId'], 'files': data['files'],
              'configurationPreserved': True, 'dependenciesPreserved': True, 'productionHealthy': True, 'http': http}
    release.save('deployment-result.json', result)
    print(json.dumps(result), flush=True)


def apply():
    data = release.state()
    release.current(data)
    check = json.loads((RELEASE / 'image-check.json').read_text())
    assert check['passed'] and check['imageId'] == data['candidateImageId']
    release.config_check(data)
    release.assert_no_active_operations(release.preflight())
    args = ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app']
    try:
        with (RELEASE / 'cutover.log').open('wb') as output:
            subprocess.run(release.compose(data, 'release') + args, cwd=SERVER.parent,
                           stdout=output, stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except BaseException:
        with (RELEASE / 'rollback.log').open('wb') as output:
            subprocess.run(release.compose(data, 'rollback') + args, cwd=SERVER.parent,
                           stdout=output, stderr=subprocess.STDOUT, check=True, timeout=60)
        release.ready(data['app']['imageId'])
        raise


if __name__ == '__main__':
    if sys.argv[1] == 'build':
        atexit.register(release.cleanup_manual)
    {'capture': capture, 'prepare': prepare, 'validated': validated,
     'build': release.build, 'apply': apply, 'verify': verify}[sys.argv[1]]()
