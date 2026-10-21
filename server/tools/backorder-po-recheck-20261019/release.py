"""Capture and prepare a scoped backorder overlay; reuse the established image checks."""
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
import urllib.request

SERVER = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('release_helpers', SERVER / 'tools/delivery-scm-release.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
r.RELEASE = SERVER / 'deployments/backorder-po-recheck-20261019'
r.IMAGE = 'mbbs-operator-app:backorder-po-recheck-20261019'
r.ROLLBACK = r.IMAGE + '-rollback'
r.READ_NAME = 'mbbs-backorder-po-recheck-reader'
r.CHECK_NAME = 'mbbs-backorder-po-recheck-image-check'
FILES = ['public/backorder-workflow.js']
TESTS = ['test/mbt/integration/backorder-requests.test.js', 'test/mbt/integration/backorder-browser.test.js', 'test/mbt/property/backorder-link-sequence.property.test.js']


def capture():
    r.RELEASE.mkdir(parents=True, exist_ok=False)
    app = r.metadata(r.APP)
    dependencies = [r.metadata(n) for n in r.DEPENDENCIES]
    baseline = r.RELEASE / 'before'
    baseline.mkdir()
    archive = r.docker('exec', r.APP, 'tar', '-cf', '-', '-C', '/app', 'src', 'public', 'migrations', 'package.json', 'package-lock.json')
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        stream.extractall(baseline, filter='data')
    for path in baseline.rglob('*'):
        path.chmod(0o755 if path.is_dir() else 0o644)
    assert r.metadata(r.APP) == app
    for name in FILES + TESTS:
        target = r.RELEASE / 'workspace-before' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SERVER / name, target)
    r.save('capture.json', {'app': app, 'dependencies': dependencies})
    print(json.dumps({'captured': True, 'workspaceDifferences': [n for n in FILES if (baseline / n).read_bytes() != (SERVER / n).read_bytes()]}))


def prepare():
    captured = json.loads((r.RELEASE / 'capture.json').read_text())
    candidate = r.RELEASE / 'candidate'
    if candidate.exists():
        shutil.rmtree(candidate)
    shutil.copytree(r.RELEASE / 'before', candidate)
    patch = ''.join(''.join(difflib.unified_diff((r.RELEASE / 'workspace-before' / n).read_text().splitlines(True),
        (SERVER / n).read_text().splitlines(True), fromfile='a/' + n, tofile='b/' + n)) for n in FILES)
    r.apply_patch(candidate, patch, 'feature')
    before, after = r.files_at(r.RELEASE / 'before'), r.files_at(candidate)
    changed = sorted(n for n in before.keys() | after.keys() if before.get(n) != after.get(n))
    assert changed == sorted(FILES), changed
    r.save('manifest.json', {**captured, 'files': changed, 'beforeTree': before, 'candidateTree': after,
        'candidateTreeHash': r.sha(json.dumps(after, sort_keys=True).encode()),
        'workspace': {n: r.sha((SERVER / n).read_bytes()) for n in FILES}})
    lines = {}
    for name in FILES:
        old = (r.RELEASE / 'before' / name).read_text().splitlines()
        new = (candidate / name).read_text().splitlines()
        lines[name] = [i+1 for tag, _a, _b, start, end in difflib.SequenceMatcher(a=old, b=new).get_opcodes()
            if tag in ('replace', 'insert') for i in range(start, end)
            if new[i].strip() and not new[i].strip().startswith(('//', '/*', '*'))]
    r.save('changed-lines.json', lines)
    r.current(r.state())
    print(json.dumps({'prepared': True, 'files': changed}))


def validated():
    evidence = SERVER / 'test-artifacts/backorder-po-recheck-20261019/final'
    report = json.loads((evidence / 'report.json').read_text())
    assert report['passed'] and report['coverage']['uncovered'] == []
    assert all(item['killed'] for item in json.loads((evidence / 'mutations.json').read_text()))
    assert not any(json.loads((evidence / 'cleanup.json').read_text()).values())
    data = r.state()
    assert report['source'] == {name: data['candidateTree'][name] for name in FILES}
    r.current(data)
    r.save('validation-passed.json', {'passed': True, 'candidateTreeHash': data['candidateTreeHash'], 'report': report})
    print(json.dumps({'validated': True, 'coverage': report['coverage']}))


def verify():
    data = r.state()
    r.ready(data['candidateImageId'])
    live = r.metadata(r.APP)
    assert live['imageId'] == data['candidateImageId']
    assert live['configuration'] == data['app']['configuration']
    assert [r.metadata(n) for n in r.DEPENDENCIES] == data['dependencies']
    assert json.loads(r.docker('exec', r.APP, 'node', '-e', r.HASH_SCRIPT)) == data['candidateTree']
    probes = {}
    for name in FILES:
        if not name.startswith('public/'):
            continue
        url = 'http://127.0.0.1:3000/' + name.removeprefix('public/') + '?backorderPoRecheck=20261019'
        with urllib.request.urlopen(url, timeout=10) as response:
            assert response.status == 200
            assert r.sha(response.read()) == data['candidateTree'][name]
        probes[name] = 200
    result = {'deployed': True, 'at': r.now(), 'image': r.IMAGE, 'files': FILES,
        'candidateTreeHash': data['candidateTreeHash'], 'configurationPreserved': True,
        'dependenciesPreserved': True, 'productionHealthy': True, 'publicAssets': probes,
        'databaseMigration': False}
    r.save('deployment-result.json', result)
    print(json.dumps(result), flush=True)


def apply():
    data = r.state()
    r.current(data)
    check = json.loads((r.RELEASE / 'image-check.json').read_text())
    assert check['passed'] and check['imageId'] == data['candidateImageId']
    r.config_check(data)
    r.assert_no_active_operations(r.preflight())
    args = ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'app']
    r.current(data)
    try:
        with (r.RELEASE / 'apply.log').open('wb') as log:
            subprocess.run(r.compose(data, 'release') + args, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except BaseException:
        # A concurrent release must never be replaced by this task's rollback.
        active = r.metadata(r.APP)
        if active['imageId'] not in (data['app']['imageId'], data['candidateImageId']):
            r.save('concurrent-release.json', {'at': r.now(), 'activeImageId': active['imageId'],
                'expectedImageId': data['candidateImageId'], 'rollbackSkipped': True})
            raise
        with (r.RELEASE / 'rollback.log').open('wb') as log:
            subprocess.run(r.compose(data, 'rollback') + args, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        r.ready(data['app']['imageId'])
        raise


if __name__ == '__main__':
    if sys.argv[1] == 'build':
        atexit.register(r.cleanup_manual)
    {'capture': capture, 'prepare': prepare, 'validated': validated, 'build': r.build, 'apply': apply, 'verify': verify}[sys.argv[1]]()
