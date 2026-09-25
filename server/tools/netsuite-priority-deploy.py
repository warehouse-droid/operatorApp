"""Release the frozen priority fix over each service's current live image."""
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

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
ART = SERVER / 'test-artifacts/netsuite-priority-queue'
RELEASE = SERVER / 'test-artifacts/netsuite-priority-deployment-20260925'
PREPARED = ART / 'candidate-v4'
MIGRATION = '227_netsuite_request_priority.sql'
CONTAINERS = {'app': 'mbbs-operator-app-app-1', 'webhook-worker': 'mbbs-operator-app-webhook-worker-1'}
DEPENDENCIES = ['mbbs-operator-app-db-1', 'mbbs-operator-app-ollama-1']
IMAGES = {name: 'mbbs-operator-app:netsuite-priority-20260925-v1-' + name for name in CONTAINERS}
ROLLBACK = {name: 'mbbs-operator-app:rollback-netsuite-priority-20260925-v1-' + name for name in CONTAINERS}
spec = importlib.util.spec_from_file_location('priority_release_core', SERVER / 'tools/operator-display-settings-deploy.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.RELEASE = RELEASE
docker, database, digest, save = core.docker, core.database, core.digest, core.save
FILES = sorted(json.loads((ART / 'prepared-manifest.json').read_text())['runtime'])


def emit(value):
    print(json.dumps(value), flush=True)


def state():
    return json.loads((RELEASE / 'manifest.json').read_text())


def prepared_gate():
    manifest = json.loads((ART / 'prepared-manifest.json').read_text())
    report = json.loads((ART / 'regression.json').read_text())
    assert manifest['candidate'] == report['candidate'] == 'candidate-v4'
    assert report['checks']['passed'] and not report['newFailures'] and not report['newFailedFiles']
    for name, sha in manifest['runtime'].items():
        assert digest((PREPARED / name).read_bytes()) == sha, name
    return manifest


def candidate_hashes(service):
    return {name: digest((RELEASE / ('candidate-' + service) / name).read_bytes()) for name in FILES}


def current(info):
    for service, container in CONTAINERS.items():
        assert core.metadata(container) == info['services'][service]['live'], service + ' changed while preparing'
        assert candidate_hashes(service) == info['services'][service]['after'], service + ' candidate changed'
    assert [core.metadata(name) for name in DEPENDENCIES] == info['dependencies']
    prepared_gate()


def copy_container(container, target):
    target.mkdir()
    archive = docker('exec', container, 'tar', '-C', '/app', '-cf', '-', 'src', 'public', 'migrations', 'package.json', 'package-lock.json')
    with tarfile.open(fileobj=io.BytesIO(archive)) as captured:
        captured.extractall(target, filter='data')


def add_test_tooling(target, candidate):
    for name in ['test', 'tools', 'contracts']:
        shutil.copytree(SERVER / name, target / name)
    for pattern in ['tsconfig*.json', '*eslint*.js', '*eslint*.json', 'Dockerfile*']:
        for file in SERVER.glob(pattern):
            if file.is_file():
                shutil.copy2(file, target / file.name)
    # Freeze the already-reviewed priority tests and runners, not incidental edits.
    for pattern in ['test/mbt/integration/netsuite-priority-queue*', 'test/support/netsuite-priority-queue*',
                    'tools/netsuite-priority-queue*']:
        for file in PREPARED.glob(pattern):
            if file.is_file():
                shutil.copy2(file, target / file.relative_to(PREPARED))
    test = 'test/mbt/unit/smart-scm-created-po-service.test.js'
    shutil.copy2((PREPARED if candidate else ART / 'baseline') / test, target / test)


def prepare():
    prepared = prepared_gate()
    RELEASE.mkdir(parents=True, exist_ok=False)
    info = {'preparedRevision': prepared['sourceTreeHash'], 'services': {},
            'dependencies': [core.metadata(name) for name in DEPENDENCIES]}
    original_patch = (ART / 'prepared-combined.patch').read_text().split('--- a/test/')[0]
    (RELEASE / 'prepared.patch').write_text(original_patch)
    # Two context blocks changed since preparation: new Special quantity
    # functions follow the former end-of-file, and receiving now has a recovery
    # router between these guards. Apply their exact edits below, retaining both.
    hunks = re.split(r'(?m)(?=^@@ |^--- )', original_patch)
    patch = ''.join(hunk for hunk in hunks if not (
        hunk.startswith('@@ ') and ('synchronizeSpecialSalesDescriptionsInNetSuite' in hunk
                                    or 'app.use("/api/customer-pickup"' in hunk)))
    (RELEASE / 'context-adapted.patch').write_text(patch)
    for service, container in CONTAINERS.items():
        live = core.metadata(container)
        baseline, candidate = RELEASE / ('baseline-' + service), RELEASE / ('candidate-' + service)
        copy_container(container, baseline)
        assert core.metadata(container) == live
        shutil.copytree(baseline, candidate)
        service_patch = patch
        if service == 'webhook-worker':
            # This older worker does not contain the newer inventory/counting,
            # standalone RA or Field Sales functions used as patch context.
            worker_context = ['export async function inventoryTransferRest',
                'export async function createStandaloneReturnAuthorizationInNetSuite',
                'NetSuite estimate request failed',
                "import { filterSorPlanningOrders }", 'app.use("/api/count-sheets"',
                'app.use("/api/operator", requireOperator']
            service_patch = ''.join(hunk for hunk in re.split(r'(?m)(?=^@@ |^--- )', patch)
                                    if not (hunk.startswith('@@ ') and any(text in hunk for text in worker_context)))
        result = subprocess.run(['patch', '--batch', '--fuzz=0', '-p1', '-d', str(candidate)],
                                input=service_patch, text=True, capture_output=True)
        (RELEASE / ('patch-' + service + '.log')).write_text(result.stdout + result.stderr)
        assert result.returncode == 0, service + ' patch requires review'
        filename = candidate / 'src/netsuite.js'
        content = filename.read_text()
        old = """export async function synchronizeSpecialSalesDescriptionsInNetSuite(input) {
  const { synchronizeSpecialDescriptions } = await import('./special-stock-netsuite-adapter.js');
  const run = () => synchronizeSpecialDescriptions(input, { rest: netsuiteRest, queryAll: suiteqlAll });
  const result = restMutationQueue.then(run, run);
  restMutationQueue = result.catch(() => {});
  return result;
}"""
        new = old.replace('  const result = restMutationQueue.then(run, run);\n  restMutationQueue = result.catch(() => {});\n  return result;',
                          '  return queueNetSuiteMutation(run);')
        assert content.count(old) == 1
        content = content.replace(old, new)
        if service == 'webhook-worker':
            for function in ['createTransferOrderInNetSuite', 'createOrUpdateCreditMemoInNetSuite']:
                start = content.index('export async function ' + function + '(')
                end = content.index('\nexport async function ', start + 1)
                old_function = content[start:end]
                tail = '  const result = restMutationQueue.then(run, run);\n  restMutationQueue = result.catch(() => {});\n  return result;'
                assert old_function.count(tail) == 1
                content = content[:start] + old_function.replace(tail, '  return queueNetSuiteMutation(run);') + content[end:]
        filename.write_text(content)
        filename = candidate / 'src/server.js'
        content = filename.read_text()
        if service == 'webhook-worker':
            assert "import { operatorNetSuitePriority }" not in content
            content = "import { operatorNetSuitePriority } from './operator-netsuite-priority-middleware.js';\n" + content
        routes = ['delivery', 'customer-pickup', 'receiving', 'inventory', 'cycle-count']
        if service == 'webhook-worker':
            routes.append('operator')
        for route in routes:
            old = 'app.use("/api/' + route + '", requireOperator, requireOperatorAccess, requireOperatorYardRequest);'
            assert content.count(old) == 1
            content = content.replace(old, old.removesuffix(');') + ', operatorNetSuitePriority);')
        filename.write_text(content)
        for file in candidate.rglob('*.orig'):
            file.unlink()
        before, after = core.files_at(baseline), core.files_at(candidate)
        assert sorted(file for file in after if before.get(file) != after[file]) == FILES
        exact_patch = ''
        for file in FILES:
            old = (baseline / file).read_text().splitlines(True) if (baseline / file).exists() else []
            new = (candidate / file).read_text().splitlines(True)
            exact_patch += ''.join(difflib.unified_diff(old, new, fromfile='a/' + file, tofile='b/' + file))
        (RELEASE / ('release-' + service + '.patch')).write_text(exact_patch)
        info['services'][service] = {'live': live, 'before': {file: before.get(file) for file in FILES},
            'after': {file: after[file] for file in FILES}, 'baselineHashes': before,
            'candidateHashes': after, 'image': IMAGES[service]}
        add_test_tooling(baseline, False)
        add_test_tooling(candidate, True)
    for label in ['release', 'rollback']:
        content = 'services:\n'
        for service in CONTAINERS:
            image = IMAGES[service] if label == 'release' else info['services'][service]['live']['imageId']
            content += '  ' + service + ':\n    image: ' + image + '\n'
        (RELEASE / ('compose.' + label + '.yml')).write_text(content)
    save('manifest.json', info)
    current(info)
    emit({'prepared': True, 'services': list(CONTAINERS), 'runtimeFilesPerService': len(FILES)})


def build():
    info = state()
    current(info)
    for service in CONTAINERS:
        row = info['services'][service]
        docker('tag', row['live']['imageId'], ROLLBACK[service])
        context = RELEASE / ('build-' + service)
        overlay = context / 'overlay'
        for name in FILES:
            target = overlay / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(RELEASE / ('candidate-' + service) / name, target)
        (context / 'Dockerfile').write_text('FROM ' + ROLLBACK[service] + '\nCOPY --chown=node:node overlay/ /app/\n')
        with (RELEASE / ('build-' + service + '.log')).open('wb') as output:
            subprocess.run(['sudo', '-n', 'docker', 'build', '--network', 'none', '--pull=false', '-t', IMAGES[service], str(context)],
                           stdout=output, stderr=subprocess.STDOUT, check=True)
        row['candidateImageId'] = docker('image', 'inspect', '--format', '{{.Id}}', IMAGES[service]).decode().strip()
        hashes = docker('run', '--rm', '--network', 'none', '--entrypoint', 'sha256sum', IMAGES[service],
                        *['/app/' + name for name in FILES]).decode().splitlines()
        assert {line.split()[1].removeprefix('/app/'): line.split()[0] for line in hashes} == row['after']
        emit({'built': service, 'imageId': row['candidateImageId']})
    save('manifest.json', info)


def check():
    info = state()
    current(info)
    output_folder = RELEASE / 'checks-app'
    output_folder.mkdir(exist_ok=True)
    baseline = output_folder / 'baseline'
    if not baseline.exists():
        shutil.copytree(RELEASE / 'baseline-app', baseline)
    command = ['sudo', '-n', 'env', 'NETSUITE_PRIORITY_SOURCE_ROOT=' + str(RELEASE / 'candidate-app'),
               'NETSUITE_PRIORITY_ARTIFACT_ROOT=' + str(output_folder), 'bash',
               str(SERVER / 'tools/netsuite-priority-release-test.sh'), 'node', 'tools/netsuite-priority-queue-checks.mjs']
    with (RELEASE / 'release-checks.log').open('wb') as output:
        subprocess.run(command, cwd=SERVER, stdout=output, stderr=subprocess.STDOUT, check=True)
    result = json.loads((output_folder / 'checks.json').read_text())
    assert result['passed']
    assert result['sourceHashes'] == {file: sha for file, sha in info['services']['app']['after'].items() if file.startswith('src/')}
    current(info)
    save('candidate-checks.json', {'passed': True, 'services': {service: {
        'imageId': row['candidateImageId'], 'sources': row['after']} for service, row in info['services'].items()},
        'focusedTests': result['focusedTests']})
    emit({'checksPassed': True, 'focusedTests': result['focusedTests']})


def compose(info, override):
    args = ['sudo', '-n', 'docker', 'compose', '-p', 'mbbs-operator-app']
    for file in info['services']['app']['live']['configFiles'].split(','):
        args.extend(['-f', file])
    return args + ['-f', str(RELEASE / override), '--env-file', str(ROOT / 'docker/env/.env')]


def config_gate(info):
    resolved = json.loads(subprocess.check_output(compose(info, 'compose.release.yml') + ['config', '--format', 'json'], cwd=ROOT))['services']
    for service, container in CONTAINERS.items():
        image = json.loads(docker('image', 'inspect', info['services'][service]['candidateImageId']))[0]['Config']
        live = json.loads(docker('inspect', container))[0]['Config']
        config = resolved[service]
        environment = dict(value.split('=', 1) for value in image['Env'])
        environment.update({key: str(value) for key, value in config.get('environment', {}).items()})
        assert environment == dict(value.split('=', 1) for value in live['Env']), service + ' environment drift'
        for field, option in [('Cmd', 'command'), ('Entrypoint', 'entrypoint'), ('User', 'user'), ('WorkingDir', 'working_dir')]:
            assert (image.get(field) if config.get(option) is None else config[option]) == live.get(field), service + '/' + field


def preflight():
    sql = """SELECT json_build_object(
      'operatorPostings',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),
      'fulfillments',(SELECT count(*) FROM dispatch_sales_order_if_candidates WHERE status='posting'),
      'webhooks',(SELECT count(*) FROM netsuite_order_webhook_inbox WHERE status IN ('processing','running')),
      'dispatchEditors',(SELECT count(*) FROM dispatch_plan_edit_leases WHERE expires_at>clock_timestamp()),
      'openBusinessTransactions',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='idle in transaction'));
    """
    counts = json.loads(database(sql))
    save('preflight.json', counts)
    return counts


def backup_and_migrate():
    for filename, options in [('schema-before.dump', ['--schema-only']), ('migrations-before.dump', ['--table=public.schema_migrations'])]:
        target = RELEASE / filename
        if not target.exists():
            with target.open('wb') as output:
                subprocess.run(['sudo', '-n', 'docker', 'exec', DEPENDENCIES[0], 'pg_dump', '-U', 'mbbs_app', '-d', 'mbbs_yard',
                                '--format=custom', *options], stdout=output, check=True)
        with target.open('rb') as source:
            toc = docker('exec', '-i', DEPENDENCIES[0], 'pg_restore', '--list', stdin=source)
        assert b'schema_migrations' in toc
        (RELEASE / (filename + '.toc')).write_bytes(toc)
    if database("SELECT count(*) FROM schema_migrations WHERE filename='" + MIGRATION + "';").strip() == '0':
        assert database("SELECT to_regclass('public.netsuite_request_queue') IS NULL;").strip() == 't'
        sql = (RELEASE / 'candidate-app/migrations' / MIGRATION).read_text()
        output = database("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';\n" + sql +
                          "\nINSERT INTO schema_migrations(filename) VALUES ('" + MIGRATION + "'); COMMIT;")
        (RELEASE / 'migration.log').write_text(output)
    assert database("SELECT count(*) FROM schema_migrations WHERE filename='" + MIGRATION + "';").strip() == '1'
    emit({'migrationApplied': MIGRATION, 'backupsValidated': True})


def verify():
    info = state()
    core.ready(info['services']['app']['candidateImageId'])
    for service, container in CONTAINERS.items():
        actual = core.metadata(container)
        row = info['services'][service]
        assert actual['imageId'] == row['candidateImageId']
        assert actual['configuration'] == row['live']['configuration'], service + ' configuration changed'
        status = json.loads(docker('inspect', container))[0]
        assert status['State']['Running'] and status['RestartCount'] == 0
        hashes = docker('exec', container, 'sha256sum', *['/app/' + name for name in FILES]).decode().splitlines()
        assert {line.split()[1].removeprefix('/app/'): line.split()[0] for line in hashes} == row['after']
    assert [core.metadata(name) for name in DEPENDENCIES] == info['dependencies']
    assert database("SELECT count(*) FROM schema_migrations WHERE filename='" + MIGRATION + "';").strip() == '1'
    probe = """import assert from 'node:assert/strict';
for (const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
  const r=await fetch(base+'/health',{signal:AbortSignal.timeout(10000)});
  assert.equal(r.status,200);assert.equal((await r.json()).ok,true);
  assert.equal((await fetch(base+'/api/operator/preferences',{signal:AbortSignal.timeout(10000)})).status,401);
}
console.log(JSON.stringify({localHealth:200,publicHealth:200,anonymousAccess:401}));
"""
    health = json.loads(docker('exec', '-i', CONTAINERS['app'], 'node', '--input-type=module', input=probe.encode()))
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'services': {service: row['candidateImageId'] for service, row in info['services'].items()},
        'migration': MIGRATION, 'configurationPreserved': True, 'databaseAndOllamaUnchanged': True,
        'runtimeFilesPerService': len(FILES), **health}
    save('deployment-result.json', result)
    emit(result)


