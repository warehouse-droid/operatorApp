"""Release only the verified Dispatch recency delta over the captured live image.

The candidate and verified.json are supplied by the isolated regression checks.
Only six server modules and the reviewed additive first-seen migration are copied.
"""
import datetime
import difflib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import urllib.request

sys.dont_write_bytecode = True
SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
OUT = SERVER / 'test-artifacts/dispatch-recent-cards'
RELEASE = SERVER / 'deployments/dispatch-recent-cards-20260930'
APP = 'mbbs-operator-app-app-1'
DEPENDENCIES = ['mbbs-operator-app-db-1', 'mbbs-operator-app-ollama-1', 'mbbs-operator-app-webhook-worker-1']
FILES = ['src/dispatch-repository.js', 'src/dispatch-order-recency.js',
         'src/dispatch-order-catalog-repository.js', 'src/dispatch-planner-optimization.js',
         'src/dispatch-delivery-group-repository.js', 'src/server.js']
MIGRATION = '242_dispatch_order_first_seen.sql'
MIGRATION_PATH = 'migrations/' + MIGRATION
FILES.append(MIGRATION_PATH)
BASE_RUNTIME_FILES, CANDIDATE_RUNTIME_FILES = 1148, 1150
PACKAGES = ['package.json', 'package-lock.json']
IMAGE = 'mbbs-operator-app:dispatch-recent-cards-20260930'
BASE_IMAGE_ID = 'sha256:857cfc206725bdff672b9445ced773848f0cad4823c7d95397f8fe04c8e1b726'
spec = importlib.util.spec_from_file_location('recent_cards_regular_release', SERVER / 'tools/regular-stock-v2-deploy.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.RELEASE, release.CONTAINERS, release.DEPENDENCIES = RELEASE, {'app': APP}, DEPENDENCIES
docker, digest, metadata = release.docker, release.digest, release.metadata

HASH_SCRIPT = """const fs=require('node:fs'),crypto=require('node:crypto'),hashes={};
function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const path=dir+'/'+entry.name;
if(entry.isDirectory())walk(path);else if(entry.isFile())hashes[path]=crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex');}}
for(const dir of ['src','public','migrations'])walk(dir);console.log(JSON.stringify(hashes));"""

BUSINESS_HASH_SQL = "SELECT jsonb_object_agg(table_name, jsonb_build_object('rows',row_count,'md5',row_hash)) AS hashes FROM (" + " UNION ALL ".join(
    "SELECT '" + table + "'::text AS table_name,count(*) AS row_count,"
    "md5(COALESCE(string_agg(md5((to_jsonb(item)" + ("-'first_seen_at'" if table in ['sales_orders', 'purchase_orders', 'transfer_orders'] else "")
    + ")::text),'' ORDER BY " + keys + "),'')) AS row_hash FROM " + table + " item"
    for table, keys in [
        ('sales_orders', 'netsuite_id'), ('purchase_orders', 'netsuite_id'), ('transfer_orders', 'netsuite_id'),
        ('sales_order_lines', 'id'), ('purchase_order_lines', 'id'), ('transfer_order_lines', 'line_stage,id'),
        ('dispatch_plans', 'id'), ('dispatch_plan_snapshots', 'plan_id'), ('dispatch_plan_load_assignments', 'id'),
        ('dispatch_order_completion_events', 'id'), ('sor_return_reconcile_queue', 'source_ref')]
) + ") business_hashes"


def save(name, value):
    RELEASE.mkdir(parents=True, exist_ok=True)
    (RELEASE / name).write_text(json.dumps(value, indent=2) + '\n')


def state():
    return json.loads((RELEASE / 'manifest.json').read_text())


def candidate_scope():
    baseline, candidate = OUT / 'production-before', OUT / 'candidate'
    before, after = release.core.files_at(baseline), release.core.files_at(candidate)
    changed = sorted(file for file in set(before) | set(after) if before.get(file) != after.get(file))
    assert changed == sorted(FILES), 'Unexpected candidate scope: ' + json.dumps(changed)
    assert len(before) == BASE_RUNTIME_FILES and len(after) == CANDIDATE_RUNTIME_FILES, 'Unexpected complete runtime file count'
    hashes = {file: after[file] for file in FILES}
    expected = {**before, **hashes}
    assert after == expected, 'Candidate changed unrelated runtime bytes'
    package_hashes = {file: digest((baseline / file).read_bytes()) for file in PACKAGES}
    assert all(digest((candidate / file).read_bytes()) == sha for file, sha in package_hashes.items()), 'Candidate changed a package file'
    return before, after, hashes, package_hashes


def verified(data):
    checks = json.loads((RELEASE / 'verified.json').read_text())
    assert checks.get('passed') is True and checks.get('sourceHashes') == data['sourceHashes'], 'Verification is stale'
    return checks


def current(data):
    before, after, hashes, package_hashes = candidate_scope()
    assert before == data['baselineRuntime'], 'Captured baseline source changed'
    assert after == data['candidateRuntime'] and hashes == data['sourceHashes'], 'Candidate source changed'
    assert package_hashes == data['packageHashes'], 'Captured package bytes changed'
    base = data['services']['app']['before']
    assert base['imageId'] == BASE_IMAGE_ID, 'Unexpected captured baseline image'
    assert metadata(APP) == base, 'App changed during verification'
    assert {name: metadata(name) for name in DEPENDENCIES} == data['dependencies'], 'Dependency changed'
    assert docker('image', 'inspect', '--format', '{{.Id}}', base['image']).decode().strip() == base['imageId'], 'Baseline tag changed'
    assert json.loads(docker('exec', APP, 'node', '-e', HASH_SCRIPT)) == data['baselineRuntime'], 'Live runtime differs from captured baseline'
    for file, sha in data['packageHashes'].items():
        assert digest(docker('exec', APP, 'cat', '/app/' + file)) == sha, 'Live package changed: ' + file


def candidate_patch():
    return ''.join(''.join(difflib.unified_diff(
        (OUT / 'production-before' / file).read_text().splitlines(True)
        if (OUT / 'production-before' / file).exists() else [],
        (OUT / 'candidate' / file).read_text().splitlines(True),
        fromfile='a/' + file, tofile='b/' + file)) for file in FILES)


def capture():
    """Register the existing production capture and task-only candidate."""
    os.umask(0o077)
    assert not (RELEASE / 'manifest.json').exists(), 'Capture already registered'
    captured = json.loads((OUT / 'baseline-metadata.json').read_text())
    assert set(captured['dependencies']) == set(DEPENDENCIES), 'Captured dependency scope differs'
    assert captured['app']['imageId'] == BASE_IMAGE_ID, 'Wrong production baseline image'
    before, after, hashes, packages = candidate_scope()
    data = {'services': {'app': {'before': captured['app'], 'image': IMAGE}},
            'dependencies': captured['dependencies'], 'baselineRuntime': before,
            'candidateRuntime': after, 'beforeHashes': {file: before.get(file) for file in FILES},
            'sourceHashes': hashes, 'packageHashes': packages, 'sourceFiles': FILES,
            'migration': {'filename': MIGRATION, 'sha256': hashes[MIGRATION_PATH]}}
    current(data)
    save('manifest.json', data)
    (RELEASE / 'release.patch').write_text(candidate_patch())
    print(json.dumps({'captured': True, 'runtimeFiles': len(after), 'changedFiles': FILES}), flush=True)


def refresh_candidate():
    """Register reviewed task-file edits over the same immutable live baseline."""
    data = state()
    before, after, hashes, packages = candidate_scope()
    assert before == data['baselineRuntime'], 'Captured baseline source changed'
    assert packages == data['packageHashes'], 'Captured package bytes changed'
    refreshed = {**data, 'candidateRuntime': after, 'sourceHashes': hashes,
                 'migration': {'filename': MIGRATION, 'sha256': hashes[MIGRATION_PATH]}}
    refreshed['services'] = {'app': {**data['services']['app']}}
    refreshed['services']['app'].pop('candidateImageId', None)
    current(refreshed)
    save('manifest.json', refreshed)
    (RELEASE / 'release.patch').write_text(candidate_patch())
    print(json.dumps({'candidateRefreshed': True, 'runtimeFiles': len(after),
                      'sourceHashes': hashes, 'requiresFreshVerificationAndBuild': True}), flush=True)


def check():
    """Consume the root's completed isolated checks without rerunning suites."""
    data = state()
    current(data)
    verified(data)
    print(json.dumps({'verified': True, 'sourceHashes': data['sourceHashes']}), flush=True)


def stage():
    data = state()
    current(data)
    verified(data)
    directory = RELEASE / 'stage'
    if directory.exists():
        shutil.rmtree(directory)
    for file in FILES:
        target = directory / 'overlay' / file
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(OUT / 'candidate' / file, target)
    staged = {str(path.relative_to(directory / 'overlay')): digest(path.read_bytes())
              for path in (directory / 'overlay').rglob('*') if path.is_file()}
    assert staged == data['sourceHashes'], 'Staged bytes differ from verified candidate'
    base = data['services']['app']['before']
    # BuildKit resolves local tags; current() pins this tag to the captured ID.
    (directory / 'Dockerfile').write_text('FROM ' + base['image'] + '\nCOPY --chown=node:node overlay/ /app/\n')
    (RELEASE / 'compose.release.yml').write_text('services:\n  app:\n    image: ' + IMAGE + '\n')
    (RELEASE / 'compose.rollback.yml').write_text('services:\n  app:\n    image: ' + base['imageId'] + '\n')
    print(json.dumps({'staged': True, 'changedFiles': FILES, 'baselineImageId': base['imageId']}), flush=True)


def build():
    data = state()
    current(data)
    verified(data)
    directory = RELEASE / 'stage'
    staged = {str(path.relative_to(directory / 'overlay')): digest(path.read_bytes())
              for path in (directory / 'overlay').rglob('*') if path.is_file()}
    assert staged == data['sourceHashes'], 'Staged bytes differ from verified candidate'
    assert (directory / 'Dockerfile').read_text() == 'FROM ' + data['services']['app']['before']['image'] + '\nCOPY --chown=node:node overlay/ /app/\n', 'Dockerfile changed'
    with (RELEASE / 'build.log').open('wb') as log:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--network', 'none', '--pull=false', '-t', IMAGE, str(directory)],
                       stdout=log, stderr=subprocess.STDOUT, check=True)
    image_id = docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    assert json.loads(docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', image_id,
                            '-e', HASH_SCRIPT)) == data['candidateRuntime'], 'Built image has unexpected runtime content'
    for file in FILES:
        if file.endswith('.js'):
            docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', image_id, '--check', file)
    for file, sha in data['packageHashes'].items():
        assert digest(docker('run', '--rm', '--network', 'none', '--entrypoint', 'cat', image_id, '/app/' + file)) == sha, 'Built package changed: ' + file
    data['services']['app']['candidateImageId'] = image_id
    release.config_check(data)
    current(data)
    save('manifest.json', data)
    print(json.dumps({'prepared': True, 'image': IMAGE, 'imageId': image_id,
                      'verifiedRuntimeFiles': CANDIDATE_RUNTIME_FILES, 'migration': MIGRATION}), flush=True)


