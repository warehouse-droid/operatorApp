"""One-file release over the active production image; no database migrations."""
import atexit
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
RELEASE = SERVER / 'deployments/regular-stock-so-scope-20261008'
spec = importlib.util.spec_from_file_location('release_helpers', SERVER / 'tools/delivery-scm-release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.RELEASE = RELEASE
release.IMAGE = 'mbbs-operator-app:regular-stock-so-scope-20261008'
release.ROLLBACK = release.IMAGE + '-rollback'
release.READ_NAME = 'mbbs-so-scope-reader'
release.CHECK_NAME = 'mbbs-so-scope-image-check'
FILE = 'src/regular-stock-handoff.js'


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
    assert (baseline / FILE).read_bytes() == (SERVER / FILE).read_bytes(), 'Overlapping workspace changes require a scoped patch'
    shutil.copytree(baseline, RELEASE / 'candidate')
    release.save('capture.json', {'app': before, 'dependencies': dependencies})
    print('Captured production code and one-file baseline', flush=True)


def prepare():
    import difflib
    captured = json.loads((RELEASE / 'capture.json').read_text())
    shutil.copy2(SERVER / FILE, RELEASE / 'candidate' / FILE)
    before_tree = release.files_at(RELEASE / 'before')
    candidate_tree = release.files_at(RELEASE / 'candidate')
    changed = [name for name in before_tree if before_tree[name] != candidate_tree[name]]
    assert changed == [FILE], changed
    (RELEASE / 'release.patch').write_text(''.join(difflib.unified_diff(
        (RELEASE / 'before' / FILE).read_text().splitlines(True),
        (RELEASE / 'candidate' / FILE).read_text().splitlines(True), fromfile='a/' + FILE, tofile='b/' + FILE)))
    release.save('manifest.json', {**captured, 'files': changed, 'beforeTree': before_tree,
        'candidateTree': candidate_tree, 'candidateTreeHash': release.sha(json.dumps(candidate_tree, sort_keys=True).encode()),
        'workspace': {FILE: release.sha((SERVER / FILE).read_bytes())}})
    release.current(release.state())
    print('Prepared one-file candidate', flush=True)


def validated():
    report = json.loads((SERVER / 'test-artifacts/regular-stock-so-scope-20261008/final/report.json').read_text())
    assert report['passed'] and report['sourceHash'] == release.sha((RELEASE / 'candidate' / FILE).read_bytes())
    proofs = json.loads((SERVER / 'test-artifacts/regular-stock-so-scope-20261008/proofs/report.json').read_text())
    assert proofs['passed'] and proofs['sourceHash'] == report['sourceHash']
    data = release.state()
    release.current(data)
    release.save('validation-passed.json', {'passed': True, 'candidateTreeHash': data['candidateTreeHash'], 'report': report, 'proofs': proofs})
    print('Exact candidate validation recorded', flush=True)


def verify():
    data = release.state()
    release.ready(data['candidateImageId'])
    live = release.metadata(release.APP)
    assert live['imageId'] == data['candidateImageId']
    assert live['configuration'] == data['app']['configuration']
    assert [release.metadata(name) for name in release.DEPENDENCIES] == data['dependencies']
    assert json.loads(release.docker('exec', release.APP, 'node', '-e', release.HASH_SCRIPT)) == data['candidateTree']
    result = {'deployed': True, 'at': release.now(), 'imageId': live['imageId'], 'files': data['files'],
              'configurationPreserved': True, 'dependenciesPreserved': True, 'productionHealthy': True}
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
            subprocess.run(release.compose(data, 'release') + args, cwd=ROOT, stdout=output,
                           stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except BaseException:
        with (RELEASE / 'rollback.log').open('wb') as output:
            subprocess.run(release.compose(data, 'rollback') + args, cwd=ROOT, stdout=output,
                           stderr=subprocess.STDOUT, check=True, timeout=60)
        release.ready(data['app']['imageId'])
        raise


if __name__ == '__main__':
    os.umask(0o022)
    if sys.argv[1] == 'build':
        atexit.register(release.cleanup_manual)
    {'capture': capture, 'prepare': prepare, 'validated': validated, 'build': release.build, 'apply': apply, 'verify': verify}[sys.argv[1]]()
