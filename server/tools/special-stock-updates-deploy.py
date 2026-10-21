"""Publish the verified stock-update changes over the current live images."""
import datetime
import difflib
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
RELEASE = SERVER / 'deployments/special-stock-updates-20261002'
EVIDENCE = SERVER / 'test-artifacts/special-workflow-review/stock-updates-20261002'
MIGRATION = '258_special_stock_information.sql'
FILES = [f for f in json.loads((SERVER / 'tools/special-stock-updates-files.json').read_text()) if not f.startswith('tools/')]
WORKER_FILES = ['public/special-stock-workflow.js', 'src/special-stock-request-domain.js', 'src/special-stock-request-repository.js']
CONTAINERS = {'app': 'mbbs-operator-app-app-1', 'webhook-worker': 'mbbs-operator-app-webhook-worker-1'}
DEPENDENCIES = ['mbbs-operator-app-db-1', 'mbbs-operator-app-ollama-1']
spec = importlib.util.spec_from_file_location('stock_release_core', SERVER / 'tools/regular-stock-v2-deploy.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.RELEASE, core.CONTAINERS = RELEASE, CONTAINERS
docker, digest, metadata = core.docker, core.digest, core.metadata
TREE = "const fs=require('fs'),c=require('crypto'),r={};function walk(p){for(const e of fs.readdirSync(p,{withFileTypes:true})){const n=p+'/'+e.name;if(e.isDirectory())walk(n);else if(e.isFile())r[n]=c.createHash('sha256').update(fs.readFileSync(n)).digest('hex')}}for(const p of ['src','public','migrations'])walk(p);console.log(JSON.stringify(r));"


def save(name, value):
    (RELEASE / name).write_text(json.dumps(value, indent=2) + '\n')


def state():
    return json.loads((RELEASE / 'manifest.json').read_text())


def database(sql):
    return docker('exec', '-i', DEPENDENCIES[0], 'psql', '-U', 'mbbs_app', '-d', 'mbbs_yard', '-XAt', '-v', 'ON_ERROR_STOP=1', input=sql.encode()).decode().strip()


def current(data):
    for service, row in data['services'].items():
        assert metadata(CONTAINERS[service]) == row['before'], 'Running service changed: ' + service
        assert json.loads(docker('exec', CONTAINERS[service], 'node', '-e', TREE)) == core.files_at(RELEASE / ('before-' + service)), 'Live source changed: ' + service
    assert {name: metadata(name) for name in DEPENDENCIES} == data['dependencies'], 'Dependency changed'
    for file, value in data['workspaceHashes'].items():
        assert digest((SERVER / file).read_bytes()) == value, 'Verified source changed: ' + file


def capture():
    os.umask(0o077)
    verified = json.loads((EVIDENCE / 'checks.json').read_text())
    assert verified['focused']['fail'] == 0 and verified['reverseOrder']['fail'] == 0
    hashes = {file: digest((SERVER / file).read_bytes()) for file in FILES}
    assert all(value == verified['sourceHashes'][file] for file, value in hashes.items())
    RELEASE.mkdir(exist_ok=False)
    data = {'services': {}, 'workspaceHashes': hashes, 'dependencies': {name: metadata(name) for name in DEPENDENCIES}}
    for service, container in CONTAINERS.items():
        before = metadata(container)
        baseline = RELEASE / ('before-' + service)
        baseline.mkdir()
        for path in ['src', 'public', 'migrations', 'package.json', 'package-lock.json']:
            with tarfile.open(fileobj=io.BytesIO(docker('cp', container + ':/app/' + path, '-'))) as archive:
                archive.extractall(baseline, filter='data')
        assert metadata(container) == before
        data['services'][service] = {'before': before, 'files': FILES if service == 'app' else WORKER_FILES,
                                    'image': 'mbbs-operator-app:special-stock-updates-' + service + '-20261002'}
    save('manifest.json', data)
    current(data)
    print(json.dumps({'captured': {key: row['before']['image'] for key, row in data['services'].items()}}), flush=True)


def stage():
    data = state()
    current(data)
    conflicts = []
    for service, row in data['services'].items():
        baseline = RELEASE / ('before-' + service)
        candidate = RELEASE / ('candidate-' + service)
        shutil.copytree(baseline, candidate, dirs_exist_ok=True)
        patch = ''
        for file in row['files']:
            old, base, updated = baseline / file, EVIDENCE / 'before' / file, SERVER / file
            if service == 'webhook-worker' and file == 'src/special-stock-request-repository.js':
                content = worker_repository(old.read_text())
            elif not base.exists():
                assert not old.exists(), 'New source already exists: ' + file
                content = updated.read_text()
            elif old.read_bytes() == base.read_bytes():
                content = updated.read_text()
            else:
                merged = subprocess.run(['git', 'merge-file', '-p', str(updated), str(base), str(old)], text=True, capture_output=True)
                content = merged.stdout
                if merged.returncode != 0:
                    conflicts.append(service + ':' + file)
            target = candidate / file
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content)
            patch += ''.join(difflib.unified_diff(old.read_text().splitlines(True) if old.exists() else [], content.splitlines(True), fromfile='a/' + file, tofile='b/' + file))
        (RELEASE / (service + '.patch')).write_text(patch)
    save('merge-conflicts.json', conflicts)
    print(json.dumps({'staged': not conflicts, 'conflicts': conflicts}), flush=True)


