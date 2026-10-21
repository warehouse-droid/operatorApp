"""Prepare and publish only the verified sharing patch, retaining rollback data."""
import difflib
import hashlib
import json
from pathlib import Path
import signal
import subprocess
import sys
import time

SERVER = Path(__file__).resolve().parents[2]
REPO = SERVER.parent
TASK = Path(__file__).resolve().parent
OUT = SERVER / 'test-artifacts/special-shared-orders-20261009'
RELEASE = SERVER / 'deployments/special-shared-orders-20261009'
DOCKER = ['sudo', '-n', 'docker']
SERVICES = {'app': 'mbbs-operator-app-app-1', 'webhook-worker': 'mbbs-operator-app-webhook-worker-1'}
DEPENDENCIES = ['mbbs-operator-app-db-1', 'mbbs-operator-app-ollama-1']
FILES = ['src/special-stock-request-repository.js', 'src/server.js']
MIGRATION = '278_special_shared_orders.sql'

def docker(*args, **kwargs):
    return subprocess.check_output(DOCKER + list(args), **kwargs)

def sha(value):
    return hashlib.sha256(value).hexdigest()

def save(name, value):
    target = RELEASE / name
    target.write_text(json.dumps(value, indent=2) + '\n')
    target.chmod(0o600)

def metadata(name):
    row = json.loads(docker('inspect', name))[0]
    config = {'Config': {key: value for key, value in row['Config'].items() if key not in ['Image', 'Labels', 'Hostname']}, 'HostConfig': row['HostConfig']}
    config['Config']['Env'] = sorted(config['Config']['Env'])
    config['HostConfig']['Binds'] = sorted(config['HostConfig'].get('Binds') or [])
    return {'image': row['Image'], 'configHash': sha(json.dumps(config, sort_keys=True).encode())}

def compose(state, service, suffix):
    labels = state['compose'][service]
    args = DOCKER + ['compose', '--project-name', labels['com.docker.compose.project'],
                     '--project-directory', labels['com.docker.compose.project.working_dir']]
    if labels.get('com.docker.compose.project.environment_file'):
        args += ['--env-file', labels['com.docker.compose.project.environment_file']]
    for file in labels['com.docker.compose.project.config_files'].split(','):
        args += ['-f', file]
    return args + ['-f', str(RELEASE / ('compose.' + suffix + '.json'))]

def database(sql):
    return docker('exec', '-i', 'mbbs-operator-app-db-1', 'psql', '-U', 'mbbs_app', '-d', 'mbbs_yard', '-XAt', '-v', 'ON_ERROR_STOP=1', input=sql.encode()).decode().strip()

def current(state):
    assert {service: metadata(name) for service, name in SERVICES.items()} == state['services'], 'Live app or worker changed; rebase the task release'
    assert {name: metadata(name) for name in DEPENDENCIES} == state['dependencies'], 'Production dependency changed'

def evidence():
    summary = json.loads((OUT / 'summary.json').read_text())
    assert not summary['newFailures']
    assert summary['focused']['fail'] == summary['restored']['fail'] == summary['backorder']['fail'] == 0
    assert all(result['killed'] for result in summary['mutations'])
    assert not summary['staticResults']['newTypes'] and not summary['staticResults']['newLint']
    assert not json.loads((OUT / 'changed-coverage.json').read_text())['uncovered']
    assert json.loads((OUT / 'migration.json').read_text())['rollbackVerified']
    cleanup = json.loads((OUT / 'cleanup-final.json').read_text())
    assert not cleanup['testContainers'] and cleanup['productionHealthy']
    assert all(sha((SERVER / file).read_bytes()) == expected for file, expected in summary['hashes'].items()), 'Validated source changed'
    return summary

