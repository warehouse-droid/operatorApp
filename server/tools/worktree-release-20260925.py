"""Freeze, build and deploy the explicitly authorized complete worktree."""
import datetime
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import time

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
RELEASE = SERVER / 'test-artifacts/whole-worktree-deployment-20260925'
SOURCE = RELEASE / 'source'
IMAGE = 'mbbs-operator-app:whole-worktree-20260925-v1'
SERVICES = {'app': 'mbbs-operator-app-app-1', 'webhook-worker': 'mbbs-operator-app-webhook-worker-1'}
DEPENDENCIES = ['mbbs-operator-app-db-1', 'mbbs-operator-app-ollama-1']
MIGRATION = '212_dispatch_executed_order_reviews.sql'
spec = importlib.util.spec_from_file_location('release_core', SERVER / 'tools/operator-display-settings-deploy.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
docker, digest = core.docker, core.digest


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def save(name, value):
    (RELEASE / name).write_text(json.dumps(value, indent=2) + '\n')


def emit(value):
    print(json.dumps(value), flush=True)


def state():
    return json.loads((RELEASE / 'manifest.json').read_text())


def ignored(folder, names):
    return [name for name in names if name == '__pycache__' or name.endswith(('.orig', '.rej', '.pyc'))]


def runtime_files(base):
    paths = set()
    for line in (base / 'Dockerfile').read_text().splitlines():
        if line.startswith('COPY '):
            for name in shlex.split(line)[1:-1]:
                path = base / name
                paths.update(path.rglob('*') if path.is_dir() else [path])
    return {str(path.relative_to(base)): digest(path.read_bytes()) for path in sorted(paths)
            if path.is_file() and not ignored(path.parent, [path.name])}


def sql(query):
    return docker('exec', '-i', DEPENDENCIES[0], 'psql', '-U', 'mbbs_app', '-d', 'mbbs_yard',
                  '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', input=query.encode()).decode().strip()


def compose(info, override=None):
    args = ['sudo', '-n', 'docker', 'compose', '-p', 'mbbs-operator-app']
    for file in info['services']['app']['configFiles'].split(','):
        args += ['-f', file]
    if override:
        args += ['-f', str(RELEASE / override)]
    return args + ['--env-file', str(ROOT / 'docker/env/.env')]


def current(info):
    assert runtime_files(SOURCE) == info['runtimeFiles'], 'Frozen source changed'
    assert runtime_files(SERVER) == info['runtimeFiles'], 'Worktree changed after freeze'
    assert {name: core.metadata(container) for name, container in SERVICES.items()} == info['services'], 'Live services changed'
    assert [core.metadata(name) for name in DEPENDENCIES] == info['dependencies'], 'Dependency changed'


def prepare():
    RELEASE.mkdir(parents=True, exist_ok=False)
    info = {'createdAt': now(), 'gitBase': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT).decode().strip(),
            'services': {name: core.metadata(container) for name, container in SERVICES.items()},
            'dependencies': [core.metadata(name) for name in DEPENDENCIES], 'image': IMAGE}
    SOURCE.mkdir()
    for name in ['src', 'public', 'migrations', 'test', 'tools', 'contracts']:
        shutil.copytree(SERVER / name, SOURCE / name, ignore=ignored)
    for file in SERVER.iterdir():
        if file.is_file() and (file.suffix in ['.json', '.js', '.mjs'] or file.name.startswith('Dockerfile') or file.name == '.dockerignore'):
            shutil.copy2(file, SOURCE / file.name)
    info['runtimeFiles'] = runtime_files(SOURCE)
    info['sourceTreeHash'] = digest(json.dumps(info['runtimeFiles'], sort_keys=True).encode())
    info['sourceFileCount'] = len(info['runtimeFiles'])
    baseline = RELEASE / 'baseline'
    shutil.copytree(SOURCE, baseline)
    for folder in ['src', 'public', 'migrations']:
        shutil.rmtree(baseline / folder)
    captured = docker('exec', SERVICES['app'], 'tar', '-C', '/app', '-cf', '-',
                      'src', 'public', 'migrations', 'tools', 'package.json', 'package-lock.json')
    with tarfile.open(fileobj=io.BytesIO(captured)) as archive:
        archive.extractall(baseline, filter='data')
    before = runtime_files(baseline)
    info['runtimeChanges'] = [name for name in sorted(set(before) | set(info['runtimeFiles']))
                              if before.get(name) != info['runtimeFiles'].get(name)]
    applied = json.loads(sql('SELECT coalesce(json_agg(filename ORDER BY filename),\'[]\'::json) FROM schema_migrations;'))
    info['pendingMigrations'] = sorted(set(path.name for path in (SOURCE / 'migrations').glob('*.sql')) - set(applied))
    assert info['pendingMigrations'] == [MIGRATION], info['pendingMigrations']
    info['appliedMigrationsBefore'] = applied
    for mode in ['release', 'rollback']:
        text = 'services:\n'
        for service, row in info['services'].items():
            tag = IMAGE if mode == 'release' else row['imageId']
            text += f'  {service}:\n    image: {tag}\n'
        (RELEASE / ('compose.' + mode + '.yml')).write_text(text)
    before_config = json.loads(subprocess.check_output(compose(info) + ['config', '--format', 'json'], cwd=ROOT))
    after_config = json.loads(subprocess.check_output(compose(info, 'compose.release.yml') + ['config', '--format', 'json'], cwd=ROOT))
    save('compose.before.private.json', before_config)
    save('compose.release.private.json', after_config)
    for name in before_config['services']:
        before_row = dict(before_config['services'][name])
        after_row = dict(after_config['services'][name])
        if name in SERVICES:
            before_row.pop('image', None)
            assert after_row.pop('image') == IMAGE
        assert before_row == after_row, 'Unexpected Compose change: ' + name
    save('manifest.json', info)
    current(info)
    emit({'prepared': True, 'sourceFiles': info['sourceFileCount'], 'runtimeChanges': len(info['runtimeChanges']),
          'pendingMigrations': info['pendingMigrations'], 'sourceTreeHash': info['sourceTreeHash']})