def worker_repository(source):
    # The worker has an older independently released repository. Update shared
    # availability/state handling without publishing the app-only editing APIs.
    replacements = [
        ('parseStages, torontoDate }', 'parseStages, torontoDate, specialStockAvailable }'),
        ("line.supplyStatus !== 'in_stock'", '!specialStockAvailable(line.supplyStatus)'),
        ("row.supply_status !== 'in_stock'", '!specialStockAvailable(row.supply_status)'),
        ("line.supply_status !== 'in_stock'", '!specialStockAvailable(line.supply_status)'),
        ("response.supplyStatus === 'in_stock'", 'specialStockAvailable(response.supplyStatus)'),
        ("line.supply_status === 'in_stock'", 'specialStockAvailable(line.supply_status)'),
        ("input.ready ? 'in_stock'", "input.ready ? (line.supply_status === 'low_inventory' ? 'low_inventory' : 'in_stock')"),
        ('function assertCaseEditable(special) {', "function assertCaseEditable(special) {\n  if (special.information_request?.status === 'pending') {\n    throw workflowError('Sales must submit the requested information before stock checking or order actions.', 409, 'SPECIAL_UPDATE_PENDING');\n  }"),
        ('    handoff: null,', '    handoff: null,\n    informationRequest: row.information_request || null,'),
        ('    submitted: detail.status !== "draft",', '    submitted: detail.status !== "draft",\n    pendingUpdate: detail.informationRequest?.status === \'pending\',')
    ]
    for old, new in replacements:
        assert old in source, 'Worker source drift: ' + old
        source = source.replace(old, new)
    return source


def resolve():
    # Both sides changed SCM cache URLs. Keep the tested URLs, including the
    # recently deployed SCM planning cache key, and one versioned stylesheet.
    for file in ['public/scm-special-stock-requests.js', 'public/scm-stock-requests.html']:
        target = RELEASE / 'candidate-app' / file
        source, count = re.subn(r'^<<<<<<< [^\n]*\n(.*?)^=======\n.*?^>>>>>>> [^\n]*\n', r'\1', target.read_text(), flags=re.M | re.S)
        assert count in (0, 1), file
        if file.endswith('.html'):
            source = source.replace('    <link rel="stylesheet" href="/special-stock-documents.css?scmPlanning=20261002-v2" data-special-document-styles />\n', '')
            assert source.count('data-special-document-styles') == 1
        routing_style = '    <link rel="stylesheet" href="/special-stock-po-routing.css?v=20261001-po-mini-rows-v1" />\n'
        assert source.replace(routing_style, '') == (SERVER / file).read_text().replace(routing_style, ''), 'Resolved app file differs beyond preserved live stylesheet order: ' + file
        target.write_text(source)
    save('merge-resolution.json', {'scmCacheKeysPreserved': True, 'appLogicMatchesVerifiedFiles': True, 'livePoRoutingStylesheetOrderPreserved': True,
                                  'worker': 'Only shared availability, readiness and pending-stage compatibility changes'})