def prepare():
    evidence()
    subprocess.run(['python3', str(TASK / 'render.py')], check=True)
    originals = {service: json.loads(docker('inspect', name))[0] for service, name in SERVICES.items()}
    state = {'services': {service: metadata(name) for service, name in SERVICES.items()},
             'dependencies': {name: metadata(name) for name in DEPENDENCIES},
             'compose': {service: {key: value for key, value in row['Config']['Labels'].items() if key.startswith('com.docker.compose.project')} for service, row in originals.items()}}
    assert not database(f"SELECT filename FROM schema_migrations WHERE filename='{MIGRATION}'"), 'Sharing migration already applied'
    RELEASE.mkdir(parents=True, exist_ok=False)
    save('state.json', state)
    definitions = json.loads(database("SELECT json_build_object('indexes',(SELECT json_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE tablename='sales_special_stock_cases' AND indexname IN ('idx_sales_special_stock_so_owner','idx_sales_special_stock_po_owner')),'comment',obj_description('sales_special_stock_cases'::regclass))"))
    save('database-before.json', definitions)
    rollback = 'DROP INDEX idx_sales_special_stock_so_owner;\nDROP INDEX idx_sales_special_stock_po_owner;\n' + '\n'.join(value + ';' for value in definitions['indexes']) + '\n'
    rollback += "COMMENT ON TABLE sales_special_stock_cases IS '" + definitions['comment'].replace("'", "''") + "';\n"
    rollback += f"DELETE FROM schema_migrations WHERE filename='{MIGRATION}';\n"
    (RELEASE / 'migration.rollback.sql').write_text(rollback)
    manifest = {}
    for service, container in SERVICES.items():
        overlay = RELEASE / service / 'overlay'
        hashes = {}
        patch = ''
        for file in FILES:
            baseline = TASK / 'baseline' / file if service == 'app' else TASK / 'baseline/src' / ('worker-' + Path(file).name)
            source = SERVER / file if service == 'app' else TASK / 'worker' / file
            live = docker('exec', container, 'cat', '/app/' + file)
            original = baseline.read_bytes()
            candidate = source.read_bytes()
            if live != original and service == 'app' and file == 'src/server.js':
                old = b'// Account preferences and phone layout policy are independent of the selected yard.'
                new = b'// Account preferences are independent of the currently selected yard.'
                assert original.count(old) == candidate.count(old) == 1
                assert original.replace(old, new) == live, 'Live executable code changed; rebase and verify'
                candidate = candidate.replace(old, new)
                save('app-comment-rebase.json', {'baselineHash': sha(original), 'liveHash': sha(live), 'candidateHash': sha(candidate), 'executableCodeUnchanged': True})
            else:
                assert live == original, 'Deployed task file changed: ' + service + '/' + file
            target = overlay / file
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(candidate)
            before = RELEASE / service / 'before' / file
            before.parent.mkdir(parents=True, exist_ok=True)
            before.write_bytes(live)
            hashes[file] = sha(target.read_bytes())
            patch += ''.join(difflib.unified_diff(live.decode().splitlines(True), target.read_text().splitlines(True), fromfile='a/' + file, tofile='b/' + file))
        target = overlay / 'migrations' / MIGRATION
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((SERVER / 'migrations' / MIGRATION).read_bytes())
        hashes['migrations/' + MIGRATION] = sha(target.read_bytes())
        (RELEASE / service / 'task.patch').write_text(patch)
        base = 'mbbs-operator-app:shared-orders-' + service + '-base-20261009'
        image = 'mbbs-operator-app:shared-orders-' + service + '-20261009'
        docker('tag', state['services'][service]['image'], base)
        (RELEASE / service / 'Dockerfile').write_text('FROM ' + base + '\nCOPY --chown=node:node overlay/ /app/\n')
        with (OUT / ('build-' + service + '.log')).open('wb') as log:
            subprocess.run(DOCKER + ['build', '--network=none', '--pull=false', '-t', image, str(RELEASE / service)], stdout=log, stderr=subprocess.STDOUT, check=True)
        manifest[service] = {'candidateImage': docker('image', 'inspect', '--format', '{{.Id}}', image).decode().strip(),
                             'baseImage': state['services'][service]['image'], 'hashes': hashes}
    save('manifest.json', manifest)
    save('compose.release.json', {'services': {service: {'image': data['candidateImage'], 'pull_policy': 'never'} for service, data in manifest.items()}})
    save('compose.rollback.json', {'services': {service: {'image': data['baseImage'], 'pull_policy': 'never'} for service, data in manifest.items()}})
    for service, row in originals.items():
        resolved = json.loads(subprocess.check_output(compose(state, service, 'release') + ['config', '--format', 'json'], stderr=subprocess.PIPE))['services'][service]
        environment = dict(value.split('=', 1) for value in row['Config']['Env'])
        assert all(environment.get(key) == str(value) for key, value in resolved.get('environment', {}).items()), 'Runtime environment drift: ' + service
    current(state)
    subprocess.run(['python3', str(TASK / 'image-tests.py')], check=True)
    print(json.dumps({'prepared': True, 'services': list(SERVICES), 'migration': MIGRATION, 'candidateImagesTested': True}), flush=True)

