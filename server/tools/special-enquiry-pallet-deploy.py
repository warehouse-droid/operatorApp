"""Publish only the saved enquiry PALLET display over the current live app."""
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
RELEASE = SERVER / 'deployments/special-enquiry-pallet-20261001'
OUT = SERVER / 'test-artifacts/special-enquiry-pallet-20261001'
FILES = ['public/special-stock-pallet-display.js', 'public/sales-special-stock-requests.js',
         'public/scm-special-stock-requests.js', 'public/sales-stock-requests.html', 'public/scm-stock-requests.html']
IMAGE = 'mbbs-operator-app:special-enquiry-pallet-20261001'
spec = importlib.util.spec_from_file_location('quote_release', SERVER / 'tools/special-quote-pallet-deploy.py')
feature = importlib.util.module_from_spec(spec)
spec.loader.exec_module(feature)
for module in [feature, feature.release, feature.parent]:
    module.RELEASE, module.OUT, module.FILES, module.IMAGE = RELEASE, OUT, FILES, IMAGE
parent, release = feature.parent, feature.release
parent.core.RELEASE = RELEASE
parent.HTML_ROUTES = {'public/sales-stock-requests.html': '/sales/stock-requests',
                      'public/scm-stock-requests.html': '/scm/stock-requests'}
APP, docker, metadata = feature.APP, feature.docker, feature.metadata


def capture():
    os.umask(0o077)
    before = metadata(APP)
    previous = json.loads((SERVER / 'deployments/special-quote-pallet-20261001/result.json').read_text())
    assert before['imageId'] == previous['imageId'], 'Running app changed; rebase first'
    RELEASE.mkdir(exist_ok=False)
    OUT.mkdir(exist_ok=True)
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
            shutil.copy2(baseline / file, target)
    parent.save('capture.json', {'before': before, 'untouched': {name: metadata(name) for name in parent.UNTOUCHED}})
    print(json.dumps({'captured': True, 'parent': before['image'], 'files': FILES}), flush=True)


def validate_candidate():
    spec = importlib.util.spec_from_file_location('enquiry_runner', SERVER / 'tools/special-po-so-note-run.py')
    runner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    runner.OUT, runner.REMOTE = OUT, '/tmp/special-enquiry-pallet-20261001'
    root = RELEASE / 'validation'
    shutil.copytree(RELEASE / 'candidate', root, dirs_exist_ok=True)
    for folder in ['test', 'tools']:
        shutil.copytree(SERVER / folder, root / folder, dirs_exist_ok=True)
    shutil.copytree(OUT / 'before', root / 'test-artifacts/special-enquiry-pallet-20261001/before', dirs_exist_ok=True)
    docker('exec', runner.RUNNER, 'node', '-e', "const fs=require('fs'),p=process.argv[1];fs.rmSync(p,{recursive:true,force:true});fs.mkdirSync(p)", runner.REMOTE)
    docker('cp', str(root) + '/.', runner.RUNNER + ':' + runner.REMOTE)
    docker('exec', runner.RUNNER, 'node', '-e', "require('fs').symlinkSync('/app/node_modules',process.argv[1]+'/node_modules','dir')", runner.REMOTE)
    status = runner.run('candidate-checks', ['node', 'tools/special-enquiry-pallet-check.mjs'])
    with tarfile.open(fileobj=io.BytesIO(docker('cp', runner.RUNNER + ':' + runner.REMOTE + '/test-artifacts/special-enquiry-pallet-20261001/.', '-'))) as archive:
        archive.extractall(OUT, filter='data')
    assert status == 0, 'Enquiry PALLET display candidate validation failed'
    checks = json.loads((OUT / 'checks.json').read_text())
    assert checks['completed'] and checks['sourceHashes'] == parent.state()['sourceHashes']


def stage():
    captured = json.loads((RELEASE / 'capture.json').read_text())
    assert metadata(APP) == captured['before'], 'Running app changed since capture'
    candidate = RELEASE / 'candidate'
    shutil.copytree(RELEASE / 'before', candidate, dirs_exist_ok=True)
    patch = ''
    for file in FILES:
        old = RELEASE / 'before' / file
        original = old.read_text() if old.exists() else ''
        updated = (SERVER / file).read_text()
        if file == 'public/scm-stock-requests.html':
            # Preserve the live stylesheet order; the workspace has an unrelated reorder.
            old_script = '/scm-special-stock-requests.js?v=20261001-po-mini-rows-v1'
            new_script = '/scm-special-stock-requests.js?v=20261001-enquiry-pallet-v1'
            assert original.count(old_script) == 1 and updated.count(new_script) == 1
            updated = original.replace(old_script, new_script)
        (candidate / file).write_text(updated)
        patch += ''.join(difflib.unified_diff(original.splitlines(True), updated.splitlines(True),
                                             fromfile='a/' + file, tofile='b/' + file))
    old_tree, new_tree = parent.core.files_at(RELEASE / 'before'), parent.core.files_at(candidate)
    assert sorted(file for file in new_tree if old_tree.get(file) != new_tree[file]) == sorted(FILES)
    (RELEASE / 'changes.patch').write_text(patch)
    parent.save('manifest.json', {'services': {'app': {'before': captured['before'], 'image': IMAGE}},
                                'workspaceHashes': {file: feature.digest((SERVER / file).read_bytes()) for file in FILES},
                                'sourceHashes': {file: new_tree[file] for file in FILES},
                                'untouched': captured['untouched'], 'noteSourcePreserved': True,
                                'unrelatedWorkspaceStylesheetOrderExcluded': True})
    parent.save('source-tree.json', new_tree)
    parent.current(parent.state())
    print(json.dumps({'staged': True, 'files': FILES, 'unrelatedStylesheetReorderExcluded': True}), flush=True)


def verify():
    parent.verify()
    result = json.loads((RELEASE / 'result.json').read_text())
    result.update({'files': FILES, 'salesAndScmEnquiryPalletVisible': True,
                   'backendAndMigrationsUnchanged': True, 'migrationAppliedByThisRelease': False})
    parent.save('result.json', result)
    print(json.dumps({'enquiryPalletDeployed': True, 'at': result['at']}), flush=True)


parent.validate_candidate = validate_candidate
release.verify = verify
if __name__ == '__main__':
    {'capture': capture, 'stage': stage, 'prepare': parent.prepare,
     'apply': release.apply, 'verify': verify}[sys.argv[1]]()
