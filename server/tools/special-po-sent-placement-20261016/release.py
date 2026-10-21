"""Deploy the scoped PO button placement change with app-only rollback."""
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
import urllib.error
import urllib.request

SERVER = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('release_helpers', SERVER / 'tools/delivery-scm-release.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
r.RELEASE = SERVER / 'deployments/special-po-sent-placement-20261016'
r.IMAGE = 'mbbs-operator-app:special-po-sent-placement-20261016'
r.ROLLBACK = r.IMAGE + '-rollback'
r.READ_NAME = 'mbbs-special-po-placement-reader'
r.CHECK_NAME = 'mbbs-special-po-placement-image-check'
FILES = ['public/scm-special-stock-requests.js', 'public/special-stock-case-status.js']
TESTS = ['test/mbt/integration/special-vendor-confirmation.test.js']


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
    evidence = SERVER / 'test-artifacts/special-po-sent-placement-20261016'
    report = json.loads((evidence / 'report.json').read_text())
    assert report['passed']
    assert not any(json.loads((evidence / 'cleanup.json').read_text()).values())
    data = r.state()
    assert json.loads((evidence / 'source.json').read_text()) == {name: data['candidateTree'][name] for name in FILES}
    r.current(data)
    r.save('validation-passed.json', {'passed': True, 'candidateTreeHash': data['candidateTreeHash'], 'report': report})
    print(json.dumps({'validated': True, 'checks': report['checks']}))


def http_check(public):
    results = {}
    headers = {'Cache-Control': 'no-cache', 'User-Agent': 'Mozilla/5.0'}
    for base in ['http://127.0.0.1:3000', 'https://test.mbbsoperation.com']:
        with urllib.request.urlopen(urllib.request.Request(base + '/health', headers=headers), timeout=15) as response:
            assert response.status == 200 and json.loads(response.read()).get('ok')
        for name, expected in public.items():
            request = urllib.request.Request(base + '/' + name.removeprefix('public/') + '?placement=20261016',
                headers=headers)
            with urllib.request.urlopen(request, timeout=15) as response:
                assert response.status == 200 and r.sha(response.read()) == expected, name
        for path in ['/api/scm/special-stock-requests', '/api/sales/special-stock-requests']:
            try:
                with urllib.request.urlopen(urllib.request.Request(base + path, headers=headers), timeout=15) as response:
                    raise AssertionError('Anonymous API access permitted: ' + path)
            except urllib.error.HTTPError as error:
                assert error.code == 401, path
        results[base] = {'health': 200, 'publicAssetsVerified': len(public), 'anonymousApisDenied': 2}
    return results


def recover():
    data = r.state()
    restored = r.metadata(r.APP)
    assert restored['imageId'] == data['app']['imageId']
    assert restored['configuration'] == data['app']['configuration']
    assert [r.metadata(name) for name in r.DEPENDENCIES] == data['dependencies']
    assert json.loads(r.docker('exec', r.APP, 'node', '-e', r.HASH_SCRIPT)) == data['beforeTree']
    r.ready(data['app']['imageId'])
    probes = http_check({name: data['beforeTree'][name] for name in FILES})
    r.save('restored-app.json', {'app': restored, 'previousApp': data['app'], 'http': probes,
        'reason': 'First deployment rolled back after the app-container outbound public health check timed out.'})
    for name in ['apply', 'rollback']:
        (r.RELEASE / (name + '.log')).rename(r.RELEASE / (name + '-attempt1.log'))
    data['app'] = restored
    r.save('manifest.json', data)
    r.current(data)
    print(json.dumps({'restored': True, 'healthy': True, 'http': probes}))


def verify():
    data = r.state()
    r.ready(data['candidateImageId'])
    live = r.metadata(r.APP)
    assert live['imageId'] == data['candidateImageId']
    assert live['configuration'] == data['app']['configuration']
    assert [r.metadata(n) for n in r.DEPENDENCIES] == data['dependencies']
    assert json.loads(r.docker('exec', r.APP, 'node', '-e', r.HASH_SCRIPT)) == data['candidateTree']
    probes = http_check({name: data['candidateTree'][name] for name in FILES})
    result = {'deployed': True, 'at': r.now(), 'image': r.IMAGE, 'imageId': live['imageId'], 'files': FILES,
        'candidateTreeHash': data['candidateTreeHash'], 'runtimeFilesVerified': len(data['candidateTree']),
        'configurationPreserved': True, 'dependenciesPreserved': True,
        'productionHealthy': True, 'http': probes, 'databaseMigration': False}
    r.save('deployment-result.json', result)
    print(json.dumps(result), flush=True)


def apply():
    data = r.state()
    r.current(data)
    check = json.loads((r.RELEASE / 'image-check.json').read_text())
    assert check['passed'] and check['imageId'] == data['candidateImageId']
    assert r.docker('image', 'inspect', '--format', '{{.Id}}', r.IMAGE).decode().strip() == data['candidateImageId']
    r.config_check(data)
    r.assert_no_active_operations(r.preflight())
    args = ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'app']
    r.current(data)
    try:
        with (r.RELEASE / 'apply.log').open('wb') as log:
            subprocess.run(r.compose(data, 'release') + args, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except BaseException:
        with (r.RELEASE / 'rollback.log').open('wb') as log:
            subprocess.run(r.compose(data, 'rollback') + args, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        r.ready(data['app']['imageId'])
        raise


if __name__ == '__main__':
    if sys.argv[1] == 'build':
        atexit.register(r.cleanup_manual)
    {'capture': capture, 'prepare': prepare, 'validated': validated, 'build': r.build, 'recover': recover, 'apply': apply, 'verify': verify}[sys.argv[1]]()
