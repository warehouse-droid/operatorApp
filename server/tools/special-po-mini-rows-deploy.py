"""Publish the Special Request mini-panel layout over the current Schedule app."""
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
RELEASE = SERVER / 'deployments/special-po-mini-rows-20261001'
OUT = SERVER / 'test-artifacts/special-po-mini-rows-20261001'
FILES = ['public/special-stock-po-routing.js', 'public/special-stock-po-routing.css',
         'public/scm-special-stock-requests.js', 'public/scm-stock-requests.html',
         'public/special-stock-line-details.js', 'public/sales-special-stock-requests.js', 'public/sales-stock-requests.html']
IMAGE = 'mbbs-operator-app:special-po-mini-rows-20261001'
VERSION = '20261001-po-mini-rows-v1'
spec = importlib.util.spec_from_file_location('mini_release', SERVER / 'tools/scm-schedule-toolbar-deploy.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.RELEASE, release.OUT, release.FILES, release.IMAGE = RELEASE, OUT, FILES, IMAGE
parent = release.parent
parent.RELEASE, parent.OUT, parent.FILES, parent.IMAGE = RELEASE, OUT, FILES, IMAGE
parent.HTML_ROUTE = '/scm/stock-requests'
parent.HTML_ROUTES = {'public/scm-stock-requests.html': '/scm/stock-requests',
                      'public/sales-stock-requests.html': '/sales/stock-requests'}
parent.core.RELEASE = RELEASE
APP, docker, metadata, digest = release.APP, release.docker, release.metadata, release.digest


def capture():
    os.umask(0o077)
    RELEASE.mkdir(exist_ok=False)
    before = metadata(APP)
    deployed = json.loads((SERVER / 'deployments/scm-schedule-toolbar-20261001/result.json').read_text())
    assert before['imageId'] == deployed['imageId'], 'Running app changed; rebase first'
    baseline = RELEASE / 'before'
    baseline.mkdir()
    for name in ['src', 'public', 'migrations', 'package.json', 'package-lock.json']:
        with tarfile.open(fileobj=io.BytesIO(docker('cp', APP + ':/app/' + name, '-'))) as archive:
            archive.extractall(baseline, filter='data')
    assert metadata(APP) == before
    candidate = RELEASE / 'candidate'
    shutil.copytree(baseline, candidate)
    patch = ''
    for file in FILES:
        original = (baseline / file).read_text()
        assert digest(original.encode()) == digest((OUT / 'before' / file).read_bytes())
        updated = (SERVER / file).read_text()
        if file.endswith('.html'):
            # Preserve the live stylesheet order and every unrelated asset version.
            updated = original
            assets = ['special-stock-po-routing.css', 'scm-special-stock-requests.js'] if file == 'public/scm-stock-requests.html' else ['sales-special-stock-requests.js']
            for asset in assets:
                updated, count = re.subn('/' + re.escape(asset) + r'\?v=[^"\s]+',
                                        '/' + asset + '?v=' + VERSION, updated)
                assert count == 1, asset
        (candidate / file).write_text(updated)
        patch += ''.join(difflib.unified_diff(original.splitlines(True), updated.splitlines(True),
                                             fromfile='a/' + file, tofile='b/' + file))
    old_tree, new_tree = parent.core.files_at(baseline), parent.core.files_at(candidate)
    assert sorted(file for file in new_tree if old_tree.get(file) != new_tree[file]) == sorted(FILES)
    (RELEASE / 'changes.patch').write_text(patch)
    data = {'services': {'app': {'before': before, 'image': IMAGE}},
            'workspaceHashes': {file: digest((SERVER / file).read_bytes()) for file in FILES},
            'sourceHashes': {file: new_tree[file] for file in FILES},
            'untouched': {name: metadata(name) for name in parent.UNTOUCHED},
            'noteSourcePreserved': True, 'backendAndMigrationsUnchanged': True,
            'liveStylesheetOrderPreserved': True}
    parent.save('manifest.json', data)
    parent.save('source-tree.json', new_tree)
    parent.current(data)
    print(json.dumps({'captured': True, 'files': FILES, 'parent': before['image']}), flush=True)


def validate_candidate():
    spec = importlib.util.spec_from_file_location('mini_runner', SERVER / 'tools/special-po-so-note-run.py')
    runner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    runner.OUT, runner.REMOTE = OUT, '/tmp/special-po-mini-rows-20261001'
    root = RELEASE / 'validation'
    shutil.copytree(RELEASE / 'candidate', root, dirs_exist_ok=True)
    for folder in ['test/mbt/unit', 'test/mbt/integration', 'test/field-sales']:
        shutil.copytree(SERVER / folder, root / folder, dirs_exist_ok=True)
    (root / 'tools').mkdir(exist_ok=True)
    for file in ['tools/special-po-mini-rows-check.mjs', 'tools/stock-request-layout-eslint.config.mjs',
                 'tools/special-workflow-queue-eslint.config.mjs', 'tools/special-workflow-native-eslint.config.mjs',
                 'tools/special-workflow-link-eslint.config.mjs', 'tools/special-workflow-eslint.config.mjs']:
        shutil.copy2(SERVER / file, root / file)
    for file in FILES:
        target = root / 'test-artifacts/special-po-mini-rows-20261001/before' / file
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(RELEASE / 'before' / file, target)
    docker('exec', runner.RUNNER, 'node', '-e', "const fs=require('fs'),p=process.argv[1];fs.rmSync(p,{recursive:true,force:true});fs.mkdirSync(p)", runner.REMOTE)
    docker('cp', str(root) + '/.', runner.RUNNER + ':' + runner.REMOTE)
    docker('exec', runner.RUNNER, 'node', '-e', "require('fs').symlinkSync('/app/node_modules',process.argv[1]+'/node_modules','dir')", runner.REMOTE)
    status = runner.run('candidate-checks', ['node', 'tools/special-po-mini-rows-check.mjs'])
    with tarfile.open(fileobj=io.BytesIO(docker('cp', runner.RUNNER + ':' + runner.REMOTE + '/test-artifacts/special-po-mini-rows-20261001/.', '-'))) as archive:
        archive.extractall(OUT, filter='data')
    assert status == 0, 'Mini-panel candidate validation failed'
    checks = json.loads((OUT / 'checks.json').read_text())
    assert checks['completed'] and checks['sourceHashes'] == parent.state()['sourceHashes']


def verify():
    parent.verify()
    result = json.loads((RELEASE / 'result.json').read_text())
    result.update({'files': FILES, 'miniPanelDesktopRows': 2, 'openPoSplitLinkRemoved': True,
                   'backendAndMigrationsUnchanged': True, 'migrationAppliedByThisRelease': False,
                   'scheduleToolbarPreserved': True, 'readinessLabel': 'Ready for Arrangement',
                   'descriptionFormat': 'name colour size detail spec', 'vendorPrefixRemoved': True})
    parent.save('result.json', result)
    print(json.dumps({'miniPanelDeployed': True, 'at': result['at'], 'files': FILES}), flush=True)


parent.validate_candidate = validate_candidate
release.verify = verify
if __name__ == '__main__':
    {'capture': capture, 'prepare': parent.prepare, 'apply': release.apply, 'verify': verify}[sys.argv[1]]()
