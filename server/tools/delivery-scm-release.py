"""Deploy the two authorized overlays on the live image with app-only rollback."""
import atexit
import datetime
import difflib
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import threading
import time
import urllib.request

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
RELEASE = SERVER / 'deployments/delivery-scm-20261006'
APP = 'mbbs-operator-app-app-1'
DB = 'mbbs-operator-app-db-1'
DEPENDENCIES = [DB, 'mbbs-operator-app-webhook-worker-1', 'mbbs-operator-app-ollama-1']
IMAGE = 'mbbs-operator-app:delivery-scm-20261006'
ROLLBACK = IMAGE + '-rollback'
MIGRATION = '265_delivery_requests.sql'
SCM_FILES = ['src/smart-scm-planning-repository.js', 'public/scm-smart-proposals.js', 'public/scm-smart.html']
READ_NAME = 'mbbs-delivery-scm-baseline-reader'
CHECK_NAME = 'mbbs-delivery-scm-image-check'
HASH_SCRIPT = """const fs=require('node:fs'),c=require('node:crypto'),result={};
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=dir+'/'+e.name;
if(e.isDirectory())walk(p);else if(e.isFile())result[p]=c.createHash('sha256').update(fs.readFileSync(p)).digest('hex');}}
for(const dir of ['src','public','migrations'])walk(dir);console.log(JSON.stringify(result));"""


def sha(value):
    return hashlib.sha256(value).hexdigest()


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def save(name, value):
    (RELEASE / name).write_text(json.dumps(value, indent=2) + '\n')


def docker(*args, **kwargs):
    return subprocess.check_output(['docker', *args], **kwargs)


def state():
    return json.loads((RELEASE / 'manifest.json').read_text())


def files_at(root):
    return {str(p.relative_to(root)): sha(p.read_bytes()) for directory in ['src', 'public', 'migrations']
            for p in sorted((root / directory).rglob('*')) if p.is_file()}


def metadata(name):
    row = json.loads(docker('inspect', name))[0]
    config = {k: row['Config'].get(k) for k in ['Cmd', 'Entrypoint', 'User', 'WorkingDir', 'Healthcheck']}
    config['env'] = sorted(row['Config'].get('Env', []))
    config['mounts'] = sorted(row['Mounts'], key=lambda item: item['Destination'])
    config['host'] = {k: row['HostConfig'].get(k) for k in ['PortBindings', 'RestartPolicy', 'Memory', 'MemorySwap',
        'MemoryReservation', 'NanoCpus', 'PidsLimit', 'Init', 'ReadonlyRootfs', 'Tmpfs', 'SecurityOpt', 'CapDrop']}
    labels = row['Config']['Labels']
    return {'id': row['Id'], 'imageId': row['Image'], 'configuration': sha(json.dumps(config, sort_keys=True).encode()),
            'configFiles': labels['com.docker.compose.project.config_files'],
            'projectDirectory': labels['com.docker.compose.project.working_dir']}


