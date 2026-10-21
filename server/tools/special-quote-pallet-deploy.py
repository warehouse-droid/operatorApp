"""Scoped app release for PALLET on initial Special Request quotes."""
import difflib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import sys
import tarfile

SERVER = Path(__file__).resolve().parents[1]
RELEASE = SERVER / 'deployments/special-quote-pallet-20261001'
OUT = SERVER / 'test-artifacts/special-quote-pallet-20261001'
FILES = ['src/special-stock-request-domain.js', 'src/special-stock-request-repository.js', 'src/special-stock-documents.js',
         'public/special-stock-request-actions.js', 'public/sales-special-stock-requests.js', 'public/sales-stock-requests.html']
IMAGE = 'mbbs-operator-app:special-quote-pallet-20261001'
spec = importlib.util.spec_from_file_location('items_release', SERVER / 'tools/scm-schedule-toolbar-deploy.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.RELEASE, release.OUT, release.FILES, release.IMAGE = RELEASE, OUT, FILES, IMAGE
parent = release.parent
parent.RELEASE, parent.OUT, parent.FILES, parent.IMAGE = RELEASE, OUT, FILES, IMAGE
parent.HTML_ROUTE = '/sales/stock-requests'
parent.HTML_ROUTES = {'public/sales-stock-requests.html': '/sales/stock-requests'}
parent.core.RELEASE = RELEASE
APP, docker, metadata, digest = release.APP, release.docker, release.metadata, release.digest


def capture():
    os.umask(0o077)
    RELEASE.mkdir(exist_ok=False)
    OUT.mkdir(exist_ok=True)
    before = metadata(APP)
    previous = json.loads((SERVER / 'deployments/special-sales-actions-row-20261001/result.json').read_text())
    assert before['imageId'] == previous['imageId'], 'Live app changed; rebase first'
    baseline = RELEASE / 'before'
    baseline.mkdir()
    for name in ['src', 'public', 'migrations', 'package.json', 'package-lock.json']:
        with tarfile.open(fileobj=io.BytesIO(docker('cp', APP + ':/app/' + name, '-'))) as archive:
            archive.extractall(baseline, filter='data')
    assert metadata(APP) == before
    for file in FILES:
        if (baseline / file).exists():
            target = OUT / 'before' / file
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists():
                assert target.read_bytes() == (baseline / file).read_bytes()
            shutil.copy2(baseline / file, target)
    parent.save('capture.json', {'before': before, 'untouched': {name: metadata(name) for name in parent.UNTOUCHED}})
    print(json.dumps({'captured': True, 'parent': before['image'], 'scopedFiles': FILES}), flush=True)


def stage():
    captured = json.loads((RELEASE / 'capture.json').read_text())
    assert metadata(APP) == captured['before'], 'Live app changed since capture'
    candidate = RELEASE / 'candidate'
    shutil.copytree(RELEASE / 'before', candidate, dirs_exist_ok=True)
    patch = ''
    for file in FILES:
        old = RELEASE / 'before' / file
        original = old.read_text() if old.exists() else ''
        updated = (SERVER / file).read_text()
        (candidate / file).write_text(updated)
        patch += ''.join(difflib.unified_diff(original.splitlines(True), updated.splitlines(True), fromfile='a/' + file, tofile='b/' + file))
    old_tree, new_tree = parent.core.files_at(RELEASE / 'before'), parent.core.files_at(candidate)
    assert sorted(file for file in new_tree if old_tree.get(file) != new_tree[file]) == sorted(FILES)
    (RELEASE / 'changes.patch').write_text(patch)
    parent.save('manifest.json', {'services': {'app': {'before': captured['before'], 'image': IMAGE}},
                                'workspaceHashes': {file: digest((SERVER / file).read_bytes()) for file in FILES},
                                'sourceHashes': {file: new_tree[file] for file in FILES},
                                'untouched': captured['untouched'], 'noteSourcePreserved': True})
    parent.save('source-tree.json', new_tree)
    parent.current(parent.state())
    print(json.dumps({'staged': True, 'files': FILES}), flush=True)


def validate_candidate():
    spec = importlib.util.spec_from_file_location('items_runner', SERVER / 'tools/special-quote-pallet-run.py')
    runner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    runner.sync()
    status = runner.run('candidate-checks', ['node', 'tools/special-quote-pallet-check.mjs'])
    runner.collect()
    assert status == 0, 'Special Request PALLET quote candidate checks failed'
    checks = json.loads((OUT / 'checks.json').read_text())
    assert checks['completed'] and checks['sourceHashes'] == parent.state()['sourceHashes']


def verify():
    parent.verify()
    result = json.loads((RELEASE / 'result.json').read_text())
    result.update({'files': FILES, 'initialQuotePalletInputs': True, 'positivePalletQuoteLine': True, 'zeroPalletQuoteLineOmitted': True,
                   'palletStoredAndCopied': True, 'existingAddItemAndCopyPreserved': True,
                   'migrationAppliedByThisRelease': False, 'scheduleAndPoMiniPanelPreserved': True})
    parent.save('result.json', result)
    print(json.dumps({'quotePalletDeployed': True, 'at': result['at'], 'files': FILES}), flush=True)


parent.validate_candidate = validate_candidate
release.verify = verify
if __name__ == '__main__':
    {'capture': capture, 'stage': stage, 'prepare': parent.prepare, 'apply': release.apply, 'verify': verify}[sys.argv[1]]()
