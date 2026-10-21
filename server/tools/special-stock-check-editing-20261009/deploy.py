"""Publish the verified task overlay on the current app image, with view/image rollback."""
import difflib
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time
import signal

SERVER = Path(__file__).resolve().parents[2]
REPO = SERVER.parent
OUT = SERVER / 'test-artifacts/special-stock-check-editing-20261009'
RELEASE = SERVER / 'deployments/special-stock-check-editing-20261009'
TASK = SERVER / 'tools/special-stock-check-editing-20261009'
APP = 'mbbs-operator-app-app-1'
DB = 'mbbs-operator-app-db-1'
DEPENDENCIES = [DB, 'mbbs-operator-app-webhook-worker-1', 'mbbs-operator-app-ollama-1']
BASE = 'mbbs-operator-app:stock-check-editing-base-20261009'
IMAGE = 'mbbs-operator-app:stock-check-editing-20261009'
MIGRATION = '276_special_stock_check_revisions.sql'
FILES = json.loads((TASK / 'files.json').read_text())
DOCKER = ['sudo', '-n', 'docker']

def docker(*args, **kwargs):
    return subprocess.check_output(DOCKER + list(args), **kwargs)

def sha(value):
    return hashlib.sha256(value).hexdigest()

def metadata(name):
    row = json.loads(docker('inspect', name))[0]
    config = {'Config': {key: value for key, value in row['Config'].items() if key not in ['Image', 'Labels', 'Hostname']},
              'HostConfig': row['HostConfig']}
    config['Config']['Env'] = sorted(config['Config']['Env'])
    # Compose may reorder the same independent mount bindings on recreation.
    config['HostConfig']['Binds'] = sorted(config['HostConfig'].get('Binds') or [])
    return {'image': row['Image'], 'configHash': sha(json.dumps(config, sort_keys=True).encode())}

def save(name, value):
    (RELEASE / name).write_text(json.dumps(value, indent=2) + '\n')

def compose(state, override):
    labels = state['compose']
    args = DOCKER + ['compose', '--project-name', labels['com.docker.compose.project'],
                     '--project-directory', labels['com.docker.compose.project.working_dir']]
    if labels.get('com.docker.compose.project.environment_file'):
        args += ['--env-file', labels['com.docker.compose.project.environment_file']]
    for file in labels['com.docker.compose.project.config_files'].split(','):
        args += ['-f', file]
    return args + ['-f', str(override)]

def database(sql):
    return docker('exec', '-i', DB, 'psql', '-U', 'mbbs_app', '-d', 'mbbs_yard', '-XAt', '-v', 'ON_ERROR_STOP=1', input=sql.encode()).decode().strip()

def current(state):
    assert metadata(APP) == state['app'], 'Application changed; rebase onto the current release'
    assert {name: metadata(name) for name in DEPENDENCIES} == state['dependencies'], 'Production dependency changed'

