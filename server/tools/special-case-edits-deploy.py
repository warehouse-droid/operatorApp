"""Scoped Sales case-edit release, keeping unrelated workspace changes out."""
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
RELEASE = SERVER / 'deployments/special-case-edits-20261001'
OUT = SERVER / 'test-artifacts/special-case-edits-20261001'
FILES = json.loads((SERVER / 'tools/special-case-edits-files.json').read_text())
IMAGE = 'mbbs-operator-app:special-case-edits-20261001'
spec = importlib.util.spec_from_file_location('quote_release', SERVER / 'tools/special-quote-pallet-deploy.py')
feature = importlib.util.module_from_spec(spec)
spec.loader.exec_module(feature)
for module in [feature, feature.release, feature.parent]:
    module.RELEASE, module.OUT, module.FILES, module.IMAGE = RELEASE, OUT, FILES, IMAGE
parent, release = feature.parent, feature.release
parent.core.RELEASE = RELEASE
parent.HTML_ROUTES = {'public/sales-stock-requests.html': '/sales/stock-requests'}
MIGRATION = '249_special_case_line_edits.sql'
parent.MIGRATION = MIGRATION
APP, docker, metadata, digest = feature.APP, feature.docker, feature.metadata, feature.digest


def capture():
    os.umask(0o077)
    before = metadata(APP)
    assert before['imageId'] == 'sha256:c2be36651db26974601e94cd9f3652cd1acec137265cc6a3d786a0baca7366f5', 'Live app changed; rebase first'
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
    assert metadata(APP) == captured['before'], 'Live app changed since capture'
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
                                             fromfile='a/' + file if old.exists() else '/dev/null', tofile='b/' + file, n=3))
    (RELEASE / 'workspace-delta.patch').write_text(patch)
    subprocess.run(['git', 'apply', '--no-index', '-'], cwd=candidate, input=patch.encode(), check=True)
    old_tree, new_tree = parent.core.files_at(RELEASE / 'before'), parent.core.files_at(candidate)
    assert sorted(file for file in new_tree if old_tree.get(file) != new_tree[file]) == sorted(FILES)
    live_patch = ''
    for file in FILES:
        old = RELEASE / 'before' / file
        original = old.read_text() if old.exists() else ''
        live_patch += ''.join(difflib.unified_diff(original.splitlines(True), (candidate / file).read_text().splitlines(True),
                                                  fromfile='a/' + file if old.exists() else '/dev/null', tofile='b/' + file))
    (RELEASE / 'changes.patch').write_text(live_patch)
    parent.save('manifest.json', {'services': {'app': {'before': captured['before'], 'image': IMAGE}},
                                'workspaceHashes': {file: digest((SERVER / file).read_bytes()) for file in FILES},
                                'sourceHashes': {file: new_tree[file] for file in FILES},
                                'untouched': captured['untouched'], 'noteSourcePreserved': True,
                                'onlyTaskWorkspaceDeltaApplied': True})
    parent.save('source-tree.json', new_tree)
    parent.current(parent.state())
    print(json.dumps({'staged': True, 'files': FILES, 'onlyTaskDelta': True}), flush=True)


def validate_candidate():
    spec = importlib.util.spec_from_file_location('case_edit_runner', SERVER / 'tools/special-case-edits-run.py')
    runner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    runner.sync()
    status = runner.run('candidate-checks', ['node', 'tools/special-case-edits-check.mjs'])
    runner.collect()
    assert status == 0, 'Sales case-edit checks failed'
    checks = json.loads((OUT / 'checks.json').read_text())
    assert checks['completed'] and checks['sourceHashes'] == parent.state()['sourceHashes']


def verify():
    parent.verify()
    result = json.loads((RELEASE / 'result.json').read_text())
    result.update({'files': FILES, 'beforeSalesOrderCaseEditing': True,
                   'materialNameOrQuantityRestartsEnquiry': True, 'priceAndPalletKeepStatus': True,
                   'migrationAppliedByThisRelease': (RELEASE / 'migration-result.json').exists()})
    parent.save('result.json', result)
    print(json.dumps({'salesCaseEditsDeployed': True, 'at': result['at']}), flush=True)


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
    assert not any(active.values()), 'Wait for active operations: ' + json.dumps(active)
    applied = False
    if parent.database("SELECT count(*) FROM schema_migrations WHERE filename='" + MIGRATION + "'") == '0':
        previous_function = parent.database("SELECT pg_get_functiondef('preserve_special_original_price()'::regprocedure)")
        (RELEASE / 'migration.rollback.sql').write_text(previous_function + '\n')
        parent.database("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';\n" +
                        (RELEASE / 'candidate/migrations' / MIGRATION).read_text() +
                        "\nINSERT INTO schema_migrations(filename) VALUES('" + MIGRATION + "'); COMMIT;")
        applied = True
        parent.save('migration-result.json', {'applied': MIGRATION, 'transactional': True,
                                              'changesExistingRows': False, 'previousFunctionSaved': True})
    try:
        release.apply()
    except Exception:
        if applied:
            parent.database("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';\n" +
                            (RELEASE / 'migration.rollback.sql').read_text() +
                            "\nDELETE FROM schema_migrations WHERE filename='" + MIGRATION + "'; COMMIT;")
            parent.save('migration-rollback-result.json', {'restoredPreviousPriceRule': True,
                                                          'dataChanged': False})
        raise


parent.validate_candidate = validate_candidate
release.verify = verify
if __name__ == '__main__':
    {'capture': capture, 'stage': stage, 'prepare': parent.prepare, 'apply': apply, 'verify': verify}[sys.argv[1]]()