def freeze():
    data = state()
    current(data)
    for service, row in data['services'].items():
        candidate = RELEASE / ('candidate-' + service)
        for file in row['files']:
            assert not any(line.startswith(('<<<<<<< ', '=======', '>>>>>>> ')) for line in (candidate / file).read_text().splitlines()), file
        tree, old = core.files_at(candidate), core.files_at(RELEASE / ('before-' + service))
        changed = sorted(file for file in tree if tree[file] != old.get(file))
        assert set(changed) <= set(row['files']), 'Unexpected changes: ' + service
        row['sourceHashes'] = {file: tree[file] for file in row['files']}
        row['changedFiles'] = changed
        patch = ''.join(''.join(difflib.unified_diff((RELEASE / ('before-' + service) / file).read_text().splitlines(True)
            if (RELEASE / ('before-' + service) / file).exists() else [], (candidate / file).read_text().splitlines(True),
            fromfile='a/' + file, tofile='b/' + file)) for file in changed)
        (RELEASE / (service + '.patch')).write_text(patch)
        save(service + '-source-tree.json', tree)
    save('manifest.json', data)
    print(json.dumps({'frozen': {key: row['changedFiles'] for key, row in data['services'].items()}}), flush=True)


def prepare():
    data = state()
    current(data)
    for service, row in data['services'].items():
        candidate = RELEASE / ('candidate-' + service)
        assert core.files_at(candidate) == json.loads((RELEASE / (service + '-source-tree.json')).read_text())
        directory = RELEASE / ('stage-' + service)
        for file in row['changedFiles']:
            target = directory / 'overlay' / file
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(candidate / file, target)
        parent = 'mbbs-operator-app:stock-updates-base-' + service + '-' + row['before']['imageId'].split(':')[1][:12]
        docker('tag', row['before']['imageId'], parent)
        (directory / 'Dockerfile').write_text('FROM ' + parent + '\nCOPY --chown=node:node overlay/ /app/\n')
        with (RELEASE / (service + '-build.log')).open('wb') as log:
            subprocess.run(['sudo', '-n', 'docker', 'build', '--network', 'none', '--pull=false', '-t', row['image'], str(directory)], stdout=log, stderr=subprocess.STDOUT, check=True)
        row['candidateImageId'] = docker('image', 'inspect', '--format', '{{.Id}}', row['image']).decode().strip()
        assert json.loads(docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', row['image'], '-e', TREE)) == core.files_at(candidate)
        code = "const {execFileSync}=require('node:child_process');for(const file of " + json.dumps(row['changedFiles']) + ")if(file.endsWith('.js'))execFileSync(process.execPath,['--check',file]);"
        docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', row['image'], '-e', code)
        docker('run', '--rm', '--network', 'none', '-e', 'MBBS_ENV_FILE=/nonexistent', '-e', 'NETSUITE_DIRECT_ACCESS_ENABLED=false', '-e', 'NETSUITE_MIRROR_ROLE=disabled',
               '--entrypoint', 'node', row['image'], '--input-type=module', '-e', "await import('./src/server.js'); process.exit(0)")
        print(json.dumps({'built': service, 'imageId': row['candidateImageId'], 'syntaxAndProductionImports': True}), flush=True)
    for kind in ['release', 'rollback']:
        (RELEASE / ('compose.' + kind + '.yml')).write_text('services:\n' + ''.join('  ' + key + ':\n    image: ' +
            (row['image'] if kind == 'release' else row['before']['imageId']) + '\n' for key, row in data['services'].items()))
    core.config_check(data)
    current(data)
    save('manifest.json', data)


def sync_checks():
    data = state()
    for service in data['services']:
        directory = RELEASE / ('checks-' + service)
        shutil.copytree(RELEASE / ('candidate-' + service), directory, dirs_exist_ok=True)
        for folder in ['test', 'tools']:
            shutil.copytree(SERVER / folder, directory / folder, dirs_exist_ok=True)
        remote = '/tmp/special-stock-updates-release-' + service
        docker('exec', 'mbbs-special-review-runner', 'node', '-e', "const f=require('fs');f.rmSync(process.argv[1],{recursive:true,force:true});f.mkdirSync(process.argv[1]);", remote)
        docker('cp', str(directory) + '/.', 'mbbs-special-review-runner:' + remote)
        docker('exec', 'mbbs-special-review-runner', 'node', '-e', "require('fs').symlinkSync('/app/node_modules',process.argv[1]+'/node_modules','dir')", remote)
    print(json.dumps({'candidateChecksSynced': True}), flush=True)


def validate_checks(data):
    for service, row in data['services'].items():
        checks = json.loads((EVIDENCE / ('release-' + service + '-checks.json')).read_text())
        assert checks['passed'] and all(result['fail'] == 0 for result in checks['results'])
        assert checks['sourceHashes'] == row['sourceHashes'], 'Candidate differs from release tests: ' + service
        assert docker('image', 'inspect', '--format', '{{.Id}}', row['image']).decode().strip() == row['candidateImageId']


def worker_red():
    remote = '/tmp/special-stock-updates-worker-before'
    runner = 'mbbs-special-review-runner'
    docker('exec', runner, 'node', '-e', "const f=require('fs');f.rmSync(process.argv[1],{recursive:true,force:true});f.mkdirSync(process.argv[1]+'/test/mbt/integration',{recursive:true});", remote)
    docker('cp', str(RELEASE / 'before-webhook-worker') + '/.', runner + ':' + remote)
    docker('cp', str(SERVER / 'test/mbt/integration/special-stock-updates-worker.test.js'), runner + ':' + remote + '/test/mbt/integration/special-stock-updates-worker.test.js')
    docker('exec', runner, 'node', '-e', "require('fs').symlinkSync('/app/node_modules',process.argv[1]+'/node_modules','dir')", remote)
    result = subprocess.run(['sudo', '-n', 'docker', 'exec', '-e', 'MBT_TEST_ISOLATED=1',
        '-e', 'DATABASE_URL=postgres://mbt_test:stock_updates_test_only@mbbs-special-updates-db-20261002:5432/mbt_verify',
        '-w', remote, runner, 'node', '--test', 'test/mbt/integration/special-stock-updates-worker.test.js'], capture_output=True, text=True)
    log = result.stdout + result.stderr
    (RELEASE / 'worker-red.log').write_text(log)
    assert result.returncode == 1 and '# fail 2\n' in log and 'ERR_MODULE_NOT_FOUND' not in log, log[-4000:]
    save('worker-red.json', {'tests': 2, 'fail': 2, 'behavioralFailuresAgainstPreviousWorker': True})
    print(json.dumps({'workerRegressionReproduced': True, 'failingTests': 2}), flush=True)


def active_work():
    return json.loads(database("""SELECT json_build_object(
      'specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'),
      'quantityApplying',(SELECT count(*) FROM sales_special_stock_cases WHERE quantity_review->>'status'='applying'),
      'operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),
      'driverExecuting',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing'),
      'regularExecuting',(SELECT count(*) FROM regular_stock_handoffs WHERE status='executing'),
      'webhookRunning',(SELECT count(*) FROM netsuite_order_webhook_inbox WHERE status='running'))"""))


def backup_schema():
    for filename, options in [('schema-before.dump', ['--schema-only']), ('migrations-before.dump', ['--table=public.schema_migrations'])]:
        target = RELEASE / filename
        if target.exists():
            continue
        with target.open('wb') as output:
            subprocess.run(['sudo', '-n', 'docker', 'exec', DEPENDENCIES[0], 'pg_dump', '-U', 'mbbs_app', '-d', 'mbbs_yard', '--format=custom', *options], stdout=output, check=True)
        toc = docker('exec', '-i', DEPENDENCIES[0], 'pg_restore', '--list', input=target.read_bytes())
        assert b'schema_migrations' in toc
        (RELEASE / (filename + '.toc')).write_bytes(toc)


def verify():
    data = state()
    core.core.ready(data['services']['app']['candidateImageId'])
    for service, row in data['services'].items():
        actual = metadata(CONTAINERS[service])
        assert actual['imageId'] == row['candidateImageId'], service + ' image differs'
        assert actual['configuration'] == row['before']['configuration'], service + ' configuration changed'
        assert json.loads(docker('exec', CONTAINERS[service], 'node', '-e', TREE)) == json.loads((RELEASE / (service + '-source-tree.json')).read_text())
        runtime = json.loads(docker('inspect', CONTAINERS[service]))[0]
        assert runtime['State']['Running'] and runtime['RestartCount'] == 0, service + ' is not stable'
    assert {name: metadata(name) for name in DEPENDENCIES} == data['dependencies']
    assert database("SELECT count(*) FROM schema_migrations WHERE filename='" + MIGRATION + "'") == '1'
    probe = (SERVER / 'tools/special-stock-updates-live.mjs').read_text().replace('RELEASE_HASHES', json.dumps(data['services']['app']['sourceHashes']))
    checked = json.loads(docker('exec', '-i', CONTAINERS['app'], 'node', '--input-type=module', input=probe.encode()))
    logs = docker('logs', '--since', metadata(CONTAINERS['webhook-worker'])['startedAt'], CONTAINERS['webhook-worker'], stderr=subprocess.STDOUT).decode()
    (RELEASE / 'worker-startup.log').write_text(logs)
    assert 'NetSuite order webhook serial worker ' in logs and ' started.' in logs, 'Worker did not start its polling loop'
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'images': {key: row['candidateImageId'] for key, row in data['services'].items()},
              'configurationPreserved': True, 'databaseAndOllamaPreserved': True, 'migration': MIGRATION, **checked}
    save('result.json', result)
    print(json.dumps(result), flush=True)