def prepare():
    stage()
    build()


def migration_status():
    assert release.database("SELECT count(*) FROM schema_migrations WHERE filename='" + MIGRATION + "';") == '1', 'First-seen migration is not recorded'
    columns = json.loads(release.database("""SELECT coalesce(json_agg(json_build_object(
      'table',table_name,'type',data_type,'nullable',is_nullable,'default',column_default)
      ORDER BY table_name),'[]'::json)
      FROM information_schema.columns WHERE table_schema='public'
        AND table_name IN ('sales_orders','purchase_orders','transfer_orders')
        AND column_name='first_seen_at'"""))
    assert len(columns) == 3 and all(row['type'] == 'timestamp with time zone'
                                    and row['nullable'] == 'NO' and row['default'] is not None
                                    for row in columns), 'First-seen columns/defaults are incomplete'
    nulls = json.loads(release.database("""SELECT json_build_object(
      'sales_orders',(SELECT count(*) FROM sales_orders WHERE first_seen_at IS NULL),
      'purchase_orders',(SELECT count(*) FROM purchase_orders WHERE first_seen_at IS NULL),
      'transfer_orders',(SELECT count(*) FROM transfer_orders WHERE first_seen_at IS NULL))"""))
    assert not any(nulls.values()), 'First-seen backfill is incomplete'
    return {'filename': MIGRATION, 'columns': columns, 'nullRows': nulls}


