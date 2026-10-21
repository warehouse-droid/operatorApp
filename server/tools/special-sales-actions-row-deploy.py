"""Publish only the Special Sales case-line action layout over the live app."""
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import sys
import tarfile

SERVER = Path(__file__).resolve().parents[1]
RELEASE = SERVER / 'deployments/special-sales-actions-row-20261001'
OUT = SERVER / 'test-artifacts/special-sales-actions-row-20261001'
FILES = ['public/sales-special-stock-requests.js', 'public/special-stock-request-actions.css',
         'public/sales-stock-requests.html']
IMAGE = 'mbbs-operator-app:special-sales-actions-row-20261001'
spec = importlib.util.spec_from_file_location('items_parent', SERVER / 'tools/special-sales-items-copy-deploy.py')
feature = importlib.util.module_from_spec(spec)
spec.loader.exec_module(feature)
for module in [feature, feature.release, feature.parent]:
    module.RELEASE, module.OUT, module.FILES, module.IMAGE = RELEASE, OUT, FILES, IMAGE
parent, release = feature.parent, feature.release
parent.core.RELEASE = RELEASE
APP, docker, metadata = feature.APP, feature.docker, feature.metadata


def capture():
    os.umask(0o077)
    before = metadata(APP)
    previous = json.loads((SERVER / 'deployments/special-sales-items-copy-20261001/result.json').read_text())
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
        target = OUT / 'before' / file
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(baseline / file, target)
    parent.save('capture.json', {'before': before, 'untouched': {name: metadata(name) for name in parent.UNTOUCHED}})
    print(json.dumps({'captured': True, 'parent': before['image'], 'files': FILES}), flush=True)


def validate_candidate():
    spec = importlib.util.spec_from_file_location('actions_runner', SERVER / 'tools/special-po-so-note-run.py')
    runner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    runner.OUT, runner.REMOTE = OUT, '/tmp/special-sales-actions-row-20261001'
    root = RELEASE / 'validation'
    shutil.copytree(RELEASE / 'candidate', root, dirs_exist_ok=True)
    for file in ['test/mbt/unit/special-sales-items-copy.test.js',
                 'test/mbt/integration/special-sales-items-copy-browser.test.js',
                 'tools/special-sales-actions-row-check.mjs', 'tools/stock-request-layout-eslint.config.mjs',
                 'tools/special-workflow-queue-eslint.config.mjs', 'tools/special-workflow-native-eslint.config.mjs',
                 'tools/special-workflow-link-eslint.config.mjs', 'tools/special-workflow-eslint.config.mjs']:
        target = root / file
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SERVER / file, target)
    for file in FILES:
        target = root / 'test-artifacts/special-sales-actions-row-20261001/before' / file
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(RELEASE / 'before' / file, target)
    docker('exec', runner.RUNNER, 'node', '-e', "const fs=require('fs'),p=process.argv[1];fs.rmSync(p,{recursive:true,force:true});fs.mkdirSync(p)", runner.REMOTE)
    docker('cp', str(root) + '/.', runner.RUNNER + ':' + runner.REMOTE)
    docker('exec', runner.RUNNER, 'node', '-e', "require('fs').symlinkSync('/app/node_modules',process.argv[1]+'/node_modules','dir')", runner.REMOTE)
    status = runner.run('candidate-checks', ['node', 'tools/special-sales-actions-row-check.mjs'])
    with tarfile.open(fileobj=io.BytesIO(docker('cp', runner.RUNNER + ':' + runner.REMOTE + '/test-artifacts/special-sales-actions-row-20261001/.', '-'))) as archive:
        archive.extractall(OUT, filter='data')
    assert status == 0, 'Case-line action layout validation failed'
    checks = json.loads((OUT / 'checks.json').read_text())
    assert checks['completed'] and checks['sourceHashes'] == parent.state()['sourceHashes']


def verify():
    parent.verify()
    result = json.loads((RELEASE / 'result.json').read_text())
    result.update({'files': FILES, 'sameRowActions': True, 'addItemAlignedRight': True,
                   'backendAndMigrationsUnchanged': True, 'migrationAppliedByThisRelease': False,
                   'scheduleAndPoMiniPanelPreserved': True, 'itemAdditionAndCopyPreserved': True})
    parent.save('result.json', result)
    print(json.dumps({'caseLineActionLayoutDeployed': True, 'at': result['at'], 'files': FILES}), flush=True)


parent.validate_candidate = validate_candidate
release.verify = verify
if __name__ == '__main__':
    {'capture': capture, 'stage': feature.stage, 'prepare': parent.prepare,
     'apply': release.apply, 'verify': verify}[sys.argv[1]]()