def apply():
    os.umask(0o077)
    data = state()
    current(data)
    validate_checks(data)
    core.config_check(data)
    active = active_work()
    save('active-before-release.json', active)
    assert not any(active.values()), 'Wait for active operations: ' + json.dumps(active)
    backup_schema()
    current(data)
    active = active_work()
    assert not any(active.values()), 'Operations started during preparation: ' + json.dumps(active)
    try:
        # A stopped worker cannot start another webhook during the schema/app cutover.
        docker('stop', '--time', '30', CONTAINERS['webhook-worker'])
        assert not any(active_work().values()), 'Wait for active work before applying migration'
        if database("SELECT count(*) FROM schema_migrations WHERE filename='" + MIGRATION + "'") == '0':
            sql = (RELEASE / 'candidate-app/migrations' / MIGRATION).read_text()
            result = database("BEGIN ISOLATION LEVEL REPEATABLE READ; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';\n"
                "CREATE TEMP TABLE stock_update_stage_baseline ON COMMIT DROP AS SELECT * FROM special_stock_workflow_stages;\n" + sql +
                "\nDO $$ BEGIN IF EXISTS(SELECT * FROM stock_update_stage_baseline EXCEPT SELECT * FROM special_stock_workflow_stages) "
                "OR EXISTS(SELECT * FROM special_stock_workflow_stages EXCEPT SELECT * FROM stock_update_stage_baseline) "
                "THEN RAISE EXCEPTION 'Existing workflow stages changed during migration'; END IF; END $$;\n"
                "INSERT INTO schema_migrations(filename) VALUES('" + MIGRATION + "'); COMMIT;")
            (RELEASE / 'migration.log').write_text(result)
            save('migration-result.json', {'applied': MIGRATION, 'transactional': True, 'existingStagesPreserved': True})
        print(json.dumps({'cutoverStarted': True, 'migration': MIGRATION}), flush=True)
        with (RELEASE / 'publish.log').open('wb') as log:
            subprocess.run(core.compose(data) + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app', 'webhook-worker'], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        time.sleep(2)
        verify()
    except Exception:
        with (RELEASE / 'rollback.log').open('wb') as log:
            subprocess.run(core.compose(data, 'compose.rollback.yml') + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app', 'webhook-worker'], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        core.core.ready(data['services']['app']['before']['imageId'])
        save('rollback-result.json', {'restoredPreviousImages': True, 'additiveSchemaRetained': True})
        raise


if __name__ == '__main__':
    {'capture': capture, 'stage': stage, 'resolve': resolve, 'freeze': freeze, 'prepare': prepare, 'sync-checks': sync_checks, 'worker-red': worker_red, 'apply': apply, 'verify': verify}[sys.argv[1]]()