def migration_business_guard_sql():
    return ("DO $dispatch_recent_cards_business_guard$ BEGIN\n"
            "IF (SELECT hashes FROM dispatch_recent_cards_business_before) IS DISTINCT FROM (" + BUSINESS_HASH_SQL + ") THEN\n"
            "RAISE EXCEPTION 'The first-seen migration changed existing order, line, saved plan or load data';\n"
            "END IF; END; $dispatch_recent_cards_business_guard$;")


def apply_migration(data):
    """Apply exactly this task's verified additive SQL, retaining it on rollback."""
    migration_bytes = (OUT / 'candidate' / MIGRATION_PATH).read_bytes()
    sql = migration_bytes.decode('utf-8')
    sha = digest(migration_bytes)
    assert sha == data['sourceHashes'][MIGRATION_PATH] == data['migration']['sha256'], 'Migration bytes differ from verified candidate'
    assert data['migration']['filename'] == MIGRATION, 'Unexpected migration filename'
    before = json.loads(release.database("SELECT coalesce(json_agg(filename ORDER BY filename),'[]'::json) FROM schema_migrations;"))
    assert before.count(MIGRATION) <= 1
    if MIGRATION not in before:
        output = release.database("BEGIN;\nSET TRANSACTION ISOLATION LEVEL REPEATABLE READ;\n"
                                  "SET LOCAL lock_timeout='5s';\nSET LOCAL statement_timeout='30s';\n"
                                  "SELECT pg_advisory_xact_lock(hashtextextended('schema-migration:" + MIGRATION + "',0));\n"
                                  "CREATE TEMP TABLE dispatch_recent_cards_business_before ON COMMIT DROP AS " + BUSINESS_HASH_SQL + ";\n"
                                  "SELECT json_build_object('dispatchRecentMigrationHashes','before','hashes',hashes) FROM dispatch_recent_cards_business_before;\n"
                                  + sql + "\n" + migration_business_guard_sql() + "\n"
                                  "INSERT INTO schema_migrations(filename) VALUES('" + MIGRATION + "') ON CONFLICT(filename) DO NOTHING;\n"
                                  "SELECT json_build_object('dispatchRecentMigrationHashes','after','hashes',hashes) FROM (" + BUSINESS_HASH_SQL + ") checked;\nCOMMIT;")
        (RELEASE / 'migration.log').write_text(output + '\n')
        reports = [json.loads(line) for line in output.splitlines() if line.startswith('{')]
        reports = [row for row in reports if row.get('dispatchRecentMigrationHashes') in ['before', 'after']]
        assert len(reports) == 2 and reports[0]['dispatchRecentMigrationHashes'] == 'before' and reports[1]['dispatchRecentMigrationHashes'] == 'after', 'Migration business hash evidence is missing'
        assert reports[0]['hashes'] == reports[1]['hashes'], 'Migration changed business source data'
        save('migration-business-hashes.json', {'unchanged': True, 'excludedMetadata': ['first_seen_at'],
                                               'before': reports[0]['hashes'], 'after': reports[1]['hashes']})
    after = json.loads(release.database("SELECT coalesce(json_agg(filename ORDER BY filename),'[]'::json) FROM schema_migrations;"))
    assert set(after) == set(before) | {MIGRATION}, 'Another migration changed during this release'
    status = migration_status()
    result = {'applied': True, 'newlyApplied': MIGRATION not in before, 'sha256': sha,
              'additiveMigrationRetainedOnRollback': True, **status}
    save('migration-result.json', result)
    return result


