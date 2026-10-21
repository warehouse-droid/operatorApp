"""Release the verified Dispatch Confirm browser change over a fresh live image.

Only public/dispatch.js may differ. Preparation never changes live containers.
Live verification reads static assets and saved-plan hashes; it never confirms
a plan, creates a browser session, or requests a Google route.
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
OUT = SERVER / 'test-artifacts/dispatch-confirm-google'
RELEASE = SERVER / 'deployments/dispatch-confirm-google-20260930'
APP = 'mbbs-operator-app-app-1'
DEPENDENCIES = ['mbbs-operator-app-db-1', 'mbbs-operator-app-ollama-1',
                'mbbs-operator-app-webhook-worker-1']
FILES = ['public/dispatch.js']
PACKAGES = ['package.json', 'package-lock.json']
IMAGE = 'mbbs-operator-app:dispatch-confirm-google-20260930'
BASE_TAG = 'mbbs-operator-app:dispatch-confirm-google-20260930-base'

spec = importlib.util.spec_from_file_location('dispatch_confirm_release_common',
                                            SERVER / 'tools/regular-stock-v2-deploy.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.RELEASE, release.CONTAINERS, release.DEPENDENCIES = RELEASE, {'app': APP}, DEPENDENCIES
digest, files_at = release.digest, release.core.files_at

HASH_SCRIPT = """const fs=require('node:fs'),crypto=require('node:crypto'),hashes={};
function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const path=dir+'/'+entry.name;
if(entry.isDirectory())walk(path);else if(entry.isFile())hashes[path]=crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex');}}
for(const dir of ['src','public','migrations'])walk(dir);console.log(JSON.stringify(hashes));"""

PLAN_TABLES = [('dispatch_plans', 'id'), ('dispatch_plan_snapshots', 'plan_id'),
               ('dispatch_plan_snapshot_history', 'id'), ('dispatch_plan_load_assignments', 'id'),
               ('dispatch_plan_order_assignments', 'plan_id,order_ref'),
               ('dispatch_plan_checkpoint_state', 'plan_id'), ('dispatch_plan_commands', 'id')]
PLAN_GUARD_METHOD = 'ordered primary keys + xmin/ctid'
# Tuple versions avoid detoasting the multi-gigabyte plan documents. Ordinary
# visible-row updates change xmin/ctid; keys/count cover inserted/deleted rows.
# xmax is omitted because lock-only maintenance changes it without a new row
# version. Physical rewrites can still conservatively reject unchanged business
# content. Endpoint equality does not prove absence of transient writes.
PLAN_HASH_SQL = "SELECT jsonb_object_agg(table_name,jsonb_build_object('rows',row_count,'rowVersionMd5',row_hash)) FROM (" + ' UNION ALL '.join(
    "SELECT '" + table + "'::text AS table_name,count(*) AS row_count,"
    "md5(COALESCE(string_agg(md5(jsonb_build_array(" + keys + ","
    "item.xmin::text,item.ctid::text)::text),'' ORDER BY " + keys + "),'')) AS row_hash"
    " FROM " + table + " item" for table, keys in PLAN_TABLES) + ') saved_plans'


def timestamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def save(name, value):
    RELEASE.mkdir(parents=True, exist_ok=True)
    (RELEASE / name).write_text(json.dumps(value, indent=2) + '\n')


def command_record(args, input_bytes=None, **result):
    RELEASE.mkdir(parents=True, exist_ok=True)
    row = {'at': timestamp(), 'argv': list(args), **result}
    if input_bytes is not None:
        row['stdinSha256'] = digest(input_bytes)
    with (RELEASE / 'commands.jsonl').open('a') as log:
        log.write(json.dumps(row) + '\n')


def docker(*args, **kwargs):
    command = ['sudo', '-n', 'docker', *args]
    try:
        output = release.docker(*args, **kwargs)
    except subprocess.CalledProcessError as error:
        command_record(command, kwargs.get('input'), exitCode=error.returncode)
        raise
    # inspect output can contain secrets: retain only its size and hash.
    command_record(command, kwargs.get('input'), exitCode=0,
                   stdoutBytes=len(output), stdoutSha256=digest(output))
    return output


def metadata(container):
    value = release.metadata(container)
    command_record(['sudo', '-n', 'docker', 'inspect', container], exitCode=0,
                   imageId=value['imageId'], configurationSha256=value['configuration'])
    return value


def state():
    return json.loads((RELEASE / 'manifest.json').read_text())


def candidate_scope():
    baseline, candidate = OUT / 'production-before', OUT / 'candidate'
    captured = json.loads((OUT / 'baseline-metadata.json').read_text())
    before, after = files_at(baseline), files_at(candidate)
    assert before == captured['runtime'], 'Captured baseline runtime differs from its metadata'
    changed = sorted(file for file in set(before) | set(after) if before.get(file) != after.get(file))
    assert changed == FILES, 'Unexpected candidate delta: ' + json.dumps(changed)
    hashes = {file: after[file] for file in FILES}
    assert after == {**before, **hashes}, 'Candidate altered an unrelated runtime file'
    packages = {file: digest((baseline / file).read_bytes()) for file in PACKAGES}
    assert packages == captured['packageHashes'], 'Captured package bytes differ from metadata'
    assert all(digest((candidate / file).read_bytes()) == sha for file, sha in packages.items()), 'Candidate changed packages'
    assert set(captured['dependencies']) == set(DEPENDENCIES), 'Unexpected captured dependencies'
    assert re.fullmatch(r'sha256:[0-9a-f]{64}', captured['app']['imageId']), 'Invalid captured image ID'
    return captured, before, after, hashes, packages


def current(data):
    captured, before, after, hashes, packages = candidate_scope()
    assert before == data['baselineRuntime'] and captured['app'] == data['services']['app']['before'], 'Baseline changed; fresh capture/rebase required'
    assert after == data['candidateRuntime'] and hashes == data['sourceHashes'], 'Candidate changed; refresh verification'
    assert packages == data['packageHashes'] and captured['dependencies'] == data['dependencies'], 'Captured dependencies or packages changed'
    base = data['services']['app']['before']
    assert metadata(APP) == base, 'Live app changed; fresh capture/rebase required'
    assert {name: metadata(name) for name in DEPENDENCIES} == data['dependencies'], 'Live dependency changed; fresh capture/rebase required'
    assert docker('image', 'inspect', '--format', '{{.Id}}', base['image']).decode().strip() == base['imageId'], 'Baseline image tag moved'
    assert json.loads(docker('exec', APP, 'node', '-e', HASH_SCRIPT)) == before, 'Live runtime differs from captured baseline'
    for file, sha in packages.items():
        assert digest(docker('exec', APP, 'cat', '/app/' + file)) == sha, 'Live package differs: ' + file


def verified(data):
    result = json.loads((RELEASE / 'verified.json').read_text())
    assert result.get('passed') is True, 'External candidate verification did not pass'
    assert result.get('sourceHashes') == data['sourceHashes'], 'External verification source hashes are stale'
    assert result.get('baselineSignature') == digest(json.dumps(data['baselineRuntime'], sort_keys=True).encode()), 'Verified backend baseline is stale'
    assert result.get('runtimeFiles') == len(data['baselineRuntime']), 'Verified runtime inventory differs'
    tests = ['test/dispatch/frontend/dispatch-google-map-redraw.red.test.js',
             'test/dispatch/frontend/dispatch-map-preview-persistence.test.js',
             'test/mbt/unit/google-maps-gateway.red.test.js',
             'test/dispatch/frontend/dispatch-save-reliability.test.js',
             'test/dispatch/property/dispatch-save-reliability.test.js',
             'test/dispatch/frontend/dispatch-planner-performance.contract.test.js',
             'test/dispatch/frontend/google-maps-usage-control.contract.test.js',
             'test/dispatch/frontend/dispatch-confirm-google-routes.test.js',
             'test/dispatch/integration/dispatch-confirm-google-route-persistence.test.js',
             'test/support/google-map-redraw-fixture.mjs']
    assert result.get('testHashes') == {file: digest((SERVER / file).read_bytes()) for file in tests}, 'Verified fixtures are stale'
    tools = ['tools/dispatch-confirm-google-check.py', 'tools/dispatch-recent-cards-check.py',
             'tools/dispatch-fulfilled-so-eslint.config.mjs', 'eslint.mbt.config.js']
    assert result.get('validationToolHashes') == {file: digest((SERVER / file).read_bytes()) for file in tools}, 'Verified tools are stale'
    checks = result.get('checks', {})
    required = {'baselineSuite', 'candidateSuite', 'static', 'changedLineCoverage',
                'mutants', 'databasePersistence'}
    assert required <= checks.keys(), 'External verification lacks required full-run layers'
    assert result.get('sourceHashesUnchanged') is True, 'Candidate changed during verification'
    assert checks.get('newFailures') == [], 'New regression failures were not excluded'
    assert checks['candidateSuite']['tests'] > checks['baselineSuite']['tests'], 'Focused tests did not run'
    assert checks['candidateSuite']['cancelled'] == checks['candidateSuite']['skipped'] == 0
    for name in ('baselineSuite', 'candidateSuite'):
        assert checks[name]['exitCode'] == (1 if checks[name]['fail'] else 0), 'Wrapper exit disagrees with TAP'
    assert checks['static']['lint']['newFindings'] == checks['static']['types']['newFindings'] == []
    coverage = checks['changedLineCoverage']
    assert coverage['total'] > 0 and coverage['covered'] == coverage['total'] and coverage['uncovered'] == []
    mutants = checks['mutants']
    expected_mutants = {'missing-only', 'browser-cache-used', 'warning-discarded', 'manual-flight-not-awaited'}
    assert len(mutants) == 4 and {item['name'] for item in mutants} == expected_mutants
    assert all(item.get('killed') is True and item['tap']['exitCode'] == 1 and item['tap']['fail'] > 0 for item in mutants)
    database = checks['databasePersistence']
    assert database['pass'] == database['tests'] == 3
    assert database['fail'] == database['skipped'] == database['cancelled'] == database['exitCode'] == 0
    return result


def candidate_patch():
    return ''.join(''.join(difflib.unified_diff(
        (OUT / 'production-before' / file).read_text().splitlines(True),
        (OUT / 'candidate' / file).read_text().splitlines(True),
        fromfile='a/' + file, tofile='b/' + file)) for file in FILES)


def capture():
    os.umask(0o077)
    assert not (RELEASE / 'manifest.json').exists(), 'Capture already registered'
    captured, before, after, hashes, packages = candidate_scope()
    data = {'services': {'app': {'before': captured['app'], 'image': IMAGE}},
            'dependencies': captured['dependencies'], 'baselineRuntime': before,
            'candidateRuntime': after, 'beforeHashes': {file: before[file] for file in FILES},
            'sourceHashes': hashes, 'packageHashes': packages, 'sourceFiles': FILES,
            'databaseChanges': False}
    current(data)
    save('manifest.json', data)
    (RELEASE / 'release.patch').write_text(candidate_patch())
    print(json.dumps({'captured': True, 'baselineImageId': captured['app']['imageId'],
                      'runtimeFiles': len(after), 'changedFiles': FILES}), flush=True)


def refresh_candidate():
    data = state()
    captured, before, after, hashes, packages = candidate_scope()
    assert before == data['baselineRuntime'] and captured['app'] == data['services']['app']['before'], 'Baseline changed; fresh capture/rebase required'
    assert packages == data['packageHashes'], 'Package bytes changed'
    data = {**data, 'candidateRuntime': after, 'sourceHashes': hashes,
            'services': {'app': {**data['services']['app']}}}
    data['services']['app'].pop('candidateImageId', None)
    current(data)
    save('manifest.json', data)
    (RELEASE / 'release.patch').write_text(candidate_patch())
    print(json.dumps({'candidateRefreshed': True, 'sourceHashes': hashes,
                      'requiresFreshVerificationAndBuild': True}), flush=True)


def check():
    data = state()
    current(data)
    verified(data)
    print(json.dumps({'verified': True, 'sourceHashes': data['sourceHashes']}), flush=True)


def compose_text(image):
    return 'services:\n  app:\n    image: ' + image + '\n'


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
    assert {str(p.relative_to(directory / 'overlay')): digest(p.read_bytes())
            for p in (directory / 'overlay').rglob('*') if p.is_file()} == data['sourceHashes']
    (directory / 'Dockerfile').write_text('FROM ' + BASE_TAG + '\nCOPY --chown=node:node overlay/ /app/\n')
    (RELEASE / 'compose.release.yml').write_text(compose_text(IMAGE))
    (RELEASE / 'compose.rollback.yml').write_text(compose_text(data['services']['app']['before']['imageId']))
    print(json.dumps({'staged': True, 'changedFiles': FILES}), flush=True)


def config_check(data):
    command_record(release.compose(data) + ['config', '--format', 'json'])
    release.config_check(data)


def build():
    data = state()
    current(data)
    verified(data)
    directory = RELEASE / 'stage'
    assert {str(p.relative_to(directory / 'overlay')): digest(p.read_bytes())
            for p in (directory / 'overlay').rglob('*') if p.is_file()} == data['sourceHashes'], 'Staged source differs'
    assert (directory / 'Dockerfile').read_text() == 'FROM ' + BASE_TAG + '\nCOPY --chown=node:node overlay/ /app/\n', 'Dockerfile changed'
    docker('tag', data['services']['app']['before']['imageId'], BASE_TAG)
    assert docker('image', 'inspect', '--format', '{{.Id}}', BASE_TAG).decode().strip() == data['services']['app']['before']['imageId']
    command = ['sudo', '-n', 'docker', 'build', '--network', 'none', '--pull=false', '-t', IMAGE, str(directory)]
    command_record(command)
    with (RELEASE / 'build.log').open('wb') as log:
        subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, check=True)
    image_id = docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    assert json.loads(docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', image_id,
                            '-e', HASH_SCRIPT)) == data['candidateRuntime'], 'Built image runtime differs'
    docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', image_id, '--check', FILES[0])
    for file, sha in data['packageHashes'].items():
        assert digest(docker('run', '--rm', '--network', 'none', '--entrypoint', 'cat', image_id, '/app/' + file)) == sha, 'Built package differs: ' + file
    data['services']['app']['candidateImageId'] = image_id
    config_check(data)
    current(data)
    save('manifest.json', data)
    print(json.dumps({'prepared': True, 'image': IMAGE, 'imageId': image_id,
                      'runtimeFilesVerified': len(data['candidateRuntime']), 'changedFiles': FILES}), flush=True)


def prepare():
    stage()
    build()


def read_only_json(statement):
    sql = ("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSET LOCAL statement_timeout='20s';\n"
           + statement + ";\nCOMMIT;")
    raw = docker('exec', '-i', DEPENDENCIES[0], 'psql', '-U', 'mbbs_app', '-d', 'mbbs_yard',
                 '-XAt', '-v', 'ON_ERROR_STOP=1', input=sql.encode()).decode()
    rows = [json.loads(line) for line in raw.splitlines() if line.startswith('{')]
    assert len(rows) == 1, 'Read-only diagnostic result is incomplete'
    return rows[0]


def database_snapshot():
    value = read_only_json("SELECT json_build_object('tables',(" + PLAN_HASH_SQL + "),'migrations',"
                          "(SELECT coalesce(json_agg(filename ORDER BY filename),'[]'::json) FROM schema_migrations))")
    assert len(value['tables']) == len(PLAN_TABLES), 'Saved-plan snapshot is incomplete'
    value['method'] = PLAN_GUARD_METHOD
    return value


def active_operations():
    return read_only_json("""SELECT json_build_object(
      'operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),
      'driverExecuting',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing'),
      'specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'),
      'stockTransferConfirming',(SELECT count(*) FROM sales_stock_transfers WHERE confirmation_status IN ('creating','approving','hydrating','printing')),
      'regularExecuting',(SELECT count(*) FROM regular_stock_handoffs WHERE status='executing'),
      'deliveryOperations',(SELECT count(*) FROM regular_stock_delivery_operations WHERE status IN ('queued','running')),
      'stockingExecuting',(SELECT count(*) FROM sales_stock_requests WHERE regular_details->'pickupTransfer'->>'status'='executing'),
      'scmExecuting',(SELECT count(*) FROM scm_smart_proposals WHERE status='executing'),
      'webhookRunning',(SELECT count(*) FROM netsuite_order_webhook_inbox WHERE status='running'))""")


def public_check(data, baseline=False):
    expected = data['baselineRuntime'] if baseline else data['candidateRuntime']
    checks = {}
    suffix = '?dispatchConfirmRelease=' + expected[FILES[0]][:16]
    for base in ['http://127.0.0.1:3000', 'https://test.mbbsoperation.com']:
        for file, path in [('health', '/health'), ('public/dispatch.js', '/dispatch.js'),
                           ('public/dispatch.html', '/dispatch/planning')]:
            if base.startswith('http://127.'):
                script = "fetch(" + json.dumps(base + path + suffix) + ",{headers:{'Cache-Control':'no-cache'},signal:AbortSignal.timeout(15000)}).then(async r=>{if(r.status!==200)process.exit(1);process.stdout.write(Buffer.from(await r.arrayBuffer()));}).catch(()=>process.exit(1));"
                body = docker('exec', APP, 'node', '-e', script)
                status = 200
            else:
                request = urllib.request.Request(base + path + suffix,
                    headers={'User-Agent': 'Mozilla/5.0', 'Cache-Control': 'no-cache'})
                with urllib.request.urlopen(request, timeout=20) as response:
                    body, status = response.read(), response.status
                command_record(['GET', base + path + suffix], exitCode=0, httpStatus=status,
                               stdoutBytes=len(body), stdoutSha256=digest(body))
            assert status == 200, path
            if file == 'health':
                assert json.loads(body)['ok'] is True, 'Public health failed'
            else:
                if file.endswith('.html'):
                    body = re.sub(rb'<script type="module" src="https://static\.cloudflareinsights\.com/beacon\.min\.js/[^>]+></script>\n', b'', body)
                assert digest(body) == expected[file], 'Served asset differs: ' + base + path
            checks[base + path] = {'status': status, 'sha256': digest(body)}
    save('rollback-public-check.json' if baseline else 'public-check.json', checks)
    return checks


def verify(pre_release=None):
    data = state()
    verified(data)
    expected = data['services']['app']
    before = database_snapshot()
    save('saved-plans-before-verification.json', before)
    if pre_release is not None:
        assert pre_release == before, 'Saved plan/snapshot/load row versions changed during cutover; concurrent saves, physical rewrites or startup work require review'
    release.core.ready(expected['candidateImageId'])
    actual = metadata(APP)
    assert actual['imageId'] == expected['candidateImageId'], 'Live candidate image differs'
    assert actual['configuration'] == expected['before']['configuration'], 'App configuration changed'
    assert {name: metadata(name) for name in DEPENDENCIES} == data['dependencies'], 'Dependency changed'
    assert json.loads(docker('exec', APP, 'node', '-e', HASH_SCRIPT)) == data['candidateRuntime'], 'Live runtime differs'
    for file, sha in data['packageHashes'].items():
        assert digest(docker('exec', APP, 'cat', '/app/' + file)) == sha, 'Live package changed: ' + file
    public = public_check(data)
    after = database_snapshot()
    save('saved-plans-after-verification.json', after)
    assert before == after, 'Saved plan/snapshot/load row versions changed during read-only verification'
    if pre_release is not None:
        assert pre_release == after, 'Saved plan/snapshot/load row versions changed across release; concurrent saves, physical rewrites or startup work require review'
    assert metadata(APP) == actual, 'App changed during verification'
    assert {name: metadata(name) for name in DEPENDENCIES} == data['dependencies'], 'Dependency changed during verification'
    assert json.loads(docker('exec', APP, 'node', '-e', HASH_SCRIPT)) == data['candidateRuntime'], 'Runtime changed during verification'
    result = {'deployed': True, 'at': timestamp(), 'image': IMAGE, 'imageId': actual['imageId'],
              'sourceFiles': FILES, 'runtimeFilesVerified': len(data['candidateRuntime']),
              'configurationPreserved': True, 'dependenciesUnchanged': True, 'packagesUnchanged': True,
              'databaseChanges': False, 'savedPlanGuardMethod': PLAN_GUARD_METHOD,
              'savedPlanRowVersionTablesUnchangedDuringVerification': len(PLAN_TABLES),
              'savedPlanRowVersionTablesUnchangedAcrossRelease': len(PLAN_TABLES) if pre_release is not None else None,
              'googleRequestsMadeByVerification': 0, 'public': public}
    save('result.json', result)
    print(json.dumps(result), flush=True)


def rollback(data, error):
    result = {'rolledBack': False, 'cause': str(error), 'databaseRestorationPerformed': False}
    try:
        base = data['services']['app']['before']
        live = metadata(APP)
        assert live['configuration'] == base['configuration'], 'Concurrent configuration change; refusing to overwrite it'
        assert live['imageId'] in [base['imageId'], data['services']['app']['candidateImageId']], 'Concurrent app release; refusing to overwrite it'
        command = release.compose(data, 'compose.rollback.yml') + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app']
        command_record(command)
        with (RELEASE / 'rollback.log').open('wb') as log:
            subprocess.run(command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        release.core.ready(base['imageId'])
        actual = metadata(APP)
        assert actual['imageId'] == base['imageId'] and actual['configuration'] == base['configuration'], 'Rollback image/configuration differs'
        assert json.loads(docker('exec', APP, 'node', '-e', HASH_SCRIPT)) == data['baselineRuntime'], 'Rollback runtime differs'
        for file, sha in data['packageHashes'].items():
            assert digest(docker('exec', APP, 'cat', '/app/' + file)) == sha, 'Rollback package differs: ' + file
        assert {name: metadata(name) for name in DEPENDENCIES} == data['dependencies'], 'Dependency changed during rollback'
        public_check(data, baseline=True)
        result.update({'rolledBack': True, 'imageId': actual['imageId']})
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
    assert docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip() == image_id, 'Candidate tag changed'
    assert json.loads(docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', image_id,
                            '-e', HASH_SCRIPT)) == data['candidateRuntime'], 'Candidate image bytes differ'
    assert (RELEASE / 'compose.release.yml').read_text() == compose_text(IMAGE), 'Release Compose scope changed'
    assert (RELEASE / 'compose.rollback.yml').read_text() == compose_text(data['services']['app']['before']['imageId']), 'Rollback Compose scope changed'
    config_check(data)
    active = active_operations()
    save('active-before-release.json', active)
    assert not any(active.values()), 'Wait for active operations: ' + json.dumps(active)
    before = database_snapshot()
    save('saved-plans-before-release.json', before)
    current(data)
    command = release.compose(data) + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app']
    command_record(command)
    try:
        with (RELEASE / 'publish.log').open('wb') as log:
            subprocess.run(command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        verify(pre_release=before)
    except BaseException as error:
        rollback(data, error)
        raise


if __name__ == '__main__':
    actions = {'capture': capture, 'refresh-candidate': refresh_candidate, 'check': check,
               'stage': stage, 'build': build, 'prepare': prepare, 'apply': apply, 'verify': verify}
    if len(sys.argv) != 2 or sys.argv[1] not in actions:
        raise SystemExit('Usage: dispatch-confirm-google-release.py ' + '|'.join(actions))
    actions[sys.argv[1]]()