def image_hashes(image):
    script = "import fs from 'node:fs';import crypto from 'node:crypto';const names=JSON.parse(fs.readFileSync(0,'utf8'));console.log(JSON.stringify(Object.fromEntries(names.map(n=>[n,crypto.createHash('sha256').update(fs.readFileSync('/app/'+n)).digest('hex')]))));"
    return json.loads(docker('run', '--rm', '-i', '--network', 'none', '--entrypoint', 'node', image,
                             '--input-type=module', '-e', script, input=json.dumps(list(state()['runtimeFiles'])).encode()))


def build():
    info = state()
    current(info)
    for service, row in info['services'].items():
        docker('tag', row['imageId'], 'mbbs-operator-app:rollback-whole-worktree-20260925-v1-' + service)
    with (RELEASE / 'build.log').open('wb') as output:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--pull=false', '-t', IMAGE, str(SOURCE)],
                       stdout=output, stderr=subprocess.STDOUT, check=True)
    info['imageId'] = docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    save('manifest.json', info)
    assert image_hashes(IMAGE) == info['runtimeFiles'], 'Built image mismatch'
    save('build-result.json', {'passed': True, 'imageId': info['imageId'], 'sourceFilesVerified': info['sourceFileCount']})
    emit({'built': True, 'imageId': info['imageId'], 'sourceFilesVerified': info['sourceFileCount']})


def preflight():
    counts = json.loads(sql("""SELECT json_build_object(
      'operatorPostings',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),
      'fulfillments',(SELECT count(*) FROM dispatch_sales_order_if_candidates WHERE status='posting'),
      'webhooks',(SELECT count(*) FROM netsuite_order_webhook_inbox WHERE status IN ('processing','running')),
      'dispatchEditors',(SELECT count(*) FROM dispatch_plan_edit_leases WHERE expires_at>clock_timestamp()),
      'openBusinessTransactions',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='idle in transaction'));
    """))
    save('preflight.json', {'at': now(), **counts})
    return counts


def config_gate(info):
    resolved = json.loads(subprocess.check_output(compose(info, 'compose.release.yml') + ['config', '--format', 'json'], cwd=ROOT))
    assert resolved == json.loads((RELEASE / 'compose.release.private.json').read_text()), 'Compose changed'
    image = json.loads(docker('image', 'inspect', info['imageId']))[0]['Config']
    for service, container in SERVICES.items():
        live = json.loads(docker('inspect', container))[0]['Config']
        config = resolved['services'][service]
        environment = dict(value.split('=', 1) for value in image['Env'])
        environment.update({key: str(value) for key, value in config.get('environment', {}).items()})
        assert environment == dict(value.split('=', 1) for value in live['Env']), service + ' environment drift'
        for field, option in [('Cmd', 'command'), ('Entrypoint', 'entrypoint'), ('User', 'user'), ('WorkingDir', 'working_dir')]:
            assert (image.get(field) if config.get(option) is None else config[option]) == live.get(field), service + '/' + field