def live_probe():
    results = {}
    script = (SERVER / 'tools/netsuite-priority-live.mjs').read_bytes()
    for service, priority in [('app', 'operator'), ('webhook-worker', 'background')]:
        output = docker('exec', '-i', CONTAINERS[service], 'node', '--input-type=module', '-', priority, input=script).decode()
        (RELEASE / ('live-probe-' + service + '.jsonl')).write_text(output)
        entries = [json.loads(line) for line in output.splitlines() if line.startswith('{')]
        result = next(row for row in entries if row.get('readOnlyNetSuiteProbe'))
        queues = [row for row in entries if row.get('operation') == 'netsuite.queue' and row.get('queue') == 'shared_' + priority]
        assert queues and all(row['outcome'] == 'ok' for row in queues)
        assert any(row.get('operation') == 'netsuite.http' and row.get('status') == 200 for row in entries)
        results[service] = {**result, 'sharedQueueWaitMs': round(sum(row['durationMs'] for row in queues), 2)}
    save('live-probes.json', results)
    emit(results)


def apply():
    info = state()
    current(info)
    checked = json.loads((RELEASE / 'candidate-checks.json').read_text())
    assert checked['passed']
    evidence = json.loads((RELEASE / 'release-evidence.json').read_text())
    assert evidence['passed']
    smoke = json.loads((RELEASE / 'release-smoke.json').read_text())
    assert smoke['passed'] and smoke['actualCandidateImages'] == {
        service: row['candidateImageId'] for service, row in info['services'].items()}
    for service, row in info['services'].items():
        assert checked['services'][service] == {'imageId': row['candidateImageId'], 'sources': row['after']}
        assert docker('image', 'inspect', '--format', '{{.Id}}', IMAGES[service]).decode().strip() == row['candidateImageId']
    config_gate(info)
    counts = preflight()
    assert not any(counts.values()), 'Active work; retry cutover when idle'
    backup_and_migrate()
    current(info)
    assert not any(preflight().values()), 'Active work; retry cutover when idle'
    started = datetime.datetime.now(datetime.timezone.utc).isoformat()
    save('cutover-start.json', {'at': started})
    emit({'cutoverStarted': started})
    try:
        with (RELEASE / 'cutover.log').open('wb') as output:
            # A coordinated stop prevents old and new request budgets overlapping.
            subprocess.run(compose(info, 'compose.release.yml') + ['stop', '--timeout', '120', *CONTAINERS],
                           cwd=ROOT, stdout=output, stderr=subprocess.STDOUT, check=True, timeout=150)
            subprocess.run(compose(info, 'compose.release.yml') + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', *CONTAINERS],
                           cwd=ROOT, stdout=output, stderr=subprocess.STDOUT, check=True, timeout=100)
        verify()
        for service, container in CONTAINERS.items():
            logs = docker('logs', '--since', started, container, stderr=subprocess.STDOUT).decode()
            (RELEASE / ('startup-' + service + '.log')).write_text(logs)
            assert not re.search(r'SyntaxError|ReferenceError|ERR_MODULE_NOT_FOUND|uncaughtException|relation "netsuite_request_queue" does not exist', logs)
    except Exception:
        with (RELEASE / 'rollback.log').open('wb') as output:
            subprocess.run(compose(info, 'compose.rollback.yml') + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', *CONTAINERS],
                           cwd=ROOT, stdout=output, stderr=subprocess.STDOUT, check=True, timeout=100)
        core.ready(info['services']['app']['live']['imageId'])
        save('rolled-back.json', {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'migrationRetained': True})
        raise


if __name__ == '__main__':
    os.umask(0o077)
    {'prepare': prepare, 'build': build, 'check': check, 'preflight': lambda: emit(preflight()),
     'apply': apply, 'verify': verify, 'live-probe': live_probe}[sys.argv[1]]()