def cleanup_manual():
    for name in [READ_NAME, CHECK_NAME]:
        subprocess.run(['docker', 'rm', '-fv', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for args, filename in [(['ps'], 'docker-ps.log'), (['ps', '-a'], 'docker-ps-a.log')]:
        (RELEASE / filename).write_bytes(docker(*args, '--format', '{{.Names}} {{.Status}}'))


def bounded(image, name, *args):
    assert not docker('ps', '-a', '--filter', 'name=^/' + name + '$', '--format', '{{.ID}}').strip()
    return docker('run', '--rm', '--name', name, '--init', '--network', 'none', '--read-only',
                  '--label', 'com.mbbs.lifecycle=disposable-test', '--cgroup-parent=mbbs-tests.slice',
                  '--memory=512m', '--memory-swap=512m', '--cpus=0.5', '--pids-limit=128',
                  '--tmpfs', '/tmp:uid=1000,gid=1000,mode=1777,size=32m',
                  '--tmpfs', '/app/data:uid=1000,gid=1000,mode=0700,size=16m',
                  '--env', 'NODE_ENV=test', '--env', 'MBBS_ENV_FILE=/nonexistent',
                  '--env', 'NETSUITE_DIRECT_ACCESS_ENABLED=false', '--env', 'NETSUITE_MIRROR_ROLE=disabled',
                  '--entrypoint', args[0], image, *args[1:])


def apply_patch(candidate, patch, label):
    (RELEASE / (label + '.patch')).write_text(patch)
    result = subprocess.run(['patch', '--batch', '--fuzz=0', '-p1', '-d', str(candidate)],
                            input=patch, text=True, capture_output=True)
    (RELEASE / (label + '-patch.log')).write_text(result.stdout + result.stderr)
    assert result.returncode == 0, 'Scoped patch needs review: ' + label
    for p in candidate.rglob('*.orig'):
        p.unlink()


def capture():
    os.umask(0o077)
    RELEASE.mkdir(parents=True, exist_ok=False)
    atexit.register(cleanup_manual)
    before = metadata(APP)
    dependencies = [metadata(name) for name in DEPENDENCIES]
    delivery = SERVER / 'test-artifacts/delivery-requests'
    original = json.loads((delivery / 'source-baseline.json').read_text())['files']
    approved = json.loads((delivery / 'source-final.json').read_text())['files']
    comparison = json.loads((delivery / 'regression-comparison.json').read_text())
    assert not any(comparison[k] for k in ['newFailingFiles', 'newTypeErrors', 'newLintErrors'])
    delivery_files = sorted(n for n in approved if n.startswith(('src/', 'public/', 'migrations/'))
                            and approved[n] != original.get(n))
    assert len(delivery_files) == 23
    assert all(sha((SERVER / n).read_bytes()) == approved[n] for n in delivery_files), 'Delivery source changed'
    scm = SERVER / 'test-artifacts/scm-ultimate-packing-20261005'
    scm_manifest = json.loads((scm / 'final/source-manifest.json').read_text())
    scm_capture = json.loads((scm / 'capture.json').read_text())
    assert scm_capture['baseImageId'] == before['imageId'], 'SCM baseline image changed'
    assert all(row['exitCode'] == 0 for row in json.loads((scm / 'final/stages.json').read_text()))
    assert all(sha((SERVER / n).read_bytes()) == scm_manifest['sourceHashes'][n] for n in SCM_FILES)
    baseline = RELEASE / 'before'
    baseline.mkdir()
    archive = docker('exec', APP, 'tar', '-cf', '-', '-C', '/app',
                     'src', 'public', 'migrations', 'package.json', 'package-lock.json')
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        stream.extractall(baseline, filter='data')
    assert metadata(APP) == before
    feature_base = RELEASE / 'delivery-before'
    feature_base.mkdir()
    existing = [n for n in delivery_files if n in original]
    try:
        archive = bounded('mbbs-delivery-requests:baseline', READ_NAME, 'tar', '-cf', '-', '-C', '/app', *existing)
        with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
            stream.extractall(feature_base, filter='data')
    finally:
        cleanup_manual()
    assert all(sha((feature_base / n).read_bytes()) == original[n] for n in existing), 'Delivery baseline differs'
    candidate = RELEASE / 'candidate'
    shutil.copytree(baseline, candidate)
    patch = ''
    for n in existing:
        patch += ''.join(difflib.unified_diff((feature_base / n).read_text().splitlines(True),
            (SERVER / n).read_text().splitlines(True), fromfile='a/' + n, tofile='b/' + n, n=3))
    apply_patch(candidate, patch, 'delivery')
    for n in delivery_files:
        if n not in original:
            assert not (candidate / n).exists(), 'New delivery file already exists: ' + n
            shutil.copy2(SERVER / n, candidate / n)
    patch = ''
    for n in SCM_FILES:
        assert sha((baseline / n).read_bytes()) == scm_capture['sourceHashes'][n], 'SCM live source changed: ' + n
        patch += ''.join(difflib.unified_diff((scm / 'baseline' / n).read_text().splitlines(True),
            (SERVER / n).read_text().splitlines(True), fromfile='a/' + n, tofile='b/' + n, n=3))
    apply_patch(candidate, patch, 'scm')
    before_tree, after_tree = files_at(baseline), files_at(candidate)
    changed = sorted(n for n in before_tree.keys() | after_tree.keys() if before_tree.get(n) != after_tree.get(n))
    assert changed == sorted(delivery_files + SCM_FILES), 'Unexpected release scope'
    data = {'capturedAt': now(), 'app': before, 'dependencies': dependencies, 'files': changed,
            'beforeTree': before_tree, 'candidateTree': after_tree,
            'candidateTreeHash': sha(json.dumps(after_tree, sort_keys=True).encode()),
            'workspace': {n: sha((SERVER / n).read_bytes()) for n in changed},
            'packages': {n: sha((candidate / n).read_bytes()) for n in ['package.json', 'package-lock.json']}}
    validation = RELEASE / 'validation'
    shutil.copytree(candidate, validation)
    for directory in ['test', 'tools', 'contracts']:
        shutil.copytree(SERVER / directory, validation / directory, ignore=shutil.ignore_patterns('__pycache__'))
    for n in ['eslint.mbt.config.js', 'tsconfig.mbt.json', '.c8rc.json']:
        shutil.copy2(SERVER / n, validation / n)
    # Existing harnesses are test scaffolding, never part of the runtime overlay.
    for p in (SERVER / 'src').glob('*harness.js'):
        shutil.copy2(p, validation / 'src' / p.name)
    artifacts = RELEASE / 'validation-artifacts'
    (artifacts / 'delivery-requests').mkdir(parents=True)
    fixture = artifacts / 'scm-ultimate-packing-20261005'
    (fixture / 'final').mkdir(parents=True)
    for n in ['replay-input.json', 'changed-lines.json', 'source-manifest.json']:
        shutil.copy2(scm / n, fixture / n)
    shutil.copytree(scm / 'baseline', fixture / 'baseline')
    shutil.copytree(scm / 'baseline-suites', fixture / 'baseline-suites')
    save('manifest.json', data)
    print(json.dumps({'captured': True, 'changedFiles': changed, 'candidateTreeHash': data['candidateTreeHash']}), flush=True)


def current(data):
    assert metadata(APP) == data['app'], 'Live application changed; recapture required'
    assert [metadata(n) for n in DEPENDENCIES] == data['dependencies'], 'Dependency changed'
    assert json.loads(docker('exec', APP, 'node', '-e', HASH_SCRIPT)) == data['beforeTree'], 'Live source changed'
    assert files_at(RELEASE / 'candidate') == data['candidateTree'], 'Candidate source changed'
    assert all(sha((SERVER / n).read_bytes()) == value for n, value in data['workspace'].items()), 'Workspace source changed'


def build():
    data = state()
    current(data)
    validation = json.loads((RELEASE / 'validation-passed.json').read_text())
    assert validation['passed'] and validation['candidateTreeHash'] == data['candidateTreeHash'], 'Exact candidate validation required'
    docker('tag', data['app']['imageId'], ROLLBACK)
    stage = RELEASE / 'stage'
    for n in data['files']:
        target = stage / 'overlay' / n
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(RELEASE / 'candidate' / n, target)
    (stage / 'Dockerfile').write_text('FROM ' + ROLLBACK + '\nCOPY --chown=node:node overlay/ /app/\n')
    for mode, tag in [('release', IMAGE), ('rollback', ROLLBACK)]:
        (RELEASE / ('compose.' + mode + '.yml')).write_text('services:\n  app:\n    image: ' + tag + '\n    pull_policy: never\n')
    with (RELEASE / 'build.log').open('wb') as output:
        subprocess.run(['docker', 'build', '--network', 'none', '--pull=false', '-t', IMAGE, str(stage)],
                       stdout=output, stderr=subprocess.STDOUT, check=True, timeout=180)
    data['candidateImageId'] = docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    save('manifest.json', data)
    atexit.register(cleanup_manual)
    try:
        actual = json.loads(bounded(data['candidateImageId'], CHECK_NAME, 'node', '-e', HASH_SCRIPT))
        assert actual == data['candidateTree'], 'Built image differs from validated runtime'
        script = "await import('./src/server.js');console.log(JSON.stringify({serverImport:true}));process.exit(0)"
        (RELEASE / 'server-import.log').write_bytes(bounded(data['candidateImageId'], CHECK_NAME,
                                                            'node', '--input-type=module', '-e', script))
    finally:
        cleanup_manual()
    save('image-check.json', {'passed': True, 'imageId': data['candidateImageId'], 'runtimeFiles': len(actual)})
    config_check(data)
    print(json.dumps({'built': True, 'imageId': data['candidateImageId'], 'runtimeFilesVerified': len(actual)}), flush=True)


def compose(data, mode):
    args = ['sudo', '-n', 'docker', 'compose', '--project-directory', data['app']['projectDirectory'], '-p', 'mbbs-operator-app']
    for n in data['app']['configFiles'].split(','):
        args += ['-f', n]
    return args + ['-f', str(RELEASE / ('compose.' + mode + '.yml')), '--env-file', str(ROOT / 'docker/env/.env')]


def config_check(data):
    service = json.loads(subprocess.check_output(compose(data, 'release') + ['config', '--format', 'json'], cwd=ROOT))['services']['app']
    live = json.loads(docker('inspect', APP))[0]
    image = json.loads(docker('image', 'inspect', data['candidateImageId']))[0]['Config']
    env = dict(entry.split('=', 1) for entry in image.get('Env', []))
    env.update({k: str(v) for k, v in service.get('environment', {}).items()})
    assert env == dict(entry.split('=', 1) for entry in live['Config']['Env']), 'Runtime environment would change'
    for field, key in [('Cmd', 'command'), ('Entrypoint', 'entrypoint'), ('User', 'user'), ('WorkingDir', 'working_dir')]:
        expected = image.get(field) if service.get(key) is None else service[key]
        assert expected == live['Config'].get(field), 'Runtime setting would change: ' + field
    save('config-check.json', {'environmentPreserved': True, 'commandPreserved': True, 'imageOnlyOverride': True})


def sql(statement):
    return docker('exec', '-i', DB, 'psql', '-U', 'mbbs_app', '-d', 'mbbs_yard',
                  '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', input=statement.encode()).decode().strip()


def preflight():
    statement = """BEGIN READ ONLY; SET LOCAL statement_timeout='5s';
SELECT json_build_object(
'operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing')),
'driverExecuting',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing'),
'specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'),
'regularExecuting',(SELECT count(*) FROM regular_stock_handoffs WHERE status='executing'),
'scmExecuting',(SELECT count(*) FROM scm_smart_proposals WHERE status='executing'),
'dispatchEditors',(SELECT count(*) FROM dispatch_plan_edit_leases WHERE expires_at>clock_timestamp()),
'openTransactions',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='idle in transaction'));
COMMIT;"""
    result = json.loads(sql(statement))
    row = {'at': now(), **result}
    save('preflight.json', row)
    with (RELEASE / 'preflight-history.jsonl').open('a') as history:
        history.write(json.dumps(row) + '\n')
    return result


def assert_no_active_operations(active):
    # Editing leases and credentials persist in the unchanged DB. An idle open
    # editor is not an executing write and survives this compatible app restart.
    executing = {name: count for name, count in active.items() if name != 'dispatchEditors'}
    assert not any(executing.values()), 'Active business operations; wait before restarting: ' + json.dumps(executing)


def edit_lease_identities():
    return json.loads(sql("SELECT coalesce(json_agg(md5(plan_date::text||operator_id||session_id||token_hash||acquired_at::text) ORDER BY plan_date),'[]'::json) FROM dispatch_plan_edit_leases WHERE expires_at>now();"))


def ready(image_id):
    for _ in range(90):
        row = json.loads(docker('inspect', APP))[0]
        if row['Image'] == image_id and row['State']['Running'] and row['RestartCount'] == 0:
            try:
                with urllib.request.urlopen('http://127.0.0.1:3000/health', timeout=1) as response:
                    if response.status == 200 and json.loads(response.read()).get('ok'):
                        if row['State'].get('Health', {}).get('Status') == 'healthy':
                            return
            except (OSError, ValueError):
                pass
        time.sleep(0.5)
    raise RuntimeError('Application did not become healthy')


def verify():
    data = state()
    ready(data['candidateImageId'])
    live = metadata(APP)
    assert live['imageId'] == data['candidateImageId']
    assert live['configuration'] == data['app']['configuration'], 'Runtime configuration changed'
    assert [metadata(n) for n in DEPENDENCIES] == data['dependencies'], 'Worker/dependency changed'
    assert json.loads(docker('exec', APP, 'node', '-e', HASH_SCRIPT)) == data['candidateTree']
    schema = json.loads(sql("SELECT json_build_object('migration',(SELECT count(*) FROM schema_migrations WHERE filename='265_delivery_requests.sql'),'settings',(SELECT settings FROM delivery_request_settings WHERE id=true),'requests',(SELECT count(*) FROM delivery_requests));"))
    assert schema['migration'] == 1
    assert schema['settings']['approvalHours'] == 3 and schema['settings']['reminderHours'] == 1
    public = {n: value for n, value in data['candidateTree'].items() if n in data['files'] and n.startswith('public/')}
    checked = http_check(public, ['/api/sales/delivery-requests', '/api/dispatch/delivery-requests', '/api/scm/smart/planning-runs'])
    result = {'deployed': True, 'at': now(), 'image': IMAGE, 'imageId': live['imageId'],
              'candidateTreeHash': data['candidateTreeHash'], 'runtimeFilesVerified': len(data['candidateTree']),
              'changedFiles': data['files'], 'configurationPreserved': True, 'workerAndDependenciesUnchanged': True,
              'schema': schema, 'http': checked}
    save('deployment-result.json', result)
    print(json.dumps({'deployed': True, 'imageId': live['imageId'], 'http': checked}), flush=True)


def http_check(public, apis):
    paths = {'public/delivery-requests.html': '/sales/delivery-requests', 'public/scm-smart.html': '/scm/smart',
             'public/sales.html': '/sales', 'public/dispatch-menu.html': '/dispatch'}
    script = """import assert from 'node:assert/strict';import crypto from 'node:crypto';
const files=FILES,paths=PATHS,apis=APIS,results={};
for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']){
const response=await fetch(base+'/health',{signal:AbortSignal.timeout(15000)});assert.equal(response.status,200);assert.equal((await response.json()).ok,true);
for(const [name,hash] of Object.entries(files)){
const url=paths[name] || '/'+name.slice(7);
const r=await fetch(base+url+'?release=delivery-scm-20261006',{headers:{'Cache-Control':'no-cache','User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(15000)});
assert.equal(r.status,200,url);let body=Buffer.from(await r.arrayBuffer());
if(name.endsWith('.html'))body=Buffer.from(body.toString().replace(/<script type=\"module\" src=\"https:\\/\\/static\\.cloudflareinsights\\.com\\/beacon\\.min\\.js\\/[^>]+><\\/script>\\n/g,''));
assert.equal(crypto.createHash('sha256').update(body).digest('hex'),hash,url);}
if(files['public/delivery-requests.html']){
const r=await fetch(base+'/dispatch/delivery-requests',{signal:AbortSignal.timeout(15000)});assert.equal(r.status,200);
assert.ok((await r.text()).includes('delivery-requests.js'));}
for(const url of apis){
assert.equal((await fetch(base+url,{signal:AbortSignal.timeout(15000)})).status,401,url);}
results[base]={health:200,publicAssetsVerified:Object.keys(files).length,anonymousApisDenied:apis.length};}
console.log(JSON.stringify(results));""".replace('FILES', json.dumps(public)).replace('PATHS', json.dumps(paths)).replace('APIS', json.dumps(apis))
    return json.loads(docker('exec', '-i', APP, 'node', '--input-type=module', input=script.encode(), timeout=100))


def apply():
    data = state()
    current(data)
    check = json.loads((RELEASE / 'image-check.json').read_text())
    assert check['passed'] and check['imageId'] == data['candidateImageId']
    assert docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip() == data['candidateImageId']
    config_check(data)
    active = preflight()
    assert_no_active_operations(active)
    applied = json.loads(sql("SELECT coalesce(json_agg(filename ORDER BY filename),'[]'::json) FROM schema_migrations;"))
    if not (RELEASE / 'migrations-before.json').exists():
        save('migrations-before.json', applied)
    # Back up schema only: this migration adds separate empty tables and changes no existing records.
    if not (RELEASE / 'schema-before.sql').exists():
        with (RELEASE / 'schema-before.sql').open('wb') as output:
            subprocess.run(['docker', 'exec', DB, 'pg_dump', '-U', 'mbbs_app', '-d', 'mbbs_yard',
                            '--schema-only', '--no-owner', '--no-acl'], stdout=output, check=True, timeout=30)
    current(data)
    if MIGRATION not in applied:
        start = time.monotonic()
        statement = (RELEASE / 'candidate/migrations' / MIGRATION).read_text()
        result = sql("BEGIN; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='20s';\n" + statement
                     + "\nINSERT INTO schema_migrations(filename) VALUES('265_delivery_requests.sql') ON CONFLICT DO NOTHING; COMMIT;")
        (RELEASE / 'migration.log').write_text(result + '\n')
        save('migration-result.json', {'filename': MIGRATION, 'seconds': round(time.monotonic() - start, 3), 'oldAppOnline': True})
    current(data)
    assert_no_active_operations(preflight())
    leases_before = edit_lease_identities()
    samples, stop = [], threading.Event()
    start = time.monotonic()
    def probe():
        while not stop.is_set():
            stamp = time.monotonic()
            try:
                with urllib.request.urlopen('http://127.0.0.1:3000/health', timeout=0.5) as response:
                    ok = response.status == 200
            except OSError:
                ok = False
            samples.append({'seconds': round(stamp - start, 3), 'ok': ok})
            stop.wait(0.2)
    watcher = threading.Thread(target=probe, daemon=True)
    watcher.start()
    args = ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app']
    try:
        with (RELEASE / 'cutover.log').open('wb') as output:
            subprocess.run(compose(data, 'release') + args, cwd=ROOT, stdout=output,
                           stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
        leases_after = edit_lease_identities()
        save('editing-lease-result.json', {'before': leases_before, 'after': leases_after,
             'retained': set(leases_before) <= set(leases_after), 'leasesModifiedByDeployment': False})
    except BaseException:
        with (RELEASE / 'rollback.log').open('wb') as output:
            subprocess.run(compose(data, 'rollback') + args, cwd=ROOT, stdout=output,
                           stderr=subprocess.STDOUT, check=True, timeout=60)
        ready(data['app']['imageId'])
        save('rollback-result.json', {'restoredImageId': data['app']['imageId'], 'additiveSchemaRetained': True})
        raise
    finally:
        stop.set()
        watcher.join(timeout=2)
        failed = [row['seconds'] for row in samples if not row['ok']]
        recovered = [row['seconds'] for row in samples if row['ok'] and failed and row['seconds'] > max(failed)]
        save('cutover.json', {'seconds': round(time.monotonic() - start, 3),
             'observedInterruptionSeconds': round(min(recovered) - min(failed), 3) if recovered else 0 if not failed else None,
             'samples': samples})
    print(json.dumps({'cutover': json.loads((RELEASE / 'cutover.json').read_text()) | {'samples': len(samples)}}), flush=True)


if __name__ == '__main__':
    {'capture': capture, 'build': build, 'apply': apply, 'verify': verify}[sys.argv[1]]()
