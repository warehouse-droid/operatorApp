"""Release the tested regular-stock changes over the current production image."""
import atexit
import difflib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tarfile

SERVER = Path(__file__).resolve().parents[1]
ARTIFACT = SERVER / 'test-artifacts/backorder-pending-po-20261021'
spec = importlib.util.spec_from_file_location('prior_status_release', SERVER / 'tools/unified-stock-status-release.py')
prior = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prior)
r = prior.r
r.RELEASE = SERVER / 'deployments/backorder-pending-po-20261021'
r.IMAGE = 'mbbs-operator-app:backorder-pending-po-20261021'
r.ROLLBACK = r.IMAGE + '-rollback'
r.READ_NAME = 'mbbs-backorder-pending-po-release-reader'
r.CHECK_NAME = 'mbbs-backorder-pending-po-release-check'


def results(folder):
    result = []
    for name in ['unit.log', 'integration.log']:
        text = (folder / name).read_text()
        values = {key: int(re.findall(r'^# ' + key + r' (\d+)$', text, re.M)[-1]) for key in ['tests', 'pass', 'fail']}
        assert values['fail'] == 0 and values['tests'] == values['pass'], (name, values)
        result.append({'file': name, **values})
    return result


def prepare():
    static = json.loads((ARTIFACT / 'static.json').read_text())
    assert all(r.sha((SERVER / n).read_bytes()) == h for n, h in static['hashes'].items()), 'Tested files changed'
    tested = results(ARTIFACT)
    r.RELEASE.mkdir(parents=True, exist_ok=False)
    before = r.metadata(r.APP)
    dependencies = [r.metadata(n) for n in r.DEPENDENCIES]
    baseline = r.RELEASE / 'before'
    baseline.mkdir()
    archive = r.docker('exec', r.APP, 'tar', '-cf', '-', '-C', '/app', 'src', 'public', 'migrations', 'package.json', 'package-lock.json')
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        stream.extractall(baseline, filter='data')
    assert r.metadata(r.APP) == before
    for p in baseline.rglob('*'):
        p.chmod(p.stat().st_mode | (0o055 if p.is_dir() else 0o044))
    candidate = r.RELEASE / 'candidate'
    shutil.copytree(baseline, candidate)
    patch, expected = '', []
    for name in json.loads((SERVER / 'tools/backorder-pending-po-files.json').read_text()):
        old = ARTIFACT / 'before' / name
        if old.exists():
            if old.read_bytes() == (SERVER / name).read_bytes():
                continue
            patch += ''.join(difflib.unified_diff(old.read_text().splitlines(True), (SERVER / name).read_text().splitlines(True), fromfile='a/' + name, tofile='b/' + name, n=3))
        else:
            assert not (candidate / name).exists(), 'New module already exists: ' + name
            shutil.copy2(SERVER / name, candidate / name)
        expected.append(name)
    r.apply_patch(candidate, patch, 'backorder-pending-po')
    old_tree, tree = r.files_at(baseline), r.files_at(candidate)
    changed = sorted(n for n in old_tree.keys() | tree.keys() if old_tree.get(n) != tree.get(n))
    assert changed == sorted(expected), changed
    data = {'capturedAt': r.now(), 'app': before, 'dependencies': dependencies, 'files': changed,
            'beforeTree': old_tree, 'candidateTree': tree, 'candidateTreeHash': r.sha(json.dumps(tree, sort_keys=True).encode()),
            'workspace': {n: static['hashes'][n] for n in changed}, 'tests': tested,
            'packages': {n: r.sha((candidate / n).read_bytes()) for n in ['package.json', 'package-lock.json']}}
    r.save('manifest.json', data)
    r.current(data)
    print(json.dumps({'prepared': True, 'changedFiles': changed, 'candidateDifferences': [n for n in changed if tree[n] != static['hashes'][n]]}), flush=True)


def validated():
    data = r.state()
    r.current(data)
    output = r.RELEASE / 'validation-artifacts/backorder-pending-po-20261021'
    checks = results(output)
    assert checks == data['tests'], 'Candidate regression totals differ'
    static = json.loads((output / 'static.json').read_text())
    assert all(static['hashes'][n] == data['candidateTree'][n] for n in data['files'])
    assert (r.RELEASE / 'validation-cleanup-passed').exists()
    r.save('validation-passed.json', {'passed': True, 'at': r.now(), 'candidateTreeHash': data['candidateTreeHash'],
                                     'tests': checks, 'cleanupVerified': True})
    print(json.dumps({'validated': True, 'tests': checks}), flush=True)


def verify():
    data = r.state()
    r.ready(data['candidateImageId'])
    live = r.metadata(r.APP)
    assert live['imageId'] == data['candidateImageId']
    assert live['configuration'] == data['app']['configuration']
    assert [r.metadata(n) for n in r.DEPENDENCIES] == data['dependencies']
    assert json.loads(r.docker('exec', r.APP, 'node', '-e', r.HASH_SCRIPT)) == data['candidateTree']
    checked = prior.http_check(data)
    readback = r.docker('exec', '-i', '-w', '/app', r.APP, 'node', '--input-type=module',
                       input=(SERVER / 'tools/backorder-pending-po-live-verify.mjs').read_bytes(), timeout=60)
    (r.RELEASE / 'live-readback.jsonl').write_bytes(readback)
    r.save('deployment-result.json', {'deployed': True, 'at': r.now(), 'image': r.IMAGE, 'imageId': live['imageId'],
                                     'changedFiles': data['files'], 'http': checked, 'configurationPreserved': True,
                                     'candidateTreeHash': data['candidateTreeHash'], 'dependentServicesPreserved': True,
                                     'noSchemaOrDataChanges': True})
    print(json.dumps({'deployed': True, 'image': r.IMAGE, 'http': checked}), flush=True)


prior.cutover.verify = verify
if __name__ == '__main__':
    os.umask(0o022)
    if sys.argv[1] in ['build', 'apply', 'verify']:
        atexit.register(r.cleanup_manual)
    {'prepare': prepare, 'validated': validated, 'build': r.build, 'apply': prior.cutover.apply, 'verify': verify}[sys.argv[1]]()
