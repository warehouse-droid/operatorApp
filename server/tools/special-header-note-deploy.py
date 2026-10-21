"""Scoped Sales request-header release, keeping unrelated workspace changes out."""
import difflib
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
RELEASE = SERVER / 'deployments/special-header-note-20261001'
OUT = SERVER / 'test-artifacts/special-header-note-20261001'
FILES = json.loads((SERVER / 'tools/special-header-note-files.json').read_text())
IMAGE = 'mbbs-operator-app:special-header-note-20261001'
spec = importlib.util.spec_from_file_location('quote_release', SERVER / 'tools/special-quote-pallet-deploy.py')
feature = importlib.util.module_from_spec(spec)
spec.loader.exec_module(feature)
for module in [feature, feature.release, feature.parent]:
    module.RELEASE, module.OUT, module.FILES, module.IMAGE = RELEASE, OUT, FILES, IMAGE
parent, release = feature.parent, feature.release
parent.core.RELEASE = RELEASE
parent.HTML_ROUTES = {'public/sales-stock-requests.html': '/sales/stock-requests', 'public/scm-stock-requests.html': '/scm/stock-requests'}
MIGRATION = '249_special_case_line_edits.sql'
parent.MIGRATION = MIGRATION
APP, docker, metadata, digest = feature.APP, feature.docker, feature.metadata, feature.digest


def capture():
    os.umask(0o077)
    before = metadata(APP)
    assert before['imageId'] == 'sha256:ce2341bce38156791eec3efdc5582f958e20a64324f519a377e38ab277fca53f', 'Live app changed; rebase first'
    RELEASE.mkdir(exist_ok=False)
    OUT.mkdir(exist_ok=True)
    baseline = RELEASE / 'before'
    baseline.mkdir()
    for name in ['src', 'public', 'migrations', 'package.json', 'package-lock.json']:
        with tarfile.open(fileobj=io.BytesIO(docker('cp', APP + ':/app/' + name, '-'))) as archive:
            archive.extractall(baseline, filter='data')
    assert metadata(APP) == before
    for file in FILES:
        for source, root in [(baseline / file, OUT / 'before'), (SERVER / file, RELEASE / 'workspace-before')]:
            if source.exists():
                target = root / file
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
    parent.save('capture.json', {'before': before, 'untouched': {name: metadata(name) for name in parent.UNTOUCHED}})
    print(json.dumps({'captured': True, 'parent': before['image'], 'files': FILES}), flush=True)


def stage():
    captured = json.loads((RELEASE / 'capture.json').read_text())
    before = metadata(APP)
    if before != captured['before']:
        previous = json.loads((RELEASE / 'result.json').read_text())
        assert before['imageId'] == previous['imageId'], 'An unrelated app deployment changed the parent'
        assert before['configuration'] == captured['before']['configuration']
        assert {name: metadata(name) for name in parent.UNTOUCHED} == captured['untouched']
        assert json.loads(docker('exec', APP, 'node', '-e', parent.HASH)) == json.loads((RELEASE / 'source-tree.json').read_text())
        archive = RELEASE / 'first-publication'
        if not archive.exists():
            archive.mkdir()
            for name in ['result.json', 'manifest.json', 'source-tree.json']:
                shutil.copy2(RELEASE / name, archive / name)
        parent.save('publication-parent.json', {'before': before, 'originalCapturePreserved': True,
                    'parentIsThisTaskPreviousPublication': True, 'fullRuntimeVerified': True})
    candidate = RELEASE / 'candidate'
    if candidate.exists():
        shutil.rmtree(candidate)
    shutil.copytree(RELEASE / 'before', candidate)
    patch = ''
    for file in FILES:
        old = RELEASE / 'workspace-before' / file
        original = old.read_text() if old.exists() else ''
        updated = (SERVER / file).read_text()
        patch += ''.join(difflib.unified_diff(original.splitlines(True), updated.splitlines(True),
                                             fromfile='a/' + file if old.exists() else '/dev/null', tofile='b/' + file, n=0 if file.endswith('.html') else 3))
    (RELEASE / 'workspace-delta.patch').write_text(patch)
    subprocess.run(['git', 'apply', '--no-index', '--unidiff-zero', '-'], cwd=candidate, input=patch.encode(), check=True)
    old_tree, new_tree = parent.core.files_at(RELEASE / 'before'), parent.core.files_at(candidate)
    assert sorted(file for file in new_tree if old_tree.get(file) != new_tree[file]) == sorted(FILES)
    live_patch = ''
    for file in FILES:
        old = RELEASE / 'before' / file
        original = old.read_text() if old.exists() else ''
        live_patch += ''.join(difflib.unified_diff(original.splitlines(True), (candidate / file).read_text().splitlines(True),
                                                  fromfile='a/' + file if old.exists() else '/dev/null', tofile='b/' + file))
    (RELEASE / 'changes.patch').write_text(live_patch)
    parent.save('manifest.json', {'services': {'app': {'before': before, 'image': IMAGE}},
                                'workspaceHashes': {file: digest((SERVER / file).read_bytes()) for file in FILES},
                                'sourceHashes': {file: new_tree[file] for file in FILES},
                                'untouched': captured['untouched'], 'noteSourcePreserved': True,
                                'onlyTaskWorkspaceDeltaApplied': True})
    parent.save('source-tree.json', new_tree)
    parent.current(parent.state())
    print(json.dumps({'staged': True, 'files': FILES, 'onlyTaskDelta': True}), flush=True)


def validate_candidate():
    spec = importlib.util.spec_from_file_location('case_edit_runner', SERVER / 'tools/special-header-note-run.py')
    runner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    runner.sync()
    status = runner.run('candidate-checks', ['node', 'tools/special-header-note-check.mjs'])
    runner.collect()
    assert status == 0, 'Sales header-note checks failed'
    checks = json.loads((OUT / 'checks.json').read_text())
    assert checks['completed'] and checks['sourceHashes'] == parent.state()['sourceHashes']


def verify():
    parent.verify()
    result = json.loads((RELEASE / 'result.json').read_text())
    result.update({'files': FILES, 'beforeSalesOrderHeaderEditing': True, 'noteAndDeliverySavedTogether': True, 'requestStatusPreserved': True, 'newMigration': False})
    parent.save('result.json', result)
    print(json.dumps({'salesHeaderNoteDeployed': True, 'at': result['at']}), flush=True)


def apply():
    release.apply()


parent.validate_candidate = validate_candidate
release.verify = verify
if __name__ == '__main__':
    {'capture': capture, 'stage': stage, 'prepare': parent.prepare, 'apply': apply, 'verify': verify}[sys.argv[1]]()