def public_check(data):
    checks = {}
    for file, path in [('health', '/health'), ('public/dispatch.js', '/dispatch.js'),
                       ('public/dispatch.html', '/dispatch/planning')]:
        request = urllib.request.Request('https://test.mbbsoperation.com' + path,
                                         headers={'User-Agent': 'Mozilla/5.0', 'Cache-Control': 'no-cache'})
        with urllib.request.urlopen(request, timeout=30) as response:
            body = response.read()
            assert response.status == 200, path
        if file == 'health':
            assert json.loads(body)['ok'] is True
        else:
            body = re.sub(rb'<script type="module" src="https://static\.cloudflareinsights\.com/beacon\.min\.js/[^>]+></script>\n', b'', body)
            assert digest(body) == data['baselineRuntime'][file], 'Public browser asset changed: ' + file
        checks[path] = {'status': 200, 'sha256': digest(body)}
    save('public-check.json', checks)
    return checks


def verify():
    data = state()
    verified(data)
    expected = data['services']['app']
    release.core.ready(expected['candidateImageId'])
    actual = metadata(APP)
    assert actual['imageId'] == expected['candidateImageId'], 'Live image differs from verified candidate'
    assert actual['configuration'] == expected['before']['configuration'], 'App configuration changed'
    assert {name: metadata(name) for name in DEPENDENCIES} == data['dependencies'], 'Dependency changed'
    assert json.loads(docker('exec', APP, 'node', '-e', HASH_SCRIPT)) == data['candidateRuntime'], 'Live runtime bytes differ'
    for file, sha in data['packageHashes'].items():
        assert digest(docker('exec', APP, 'cat', '/app/' + file)) == sha, 'Live package changed: ' + file
    migration = migration_status()
    public = public_check(data)
    code = (SERVER / 'tools/dispatch-recent-cards-live.mjs').read_text().replace('from "../src/', 'from "./src/').replace("from '../src/", "from './src/")
    try:
        live = json.loads(docker('exec', '-i', APP, 'node', '--input-type=module', input=code.encode()))
    except subprocess.CalledProcessError as error:
        if error.output:
            (RELEASE / 'live-check-failed.log').write_bytes(error.output)
        raise
    save('live-check.json', live)
    assert live.get('passed') is True, 'Live recency check failed'
    assert live.get('epochDateCount') == 0, 'Live catalog still contains epoch recency dates'
    assert live.get('sourceHashesUnchanged') is True, 'Live verification changed source orders or lines'
    assert live.get('diagnosticRecordsRemoved') is True, 'Live diagnostic records were not removed'
    assert live.get('requests') and all(row.get('status') == 200 for row in live['requests']), 'Live browse request failed'
    assert json.loads(docker('exec', APP, 'node', '-e', HASH_SCRIPT)) == data['candidateRuntime'], 'Runtime changed during verification'
    assert {name: metadata(name) for name in DEPENDENCIES} == data['dependencies'], 'Dependency changed during verification'
    final_app = metadata(APP)
    assert final_app == actual, 'App changed during live verification'
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'image': IMAGE, 'imageId': actual['imageId'], 'configurationPreserved': True,
              'dependenciesUnchanged': True, 'sourceFiles': FILES,
              'runtimeFilesVerified': CANDIDATE_RUNTIME_FILES,
              'migration': {**migration, 'sha256': data['sourceHashes'][MIGRATION_PATH]},
              'public': public, 'live': live}
    save('result.json', result)
    print(json.dumps(result), flush=True)


