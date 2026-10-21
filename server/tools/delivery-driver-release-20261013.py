"""Deploy the authorized delivery enhancement and prepared Driver PWA together."""
import datetime
import difflib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / 'server'
RELEASE = SERVER / 'deployments/delivery-driver-20261013'
OUT = SERVER / 'test-artifacts/delivery-driver-release-20261013'
DRIVER = ['public/driver.js', 'public/driver.html', 'public/driver.css', 'public/driver-service-worker.js',
          'public/driver-upload.js', 'src/driver-client-version.js', 'src/driver-upload-failure.js',
          'src/driver-upload-failure-repository.js', 'src/server.js', 'migrations/282_driver_upload_failure_audit.sql']
spec = importlib.util.spec_from_file_location('combined_delivery', SERVER / 'tools/delivery-request-enhancements-deploy.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
DELIVERY = list(base.FILES)
FILES = DELIVERY + DRIVER
base.RELEASE = RELEASE
base.IMAGE = 'mbbs-operator-app:delivery-driver-20261013'
base.FILES = FILES
base.release.RELEASE = RELEASE
docker, digest, metadata = base.docker, base.digest, base.metadata
APP = base.APP


def load():
    return json.loads((RELEASE / 'manifest.json').read_text())


def save(name, value):
    (RELEASE / name).write_text(json.dumps(value, indent=2) + '\n')


def driver_fragments():
    source = (SERVER / 'src/server.js').read_text()
    begin = source.index('app.post("/api/driver/upload-failures",')
    end = source.index('app.post("/api/driver/sync-status",', begin)
    parser = 'app.use("/api/driver/upload-failures", express.json({ limit: "16kb" }));\n'
    assert source.count(parser) == 1
    return 'import { recordDriverUploadFailure } from "./driver-upload-failure-repository.js";\n', source[begin:end], parser


def current(data):
    assert metadata(APP) == data['services']['app']['before'], 'Live release changed; rebase the combined release'
    assert {name: metadata(name) for name in base.DEPENDENCIES} == data['dependencies'], 'A dependency changed'
    assert json.loads(docker('exec', APP, 'node', '-e', base.HASH_SCRIPT)) == data['beforeTree'], 'Live source changed'
    for name, expected in data['inputHashes'].items():
        assert digest((SERVER / name).read_bytes()) == expected, 'Release input changed: ' + name
    assert [digest(value.encode()) for value in driver_fragments()] == data['driverFragmentHashes'], 'Driver API changed'
    for name, expected in data['sourceHashes'].items():
        assert digest((RELEASE / 'stage' / name).read_bytes()) == expected, 'Staged source changed: ' + name


base.current = current


def prepare():
    os.umask(0o077)
    before = metadata(APP)
    tree = json.loads(docker('exec', APP, 'node', '-e', base.HASH_SCRIPT))
    delivery_evidence = json.loads((base.OUT / 'candidate-final/results/evidence.json').read_text())
    assert all(row['exitCode'] == 0 for row in delivery_evidence['layers'])
    driver_evidence = json.loads((SERVER / 'test-artifacts/driver-upload-reliability/final-evidence.json').read_text())
    assert driver_evidence['unit']['fail'] == 0 and driver_evidence['http']['fail'] == 0
    driver_baseline = json.loads((SERVER / 'test-artifacts/driver-upload-reliability/baseline/source-hashes.json').read_text())
    for name in DELIVERY:
        original = base.OUT / 'live-before' / name
        if original.exists():
            assert tree[name] == digest(original.read_bytes()), 'Overlapping delivery change: ' + name
        else:
            assert name not in tree, 'Unexpected existing delivery module: ' + name
    for name in DRIVER:
        if name not in ['src/server.js', 'public/driver-service-worker.js', 'migrations/282_driver_upload_failure_audit.sql']:
            expected = driver_evidence['source']['implementationFiles'][name]
            assert digest((SERVER / name).read_bytes()) == expected, 'Prepared Driver implementation drift: ' + name
        if name in driver_baseline and name not in ['src/server.js', 'public/driver-service-worker.js']:
            assert tree[name] == driver_baseline[name], 'Overlapping Driver runtime change: ' + name
    RELEASE.mkdir(exist_ok=False)
    OUT.mkdir(parents=True, exist_ok=True)
    stage = RELEASE / 'stage'
    originals = RELEASE / 'before'
    input_hashes = {}
    patch = ''
    for name in FILES:
        target = stage / name
        target.parent.mkdir(parents=True, exist_ok=True)
        old = ''
        if name in tree:
            original = originals / name
            original.parent.mkdir(parents=True, exist_ok=True)
            docker('cp', APP + ':/app/' + name, str(original))
            assert digest(original.read_bytes()) == tree[name]
            old = original.read_text()
        if name == 'src/server.js':
            added_import, route, parser = driver_fragments()
            import_anchor = 'import { listDispatchAudit, writeDispatchAudit } from "./dispatch-audit-repository.js";\n'
            route_anchor = 'app.post("/api/driver/sync-status",'
            assert old.count(import_anchor) == 1 and old.count(route_anchor) == 1
            assert 'recordDriverUploadFailure' not in old
            content = old.replace(import_anchor, import_anchor + added_import).replace(route_anchor, route + route_anchor)
            assert content.count('app.use(express.json({') == 1
            content = content.replace('app.use(express.json({', parser + 'app.use(express.json({')
        elif name == 'public/driver-service-worker.js':
            content = old
            replacements = [('${DRIVER_CACHE_PREFIX}v44', '${DRIVER_CACHE_PREFIX}v45'),
                            ('${DRIVER_CACHE_PREFIX}refresh-v44', '${DRIVER_CACHE_PREFIX}refresh-v45'),
                            ('/driver.css?v=20260910-route-prefix-cursor-v1', '/driver.css?v=20261013-driver-upload-v1'),
                            ('/driver.js?v=20260924-driver-workflow-v1', '/driver.js?v=20261013-driver-upload-v1')]
            for previous, replacement in replacements:
                assert content.count(previous) == 1, 'Unexpected Driver shell anchor: ' + previous
                content = content.replace(previous, replacement)
            anchor = '  "/driver-offline-sync.js?v=20260910-route-prefix-cursor-v1",\n'
            assert content.count(anchor) == 1
            content = content.replace(anchor, anchor + '  "/driver-upload.js?v=20261013-driver-upload-v1",\n')
            assert content == (SERVER / name).read_text(), 'Driver worker merge needs review'
            input_hashes[name] = digest((SERVER / name).read_bytes())
        else:
            content = (SERVER / name).read_text()
            input_hashes[name] = digest(content.encode())
        target.write_text(content)
        patch += ''.join(difflib.unified_diff(old.splitlines(True), content.splitlines(True), fromfile='a/' + name, tofile='b/' + name))
    source = {name: digest((stage / name).read_bytes()) for name in FILES}
    for name, value in delivery_evidence['sourceHashes'].items():
        assert source[name] == value
    data = {'services': {'app': {'before': before, 'image': base.IMAGE}},
            'dependencies': {name: metadata(name) for name in base.DEPENDENCIES}, 'beforeTree': tree,
            'sourceHashes': source, 'inputHashes': input_hashes,
            'driverFragmentHashes': [digest(value.encode()) for value in driver_fragments()]}
    (RELEASE / 'runtime.patch').write_text(patch)
    current(data)
    assert docker('image', 'inspect', '--format', '{{.Id}}', before['image']).decode().strip() == before['imageId']
    (stage / 'Dockerfile').write_text('FROM ' + before['image'] + '\n' + ''.join('COPY --chown=node:node ' + name + ' /app/' + name + '\n' for name in FILES))
    with (RELEASE / 'build.log').open('wb') as log:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--network', 'none', '--pull=false', '-t', base.IMAGE, str(stage)], stdout=log, stderr=subprocess.STDOUT, check=True)
    data['services']['app']['candidateImageId'] = docker('image', 'inspect', '--format', '{{.Id}}', base.IMAGE).decode().strip()
    base.import_check(base.IMAGE)
    assert json.loads((RELEASE / 'candidate-tree.json').read_text()) == {**tree, **source}, 'Unrelated source changed'
    (RELEASE / 'compose.release.yml').write_text('services:\n  app:\n    image: ' + base.IMAGE + '\n')
    (RELEASE / 'compose.rollback.yml').write_text('services:\n  app:\n    image: ' + before['imageId'] + '\n')
    base.release.config_check(data)
    current(data)
    save('manifest.json', data)
    print(json.dumps({'prepared': True, 'runtimeFiles': len(FILES), 'driverCache': 'v45', 'otherSourcePreserved': True}), flush=True)


def migration():
    sql = (RELEASE / 'stage/migrations/282_driver_upload_failure_audit.sql').read_text()
    concurrent = sql.replace('CREATE UNIQUE INDEX IF NOT EXISTS', 'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS')
    assert concurrent != sql
    with (RELEASE / 'migration.log').open('wb') as log:
        subprocess.run(['sudo', '-n', 'docker', 'exec', '-i', 'mbbs-operator-app-db-1', 'psql', '-U', 'mbbs_app', '-d', 'mbbs_yard', '-v', 'ON_ERROR_STOP=1'],
                       input=("SET lock_timeout='5s'; SET statement_timeout='180s';\n" + concurrent).encode(), stdout=log, stderr=subprocess.STDOUT, check=True)
    checked = base.release.database("SELECT indisvalid AND indisunique FROM pg_index WHERE indexrelid=to_regclass('public.driver_upload_failure_audit_identity');").strip()
    assert checked == 't', 'Driver diagnostic index is invalid'
    base.release.database("INSERT INTO schema_migrations(filename) VALUES('282_driver_upload_failure_audit.sql') ON CONFLICT(filename) DO NOTHING;")
    save('migration-result.json', {'applied': True, 'concurrent': True, 'valid': True, 'operationalAuditPreserved': True})


def restage():
    data = load()
    # The only correction is the already tested Driver diagnostic JSON limit.
    assert metadata(APP) == data['services']['app']['before']
    assert {name: metadata(name) for name in base.DEPENDENCIES} == data['dependencies']
    assert json.loads(docker('exec', APP, 'node', '-e', base.HASH_SCRIPT)) == data['beforeTree']
    target = RELEASE / 'stage/src/server.js'
    parser = driver_fragments()[2]
    text = target.read_text()
    assert parser not in text and text.count('app.use(express.json({') == 1
    target.write_text(text.replace('app.use(express.json({', parser + 'app.use(express.json({'))
    save('manifest-before-diagnostic-limit.json', data)
    data['sourceHashes']['src/server.js'] = digest(target.read_bytes())
    data['driverFragmentHashes'] = [digest(value.encode()) for value in driver_fragments()]
    current(data)
    with (RELEASE / 'rebuild.log').open('wb') as log:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--network', 'none', '--pull=false', '-t', base.IMAGE, str(RELEASE / 'stage')], stdout=log, stderr=subprocess.STDOUT, check=True)
    data['services']['app']['candidateImageId'] = docker('image', 'inspect', '--format', '{{.Id}}', base.IMAGE).decode().strip()
    base.import_check(base.IMAGE)
    assert json.loads((RELEASE / 'candidate-tree.json').read_text()) == {**data['beforeTree'], **data['sourceHashes']}
    current(data)
    save('manifest.json', data)
    previous = RELEASE / 'candidate-source'
    previous.rename(RELEASE / 'candidate-source-before-diagnostic-limit')
    base.capture_candidate()
    original = (RELEASE / 'before/src/server.js').read_text()
    with (RELEASE / 'runtime.patch').open('a') as patch:
        patch.write(''.join(difflib.unified_diff(original.splitlines(True), target.read_text().splitlines(True), fromfile='a/src/server.js', tofile='b/src/server.js')))
    print(json.dumps({'rebuilt': True, 'diagnosticBodyLimit': '16kb'}), flush=True)


def verify():
    base.verify()
    script = """import assert from 'node:assert/strict';
for(const origin of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']){
  const html=await (await fetch(origin+'/driver')).text();assert.match(html,/driver-upload.js\\?v=20261013-driver-upload-v1/);
  const worker=await fetch(origin+'/driver-service-worker.js');assert.equal(worker.status,200);const source=await worker.text();assert.match(source,/DRIVER_CACHE_PREFIX}v45/);
  const version=await fetch(origin+'/api/driver/client-version');assert.equal(version.status,200);
  const denied=await fetch(origin+'/api/driver/upload-failures',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(denied.status,401);
}
console.log(JSON.stringify({driverCache:'v45',driverPublicAssetsVerified:true,anonymousDiagnosticDenied:true}));"""
    result = json.loads(docker('exec', '-i', APP, 'node', '--input-type=module', input=script.encode()))
    assert base.release.database("SELECT indisvalid FROM pg_index WHERE indexrelid=to_regclass('public.driver_upload_failure_audit_identity');").strip() == 't'
    data = json.loads((RELEASE / 'result.json').read_text())
    data.update(result)
    data['schemaChanged'] = True
    data['driverDiagnosticIndexConcurrent'] = True
    save('result.json', data)
    print(json.dumps(result), flush=True)


def apply():
    data = load()
    for name in ['delivery', 'driver']:
        root = OUT / name
        assert (root / 'teardown.log').read_text().endswith('teardown_exit=0\n'), 'Test teardown failed: ' + name
    checks = json.loads((OUT / 'delivery/results/evidence.json').read_text())
    assert all(row['exitCode'] == 0 for row in checks['layers']) and checks['coverage']['covered'] == checks['coverage']['total']
    driver = json.loads((OUT / 'driver/results/driver-checks.json').read_text())
    assert all(row['exitCode'] == 0 for row in driver['layers']), 'Driver checks failed'
    for file, value in driver['sourceHashes'].items():
        assert value == data['sourceHashes'][file], 'Driver tested source changed: ' + file
    current(data)
    base.release.config_check(data)
    active = json.loads(base.release.database("""BEGIN READ ONLY;
SELECT json_build_object(
 'operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),
 'driverExecuting',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing'),
 'specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'),
 'stockTransferConfirming',(SELECT count(*) FROM sales_stock_transfers WHERE confirmation_status IN ('creating','approving','hydrating','printing')),
 'regularExecuting',(SELECT count(*) FROM regular_stock_handoffs WHERE status='executing'),
 'deliveryOperations',(SELECT count(*) FROM regular_stock_delivery_operations WHERE status IN ('queued','running')),
 'scmExecuting',(SELECT count(*) FROM scm_smart_proposals WHERE status='executing'));
ROLLBACK;""").removeprefix('BEGIN\n').removesuffix('\nROLLBACK'))
    save('active-before-release.json', active)
    assert not any(active.values()), 'Wait for active operations: ' + json.dumps(active)
    migration()
    current(data)
    try:
        with (RELEASE / 'publish.log').open('wb') as log:
            subprocess.run(base.release.compose(data) + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except Exception:
        with (RELEASE / 'rollback.log').open('wb') as log:
            subprocess.run(base.release.compose(data, 'compose.rollback.yml') + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        base.release.core.ready(data['services']['app']['before']['imageId'])
        save('rollback-result.json', {'rolledBack': True, 'auditIndexRetained': True})
        raise


if __name__ == '__main__':
    {'prepare': prepare, 'capture': base.capture_candidate, 'restage': restage, 'apply': apply, 'verify': verify, 'documents': base.live_documents}[sys.argv[1]]()
