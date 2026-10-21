"""Release the verified Purchase delta over each current app/worker image."""
import datetime
import difflib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.request
import uuid

sys.dont_write_bytecode = True
SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
OUT = SERVER / 'test-artifacts/regular-stock-purchase'
RELEASE = SERVER / 'deployments/regular-stock-purchase-20260930'
FILES = json.loads((SERVER / 'tools/regular-stock-purchase-files.json').read_text())
WORKER_FILES = ['src/order-sync-repository.js', 'src/regular-stock-purchase-domain.js',
                'src/regular-stock-purchase-repository.js', 'migrations/245_regular_stock_purchase.sql']
CONTAINERS = {'app': 'mbbs-operator-app-app-1', 'webhook-worker': 'mbbs-operator-app-webhook-worker-1'}
DEPENDENCIES = ['mbbs-operator-app-db-1', 'mbbs-operator-app-ollama-1']
MIGRATION = '245_regular_stock_purchase.sql'
spec = importlib.util.spec_from_file_location('purchase_release_core', SERVER / 'tools/regular-stock-v2-deploy.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.RELEASE, release.CONTAINERS, release.DEPENDENCIES = RELEASE, CONTAINERS, DEPENDENCIES
docker, digest, metadata, files_at = release.docker, release.digest, release.metadata, release.files_at

HASH_SCRIPT = """const fs=require('node:fs'),crypto=require('node:crypto'),hashes={};
function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const path=dir+'/'+entry.name;
if(entry.isDirectory())walk(path);else if(entry.isFile())hashes[path]=crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex');}}
for(const dir of ['src','public','migrations'])walk(dir);console.log(JSON.stringify(hashes));"""

def save(name, value):
    (RELEASE / name).write_text(json.dumps(value, indent=2) + '\n')

def state():
    return json.loads((RELEASE / 'manifest.json').read_text())

def workspace_verified():
    checks = json.loads((OUT / 'gauntlet.json').read_text())
    assert checks['complete'] and all(row['exitCode'] == 0 for row in checks['layers'])
    # Rebase the frozen, tested delta even if another task edits a shared file.
    patch = 'test/regular-stock-purchase.changes.patch'
    assert digest((SERVER / patch).read_bytes()) == checks['files'][patch], 'Verified patch changed'
    supporting = [file for file in checks['files'] if file not in FILES]
    assert all(digest((SERVER / file).read_bytes()) == checks['files'][file] for file in supporting), 'Test support changed'
    assert json.loads((OUT / 'changed-lines.json').read_text())['complete']
    return {file: checks['files'][file] for file in FILES}

def current(data):
    assert workspace_verified() == data['workspace'], 'Implementation changed'
    assert {name: metadata(name) for name in DEPENDENCIES} == data['dependencies'], 'Dependency changed'
    for service, row in data['services'].items():
        assert metadata(CONTAINERS[service]) == row['before'], 'Live service changed: ' + service
        assert files_at(RELEASE / ('candidate-' + service)) == row['candidateRuntime'], 'Candidate changed: ' + service
        assert json.loads(docker('exec', CONTAINERS[service], 'node', '-e', HASH_SCRIPT)) == row['baselineRuntime'], 'Live runtime changed'
        for file, sha in row['packages'].items():
            assert digest(docker('exec', CONTAINERS[service], 'cat', '/app/' + file)) == sha, 'Live package changed'

def merge_html_lines(content):
    """Resolve adjacent independent asset edits without choosing a whole side."""
    pattern = r'^<<<<<<<[^\n]*\n(.*?)^\|\|\|\|\|\|\|[^\n]*\n(.*?)^=======\n(.*?)^>>>>>>>[^\n]*\n'
    def resolve(match):
        live, base, purchase = [value.splitlines(True) for value in match.groups()]
        assert len(live) == len(base) == len(purchase), 'Review HTML structure conflict'
        lines = []
        for current_line, original_line, purchase_line in zip(live, base, purchase):
            assert all('<script src=' in line for line in [current_line, original_line, purchase_line]), 'Review non-asset HTML conflict'
            if current_line == original_line:
                lines.append(purchase_line)
            elif purchase_line == original_line or current_line == purchase_line:
                lines.append(current_line)
            else:
                raise AssertionError('Review overlapping HTML asset change')
        return ''.join(lines)
    merged, count = re.subn(pattern, resolve, content, flags=re.MULTILINE | re.DOTALL)
    assert count > 0 and '<<<<<<<' not in merged, 'Unresolved HTML conflict'
    return merged

def capture():
    os.umask(0o077)
    verified = workspace_verified()
    RELEASE.mkdir(exist_ok=False)
    original = OUT / 'baseline-source'
    baseline_hashes = json.loads((original / 'manifest.json').read_text())
    tested = RELEASE / 'tested-source'
    shutil.copytree(original, tested)
    (tested / 'migrations').mkdir()
    patch = (SERVER / 'test/regular-stock-purchase.changes.patch').read_bytes()
    result = subprocess.run(['patch','--batch','--fuzz=0','-p1','-d',str(tested)],input=patch,capture_output=True)
    (RELEASE / 'reconstruct.log').write_bytes(result.stdout + result.stderr)
    assert result.returncode == 0, 'Verified source reconstruction failed'
    assert all(digest((tested / file).read_bytes()) == sha for file, sha in verified.items()), 'Reconstructed source differs from tested bytes'
    data = {'workspace': verified, 'dependencies': {name: metadata(name) for name in DEPENDENCIES}, 'services': {}}
    for service, container in CONTAINERS.items():
        before = metadata(container)
        baseline = RELEASE / ('baseline-' + service)
        baseline.mkdir()
        for folder in ['src', 'public', 'migrations', 'package.json', 'package-lock.json']:
            with tarfile.open(fileobj=io.BytesIO(docker('cp', container + ':/app/' + folder, '-'))) as archive:
                archive.extractall(baseline, filter='data')
        assert metadata(container) == before, 'Service changed while capturing'
        candidate = RELEASE / ('candidate-' + service)
        shutil.copytree(baseline, candidate)
        selected = FILES if service == 'app' else WORKER_FILES
        merges = []
        for file in selected:
            target = candidate / file
            target.parent.mkdir(parents=True, exist_ok=True)
            if file not in baseline_hashes:
                assert not (baseline / file).exists(), 'Added source already exists: ' + file
                shutil.copy2(tested / file, target)
                merges.append({'file': file, 'added': True})
            else:
                assert digest((original / file).read_bytes()) == baseline_hashes[file], 'Implementation baseline changed'
                result = subprocess.run(['git', 'merge-file', '--diff3', '--stdout', str(baseline / file),
                                         str(original / file), str(tested / file)], capture_output=True)
                if file.endswith('.html') and result.returncode == 1:
                    target.write_text(merge_html_lines(result.stdout.decode()))
                    merges.append({'file': file, 'exitCode': 0, 'adjacentAssetEditsMerged': True})
                else:
                    target.write_bytes(result.stdout)
                    merges.append({'file': file, 'exitCode': result.returncode})
                (RELEASE / (service + '-merge-errors.log')).write_bytes(result.stderr)
        before_hashes, after_hashes = files_at(baseline), files_at(candidate)
        changed = sorted(file for file in set(before_hashes) | set(after_hashes) if before_hashes.get(file) != after_hashes.get(file))
        packages = {file: digest((baseline / file).read_bytes()) for file in ['package.json', 'package-lock.json']}
        row = {'before': before, 'baselineRuntime': before_hashes, 'candidateRuntime': after_hashes,
               'sourceHashes': {file: after_hashes[file] for file in selected}, 'changed': changed,
               'packages': packages, 'merges': merges, 'image': 'mbbs-operator-app:regular-stock-purchase-' + service + '-20260930'}
        data['services'][service] = row
        save('manifest.json', data)
        assert all(value.get('exitCode', 0) == 0 for value in merges), 'Review candidate merge conflicts: ' + service
        assert changed == sorted(selected), 'Unexpected candidate scope'
        patch = ''.join(''.join(difflib.unified_diff((baseline / file).read_text().splitlines(True) if (baseline / file).exists() else [],
                       (candidate / file).read_text().splitlines(True), fromfile='a/' + file, tofile='b/' + file)) for file in selected)
        (RELEASE / (service + '.patch')).write_text(patch)
        print(json.dumps({'captured': service, 'baseImage': before['image'], 'changedFiles': changed,
                          'rebasedFiles': [file for file in selected if after_hashes[file] != verified[file]]}), flush=True)
    current(data)

def build():
    data = state()
    current(data)
    for service, row in data['services'].items():
        stage = RELEASE / ('stage-' + service)
        for file in row['changed']:
            target = stage / 'overlay' / file
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(RELEASE / ('candidate-' + service) / file, target)
        base = 'mbbs-operator-app:purchase-base-' + service + '-20260930'
        docker('tag', row['before']['imageId'], base)
        (stage / 'Dockerfile').write_text('FROM ' + base + '\nCOPY --chown=node:node overlay/ /app/\n')
        with (RELEASE / (service + '-build.log')).open('wb') as log:
            subprocess.run(['sudo', '-n', 'docker', 'build', '--network', 'none', '--pull=false', '-t', row['image'], str(stage)],
                           stdout=log, stderr=subprocess.STDOUT, check=True)
        row['candidateImageId'] = docker('image', 'inspect', '--format', '{{.Id}}', row['image']).decode().strip()
        assert json.loads(docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', row['candidateImageId'], '-e', HASH_SCRIPT)) == row['candidateRuntime']
        for file in row['changed']:
            if file.endswith('.js'):
                docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', row['candidateImageId'], '--check', file)
        module = 'server.js' if service == 'app' else 'order-sync-repository.js'
        docker('run', '--rm', '--network', 'none', '-e', 'MBBS_ENV_FILE=/nonexistent', '-e', 'NETSUITE_DIRECT_ACCESS_ENABLED=false',
               '-e', 'NETSUITE_MIRROR_ROLE=disabled', '--entrypoint', 'node', row['candidateImageId'], '--input-type=module',
               '-e', "await import('./src/" + module + "');process.exit(0)")
        print(json.dumps({'built': service, 'imageId': row['candidateImageId'], 'runtimeFilesVerified': len(row['candidateRuntime'])}), flush=True)
    for kind in ['release', 'rollback']:
        (RELEASE / ('compose.' + kind + '.yml')).write_text('services:\n' + ''.join('  ' + service + ':\n    image: ' +
          (row['image'] if kind == 'release' else row['before']['imageId']) + '\n' for service, row in data['services'].items()))
    release.config_check(data)
    current(data)
    save('manifest.json', data)

def validate():
    data = state()
    current(data)
    runner = json.loads(docker('inspect', 'mbbs-regular-v2-runner'))[0]
    env = dict(value.split('=', 1) for value in runner['Config']['Env'])
    assert env['MBT_TEST_ISOLATED'] == '1' and env['NETSUITE_DIRECT_ACCESS_ENABLED'] == 'false'
    name = 'mbbs-purchase-release-' + uuid.uuid4().hex[:10]
    network, database = name + '-internal', name + '-db'
    checks = []
    check_out = RELEASE / 'checks'
    check_out.mkdir(exist_ok=True)
    def run(label, command, browser=False, worker=False):
        args = ['sudo', '-n', 'docker', 'run', '--rm', '--network', network, '--read-only',
                '--tmpfs', '/tmp:uid=1000,gid=1000,mode=1777', '--tmpfs', '/app/data:uid=1000,gid=1000,mode=0700']
        for key, value in {**env, 'DATABASE_URL': 'postgres://mbt_test:mbt_test_password@db:5432/mbt_test'}.items():
            args += ['-e', key + '=' + value]
        candidate = RELEASE / 'candidate-app'
        for folder in ['src', 'public', 'migrations']:
            args += ['-v', str(candidate / folder) + ':/app/' + folder + ':ro']
        if worker:
            args += ['-v', str(RELEASE / 'candidate-webhook-worker') + ':/app/worker:ro']
        for folder in ['tools', 'test']:
            args += ['-v', str(SERVER / folder) + ':/app/' + folder + ':ro']
        args += ['-v', str(candidate / 'package.json') + ':/app/package.json:ro',
                 '-v', str(check_out) + ':/app/test-artifacts',
                 '-v', str(check_out) + ':/app/test-artifacts/regular-stock-purchase']
        image = 'mbbs-regular-v2:e2e' if browser else 'mbbs-regular-v2:test'
        started = time.monotonic()
        with (check_out / (label + '.log')).open('wb') as log:
            result = subprocess.run(args + [image] + command, stdout=log, stderr=subprocess.STDOUT)
        checks.append({'layer': label, 'exitCode': result.returncode, 'seconds': round(time.monotonic() - started, 2)})
        save('candidate-checks.json', {'services': {service: row['candidateImageId'] for service, row in data['services'].items()}, 'layers': checks})
        print(json.dumps(checks[-1]), flush=True)
        assert result.returncode == 0, 'Inspect candidate check: ' + label
    try:
        docker('network', 'create', '--internal', network)
        db_image = json.loads(docker('inspect', 'mbbs-regular-v2-db-1'))[0]['Image']
        docker('run', '-d', '--name', database, '--network', network, '--network-alias', 'db',
               '--tmpfs', '/var/lib/postgresql', '-e', 'POSTGRES_DB=mbt_test', '-e', 'POSTGRES_USER=mbt_test',
               '-e', 'POSTGRES_PASSWORD=mbt_test_password', '-e', 'PGDATA=/var/lib/postgresql/data', db_image)
        for attempt in range(60):
            if subprocess.run(['sudo', '-n', 'docker', 'exec', database, 'pg_isready', '-U', 'mbt_test', '-d', 'mbt_test'], capture_output=True).returncode == 0:
                break
            time.sleep(.5)
        else:
            raise RuntimeError('Disposable database did not start')
        run('migrations', ['node', 'src/migrate.js'])
        run('regressions', ['node', 'tools/regular-stock-purchase-tests.mjs'])
        run('browser', ['node', 'tools/regular-stock-purchase-browser.mjs'], browser=True)
        run('worker-receipts', ['node', 'tools/regular-stock-purchase-worker-check.mjs'], worker=True)
        current(data)
        save('verified.json', {'passed': True, 'services': {service: row['candidateRuntime'] for service, row in data['services'].items()}, 'layers': checks})
    finally:
        subprocess.run(['sudo', '-n', 'docker', 'rm', '-f', database], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(['sudo', '-n', 'docker', 'network', 'rm', network], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def verified(data):
    value = json.loads((RELEASE / 'verified.json').read_text())
    assert value['passed'] and value['services'] == {service: row['candidateRuntime'] for service, row in data['services'].items()}, 'Candidate checks are stale'

def active_operations():
    return json.loads(release.database("""SELECT json_build_object(
      'operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),
      'driverExecuting',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing'),
      'specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'),
      'quantityApplying',(SELECT count(*) FROM sales_special_stock_cases WHERE quantity_review->>'status'='applying'),
      'stockTransferConfirming',(SELECT count(*) FROM sales_stock_transfers WHERE confirmation_status IN ('creating','approving','hydrating','printing')),
      'regularExecuting',(SELECT count(*) FROM regular_stock_handoffs WHERE status='executing'),
      'deliveryOperations',(SELECT count(*) FROM regular_stock_delivery_operations WHERE status IN ('queued','running')),
      'stockingExecuting',(SELECT count(*) FROM sales_stock_requests WHERE regular_details->'pickupTransfer'->>'status'='executing'),
      'scmExecuting',(SELECT count(*) FROM scm_smart_proposals WHERE status='executing'),
      'webhookRunning',(SELECT count(*) FROM netsuite_order_webhook_inbox WHERE status='running'))"""))

def migrate(data):
    path = 'migrations/' + MIGRATION
    sql = (RELEASE / 'candidate-app' / path).read_text()
    assert digest(sql.encode()) == data['services']['app']['sourceHashes'][path]
    before = json.loads(release.database("SELECT coalesce(json_agg(filename ORDER BY filename),'[]'::json) FROM schema_migrations"))
    if MIGRATION not in before:
        tables = [('sales_stock_requests','id'),('sales_stock_request_lines','id'),('scm_smart_proposals','id'),
                  ('scm_smart_proposal_lines','id'),('purchase_orders','netsuite_id'),('purchase_order_lines','id')]
        business = 'SELECT jsonb_object_agg(name,value) AS hashes FROM (' + ' UNION ALL '.join(
          "SELECT '" + table + "' AS name,jsonb_build_object('count',count(*),'hash',md5(COALESCE(string_agg(md5((to_jsonb(t)" +
          ("-'stocking_type'" if table=='sales_stock_request_lines' else '') + ")::text),'' ORDER BY " + key + "),''))) AS value FROM " + table + ' t'
          for table, key in tables) + ') hashed'
        output = release.database("BEGIN;\nSET TRANSACTION ISOLATION LEVEL REPEATABLE READ;\nSET LOCAL lock_timeout='5s';\nSET LOCAL statement_timeout='30s';\n"
          "SELECT pg_advisory_xact_lock(hashtextextended('schema-migration:" + MIGRATION + "',0));\n"
          'CREATE TEMP TABLE purchase_migration_before ON COMMIT DROP AS ' + business + ';\n' + sql + '\n'
          "DO $guard$ BEGIN IF (SELECT hashes FROM purchase_migration_before) IS DISTINCT FROM (" + business + ") THEN RAISE EXCEPTION 'Purchase migration altered business quantities or request/order data'; END IF; END $guard$;\n"
          "INSERT INTO schema_migrations(filename) VALUES('" + MIGRATION + "');\nSELECT json_build_object('businessDataUnchanged',true,'hashes',hashes) FROM purchase_migration_before;\nCOMMIT;")
        (RELEASE / 'migration.log').write_text(output + '\n')
    after = json.loads(release.database("SELECT coalesce(json_agg(filename ORDER BY filename),'[]'::json) FROM schema_migrations"))
    assert set(after) == set(before) | {MIGRATION}
    save('migration-result.json', {'applied': True, 'newlyApplied': MIGRATION not in before,
                                 'filename': MIGRATION, 'businessDataUnchanged': True, 'retainedOnRollback': True})

def verify():
    data = state()
    release.core.ready(data['services']['app']['candidateImageId'])
    for service, container in CONTAINERS.items():
        row = data['services'][service]
        after = metadata(container)
        assert after['imageId'] == row['candidateImageId']
        assert after['configuration'] == row['before']['configuration'], 'Runtime configuration changed'
        assert json.loads(docker('exec', container, 'node', '-e', HASH_SCRIPT)) == row['candidateRuntime']
        runtime = json.loads(docker('inspect', container))[0]
        assert runtime['State']['Running'] and runtime['RestartCount'] == 0
    assert {name: metadata(name) for name in DEPENDENCIES} == data['dependencies']
    public = {}
    for file in ['health', *[file for file in FILES if file.startswith('public/')]]:
        path = {'public/sales-stock-requests.html':'/sales/stock-requests','public/scm-stock-requests.html':'/scm/stock-requests','public/scm-smart.html':'/scm/smart'}.get(file,'/'+file.removeprefix('public/'))
        request = urllib.request.Request('https://test.mbbsoperation.com' + path, headers={'User-Agent':'Mozilla/5.0','Cache-Control':'no-cache'})
        with urllib.request.urlopen(request, timeout=30) as response:
            body = response.read()
            assert response.status == 200
        if file == 'health':
            assert json.loads(body)['ok'] is True
        else:
            if file.endswith('.html'):
                body = re.sub(rb'<script type="module" src="https://static\.cloudflareinsights\.com/beacon\.min\.js/[^>]+></script>\n', b'', body)
            assert digest(body) == data['services']['app']['sourceHashes'][file], 'Public asset differs: ' + file
        public[path] = {'status':200,'sha256':digest(body)}
    save('public-check.json', public)
    code = (SERVER / 'tools/regular-stock-purchase-live.mjs').read_text().replace("from '../src/", "from './src/")
    live = {service: json.loads(docker('exec','-i',container,'node','--input-type=module',input=code.encode())) for service, container in CONTAINERS.items()}
    auth = """import assert from 'node:assert/strict';
for(const [path,method] of [['/api/scm/stock-requests/alerts','GET'],['/api/scm/stock-requests/1/purchase-proposals','POST'],['/api/scm/stock-requests/1/purchase-release','POST']]){
const r=await fetch('http://127.0.0.1:3000'+path,{method,headers:{'Content-Type':'application/json'},...(method==='POST'?{body:'{}'}:{})});assert.equal(r.status,401,path);}
console.log(JSON.stringify({protectedEndpoints:3,anonymousStatus:401}));"""
    protection = json.loads(docker('exec','-i',CONTAINERS['app'],'node','--input-type=module',input=auth.encode()))
    save('live-check.json', live)
    result = {'deployed':True,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'site':'https://test.mbbsoperation.com','migration':MIGRATION,
              'images':{service:row['candidateImageId'] for service,row in data['services'].items()},
              'configurationPreserved':True,'databaseAndOllamaUnchanged':True,'completeSourceTreesVerified':True,
              'checks':live,'authorization':protection,'publicAssets':len(public),'netSuiteCalls':0,'orderWrites':0}
    save('result.json', result)
    print(json.dumps(result), flush=True)

def apply():
    data = state()
    current(data)
    verified(data)
    release.config_check(data)
    active = active_operations()
    save('active-before-release.json', active)
    assert not any(active.values()), 'Wait for active operations: ' + json.dumps(active)
    migrate(data)
    current(data)
    try:
        with (RELEASE / 'publish.log').open('wb') as log:
            subprocess.run(release.compose(data) + ['up','-d','--no-build','--no-deps','--pull','never',*CONTAINERS],
                           cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except Exception:
        with (RELEASE / 'rollback.log').open('wb') as log:
            subprocess.run(release.compose(data,'compose.rollback.yml') + ['up','-d','--no-build','--no-deps','--pull','never',*CONTAINERS],
                           cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        release.core.ready(data['services']['app']['before']['imageId'])
        save('rollback-result.json', {'rolledBack':True,'migrationRetained':True})
        raise

if __name__ == '__main__':
    {'capture':capture,'build':build,'validate':validate,'apply':apply,'verify':verify}[sys.argv[1]]()
