"""Capture and deploy a scoped Special Order overlay; reuse the established image checks."""
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
r.RELEASE = SERVER / 'deployments/special-vendor-confirmation-20261016'
r.IMAGE = 'mbbs-operator-app:special-vendor-confirmation-20261016'
r.ROLLBACK = r.IMAGE + '-rollback'
MIGRATION = '296_special_vendor_confirmation.sql'
r.READ_NAME = 'mbbs-special-vendor-reader'
r.CHECK_NAME = 'mbbs-special-vendor-image-check'
FILES = ['public/backorder-stock-requests.js', 'public/special-stock-workflow.js', 'public/scm-special-stock-requests.js', 'src/special-stock-request-repository.js', 'src/server.js', 'migrations/296_special_vendor_confirmation.sql']
TESTS = ['test/mbt/unit/special-customer-confirmation.test.js', 'test/mbt/unit/special-po-dispatch-stage.test.js', 'test/mbt/integration/special-customer-confirmation.test.js', 'test/mbt/integration/special-po-dispatch-stage.test.js']


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
        if (SERVER / name).exists(): shutil.copy2(SERVER / name, target)
    r.save('capture.json', {'app': app, 'dependencies': dependencies})
    print(json.dumps({'captured': True, 'workspaceDifferences': [n for n in FILES if (baseline / n).exists() and (baseline / n).read_bytes() != (SERVER / n).read_bytes()]}))