def image_check(budget, args, kind):
    name = 'mbbs-stock-check-image-' + kind + '-' + str(time.time_ns())
    # Register exact-container removal before launching the one-off test.
    try:
        return docker(*budget, '--name', name, *args)
    finally:
        subprocess.run(DOCKER + ['rm', '-f', '-v', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def normalize_state():
    """Validate old hashes before upgrading the initial release's mount-order hash."""
    state = json.loads((RELEASE / 'state.json').read_text())
    assert not database(f"SELECT filename FROM schema_migrations WHERE filename='{MIGRATION}'")
    diagnosis = json.loads((OUT / 'configuration-order-diagnosis.json').read_text())
    assert len(diagnosis) == 1 and diagnosis[0]['field'] == 'HostConfig.Binds'
    for name, expected in [(APP, state['app']), *state['dependencies'].items()]:
        row = json.loads(docker('inspect', name))[0]
        assert row['Image'] == expected['image']
        config = {'Config': {key: value for key, value in row['Config'].items() if key not in ['Image', 'Labels', 'Hostname']}, 'HostConfig': row['HostConfig']}
        config['Config']['Env'] = sorted(config['Config']['Env'])
        if name == APP:
            assert sorted(config['HostConfig']['Binds']) == sorted(diagnosis[0]['original'])
            config['HostConfig']['Binds'] = diagnosis[0]['original']
        assert sha(json.dumps(config, sort_keys=True).encode()) == expected['configHash'], 'Configuration changed beyond mount order: ' + name
    save('state.uncanonicalized.json', state)
    state['app'] = metadata(APP)
    state['dependencies'] = {name: metadata(name) for name in DEPENDENCIES}
    save('state.json', state)
    print(json.dumps({'configurationPreserved': True, 'onlyDifference': 'mount-binding order', 'hashNormalization': True}), flush=True)

def prepare():
    verified = json.loads((OUT / 'summary.json').read_text())
    assert verified['focused']['fail'] == verified['reverse']['fail'] == verified['restored']['fail'] == 0
    assert not verified['newFailures'] and all(row['killed'] for row in verified['mutations'])
    coverage = json.loads((OUT / 'changed-coverage.json').read_text())
    assert coverage['changedLines'] == coverage['executedLines'] and coverage['changedLines'] > 0
    assert not any(json.loads((OUT / 'static.json').read_text())[key] for key in ['newTypes', 'newLint'])
    cleanup = json.loads((OUT / 'cleanup-final.json').read_text())
    assert not cleanup['testContainers'] and cleanup['productionHealthy']
    assert all(sha((SERVER / file).read_bytes()) == verified['hashes'][file] for file in FILES)
    original = json.loads(docker('inspect', APP))[0]
    state = {'app': metadata(APP), 'dependencies': {name: metadata(name) for name in DEPENDENCIES},
             'compose': {key: value for key, value in original['Config']['Labels'].items() if key.startswith('com.docker.compose.project')}}
    RELEASE.mkdir(parents=True, exist_ok=False)
    save('state.json', state)
    patch = ''
    for file in FILES:
        target = RELEASE / 'overlay' / file
        target.parent.mkdir(parents=True, exist_ok=True)
        if file.startswith('migrations/'):
            assert not database(f"SELECT filename FROM schema_migrations WHERE filename='{MIGRATION}'"), 'Migration already applied'
            before = ''
        else:
            live = docker('exec', APP, 'cat', '/app/' + file)
            assert live == (TASK / 'baseline' / file).read_bytes(), 'Task source changed in production: ' + file
            backup = RELEASE / 'before' / file
            backup.parent.mkdir(parents=True, exist_ok=True)
            backup.write_bytes(live)
            before = live.decode()
        target.write_bytes((SERVER / file).read_bytes())
        patch += ''.join(difflib.unified_diff(before.splitlines(True), target.read_text().splitlines(True), fromfile='a/' + file, tofile='b/' + file))
    (RELEASE / 'task.patch').write_text(patch)
    view = database("SELECT pg_get_viewdef('special_stock_workflow_stages'::regclass,true)")
    (RELEASE / 'view.rollback.sql').write_text('CREATE OR REPLACE VIEW special_stock_workflow_stages AS\n' + view + '\n')
    assert [line.strip() for line in (OUT / 'view-before.sql').read_text().splitlines()] == [line.strip() for line in (RELEASE / 'view.rollback.sql').read_text().splitlines()], 'Stage view changed since investigation'
    current(state)
    docker('tag', state['app']['image'], BASE)
    (RELEASE / 'Dockerfile').write_text('FROM ' + BASE + '\nCOPY --chown=node:node overlay/ /app/\n')
    with (OUT / 'build.log').open('wb') as log:
        subprocess.run(DOCKER + ['build', '--network=none', '--pull=false', '-t', IMAGE, str(RELEASE)], stdout=log, stderr=subprocess.STDOUT, check=True)
    candidate = docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    # These image checks are one-off disposable tests with the required host budget.
    budget = ['run', '--rm', '--init', '--network=none', '--cgroup-parent=mbbs-tests.slice', '--memory=1g', '--memory-swap=1g',
              '--cpus=1', '--pids-limit=256', '--label=com.mbbs.lifecycle=disposable-test',
              '--tmpfs=/tmp:rw,size=128m', '--tmpfs=/app/data:rw,uid=1000,gid=1000,size=128m', '--entrypoint=node']
    code = "const f=require('fs'),c=require('crypto'),p=JSON.parse(process.argv[1]);for(const [file,expected] of Object.entries(p)){if(c.createHash('sha256').update(f.readFileSync(file)).digest('hex')!==expected)throw Error(file)}console.log('Candidate source hashes verified');"
    image_check(budget, [IMAGE, '-e', code, json.dumps(verified['hashes'])], 'source')
    image_check(budget, ['-e', 'MBBS_ENV_FILE=/nonexistent', '-e', 'NETSUITE_DIRECT_ACCESS_ENABLED=false', '-e', 'NETSUITE_MIRROR_ROLE=disabled',
                IMAGE, '--input-type=module', '-e', "await import('./src/server.js'); console.log('Candidate server imported'); process.exit(0)"], 'startup')
    active = docker('ps', '--format', '{{.Names}}\t{{.Status}}').decode()
    all_containers = docker('ps', '-a', '--format', '{{.Names}}\t{{.Status}}').decode()
    residual = docker('ps', '-a', '--filter', 'label=com.mbbs.lifecycle=disposable-test', '--format', '{{.Names}}').decode().strip()
    assert not residual, 'An image-check test container remains'
    health = json.loads(docker('exec', APP, 'node', '-e', "fetch('http://127.0.0.1:3000/health').then(r=>r.json()).then(h=>console.log(JSON.stringify(h)))"))
    assert health.get('ok') is True
    (OUT / 'cleanup-images.json').write_text(json.dumps({'dockerPs': active, 'dockerPsA': all_containers, 'testContainers': residual, 'productionHealthy': True}, indent=2))
    (RELEASE / 'compose.release.yml').write_text(f'services:\n  app:\n    image: {IMAGE}\n    pull_policy: never\n')
    (RELEASE / 'compose.rollback.yml').write_text(f'services:\n  app:\n    image: {BASE}\n    pull_policy: never\n')
    service = json.loads(subprocess.check_output(compose(state, RELEASE / 'compose.release.yml') + ['config', '--format', 'json'], stderr=subprocess.PIPE))['services']['app']
    environment = dict(value.split('=', 1) for value in original['Config']['Env'])
    assert all(environment.get(key) == str(value) for key, value in service.get('environment', {}).items()), 'Environment drift'
    save('manifest.json', {'candidateImage': candidate, 'baseImage': state['app']['image'], 'hashes': verified['hashes'], 'migration': MIGRATION})
    current(state)
    print(json.dumps({'prepared': True, 'candidateImage': candidate, 'files': FILES, 'configurationPreserved': True}), flush=True)

def verify():
    state = json.loads((RELEASE / 'state.json').read_text())
    manifest = json.loads((RELEASE / 'manifest.json').read_text())
    deployed = metadata(APP)
    assert deployed['image'] == manifest['candidateImage'] and deployed['configHash'] == state['app']['configHash']
    assert all(sha(docker('exec', APP, 'cat', '/app/' + file)) == expected for file, expected in manifest['hashes'].items())
    assert {name: metadata(name) for name in DEPENDENCIES} == state['dependencies']
    health = json.loads(docker('exec', APP, 'node', '-e', "fetch('http://127.0.0.1:3000/health').then(r=>r.json()).then(h=>console.log(JSON.stringify(h)))"))
    assert health['ok'] is True
    script = """import {getSpecialStockCase,listSpecialStockCases} from './src/special-stock-request-repository.js';import {query,closeDb} from './src/db.js';
    try{const d=await getSpecialStockCase(162,{audience:'scm'});const stage=(await query('SELECT stage FROM special_stock_workflow_stages WHERE request_id=$1',[d.id])).rows[0].stage;
    const queued=(await listSpecialStockCases({audience:'scm',stages:['await_customer_confirmation'],search:'SPREQ-000063'})).some(r=>r.id===d.id);
    console.log(JSON.stringify({ref:d.requestRef,revision:d.revision,stage:d.stage,sqlStage:stage,confirmationQueue:queued,lines:d.lines.length,
    declinedLines:d.lines.filter(l=>l.salesDecision==='declined').map(l=>({id:l.id,name:l.productName,supplyStatus:l.supplyStatus})),orders:{so:d.salesOrderId,po:d.purchaseOrderId}}));}finally{await closeDb();}"""
    result = json.loads(docker('exec', '-i', APP, 'node', '--input-type=module', input=script.encode()))
    assert result['ref'] == 'SPREQ-000063' and result['stage'] == result['sqlStage'] == 'await_customer_confirmation' and result['confirmationQueue']
    evidence = {'deployed': True, 'healthy': True, 'configurationPreserved': True, 'dependenciesPreserved': True, **result}
    (OUT / 'live.json').write_text(json.dumps(evidence, indent=2) + '\n')
    print(json.dumps(evidence), flush=True)

def apply():
    state = json.loads((RELEASE / 'state.json').read_text())
    current(state)
    active = json.loads(database("SELECT json_build_object('specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'), 'quantityApplying',(SELECT count(*) FROM sales_special_stock_cases WHERE quantity_review->>'status'='applying'),'operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),'driverExecuting',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing'),'regularExecuting',(SELECT count(*) FROM regular_stock_handoffs WHERE status='executing'))"))
    assert not any(active.values()), 'Active application writes must finish before the short app restart: ' + json.dumps(active)
    migration = (SERVER / 'migrations' / MIGRATION).read_text()
    try:
        database("BEGIN; SET LOCAL lock_timeout='5s';\n" + migration + f"\nINSERT INTO schema_migrations(filename) VALUES('{MIGRATION}'); COMMIT;")
        with (OUT / 'publish.log').open('wb') as log:
            subprocess.run(compose(state, RELEASE / 'compose.release.yml') + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'app'], stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        for _ in range(25):
            if docker('inspect', '--format', '{{.State.Health.Status}}', APP).decode().strip() == 'healthy':
                break
            time.sleep(1)
        verify()
    except BaseException:
        with (OUT / 'rollback.log').open('wb') as log:
            subprocess.run(compose(state, RELEASE / 'compose.rollback.yml') + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'app'], stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        database("BEGIN; SET LOCAL lock_timeout='5s';\n" + (RELEASE / 'view.rollback.sql').read_text() + f"\nDELETE FROM schema_migrations WHERE filename='{MIGRATION}'; COMMIT;")
        raise

if __name__ == '__main__':
    def interrupted(_signal, _frame):
        raise KeyboardInterrupt('Interrupted: remove one-off tests and roll back any incomplete release')
    signal.signal(signal.SIGTERM, interrupted)
    {'prepare': prepare, 'apply': apply, 'verify': verify, 'normalize-state': normalize_state}[sys.argv[1]]()