def backup():
    info = state()
    current(info)
    target = RELEASE / 'postgres-before.dump'
    assert not target.exists(), 'Backup already exists'
    with target.open('wb') as output:
        subprocess.run(['sudo', '-n', 'docker', 'exec', DEPENDENCIES[0], 'pg_dump', '-U', 'mbbs_app', '-d', 'mbbs_yard',
                        '--format=custom'], stdout=output, check=True)
    with target.open('rb') as source:
        toc = docker('exec', '-i', DEPENDENCIES[0], 'pg_restore', '--list', stdin=source)
    assert b'schema_migrations' in toc and target.stat().st_size > 1000000
    (RELEASE / 'postgres-before.toc').write_bytes(toc)
    with target.open('rb') as source:
        sha = hashlib.file_digest(source, 'sha256').hexdigest()
    result = {'validated': True, 'createdAt': now(), 'bytes': target.stat().st_size, 'sha256': sha, 'tocLines': len(toc.splitlines())}
    save('backup-result.json', result)
    emit(result)


def migrate():
    files = sorted(path.name for path in (SOURCE / 'migrations').glob('*.sql'))
    applied = set(json.loads(sql("SELECT json_agg(filename) FROM schema_migrations;")))
    pending = sorted(set(files) - applied)
    if not pending and MIGRATION in applied:
        assert sql("SELECT to_regclass('public.dispatch_executed_order_reviews');") == 'dispatch_executed_order_reviews'
        return
    assert pending == [MIGRATION], 'Migration inventory changed'
    assert sql("SELECT to_regclass('public.dispatch_executed_order_reviews') IS NULL;") == 't'
    output = sql("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';\n" +
                 (SOURCE / 'migrations' / MIGRATION).read_text() +
                 "\nINSERT INTO schema_migrations(filename) VALUES ('" + MIGRATION + "'); COMMIT;")
    (RELEASE / 'migration.log').write_text(output)
    emit({'migrationApplied': MIGRATION})


def verify():
    info = state()
    core.ready(info['imageId'])
    for _ in range(60):
        rows = {name: json.loads(docker('inspect', container))[0] for name, container in SERVICES.items()}
        if rows['app']['State'].get('Health', {}).get('Status') == 'healthy':
            break
        time.sleep(0.5)
    else:
        raise RuntimeError('Docker application health did not become healthy')
    hash_script = "import fs from 'node:fs';import crypto from 'node:crypto';const names=JSON.parse(fs.readFileSync(0,'utf8'));console.log(JSON.stringify(Object.fromEntries(names.map(n=>[n,crypto.createHash('sha256').update(fs.readFileSync('/app/'+n)).digest('hex')]))));"
    services = {}
    for service, container in SERVICES.items():
        row = rows[service]
        actual = core.metadata(container)
        assert row['State']['Running'] and row['RestartCount'] == 0
        assert actual['imageId'] == info['imageId']
        assert actual['configuration'] == info['services'][service]['configuration'], service + ' settings changed'
        hashes = json.loads(docker('exec', '-i', container, 'node', '--input-type=module', '-e', hash_script,
                                   input=json.dumps(list(info['runtimeFiles'])).encode()))
        assert hashes == info['runtimeFiles'], service + ' source mismatch'
        services[service] = {'imageId': row['Image'], 'status': row['State']['Status'], 'restartCount': row['RestartCount'],
                             'sourceFilesVerified': len(hashes), 'startedAt': row['State']['StartedAt']}
    assert [core.metadata(name) for name in DEPENDENCIES] == info['dependencies'], 'Dependency restarted'
    applied = set(json.loads(sql('SELECT json_agg(filename) FROM schema_migrations;')))
    assert {path.name for path in (SOURCE / 'migrations').glob('*.sql')} <= applied
    assert sql("SELECT to_regclass('public.dispatch_executed_order_reviews');") == 'dispatch_executed_order_reviews'
    assets = {name: value for name, value in info['runtimeFiles'].items() if name in info['runtimeChanges'] and name.startswith('public/')}
    for name in ['public/scm-aggregate-alert.js', 'public/aggregate.js', 'public/scm-aggregate.html']:
        if name in info['runtimeFiles']:
            assets[name] = info['runtimeFiles'][name]
    script = """import assert from 'node:assert/strict'; import crypto from 'node:crypto';
const files = FILES;
for (const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
  for (const [file, expected] of Object.entries(files)) {
    const response = await fetch(base+'/'+file.replace(/^public\\//,''), {headers:{'Cache-Control':'no-cache'},signal:AbortSignal.timeout(10000)});
    assert.equal(response.status,200,file);
    assert.equal(crypto.createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'),expected,file);
  }
  const response = await fetch(base+'/health',{signal:AbortSignal.timeout(10000)});
  assert.equal(response.status,200); assert.equal((await response.json()).ok,true);
  for(const path of ['/api/dispatch/plans/1/executed-order-reviews','/api/scm/aggregate-requests?queue=pending','/api/operator/preferences']) {
    assert.equal((await fetch(base+path,{signal:AbortSignal.timeout(10000)})).status,401,path);
  }
}
console.log(JSON.stringify({localHealth:200,publicHealth:200,anonymousAccess:401,servedAssetHashesPerEndpoint:Object.keys(files).length}));
""".replace('FILES', json.dumps(assets))
    http = json.loads(docker('exec', '-i', SERVICES['app'], 'node', '--input-type=module', input=script.encode()))
    started = json.loads((RELEASE / 'cutover-start.json').read_text())['at']
    for service, container in SERVICES.items():
        logs = docker('logs', '--since', started, container, stderr=subprocess.STDOUT).decode()
        (RELEASE / ('startup-' + service + '.log')).write_text(logs)
        assert not re.search(r'SyntaxError|ReferenceError|ERR_MODULE_NOT_FOUND|uncaughtException|relation "dispatch_executed_order_reviews" does not exist', logs)
        if service == 'webhook-worker':
            assert 'serial worker ' in logs and ' started.' in logs
    result = {'deployed': True, 'at': now(), 'image': IMAGE, 'imageId': info['imageId'], 'services': services,
              'migration': MIGRATION, 'configurationPreserved': True, 'dependenciesUnchanged': True,
              'sourceTreeHash': info['sourceTreeHash'], **http}
    save('deployment-result.json', result)
    emit(result)
    return result


