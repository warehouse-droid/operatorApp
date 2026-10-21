"""Capture and publish the tested scoped Dispatch source decision overlay."""
import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
RELEASE = SERVER / 'deployments/dispatch-source-decision-20261007'
spec = importlib.util.spec_from_file_location('release_helpers', SERVER / 'tools/delivery-scm-release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.RELEASE = RELEASE
release.IMAGE = 'mbbs-operator-app:dispatch-source-decision-20261007'
release.ROLLBACK = release.IMAGE + '-rollback'
release.READ_NAME = 'mbbs-source-decision-baseline-reader'
release.CHECK_NAME = 'mbbs-source-decision-image-check'
MIGRATION = '271_dispatch_source_decisions.sql'
FILES = ['src/dispatch-executed-order-review.js', 'src/dispatch-executed-order-review-repository.js',
    'src/server.js', 'public/dispatch.js', 'migrations/' + MIGRATION]


def capture():
    RELEASE.mkdir(parents=True, exist_ok=False)
    app = release.metadata(release.APP)
    dependencies = [release.metadata(name) for name in release.DEPENDENCIES]
    before = RELEASE / 'before'
    before.mkdir()
    archive = release.docker('exec', release.APP, 'tar', '-cf', '-', '-C', '/app',
        'src', 'public', 'migrations', 'package.json', 'package-lock.json')
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        stream.extractall(before, filter='data')
    for path in before.rglob('*'):
        path.chmod(path.stat().st_mode | (0o055 if path.is_dir() else 0o044))
    assert release.metadata(release.APP) == app, 'Live application changed during capture'
    shutil.copytree(before, RELEASE / 'candidate')
    workspace = RELEASE / 'workspace-before'
    workspace.mkdir()
    for name in FILES:
        if (SERVER / name).exists():
            target = workspace / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(SERVER / name, target)
    release.save('capture.json', {'app': app, 'dependencies': dependencies,
        'beforeTree': release.files_at(before), 'capturedAt': release.now()})
    print(json.dumps({'captured': True, 'imageId': app['imageId']}))


def stage():
    data = json.loads((RELEASE / 'capture.json').read_text())
    assert release.metadata(release.APP) == data['app'], 'Live application changed; recapture required'
    before, candidate = RELEASE / 'before', RELEASE / 'candidate'
    for name in FILES:
        target = candidate / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SERVER / name, target)
    tree = release.files_at(candidate)
    changed = sorted(n for n in data['beforeTree'].keys() | tree.keys()
        if data['beforeTree'].get(n) != tree.get(n))
    assert changed == sorted(FILES), 'Unexpected runtime scope'
    manifest = {**data, 'files': FILES, 'candidateTree': tree,
        'candidateTreeHash': release.sha(json.dumps(tree, sort_keys=True).encode()),
        'workspace': {n: release.sha((SERVER / n).read_bytes()) for n in FILES},
        'packages': {n: release.sha((candidate / n).read_bytes()) for n in ['package.json', 'package-lock.json']}}
    release.save('manifest.json', manifest)
    release.current(manifest)
    print(json.dumps({'staged': True, 'files': FILES, 'candidateTreeHash': manifest['candidateTreeHash']}))


def apply():
    data = release.state()
    release.current(data)
    check = json.loads((RELEASE / 'image-check.json').read_text())
    assert check['passed'] and check['imageId'] == data['candidateImageId']
    release.config_check(data)
    release.assert_no_active_operations(release.preflight())
    # The additive schema is compatible with the previous app image.
    applied = json.loads(release.sql("SELECT coalesce(json_agg(filename ORDER BY filename),'[]'::json) FROM schema_migrations;"))
    release.save('migrations-before.json', applied)
    if MIGRATION not in applied:
        sql = (RELEASE / 'candidate/migrations' / MIGRATION).read_text()
        migration = "BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';\n" + sql
        migration += "\nINSERT INTO schema_migrations(filename) VALUES ('" + MIGRATION + "'); COMMIT;"
        (RELEASE / 'migration.log').write_text(release.sql(migration))
    release.current(data)
    release.assert_no_active_operations(release.preflight())
    release.save('edit-leases-before.json', release.edit_lease_identities())
    args = ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app']
    try:
        with (RELEASE / 'cutover.log').open('wb') as output:
            subprocess.run(release.compose(data, 'release') + args, cwd=ROOT,
                stdout=output, stderr=subprocess.STDOUT, check=True, timeout=60)
        release.ready(data['candidateImageId'])
        assert release.metadata(release.APP)['configuration'] == data['app']['configuration']
        assert [release.metadata(n) for n in release.DEPENDENCIES] == data['dependencies']
        assert json.loads(release.docker('exec', release.APP, 'node', '-e', release.HASH_SCRIPT)) == data['candidateTree']
        release.save('edit-leases-after.json', release.edit_lease_identities())
        release.save('deployment-result.json', {'deployed': True, 'at': release.now(),
            'imageId': data['candidateImageId'], 'changedFiles': FILES,
            'configurationPreserved': True, 'dependentContainersUnchanged': True})
        print(json.dumps({'deployed': True, 'imageId': data['candidateImageId']}))
    except BaseException:
        with (RELEASE / 'rollback.log').open('wb') as output:
            subprocess.run(release.compose(data, 'rollback') + args, cwd=ROOT,
                stdout=output, stderr=subprocess.STDOUT, check=True, timeout=60)
        release.ready(data['app']['imageId'])
        raise


