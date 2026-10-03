"""Scoped BOSS approval release based on the two independently deployed images."""
import base64
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

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
RELEASE = SERVER / 'deployments/boss-approvals-20261003'
EVIDENCE = SERVER / 'test-artifacts/boss-approvals'
MIGRATION = '261_boss_approvals.sql'
CONTAINERS = {'app': 'mbbs-operator-app-app-1', 'webhook-worker': 'mbbs-operator-app-webhook-worker-1'}
DEPENDENCIES = ['mbbs-operator-app-db-1', 'mbbs-operator-app-ollama-1']
EXISTING = ['src/server.js', 'src/auth-repository.js', 'src/netsuite.js',
            'src/netsuite-delayed-status-refresh-service.js', 'public/control.js',
            'public/app-sidebar.js', 'public/login.js', 'public/dispatch-auth.js',
            'public/service-worker.js', 'package.json', 'package-lock.json']
ADDED = ['src/account-email.js', *sorted(str(p.relative_to(SERVER)) for p in (SERVER / 'src').glob('boss-approval-*.js')),
         'public/boss.html', 'public/boss.css', 'public/boss.js', 'public/boss-admin.html', 'public/boss-admin.js',
         'migrations/' + MIGRATION]
FILES = sorted(EXISTING + ADDED + ['public/admin.html', 'public/login.html'])
spec = importlib.util.spec_from_file_location('boss_release_core', SERVER / 'tools/regular-stock-v2-deploy.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.RELEASE, core.CONTAINERS = RELEASE, CONTAINERS
docker, digest, metadata = core.docker, core.digest, core.metadata
TREE = """const fs=require('fs'),crypto=require('crypto'),out={};function walk(p){for(const e of fs.readdirSync(p,{withFileTypes:true})){const f=p+'/'+e.name;if(e.isDirectory())walk(f);else if(e.isFile())out[f]=crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')}}for(const p of ['src','public','migrations'])walk(p);for(const p of ['package.json','package-lock.json'])out[p]=crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');console.log(JSON.stringify(out));"""


def save(name, value):
    (RELEASE / name).write_text(json.dumps(value, indent=2) + '\n')


def state():
    return json.loads((RELEASE / 'manifest.json').read_text())


def tree(directory):
    result = core.files_at(directory)
    for name in ['package.json', 'package-lock.json']:
        result[name] = digest((directory / name).read_bytes())
    return result


def database(sql):
    return docker('exec', '-i', DEPENDENCIES[0], 'psql', '-U', 'mbbs_app', '-d', 'mbbs_yard',
                  '-XAt', '-v', 'ON_ERROR_STOP=1', input=sql.encode()).decode().strip()


def current(data):
    assert {name: metadata(name) for name in DEPENDENCIES} == data['dependencies'], 'A dependency changed'
    assert {file: digest((SERVER / file).read_bytes()) for file in FILES} == data['workspaceHashes'], 'Workspace feature files changed'
    for service, row in data['services'].items():
        assert metadata(CONTAINERS[service]) == row['before'], 'Running service changed: ' + service
        assert tree(RELEASE / ('candidate-' + service)) == row['tree'], 'Candidate changed: ' + service
        assert json.loads(docker('exec', CONTAINERS[service], 'node', '-e', TREE)) == row['beforeTree'], 'Live sources changed'


def apply_patch(directory, patch, name):
    (RELEASE / (name + '.patch')).write_text(patch)
    result = subprocess.run(['patch', '--batch', '--fuzz=0', '-p1', '-d', str(directory)],
                            input=patch, text=True, capture_output=True)
    (RELEASE / (name + '-patch.log')).write_text(result.stdout + result.stderr)
    assert result.returncode == 0, 'Scoped patch requires review: ' + name
    for path in directory.rglob('*.orig'):
        path.unlink()


def capture():
    os.umask(0o077)
    RELEASE.mkdir(exist_ok=False)
    tested = json.loads((EVIDENCE / 'source-hashes.json').read_text())
    assert all(digest((SERVER / file).read_bytes()) == value for file, value in tested.items()), 'Implementation changed since verification'
    data = {'services': {}, 'dependencies': {name: metadata(name) for name in DEPENDENCIES},
            'workspaceHashes': {file: digest((SERVER / file).read_bytes()) for file in FILES}}
    for service, container in CONTAINERS.items():
        before = metadata(container)
        baseline = RELEASE / ('before-' + service)
        baseline.mkdir()
        for name in ['src', 'public', 'migrations', 'package.json', 'package-lock.json']:
            with tarfile.open(fileobj=io.BytesIO(docker('cp', container + ':/app/' + name, '-'))) as archive:
                archive.extractall(baseline, filter='data')
        candidate = RELEASE / ('candidate-' + service)
        shutil.copytree(baseline, candidate)
        if service == 'app':
            patch = ''.join(''.join(difflib.unified_diff((EVIDENCE / 'baseline' / file).read_text().splitlines(True),
                (SERVER / file).read_text().splitlines(True), fromfile='a/' + file, tofile='b/' + file)) for file in EXISTING)
            apply_patch(candidate, patch, service)
            for file in ADDED:
                assert not (baseline / file).exists(), 'New feature file already deployed: ' + file
                shutil.copy2(SERVER / file, candidate / file)
            for file, assets in [('public/admin.html', ['app-sidebar.js', 'control.js']), ('public/login.html', ['login.js'])]:
                text = (candidate / file).read_text()
                for asset in assets:
                    text, count = re.subn('/' + re.escape(asset) + r'\?v=[^"\s]+', '/' + asset + '?v=20261003-boss-1', text)
                    assert count == 1, asset
                (candidate / file).write_text(text)
            expected = FILES
        else:
            # Worker imports its own server.js and only needs the SOT enqueue.
            # The app is the sole delayed-status and BOSS runtime owner.
            file = 'src/server.js'
            text = (candidate / file).read_text()
            anchor = '  if (type === "sales_order" && isExcludedSalesOrderRef(payload.tranid)) {\n'
            assert text.count(anchor) == 1
            addition = (SERVER / file).read_text().split(anchor, 1)[1].split('    await writeAudit({', 1)[0]
            assert addition.startswith('    if (scheduleDelayedStatus) {') and addition.count('enqueueDelayedStatusRefresh') == 1
            (candidate / file).write_text(text.replace(anchor, anchor + addition, 1))
            expected = [file]
        old, new = tree(baseline), tree(candidate)
        changed = sorted(file for file in new if old.get(file) != new[file])
        assert changed == sorted(expected), changed
        assert set(old) <= set(new), 'Unexpected source deletion'
        data['services'][service] = {'before': before, 'beforeTree': old, 'tree': new, 'changed': changed,
            'sourceHashes': {file: new[file] for file in changed}, 'image': 'mbbs-operator-app:boss-approvals-' + service + '-20261003'}
        patch = ''.join(''.join(difflib.unified_diff((baseline / file).read_text().splitlines(True) if (baseline / file).exists() else [],
            (candidate / file).read_text().splitlines(True), fromfile='a/' + file, tofile='b/' + file)) for file in changed)
        (RELEASE / (service + '-release.patch')).write_text(patch)
    save('manifest.json', data)
    current(data)
    print(json.dumps({'captured': {key: {'parent': row['before']['image'], 'changedFiles': row['changed']} for key, row in data['services'].items()}}), flush=True)


def prepare():
    data = state()
    current(data)
    # Fetch only the locked dependency and verify its registry integrity before extraction.
    lock = json.loads((RELEASE / 'candidate-app/package-lock.json').read_text())['packages']['node_modules/nodemailer']
    archive_file = RELEASE / 'nodemailer.tgz'
    if not archive_file.exists():
        archive_file.write_bytes(urllib.request.urlopen(lock['resolved'], timeout=30).read())
    assert 'sha512-' + base64.b64encode(hashlib.sha512(archive_file.read_bytes()).digest()).decode() == lock['integrity']
    for service, row in data['services'].items():
        stage = RELEASE / ('stage-' + service)
        for file in row['changed']:
            target = stage / 'overlay' / file
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(RELEASE / ('candidate-' + service) / file, target)
        if service == 'app':
            dependency = stage / 'dependency'
            dependency.mkdir(exist_ok=True)
            with tarfile.open(archive_file) as archive:
                archive.extractall(dependency, filter='data')
            package = json.loads((dependency / 'package/package.json').read_text())
            assert package['version'] == '10.0.13' and not package.get('dependencies')
        parent = 'mbbs-operator-app:boss-parent-' + service + '-' + row['before']['imageId'].split(':')[1][:12]
        docker('tag', row['before']['imageId'], parent)
        (stage / 'Dockerfile').write_text('FROM ' + parent + '\nCOPY --chown=node:node overlay/ /app/\n' +
            ('COPY --chown=node:node dependency/package/ /app/node_modules/nodemailer/\n' if service == 'app' else ''))
        with (RELEASE / (service + '-build.log')).open('wb') as log:
            subprocess.run(['sudo', '-n', 'docker', 'build', '--network', 'none', '--pull=false', '-t', row['image'], str(stage)],
                           stdout=log, stderr=subprocess.STDOUT, check=True)
        row['candidateImageId'] = docker('image', 'inspect', '--format', '{{.Id}}', row['image']).decode().strip()
        assert json.loads(docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', row['image'], '-e', TREE)) == row['tree']
        docker('run', '--rm', '--network', 'none', '-e', 'MBBS_ENV_FILE=/nonexistent', '-e', 'NETSUITE_DIRECT_ACCESS_ENABLED=false',
               '-e', 'NETSUITE_MIRROR_ROLE=disabled', '--entrypoint', 'node', row['image'], '--input-type=module', '-e',
               "await import('./src/server.js');" + ("const {default:n}=await import('nodemailer');if(!n.createTransport)throw Error('SMTP dependency missing');" if service == 'app' else '') + 'process.exit(0);')
    for kind in ['release', 'rollback']:
        (RELEASE / ('compose.' + kind + '.yml')).write_text('services:\n' + ''.join('  ' + service + ':\n    image: ' +
            (row['image'] if kind == 'release' else row['before']['imageId']) + '\n' for service, row in data['services'].items()))
    core.config_check(data)
    save('manifest.json', data)
    current(data)
    print(json.dumps({'prepared': {key: row['candidateImageId'] for key, row in data['services'].items()}, 'lockedSmtpDependencyVerified': True}), flush=True)


def checks():
    data = state()
    current(data)
    network, db, runner = 'mbbs-boss-release-test', 'mbbs-boss-release-db', 'mbbs-boss-release-runner'
    docker('network', 'create', '--internal', network)
    docker('run', '-d', '--name', db, '--network', network, '--network-alias', 'db',
           '-e', 'POSTGRES_USER=mbt_test', '-e', 'POSTGRES_PASSWORD=boss_release_only', '-e', 'POSTGRES_DB=mbt_test',
           '--tmpfs', '/var/lib/postgresql', 'postgres:18-alpine')
    for _ in range(30):
        result = subprocess.run(['sudo', '-n', 'docker', 'exec', db, 'pg_isready', '-U', 'mbt_test', '-d', 'mbt_test'], capture_output=True)
        if result.returncode == 0:
            break
        time.sleep(1)
    assert result.returncode == 0
    env = ['-e', 'NODE_ENV=test', '-e', 'MBT_TEST_ISOLATED=1', '-e', 'MBBS_ENV_FILE=/nonexistent',
           '-e', 'DATABASE_URL=postgres://mbt_test:boss_release_only@db:5432/mbt_test',
           '-e', 'NETSUITE_DIRECT_ACCESS_ENABLED=false', '-e', 'NETSUITE_MIRROR_ROLE=disabled',
           '-e', 'SAMSARA_WRITES_ENABLED=false', '-e', 'MBT_NETSUITE_WRITES_ENABLED=false',
           '-e', 'SMART_SCM_LIVE_EXECUTION_ENABLED=false', '-e', 'SALES_PUBLIC_ACCESS_ENABLED=false']
    mounts = []
    for name in ['src', 'public', 'migrations', 'package.json', 'package-lock.json']:
        mounts += ['-v', str(RELEASE / 'candidate-app' / name) + ':/app/' + name + ':ro']
    for name in ['test', 'tools']:
        mounts += ['-v', str(SERVER / name) + ':/app/' + name + ':ro']
    mounts += ['-v', str(RELEASE / 'candidate-app') + ':/workspace:ro',
               '-v', str(RELEASE / 'stage-app/dependency/package') + ':/app/node_modules/nodemailer:ro']
    docker('run', '-d', '--name', runner, '--network', network, '--read-only',
           '--tmpfs', '/tmp:mode=1777', '--tmpfs', '/app/data:mode=1777', '--tmpfs', '/app/test-artifacts:mode=1777',
           *env, *mounts, '-e', 'PLAYWRIGHT_BROWSERS_PATH=/ms-playwright', '--entrypoint', 'sleep', 'mbbs-regular-v2:e2e', 'infinity')
    assert json.loads(docker('exec', runner, 'node', '-e', TREE)) == data['services']['app']['tree']
    versions = "const fs=require('fs'),p=require('./package.json'),o={};for(const n of Object.keys(p.dependencies))o[n]=JSON.parse(fs.readFileSync('node_modules/'+n+'/package.json')).version;console.log(JSON.stringify(o));"
    runtime_versions = json.loads(docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', data['services']['app']['image'], '-e', versions))
    test_versions = json.loads(docker('exec', runner, 'node', '-e', versions))
    assert test_versions == runtime_versions, 'Runtime dependency versions differ from the test image'
    save('dependency-versions.json', runtime_versions)
    (RELEASE / 'candidate-migrations.log').write_bytes(docker('exec', runner, 'node', 'src/migrate.js'))
    tests = re.findall(r"'(test/[^']+\.test\.js)'", (SERVER / 'tools/boss-gauntlet.mjs').read_text().split('const files=', 1)[0])
    with (RELEASE / 'candidate-tests.log').open('wb') as output:
        result = subprocess.run(['sudo', '-n', 'docker', 'exec', runner, 'node', '--test', '--test-concurrency=1', *tests],
                                stdout=output, stderr=subprocess.STDOUT, timeout=180)
    log = (RELEASE / 'candidate-tests.log').read_text()
    counts = {key: int(re.search(r'^# ' + key + r' (\d+)$', log, re.M).group(1)) for key in ['tests', 'pass', 'fail']}
    assert result.returncode == 0 and counts == {'tests': 94, 'pass': 94, 'fail': 0}, log[-4000:]
    # Test the worker's own independently based server and retained SOT suppression.
    worker_probe = """import assert from 'node:assert/strict';import {processNetSuiteOrderWebhook} from './src/server.js';import {query,closeDb} from './src/db.js';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
try {for(const [id,schedule] of [[982100001,true],[982100002,false]]){
 const before=Date.now();const result=await processNetSuiteOrderWebhook({recordType:'salesorder',id,tranid:'SOT-BOSS-RELEASE-'+id,status:'A'},{scheduleDelayedStatus:schedule});
 assert.equal(result.ignored,true);assert.equal((await query('SELECT count(*)::int n FROM sales_orders WHERE netsuite_id=$1',[id])).rows[0].n,0);
 assert.equal((await query('SELECT count(*)::int n FROM boss_approval_sources WHERE order_id=$1',[id])).rows[0].n,0);
 const jobs=(await query('SELECT * FROM netsuite_delayed_status_refresh_jobs WHERE netsuite_order_id=$1',[id])).rows;
 assert.equal(jobs.length,schedule?1:0);if(schedule)assert(new Date(jobs[0].available_at).getTime()>=before+9900);
} console.log(JSON.stringify({workerSotDelay:true,operationalIntakeExcluded:true,noPrematureApproval:true,schedulingOptOutPreserved:true}));}finally{await closeDb();}"""
    worker = json.loads(docker('run', '--rm', '-i', '--network', network, *env, '--entrypoint', 'node',
                       data['services']['webhook-worker']['image'], '--input-type=module', input=worker_probe.encode()))
    save('worker-checks.json', worker)
    startup_checks()


def startup_checks():
    data = state()
    current(data)
    network, db = 'mbbs-boss-release-test', 'mbbs-boss-release-db'
    log = (RELEASE / 'candidate-tests.log').read_text()
    counts = {key: int(re.search(r'^# ' + key + r' (\d+)$', log, re.M).group(1)) for key in ['tests', 'pass', 'fail']}
    assert counts == {'tests': 94, 'pass': 94, 'fail': 0}
    worker = json.loads((RELEASE / 'worker-checks.json').read_text())
    env = ['-e', 'NODE_ENV=test', '-e', 'MBT_TEST_ISOLATED=1', '-e', 'MBBS_ENV_FILE=/nonexistent',
           '-e', 'DATABASE_URL=postgres://mbt_test:boss_release_only@db:5432/mbt_boot',
           '-e', 'NETSUITE_DIRECT_ACCESS_ENABLED=false', '-e', 'NETSUITE_MIRROR_ROLE=disabled',
           '-e', 'SAMSARA_WRITES_ENABLED=false', '-e', 'MBT_NETSUITE_WRITES_ENABLED=false',
           '-e', 'SMART_SCM_LIVE_EXECUTION_ENABLED=false', '-e', 'SALES_PUBLIC_ACCESS_ENABLED=false']
    # Rehearse actual application startup on a fresh disposable schema.
    docker('exec', db, 'createdb', '-U', 'mbt_test', 'mbt_boot')
    docker('run', '--rm', '--network', network, *env, '--entrypoint', 'node', data['services']['app']['image'], 'src/migrate.js')
    boot = 'mbbs-boss-release-boot'
    docker('run', '-d', '--name', boot, '--network', network, *env, '--tmpfs', '/app/data:mode=1777', data['services']['app']['image'])
    try:
        for _ in range(45):
            ready = subprocess.run(['sudo', '-n', 'docker', 'exec', boot, 'node', '-e',
                "fetch('http://127.0.0.1:3000/health').then(async r=>{if(!r.ok||!(await r.json()).ok)process.exit(1)}).catch(()=>process.exit(1))"], capture_output=True)
            if ready.returncode == 0:
                break
            time.sleep(1)
        assert ready.returncode == 0, 'Candidate startup failed'
        # Let the BOSS runtime execute its initial polling lanes while disabled.
        time.sleep(6)
        boot_probe = """import assert from 'node:assert/strict';import {query,closeDb} from './src/db.js';
try {assert.equal((await query('SELECT enabled FROM boss_approval_settings')).rows[0].enabled,false);
 for(const t of ['boss_approval_commands','boss_approval_requests','boss_approval_notifications'])assert.equal((await query('SELECT count(*)::int n FROM '+t)).rows[0].n,0);
 for(const path of ['/api/boss/requests','/api/boss/notifications','/api/admin/boss-approvals'])assert.equal((await fetch('http://127.0.0.1:3000'+path)).status,401);
 console.log(JSON.stringify({actualImageBoot:true,defaultDisabled:true,protectedEndpoints:true}));}finally{await closeDb();}"""
        startup = json.loads(docker('exec', '-i', boot, 'node', '--input-type=module', input=boot_probe.encode()))
        boot_log = docker('logs', boot, stderr=subprocess.STDOUT).decode()
        (RELEASE / 'candidate-startup.log').write_text(boot_log)
        assert not re.search(r'BOSS .+worker:|relation .+ does not exist|ERR_MODULE_NOT_FOUND', boot_log)
        save('startup-checks.json', startup)
    finally:
        docker('rm', '-f', boot)
    save('candidate-checks.json', {'passed': True, 'images': {key: row['candidateImageId'] for key, row in data['services'].items()},
         'runtimeDependencyVersionsMatch': True, **counts, **worker, **startup})
    current(data)
    print(json.dumps({'candidateChecksPassed': True, **counts, **worker, **startup}), flush=True)


def backup():
    os.umask(0o077)
    data = state()
    current(data)
    for name, args in [('schema-before.dump', ['--schema-only']), ('migrations-before.dump', ['--table=public.schema_migrations'])]:
        destination = RELEASE / name
        assert not destination.exists(), 'Backup already exists'
        with destination.open('wb') as output:
            subprocess.run(['sudo', '-n', 'docker', 'exec', DEPENDENCIES[0], 'pg_dump', '-U', 'mbbs_app', '-d', 'mbbs_yard',
                            '--format=custom', *args], stdout=output, check=True)
        toc = docker('exec', '-i', DEPENDENCIES[0], 'pg_restore', '--list', input=destination.read_bytes())
        assert b'schema_migrations' in toc
        (RELEASE / (name + '.toc')).write_bytes(toc)
    # Restore the captured schema into the disposable database and rehearse the
    # exact narrow migration. No production records or credentials are copied.
    db = 'mbbs-boss-release-db'
    docker('exec', db, 'createdb', '-U', 'mbt_test', 'mbt_schema')
    restored = subprocess.run(['sudo', '-n', 'docker', 'exec', '-i', db, 'pg_restore', '-U', 'mbt_test', '-d', 'mbt_schema',
                              '--no-owner', '--no-acl', '--exit-on-error'], input=(RELEASE / 'schema-before.dump').read_bytes(), capture_output=True)
    (RELEASE / 'schema-restore.log').write_bytes(restored.stdout + restored.stderr)
    assert restored.returncode == 0, 'Captured schema restore failed'
    sql = (RELEASE / 'candidate-app/migrations' / MIGRATION).read_text()
    probe = 'BEGIN;\n' + sql + "\nINSERT INTO schema_migrations(filename) VALUES('" + MIGRATION + "');\nROLLBACK;\n" + \
        "DO $$ BEGIN IF to_regclass('public.boss_approval_settings') IS NOT NULL THEN RAISE EXCEPTION 'Rollback failed'; END IF; END $$;\n" + \
        'BEGIN;\n' + sql + '\nCOMMIT;\n' + \
        "DO $$ BEGIN IF (SELECT enabled FROM boss_approval_settings WHERE id=1) OR (SELECT count(*) FROM boss_approval_principals)<>3 " + \
        "THEN RAISE EXCEPTION 'Invalid defaults'; END IF; END $$;"
    (RELEASE / 'schema-migration-rehearsal.log').write_bytes(docker('exec', '-i', db, 'psql', '-U', 'mbt_test', '-d', 'mbt_schema',
        '-XAt', '-v', 'ON_ERROR_STOP=1', input=probe.encode()))
    save('backup-result.json', {'schemaRestored': True, 'migrationRollbackRehearsed': True, 'migrationCommitRehearsed': True,
         'previousImagesRetained': {key: row['before']['imageId'] for key, row in data['services'].items()},
         'hashes': {name: digest((RELEASE / name).read_bytes()) for name in ['schema-before.dump', 'migrations-before.dump']}})
    current(data)
    print(json.dumps({'rollbackPrepared': True, 'capturedSchemaMigrationRehearsalPassed': True}), flush=True)


def active_work():
    return json.loads(database("""SELECT json_build_object(
      'operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),
      'driverExecuting',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing'),
      'specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'),
      'quantityApplying',(SELECT count(*) FROM sales_special_stock_cases WHERE quantity_review->>'status'='applying'),
      'stockTransferConfirming',(SELECT count(*) FROM sales_stock_transfers WHERE confirmation_status IN ('creating','approving','hydrating','printing')),
      'scmExecuting',(SELECT count(*) FROM scm_smart_proposals WHERE status='executing'),
      'regularExecuting',(SELECT count(*) FROM regular_stock_handoffs WHERE status='executing'),
      'webhookRunning',(SELECT count(*) FROM netsuite_order_webhook_inbox WHERE status='running'))"""))


def verify():
    data = state()
    core.core.ready(data['services']['app']['candidateImageId'])
    for service, row in data['services'].items():
        actual = metadata(CONTAINERS[service])
        assert actual['imageId'] == row['candidateImageId'], 'Incorrect image: ' + service
        assert actual['configuration'] == row['before']['configuration'], 'Configuration changed: ' + service
        assert json.loads(docker('exec', CONTAINERS[service], 'node', '-e', TREE)) == row['tree'], 'Unexpected source change: ' + service
        runtime = json.loads(docker('inspect', CONTAINERS[service]))[0]
        assert runtime['State']['Running'] and runtime['RestartCount'] == 0
    assert {name: metadata(name) for name in DEPENDENCIES} == data['dependencies']
    assert database("SELECT count(*) FROM schema_migrations WHERE filename='" + MIGRATION + "'") == '1'
    probe = r"""import assert from 'node:assert/strict';import crypto from 'node:crypto';
import {query,closeDb} from './src/db.js';import {config} from './src/config.js';import {createBossMailer} from './src/boss-approval-mail.js';
const hashes=HASHES, bases=['http://127.0.0.1:3000','https://test.mbbsoperation.com'];
try {
 for(const base of bases){
  const health=await fetch(base+'/health',{signal:AbortSignal.timeout(20000)});assert.equal(health.status,200);assert.equal((await health.json()).ok,true);
  for(const [file,hash] of Object.entries(hashes)){
   if(!file.startsWith('public/'))continue;
   const path=({'public/admin.html':'/admin/accounts','public/login.html':'/login.html','public/boss.html':'/boss','public/boss-admin.html':'/admin/boss-approvals'})[file]||'/'+file.slice(7);
   const response=await fetch(base+path,{headers:{'Cache-Control':'no-cache','User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(20000)});assert.equal(response.status,200,path);
   const body=(await response.text()).replace(/<script type="module" src="https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js\/[^>]+><\/script>\n/g,'');
   assert.equal(crypto.createHash('sha256').update(body).digest('hex'),hash,path);
  }
  for(const path of ['/api/boss/requests','/api/boss/notifications','/api/admin/boss-approvals']){
   assert.equal((await fetch(base+path,{signal:AbortSignal.timeout(20000)})).status,401,path);
  }
 }
 const settings=(await query('SELECT enabled FROM boss_approval_settings WHERE id=1')).rows[0];assert.equal(settings.enabled,false);
 const mapped=Number((await query('SELECT count(*) n FROM boss_approval_principals WHERE operator_id IS NOT NULL')).rows[0].n);assert.equal(mapped,0);
 for(const table of ['boss_approval_requests','boss_approval_commands','boss_approval_notifications'])assert.equal(Number((await query('SELECT count(*) n FROM '+table)).rows[0].n),0);
 const email=await query("SELECT count(*)::int n FROM information_schema.columns WHERE table_schema='public' AND table_name='operators' AND column_name='email'");assert.equal(email.rows[0].n,1);
 const mail=createBossMailer().readiness();assert.equal(mail.senderName,'MBBS System');assert.equal(mail.senderAddress,'warehouse@mrbininc.com');
 console.log(JSON.stringify({health:true,publicAssetsVerified:true,anonymousAccessDenied:true,approvalsEnabled:false,accountsEmailAvailable:true,
  bossAccountsMapped:mapped,smtpConfigured:mail.configured,senderName:mail.senderName,senderAddress:mail.senderAddress,applicationBaseUrl:config.appBaseUrl}));
}finally{await closeDb();}"""
    checks = json.loads(docker('exec', '-i', CONTAINERS['app'], 'node', '--input-type=module',
                 input=probe.replace('HASHES', json.dumps(data['services']['app']['sourceHashes'])).encode()))
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'images': {key: row['candidateImageId'] for key, row in data['services'].items()},
              'configurationPreserved': True, 'databaseAndOllamaContainersPreserved': True,
              'migration': MIGRATION, 'sourceTreesVerified': {key: len(row['tree']) for key, row in data['services'].items()}, **checks}
    save('result.json', result)
    print(json.dumps(result), flush=True)


def apply():
    os.umask(0o077)
    data = state()
    current(data)
    checks = json.loads((RELEASE / 'candidate-checks.json').read_text())
    assert checks['passed'] and checks['images'] == {key: row['candidateImageId'] for key, row in data['services'].items()}
    backups = json.loads((RELEASE / 'backup-result.json').read_text())
    assert backups['schemaRestored'] and backups['migrationRollbackRehearsed'] and backups['migrationCommitRehearsed']
    assert all(digest((RELEASE / name).read_bytes()) == value for name, value in backups['hashes'].items())
    core.config_check(data)
    active = active_work()
    save('active-before-release.json', active)
    assert not any(active.values()), 'Wait for active operations: ' + json.dumps(active)
    if database("SELECT count(*) FROM schema_migrations WHERE filename='" + MIGRATION + "'") == '0':
        assert database("SELECT to_regclass('public.boss_approval_settings')") == '', 'Untracked BOSS schema'
        sql = (RELEASE / 'candidate-app/migrations' / MIGRATION).read_text()
        # Preserve every existing account field while adding the new email column.
        transaction = "BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';\n" + \
            "LOCK TABLE operators IN ACCESS EXCLUSIVE MODE;\nCREATE TEMP TABLE boss_accounts_before ON COMMIT DROP AS SELECT id,md5(to_jsonb(o)::text) fingerprint FROM operators o;\n" + sql + \
            "\nDO $$ BEGIN IF EXISTS(SELECT 1 FROM boss_accounts_before b FULL JOIN operators o USING(id) WHERE b.fingerprint IS DISTINCT FROM md5((to_jsonb(o)-'email')::text)) " + \
            "THEN RAISE EXCEPTION 'Existing account data changed'; END IF; END $$;\n" + \
            "INSERT INTO schema_migrations(filename) VALUES('" + MIGRATION + "'); COMMIT;"
        (RELEASE / 'migration.log').write_text(database(transaction))
        save('migration-result.json', {'applied': MIGRATION, 'transactional': True, 'existingAccountFieldsPreserved': True})
    else:
        recorded = json.loads((RELEASE / 'migration-result.json').read_text())
        assert recorded['applied'] == MIGRATION and recorded['existingAccountFieldsPreserved']
        assert database('SELECT enabled FROM boss_approval_settings WHERE id=1') == 'f', 'Approval configuration changed'
    current(data)
    assert not any(active_work().values()), 'New active operation; migration applied safely, defer service switch'
    print(json.dumps({'cutoverStarted': datetime.datetime.now(datetime.timezone.utc).isoformat()}), flush=True)
    try:
        with (RELEASE / 'publish.log').open('wb') as log:
            subprocess.run(core.compose(data) + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app', 'webhook-worker'],
                           cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except Exception:
        with (RELEASE / 'rollback.log').open('wb') as log:
            subprocess.run(core.compose(data, 'compose.rollback.yml') + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app', 'webhook-worker'],
                           cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        core.core.ready(data['services']['app']['before']['imageId'])
        save('rollback-result.json', {'previousImagesRestored': True, 'additiveSchemaRetained': True})
        raise


def resume_after_rollback():
    data = state()
    assert json.loads((RELEASE / 'rollback-result.json').read_text())['previousImagesRestored']
    save('initial-manifest.json', data)
    for service, row in data['services'].items():
        actual = metadata(CONTAINERS[service])
        assert actual['imageId'] == row['before']['imageId'] and actual['configuration'] == row['before']['configuration']
        assert json.loads(docker('exec', CONTAINERS[service], 'node', '-e', TREE)) == row['beforeTree']
        row['before'] = actual
    assert database('SELECT enabled FROM boss_approval_settings WHERE id=1') == 'f'
    assert database('SELECT count(*) FROM boss_approval_commands') == '0'
    save('manifest.json', data)
    current(data)
    print(json.dumps({'previousImagesAndSourcesVerified': True, 'readyToResume': True}), flush=True)


if __name__ == '__main__':
    {'capture': capture, 'prepare': prepare, 'checks': checks, 'startup-checks': startup_checks,
     'backup': backup, 'apply': apply, 'verify': verify, 'resume-after-rollback': resume_after_rollback}[sys.argv[1]]()