def prepare():
    captured = json.loads((r.RELEASE / 'capture.json').read_text())
    candidate = r.RELEASE / 'candidate'
    if candidate.exists():
        shutil.rmtree(candidate)
    shutil.copytree(r.RELEASE / 'before', candidate)
    patch = ''.join(''.join(difflib.unified_diff(((r.RELEASE / 'workspace-before' / n).read_text() if (r.RELEASE / 'workspace-before' / n).exists() else '').splitlines(True),
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
        old = ((r.RELEASE / 'before' / name).read_text() if (r.RELEASE / 'before' / name).exists() else '').splitlines()
        new = (candidate / name).read_text().splitlines()
        lines[name] = [i+1 for tag, _a, _b, start, end in difflib.SequenceMatcher(a=old, b=new).get_opcodes()
            if tag in ('replace', 'insert') for i in range(start, end)
            if new[i].strip() and not new[i].strip().startswith(('//', '/*', '*'))]
    # Repeated res.json/catch/closure lines otherwise align with the preceding skip
    # route. Verify that route is byte-for-byte unchanged, then measure the actual
    # inserted handler rather than attributing its old neighbor's closing lines.
    name = 'src/server.js'
    before_text = (r.RELEASE / 'before' / name).read_text()
    after_text = (candidate / name).read_text()
    skip = "app.post('/api/scm/special-stock-requests/:id/purchase-order/skip'"
    link = 'app.post("/api/scm/special-stock-requests/:id/purchase-order/link"'
    sent = "app.post('/api/scm/special-stock-requests/:id/purchase-order/sent-to-vendor'"
    assert before_text[before_text.index(skip):before_text.index(link)].strip() == after_text[after_text.index(skip):after_text.index(sent)].strip()
    first = after_text[:after_text.index(sent)].count('\n') + 1
    last = after_text[:after_text.index('\n});', after_text.index(sent))].count('\n') + 2
    imported = after_text[:after_text.index('  markSpecialPurchaseOrderSentToVendor,')].count('\n') + 1
    aligned = [imported, *range(first, last + 1)]
    r.save('coverage-line-alignment.json', {'file': name, 'textDiffLines': lines[name], 'actualAddedHandlerLines': aligned,
        'precedingSkipRouteUnchanged': True, 'reason': 'Repeated route closing statements align with the unchanged previous handler in a text-only diff.'})
    lines[name] = aligned
    r.save('changed-lines.json', lines)
    r.current(r.state())
    print(json.dumps({'prepared': True, 'files': changed}))


def validated():
    evidence = SERVER / 'test-artifacts/special-vendor-confirmation-20261016/final'
    report = json.loads((evidence / 'report.json').read_text())
    assert report['passed'] and report['coverage']['uncovered'] == []
    mutations = json.loads((evidence / 'mutations.json').read_text())
    assert len(mutations) == 5 and all(item['killed'] for item in mutations)
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
        url = 'http://127.0.0.1:3000/' + name.removeprefix('public/') + '?vendorConfirmation=20261016'
        with urllib.request.urlopen(url, timeout=10) as response:
            assert response.status == 200
            assert r.sha(response.read()) == data['candidateTree'][name]
        probes[name] = 200
    schema = json.loads(r.sql("SELECT json_build_object('migration',(SELECT count(*) FROM schema_migrations WHERE filename='296_special_vendor_confirmation.sql'),'columns',(SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='sales_special_stock_cases' AND column_name IN ('purchase_order_sent_to_vendor_at','purchase_order_sent_to_vendor_by')),'stageView',position('waiting_vendor_confirmation' in pg_get_viewdef('special_stock_workflow_stages'::regclass))>0);"))
    assert schema == {'migration': 1, 'columns': 2, 'stageView': True}
    public = {name: data['candidateTree'][name] for name in FILES if name.startswith('public/')}
    http = r.http_check(public, ['/api/sales/special-stock-requests', '/api/scm/special-stock-requests'])
    result = {'deployed': True, 'at': r.now(), 'image': r.IMAGE, 'imageId': live['imageId'], 'files': FILES,
        'candidateTreeHash': data['candidateTreeHash'], 'configurationPreserved': True,
        'dependenciesPreserved': True, 'productionHealthy': True, 'publicAssets': probes,
        'databaseMigration': MIGRATION, 'schema': schema, 'http': http}
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
    assert r.sql("SELECT count(*) FROM schema_migrations WHERE filename='296_special_vendor_confirmation.sql';") == '0', 'Migration already applied; review state before deployment'
    prior_view = r.sql("SELECT pg_get_viewdef('special_stock_workflow_stages'::regclass, true);")
    rollback_sql = "BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';\nCREATE OR REPLACE VIEW special_stock_workflow_stages AS\n" + prior_view.rstrip(';') + ";\nDELETE FROM schema_migrations WHERE filename='296_special_vendor_confirmation.sql';\nCOMMIT;\n"
    (r.RELEASE / 'rollback-schema.sql').write_text(rollback_sql)
    migration_sql = "BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';\n" + (r.RELEASE / 'candidate/migrations' / MIGRATION).read_text() + "\nINSERT INTO schema_migrations(filename) VALUES ('296_special_vendor_confirmation.sql');\nCOMMIT;\n"
    # Additive nullable columns and the projected view are compatible with the old image.
    # Preserve columns and acknowledgement/audit data even if the application is rolled back.
    (r.RELEASE / 'apply-schema.log').write_text(r.sql(migration_sql))
    r.save('migration-applied.json', {'at': r.now(), 'migration': MIGRATION})
    try:
        with (r.RELEASE / 'apply.log').open('wb') as log:
            subprocess.run(r.compose(data, 'release') + args, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except BaseException:
        with (r.RELEASE / 'rollback.log').open('wb') as log:
            subprocess.run(r.compose(data, 'rollback') + args, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        r.ready(data['app']['imageId'])
        (r.RELEASE / 'rollback-schema.log').write_text(r.sql(rollback_sql))
        r.save('deployment-result.json', {'deployed': False, 'rolledBack': True, 'at': r.now(), 'acknowledgementDataPreserved': True})
        raise


if __name__ == '__main__':
    if sys.argv[1] == 'build':
        atexit.register(r.cleanup_manual)
    {'capture': capture, 'prepare': prepare, 'validated': validated, 'build': r.build, 'apply': apply, 'verify': verify}[sys.argv[1]]()