def rollback(data, error):
    result = {'rolledBack': False, 'cause': str(error),
              'additiveMigrationRetained': True, 'migration': MIGRATION}
    try:
        with (RELEASE / 'rollback.log').open('wb') as log:
            subprocess.run(release.compose(data, 'compose.rollback.yml') +
                           ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'],
                           cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        before = data['services']['app']['before']
        release.core.ready(before['imageId'])
        actual = metadata(APP)
        assert actual['imageId'] == before['imageId'] and actual['configuration'] == before['configuration'], 'Rollback did not restore app image/configuration'
        assert json.loads(docker('exec', APP, 'node', '-e', HASH_SCRIPT)) == data['baselineRuntime'], 'Rollback runtime differs from baseline'
        for file, sha in data['packageHashes'].items():
            assert digest(docker('exec', APP, 'cat', '/app/' + file)) == sha, 'Rollback package differs: ' + file
        assert {name: metadata(name) for name in DEPENDENCIES} == data['dependencies'], 'Dependency changed during rollback'
        migration_status()
        result['rolledBack'] = True
        result['imageId'] = actual['imageId']
    except BaseException as rollback_error:
        result['rollbackError'] = str(rollback_error)
        save('rollback-result.json', result)
        raise RuntimeError('Release failed and automatic rollback failed: ' + str(rollback_error)) from error
    save('rollback-result.json', result)


def apply():
    data = state()
    current(data)
    verified(data)
    image_id = data['services']['app']['candidateImageId']
    assert docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip() == image_id, 'Candidate image changed'
    assert json.loads(docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', image_id,
                            '-e', HASH_SCRIPT)) == data['candidateRuntime'], 'Candidate image bytes differ'
    assert (RELEASE / 'compose.release.yml').read_text() == 'services:\n  app:\n    image: ' + IMAGE + '\n', 'Release Compose scope changed'
    assert (RELEASE / 'compose.rollback.yml').read_text() == 'services:\n  app:\n    image: ' + data['services']['app']['before']['imageId'] + '\n', 'Rollback Compose scope changed'
    assert (SERVER / 'tools/dispatch-recent-cards-live.mjs').is_file(), 'Live checker is missing'
    release.config_check(data)
    active = json.loads(release.database("""SELECT json_build_object(
      'operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),
      'driverExecuting',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing'),
      'specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'),
      'stockTransferConfirming',(SELECT count(*) FROM sales_stock_transfers WHERE confirmation_status IN ('creating','approving','hydrating','printing')),
      'regularExecuting',(SELECT count(*) FROM regular_stock_handoffs WHERE status='executing'),
      'deliveryOperations',(SELECT count(*) FROM regular_stock_delivery_operations WHERE status IN ('queued','running')),
      'stockingExecuting',(SELECT count(*) FROM sales_stock_requests WHERE regular_details->'pickupTransfer'->>'status'='executing'),
      'scmExecuting',(SELECT count(*) FROM scm_smart_proposals WHERE status='executing'),
      'webhookRunning',(SELECT count(*) FROM netsuite_order_webhook_inbox WHERE status='running'))"""))
    save('active-before-release.json', active)
    assert not any(active.values()), 'Wait for active operations: ' + json.dumps(active)
    current(data)
    apply_migration(data)
    # The database change cannot alter the captured application or image bytes.
    current(data)
    try:
        with (RELEASE / 'publish.log').open('wb') as log:
            subprocess.run(release.compose(data) + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'],
                           cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except BaseException as error:
        rollback(data, error)
        raise


def rebase_after_rollback():
    data = state()
    assert json.loads((RELEASE / 'rollback-result.json').read_text()).get('rolledBack') is True
    before = data['services']['app']['before']
    actual = metadata(APP)
    assert actual['imageId'] == before['imageId'] and actual['configuration'] == before['configuration']
    assert json.loads(docker('exec', APP, 'node', '-e', HASH_SCRIPT)) == data['baselineRuntime']
    assert {name: metadata(name) for name in DEPENDENCIES} == data['dependencies']
    save('previous-deployment-baseline.json', before)
    data['services']['app']['before'] = actual
    current(data)
    save('manifest.json', data)
    print(json.dumps({'rollbackBaselineVerified': True}), flush=True)


if __name__ == '__main__':
    actions = {'capture': capture, 'refresh-candidate': refresh_candidate,
               'check': check, 'stage': stage, 'build': build,
               'prepare': prepare, 'apply': apply, 'verify': verify,
               'rebase-after-rollback': rebase_after_rollback}
    if len(sys.argv) != 2 or sys.argv[1] not in actions:
        raise SystemExit('Usage: dispatch-recent-cards-release.py ' + '|'.join(actions))
    actions[sys.argv[1]]()