def verify():
    data = release.state()
    release.ready(data['candidateImageId'])
    live = release.metadata(release.APP)
    assert live['imageId'] == data['candidateImageId']
    assert live['configuration'] == data['app']['configuration']
    assert [release.metadata(n) for n in release.DEPENDENCIES] == data['dependencies']
    assert json.loads(release.docker('exec', release.APP, 'node', '-e', release.HASH_SCRIPT)) == data['candidateTree']
    schema = json.loads(release.sql("""BEGIN READ ONLY; SET LOCAL statement_timeout='5s';
SELECT json_build_object(
  'migrationCount',(SELECT count(*) FROM schema_migrations WHERE filename='271_dispatch_source_decisions.sql'),
  'planRevision',(SELECT revision FROM dispatch_plans WHERE id=349),
  'acceptedReviews',(SELECT count(*) FROM dispatch_executed_order_reviews
    WHERE plan_id=349 AND order_ref='SOA09704' AND decision='accept_netsuite_change'),
  'acknowledgementPending',(SELECT count(*) FROM dispatch_executed_order_reviews
    WHERE plan_id=349 AND order_ref='SOA09704' AND decision='accept_netsuite_change' AND acknowledged_at IS NULL),
  'acceptanceAuditCount',(SELECT count(*) FROM dispatch_audit_log
    WHERE plan_id=349 AND order_id='SOA09704' AND action='dispatch_source_change_auto_accepted'));
COMMIT;"""))
    assert schema['migrationCount'] == 1
    assert schema['acceptedReviews'] >= 1 and schema['acceptanceAuditCount'] >= 1
    checked = release.http_check({'public/dispatch.js': data['workspace']['public/dispatch.js']},
        ['/api/dispatch/plans/349/executed-order-reviews'])
    release.save('live-verification.json', {'verified': True, 'at': release.now(),
        'imageId': live['imageId'], 'candidateTreeHash': data['candidateTreeHash'],
        'runtimeFilesVerified': len(data['candidateTree']), 'configurationPreserved': True,
        'dependentContainersUnchanged': True, 'schema': schema, 'http': checked})
    print(json.dumps({'verified': True, 'schema': schema, 'http': checked}))


def rollback():
    data = release.state()
    assert release.metadata(release.APP)['imageId'] == data['candidateImageId'], 'A later release must not be overwritten'
    assert json.loads(release.docker('exec', release.APP, 'node', '-e', release.HASH_SCRIPT)) == data['candidateTree']
    assert [release.metadata(n) for n in release.DEPENDENCIES] == data['dependencies']
    release.assert_no_active_operations(release.preflight())
    with (RELEASE / 'rollback.log').open('wb') as output:
        subprocess.run(release.compose(data, 'rollback') + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'],
            cwd=ROOT, stdout=output, stderr=subprocess.STDOUT, check=True, timeout=60)
    release.ready(data['app']['imageId'])
    assert release.metadata(release.APP)['configuration'] == data['app']['configuration']
    assert [release.metadata(n) for n in release.DEPENDENCIES] == data['dependencies']
    release.save('rollback-result.json', {'rolledBack': True, 'at': release.now(),
        'imageId': data['app']['imageId'], 'schemaAndOperationalAuditPreserved': True})
    print(json.dumps({'rolledBack': True, 'imageId': data['app']['imageId']}))


if __name__ == '__main__':
    action = sys.argv[1]
    if action in {'capture', 'stage', 'apply', 'verify', 'rollback'}:
        globals()[action]()
    elif action == 'build':
        release.build()
    else:
        raise SystemExit('Unsupported release action')
