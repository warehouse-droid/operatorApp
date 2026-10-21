"""Release only the Schedule toolbar's three public assets over the live app."""
import datetime
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
RELEASE = SERVER / 'deployments/scm-schedule-toolbar-20261001'
OUT = SERVER / 'test-artifacts/scm-schedule-toolbar-20261001'
FILES = ['public/scm-schedule.js', 'public/dispatch.css', 'public/scm-schedule.html']
IMAGE = 'mbbs-operator-app:scm-schedule-toolbar-20261001'
spec = importlib.util.spec_from_file_location('schedule_parent', SERVER / 'tools/scm-schedule-multi-sort-deploy.py')
parent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(parent)
parent.RELEASE, parent.OUT, parent.FILES, parent.IMAGE = RELEASE, OUT, FILES, IMAGE
parent.core.RELEASE = RELEASE
APP, docker, metadata, digest = parent.APP, parent.docker, parent.metadata, parent.digest


def capture():
    os.umask(0o077)
    RELEASE.mkdir(exist_ok=False)
    OUT.mkdir(exist_ok=True)
    before = metadata(APP)
    deployed = json.loads((SERVER / 'deployments/scm-schedule-multi-sort-20261001/result.json').read_text())
    assert before['imageId'] == deployed['imageId'], 'Running Schedule app changed; rebase first'
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
        assert digest(original.encode()) == digest((OUT / 'before' / file).read_bytes()), 'Concurrent source change: ' + file
        updated = (SERVER / file).read_text()
        (candidate / file).write_text(updated)
        patch += ''.join(difflib.unified_diff(original.splitlines(True), updated.splitlines(True),
                                              fromfile='a/' + file, tofile='b/' + file))
    (RELEASE / 'changes.patch').write_text(patch)
    old_tree, new_tree = parent.core.files_at(baseline), parent.core.files_at(candidate)
    assert sorted(file for file in new_tree if old_tree.get(file) != new_tree[file]) == sorted(FILES)
    data = {'services': {'app': {'before': before, 'image': IMAGE}},
            'workspaceHashes': {file: digest((SERVER / file).read_bytes()) for file in FILES},
            'sourceHashes': {file: new_tree[file] for file in FILES},
            'untouched': {name: metadata(name) for name in parent.UNTOUCHED},
            'noteSourcePreserved': True, 'backendAndMigrationsUnchanged': True}
    parent.save('source-tree.json', new_tree)
    parent.save('manifest.json', data)
    parent.current(data)
    print(json.dumps({'captured': True, 'files': FILES, 'parent': before['image']}), flush=True)


def validate_candidate():
    spec = importlib.util.spec_from_file_location('toolbar_runner', SERVER / 'tools/special-po-so-note-run.py')
    runner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    runner.OUT, runner.REMOTE = OUT, '/tmp/scm-schedule-toolbar-20261001'
    root = RELEASE / 'validation'
    shutil.copytree(RELEASE / 'candidate', root, dirs_exist_ok=True)
    shutil.copytree(SERVER / 'test/dispatch/frontend', root / 'test/dispatch/frontend', dirs_exist_ok=True)
    (root / 'tools').mkdir(exist_ok=True)
    for file in ['tools/scm-schedule-toolbar-preview.mjs', 'tools/scm-schedule-toolbar-check.mjs',
                 'tools/stock-request-layout-eslint.config.mjs', 'tools/special-workflow-queue-eslint.config.mjs',
                 'tools/special-workflow-native-eslint.config.mjs', 'tools/special-workflow-link-eslint.config.mjs',
                 'tools/special-workflow-eslint.config.mjs']:
        shutil.copy2(SERVER / file, root / file)
    for file in FILES:
        target = root / 'test-artifacts/scm-schedule-toolbar-20261001/before' / file
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(RELEASE / 'before' / file, target)
    docker('exec', runner.RUNNER, 'node', '-e', "const fs=require('fs'),p=process.argv[1];fs.rmSync(p,{recursive:true,force:true});fs.mkdirSync(p)", runner.REMOTE)
    docker('cp', str(root) + '/.', runner.RUNNER + ':' + runner.REMOTE)
    docker('exec', runner.RUNNER, 'node', '-e', "require('fs').symlinkSync('/app/node_modules',process.argv[1]+'/node_modules','dir')", runner.REMOTE)
    status = runner.run('candidate-checks', ['node', 'tools/scm-schedule-toolbar-check.mjs'])
    with tarfile.open(fileobj=io.BytesIO(docker('cp', runner.RUNNER + ':' + runner.REMOTE + '/test-artifacts/scm-schedule-toolbar-20261001/.', '-'))) as archive:
        archive.extractall(OUT, filter='data')
    assert status == 0, 'Toolbar candidate validation failed'
    checks = json.loads((OUT / 'checks.json').read_text())
    assert checks['completed'] and checks['sourceHashes'] == parent.state()['sourceHashes']


parent.validate_candidate = validate_candidate


def verify():
    parent.verify()
    result = json.loads((RELEASE / 'result.json').read_text())
    result.update({'files': FILES, 'sortSummaryRemoved': True, 'singleRowToolbar': True,
                   'backendAndMigrationsUnchanged': True, 'migrationAppliedByThisRelease': False})
    parent.save('result.json', result)
    print(json.dumps({'toolbarDeployed': True, 'at': result['at'], 'files': FILES}), flush=True)


def apply():
    data = parent.state()
    parent.current(data)
    checks = json.loads((OUT / 'checks.json').read_text())
    assert checks['completed'] and checks['sourceHashes'] == data['sourceHashes']
    parent.core.config_check(data)
    active = json.loads(parent.database("""SELECT json_build_object(
      'specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'),
      'quantityApplying',(SELECT count(*) FROM sales_special_stock_cases WHERE quantity_review->>'status'='applying'),
      'operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),
      'driverExecuting',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing'),
      'regularExecuting',(SELECT count(*) FROM regular_stock_handoffs WHERE status='executing'))"""))
    parent.save('active-before-release.json', active)
    assert not any(active.values()), 'Wait for active operations: ' + json.dumps(active)
    try:
        with (RELEASE / 'publish.log').open('wb') as log:
            subprocess.run(parent.core.compose(data) + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'],
                           cwd=SERVER.parent, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except Exception:
        with (RELEASE / 'rollback.log').open('wb') as log:
            subprocess.run(parent.core.compose(data, 'compose.rollback.yml') + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'],
                           cwd=SERVER.parent, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        parent.core.core.ready(data['services']['app']['before']['imageId'])
        parent.save('rollback-result.json', {'rolledBackToScheduleImage': True, 'noSchemaChange': True})
        raise


if __name__ == '__main__':
    {'capture': capture, 'prepare': parent.prepare, 'apply': apply, 'verify': verify}[sys.argv[1]]()