def apply():
    info = state()
    current(info)
    assert json.loads((RELEASE / 'release-checks.json').read_text())['passed'], 'Release evidence required'
    smoke = json.loads((RELEASE / 'release-smoke.json').read_text())
    assert smoke['passed'] and set(smoke['actualCandidateImages'].values()) == {info['imageId']}
    assert image_hashes(IMAGE) == info['runtimeFiles']
    assert docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip() == info['imageId']
    backup_info = json.loads((RELEASE / 'backup-result.json').read_text())
    assert backup_info['validated'] and (RELEASE / 'postgres-before.dump').stat().st_size == backup_info['bytes']
    config_gate(info)
    assert not any(preflight().values()), 'Active work; retry when idle'
    migrate()
    current(info)
    assert not any(preflight().values()), 'Active work after migration; wait for idle'
    started = now()
    save('cutover-start.json', {'at': started})
    emit({'cutoverStarted': started})
    try:
        with (RELEASE / 'cutover.log').open('wb') as output:
            subprocess.run(compose(info, 'compose.release.yml') + ['stop', '--timeout', '120', *SERVICES],
                           cwd=ROOT, stdout=output, stderr=subprocess.STDOUT, check=True, timeout=150)
            subprocess.run(compose(info, 'compose.release.yml') + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', *SERVICES],
                           cwd=ROOT, stdout=output, stderr=subprocess.STDOUT, check=True, timeout=100)
        verify()
    except Exception:
        with (RELEASE / 'rollback.log').open('wb') as output:
            subprocess.run(compose(info, 'compose.rollback.yml') + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', *SERVICES],
                           cwd=ROOT, stdout=output, stderr=subprocess.STDOUT, check=True, timeout=100)
        core.ready(info['services']['app']['imageId'])
        save('rolled-back.json', {'at': now(), 'migrationRetained': True})
        raise


def live_probe():
    script = (SERVER / 'tools/netsuite-priority-live.mjs').read_bytes()
    results = {}
    for service, priority in [('app', 'operator'), ('webhook-worker', 'background')]:
        output = docker('exec', '-i', SERVICES[service], 'node', '--input-type=module', '-', priority, input=script).decode()
        (RELEASE / ('live-priority-' + service + '.jsonl')).write_text(output)
        entries = [json.loads(line) for line in output.splitlines() if line.startswith('{')]
        probe = next(row for row in entries if row.get('readOnlyNetSuiteProbe'))
        queues = [row for row in entries if row.get('operation') == 'netsuite.queue' and row.get('queue') == 'shared_' + priority]
        assert queues and all(row['outcome'] == 'ok' for row in queues)
        assert any(row.get('operation') == 'netsuite.http' and row.get('status') == 200 for row in entries)
        results[service] = {**probe, 'sharedQueueWaitMs': round(sum(row['durationMs'] for row in queues), 2)}
    save('live-priority-probes.json', results)
    emit(results)


if __name__ == '__main__':
    os.umask(0o077)
    {'prepare': prepare, 'build': build, 'preflight': lambda: emit(preflight()),
     'backup': backup, 'apply': apply, 'verify': verify, 'live-probe': live_probe}[sys.argv[1]]()