def verify():
    state = json.loads((RELEASE / 'state.json').read_text())
    manifest = json.loads((RELEASE / 'manifest.json').read_text())
    for service, container in SERVICES.items():
        actual = metadata(container)
        assert actual['image'] == manifest[service]['candidateImage']
        assert actual['configHash'] == state['services'][service]['configHash'], 'Runtime configuration drift: ' + service
        assert all(sha(docker('exec', container, 'cat', '/app/' + file)) == expected for file, expected in manifest[service]['hashes'].items())
        assert docker('inspect', '--format', '{{.State.Running}}', container).decode().strip() == 'true'
    assert {name: metadata(name) for name in DEPENDENCIES} == state['dependencies']
    assert database(f"SELECT filename FROM schema_migrations WHERE filename='{MIGRATION}'") == MIGRATION
    indexes = json.loads(database("SELECT json_agg(json_build_object('index',indexname,'unique',indexdef LIKE 'CREATE UNIQUE INDEX%') ORDER BY indexname) FROM pg_indexes WHERE tablename='sales_special_stock_cases' AND indexname IN ('idx_sales_special_stock_so_owner','idx_sales_special_stock_po_owner','idx_sales_special_stock_so_operation','idx_sales_special_stock_po_operation')"))
    assert len(indexes) == 4 and all(row['unique'] == row['index'].endswith('_operation') for row in indexes)
    assert docker('inspect', '--format', '{{.State.Health.Status}}', SERVICES['app']).decode().strip() == 'healthy'
    health = json.loads(docker('exec', SERVICES['app'], 'node', '-e', "fetch('http://127.0.0.1:3000/health').then(r=>r.json()).then(h=>console.log(JSON.stringify(h)))"))
    assert health.get('ok') is True
    result = {'deployed': True, 'services': list(SERVICES), 'sourceHashesVerified': True, 'configurationPreserved': True,
              'sharingIndexes': indexes, 'productionHealthy': True, 'migration': MIGRATION}
    (OUT / 'deployed.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result), flush=True)

def publish(state, suffix):
    for service in ['webhook-worker', 'app']:
        with (OUT / ('publish-' + suffix + '-' + service + '.log')).open('wb') as log:
            subprocess.run(compose(state, service, suffix) + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', service],
                           stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)

def apply():
    evidence()
    assert json.loads((OUT / 'image-tests.json').read_text()) == {'app': 'pass', 'webhook-worker': 'pass', 'actualCandidateImages': True}
    state = json.loads((RELEASE / 'state.json').read_text())
    current(state)
    active = json.loads(database("SELECT json_build_object('specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'),'quantityApplying',(SELECT count(*) FROM sales_special_stock_cases WHERE quantity_review->>'status'='applying'),'operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),'driverExecuting',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing'),'regularExecuting',(SELECT count(*) FROM regular_stock_handoffs WHERE status='executing'))"))
    assert not any(active.values()), 'Wait for active application work to finish: ' + json.dumps(active)
    applied = False
    try:
        docker('stop', '--time', '30', *SERVICES.values())
        sql = (SERVER / 'migrations' / MIGRATION).read_text()
        # Compare all case rows under the migration lock; no operational data is changed.
        migration = "BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'; LOCK TABLE sales_special_stock_cases IN ACCESS EXCLUSIVE MODE; CREATE TEMP TABLE sharing_before ON COMMIT DROP AS SELECT to_jsonb(row) AS data FROM sales_special_stock_cases row;\n" + sql
        migration += "\nDO $$ BEGIN IF EXISTS((SELECT data FROM sharing_before EXCEPT SELECT to_jsonb(row) FROM sales_special_stock_cases row) UNION ALL (SELECT to_jsonb(row) FROM sales_special_stock_cases row EXCEPT SELECT data FROM sharing_before)) THEN RAISE EXCEPTION 'Order-sharing migration changed operational data'; END IF; END $$;\n"
        migration += f"INSERT INTO schema_migrations(filename) VALUES('{MIGRATION}'); COMMIT;"
        database(migration)
        applied = True
        publish(state, 'release')
        for _attempt in range(30):
            if docker('inspect', '--format', '{{.State.Health.Status}}', SERVICES['app']).decode().strip() == 'healthy':
                break
            time.sleep(1)
        verify()
        (OUT / 'migration-live.json').write_text(json.dumps({'applied': MIGRATION, 'allExistingCaseRowsPreserved': True}))
    except BaseException:
        docker('stop', '--time', '30', *SERVICES.values())
        if applied:
            duplicates = int(database("SELECT count(*) FROM (SELECT sales_order_netsuite_id FROM sales_special_stock_cases WHERE workflow_kind='special' AND sales_order_netsuite_id IS NOT NULL GROUP BY sales_order_netsuite_id HAVING count(*)>1 UNION ALL SELECT purchase_order_netsuite_id FROM sales_special_stock_cases WHERE workflow_kind='special' AND purchase_order_netsuite_id IS NOT NULL GROUP BY purchase_order_netsuite_id HAVING count(*)>1) duplicates"))
            if duplicates == 0:
                database("BEGIN; SET LOCAL lock_timeout='5s';\n" + (RELEASE / 'migration.rollback.sql').read_text() + '\nCOMMIT;')
            else:
                save('rollback-retained-shared-references.json', {'retainedNonUniqueIndexes': True, 'duplicateGroups': duplicates, 'reason': 'Preserve newly linked user data'})
        publish(state, 'rollback')
        raise

def interrupted(_signal, _frame):
    raise KeyboardInterrupt('Roll back incomplete release and remove image tests')

signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
if __name__ == '__main__':
    {'prepare': prepare, 'apply': apply, 'verify': verify}[sys.argv[1]]()
