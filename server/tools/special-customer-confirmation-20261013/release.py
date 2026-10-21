"""Prepare, test and release only the verified Special request status changes."""
import difflib
import hashlib
import io
import json
from pathlib import Path
import signal
import subprocess
import sys
import tarfile
import time

SERVER = Path(__file__).resolve().parents[2]
REPO = SERVER.parent
OUT = SERVER / 'test-artifacts/special-customer-confirmation-20261013'
RELEASE = SERVER / 'deployments/special-request-status-20261013'
DOCKER = ['sudo', '-n', 'docker']
APP = 'mbbs-operator-app-app-1'
DB = 'mbbs-operator-app-db-1'
DEPENDENCIES = [DB, 'mbbs-operator-app-webhook-worker-1', 'mbbs-operator-app-ollama-1']
BASE = 'mbbs-operator-app:special-status-base-20261013'
IMAGE = 'mbbs-operator-app:special-request-status-20261013'
MIGRATION = '283_special_customer_confirmation.sql'
FILES = ['public/special-stock-workflow.js', 'public/special-stock-case-edits.js',
         'public/special-stock-case-status.js', 'public/scm-special-stock-requests.js',
         'src/special-stock-request-repository.js']
PROJECT = 'mbbs-special-status-candidate-20261013'

def docker(*args, **kwargs):
    return subprocess.check_output(DOCKER + list(args), **kwargs)

def sha(value):
    return hashlib.sha256(value).hexdigest()

def save(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')

def metadata(name):
    row = json.loads(docker('inspect', name))[0]
    config = {'Config': {key: value for key, value in row['Config'].items() if key not in ['Image', 'Labels', 'Hostname']},
              'HostConfig': row['HostConfig']}
    config['Config']['Env'] = sorted(config['Config']['Env'])
    config['HostConfig']['Binds'] = sorted(config['HostConfig'].get('Binds') or [])
    return {'image': row['Image'], 'configHash': sha(json.dumps(config, sort_keys=True).encode())}

def database(sql):
    return docker('exec', '-i', DB, 'psql', '-U', 'mbbs_app', '-d', 'mbbs_yard', '-XAt', '-v', 'ON_ERROR_STOP=1', input=sql.encode()).decode().strip()

def production_compose(state, override):
    labels = state['compose']
    args = DOCKER + ['compose', '--project-name', labels['com.docker.compose.project'],
                     '--project-directory', labels['com.docker.compose.project.working_dir']]
    if labels.get('com.docker.compose.project.environment_file'):
        args += ['--env-file', labels['com.docker.compose.project.environment_file']]
    for file in labels['com.docker.compose.project.config_files'].split(','):
        args += ['-f', file]
    return args + ['-f', str(override)]

def current(state):
    assert metadata(APP) == state['app'], 'Running app changed; prepare against its new image'
    assert {name: metadata(name) for name in DEPENDENCIES} == state['dependencies']

def logged(label, args):
    with (OUT / (label + '.log')).open('wb') as log:
        result = subprocess.run(args, stdout=log, stderr=subprocess.STDOUT, cwd=REPO)
    print(json.dumps({'check': label, 'exit': result.returncode}), flush=True)
    if result.returncode:
        print((OUT / (label + '.log')).read_text()[-7000:], flush=True)
    return result.returncode

def cleanup_evidence(compose):
    result = logged('candidate-teardown', compose + ['--profile', '*', 'down', '--volumes', '--remove-orphans'])
    active = docker('ps', '--format', '{{.Names}}\t{{.Status}}').decode()
    all_containers = docker('ps', '-a', '--format', '{{.Names}}\t{{.Status}}').decode()
    tests = docker('ps', '-a', '--filter', 'label=com.mbbs.lifecycle=disposable-test', '--format', '{{.Names}}').decode().strip()
    networks = docker('network', 'ls', '--filter', 'label=com.docker.compose.project=' + PROJECT, '--format', '{{.Name}}').decode().strip()
    volumes = docker('volume', 'ls', '--filter', 'label=com.docker.compose.project=' + PROJECT, '--format', '{{.Name}}').decode().strip()
    health = json.loads(docker('exec', APP, 'node', '-e', "fetch('http://127.0.0.1:3000/health').then(r=>r.json()).then(h=>console.log(JSON.stringify({ok:h.ok})))"))
    save(OUT / 'candidate-cleanup.json', {'dockerPs': active, 'dockerPsA': all_containers, 'testContainers': tests,
        'testNetworks': networks, 'testVolumes': volumes, 'productionHealthy': health.get('ok') is True})
    assert result == 0 and not tests and not networks and not volumes and health.get('ok') is True

def prepare():
    checks = json.loads((OUT / 'checks.json').read_text())
    assert all(code == 0 for name, code in checks.items() if not name.startswith('known-'))
    assert not json.loads((OUT / 'cleanup.json').read_text())['testContainers']
    assert not database(f"SELECT filename FROM schema_migrations WHERE filename='{MIGRATION}'")
    RELEASE.mkdir(parents=True, exist_ok=False)
    original = json.loads(docker('inspect', APP))[0]
    state = {'app': metadata(APP), 'dependencies': {name: metadata(name) for name in DEPENDENCIES},
             'compose': {key: value for key, value in original['Config']['Labels'].items() if key.startswith('com.docker.compose.project')}}
    save(RELEASE / 'state.json', state)
    patch = ''
    for file in FILES:
        before = docker('exec', APP, 'cat', '/app/' + file)
        target = RELEASE / 'overlay' / file
        backup = RELEASE / 'before' / file
        for path in [target, backup]:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(before)
        task_before = (OUT / 'before' / file).read_text()
        patch += ''.join(difflib.unified_diff(task_before.splitlines(True), (SERVER / file).read_text().splitlines(True), fromfile='a/' + file, tofile='b/' + file))
    (RELEASE / 'task.patch').write_text(patch)
    assert logged('candidate-patch', ['patch', '--batch', '--forward', '--fuzz=0', '-p1', '-d', str(RELEASE / 'overlay'), '-i', str(RELEASE / 'task.patch')]) == 0
    target = RELEASE / 'overlay/migrations' / MIGRATION
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes((SERVER / 'migrations' / MIGRATION).read_bytes())
    rollback = database("SELECT pg_get_viewdef('special_stock_workflow_stages'::regclass,true)")
    (RELEASE / 'view.rollback.sql').write_text('CREATE OR REPLACE VIEW special_stock_workflow_stages AS\n' + rollback + '\nDROP VIEW IF EXISTS special_stock_completion_evidence;\n')
    current(state)
    docker('tag', state['app']['image'], BASE)
    (RELEASE / 'Dockerfile').write_text(f'FROM {BASE}\nCOPY --chown=node:node overlay/ /app/\n')
    assert logged('candidate-build', DOCKER + ['build', '--network=none', '--pull=false', '-t', IMAGE, str(RELEASE)]) == 0
    hashes = {file: sha((RELEASE / 'overlay' / file).read_bytes()) for file in FILES + ['migrations/' + MIGRATION]}
    manifest = {'candidateImage': docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip(),
                'baseImage': state['app']['image'], 'migration': MIGRATION, 'hashes': hashes}
    save(RELEASE / 'manifest.json', manifest)
    for name, image in [('release', IMAGE), ('rollback', BASE)]:
        save(RELEASE / ('compose.' + name + '.json'), {'services': {'app': {'image': image, 'pull_policy': 'never'}}})
    rendered = json.loads(subprocess.check_output(production_compose(state, RELEASE / 'compose.release.json') + ['config', '--format', 'json'], stderr=subprocess.PIPE))['services']['app']
    environment = dict(value.split('=', 1) for value in original['Config']['Env'])
    assert all(environment.get(key) == str(value) for key, value in rendered.get('environment', {}).items()), 'Environment drift'
    print(json.dumps({'prepared': True, 'files': list(hashes), 'candidateImage': manifest['candidateImage']}), flush=True)

def check():
    state = json.loads((RELEASE / 'state.json').read_text())
    current(state)
    snapshot = RELEASE / 'candidate-code'
    snapshot.mkdir(exist_ok=True)
    name = PROJECT + '-extract'
    # Register exact-container teardown before extracting the image's code.
    try:
        archive = docker('run', '--rm', '--name', name, '--init', '--cgroup-parent=mbbs-tests.slice',
            '--memory=512m', '--memory-swap=512m', '--pids-limit=128', '--cpus=1', '--tmpfs', '/tmp:size=64m',
            '--label', 'com.mbbs.lifecycle=disposable-test', '--read-only', '--network=none', '--entrypoint=tar', IMAGE,
            '-C', '/app', '-cf', '-', 'src', 'public', 'migrations', 'package.json', 'netsuite-smart-scm-picking-ticket-restlet.js')
        with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
            tar.extractall(snapshot, filter='data')
    finally:
        subprocess.run(DOCKER + ['rm', '-f', '-v', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    labels = {'com.mbbs.lifecycle': 'disposable-test', 'com.mbbs.task': PROJECT}
    mounts = [f'{snapshot / folder}:/app/{folder}:ro' for folder in ['src', 'public', 'migrations']]
    mounts += [f'{snapshot / file}:/app/{file}:ro' for file in ['package.json', 'netsuite-smart-scm-picking-ticket-restlet.js']]
    mounts += [f'{SERVER / "test"}:/app/test:ro', f'{SERVER / "test-artifacts/driver-upload-reliability/toolchain/node_modules"}:/app/node_modules:ro']
    environment = {'DATABASE_URL': 'postgres://mbt_test:mbt_test_password@mbbs-special-review-db:5432/mbt_verify',
        'PLAYWRIGHT_BROWSERS_PATH': '/ms-playwright', 'XDG_CONFIG_HOME': '/tmp/status-config', 'XDG_CACHE_HOME': '/tmp/status-cache',
        'SPECIAL_BROWSER_ARTIFACTS': '/app/test-artifacts/special-customer-confirmation-20261013/candidate-browser'}
    service = {'image': 'mbbs-to-yard-test-browser:20261009', 'pull_policy': 'never', 'working_dir': '/app',
               'user': '1000:1000', 'labels': labels, 'environment': environment, 'volumes': mounts}
    config = OUT / 'compose.candidate.json'
    save(config, {'services': {'db': {'labels': labels, 'networks': {'mbt_test_internal': {'aliases': ['mbbs-special-review-db']}}},
        'test': service, 'migrate': service}})
    compose = DOCKER + ['compose', '--project-name', PROJECT, '--project-directory', str(REPO),
        '-f', str(REPO / 'docker-compose.mbt-test.yml'), '-f', str(config)]
    try:
        assert logged('candidate-db', compose + ['up', '-d', '--wait', '--wait-timeout', '45', '--no-build', '--pull', 'never', 'db']) == 0
        assert logged('candidate-create-db', compose + ['exec', '-T', 'db', 'psql', '-U', 'mbt_test', '-d', 'mbt_test', '-c', 'CREATE DATABASE mbt_verify']) == 0
        assert logged('candidate-migrate', compose + ['run', '--rm', '--no-deps', '-T', 'migrate']) == 0
        assert logged('candidate-status', compose + ['run', '--rm', '--no-deps', '-T', 'test', 'node', '--test', '--test-concurrency=1',
            'test/mbt/unit/special-customer-confirmation.test.js', 'test/mbt/integration/special-customer-confirmation.test.js']) == 0
        assert logged('candidate-browser', compose + ['run', '--rm', '--no-deps', '-T', 'test', 'node', '--test',
            '--test-name-pattern=Confirmed request preserves SCM readiness', 'test/mbt/integration/special-approval-browser.test.js']) == 0
        save(OUT / 'candidate-verified.json', {'verified': True, 'manifest': json.loads((RELEASE / 'manifest.json').read_text())})
    finally:
        cleanup_evidence(compose)

def verify():
    state = json.loads((RELEASE / 'state.json').read_text())
    manifest = json.loads((RELEASE / 'manifest.json').read_text())
    deployed = metadata(APP)
    assert deployed['image'] == manifest['candidateImage'] and deployed['configHash'] == state['app']['configHash']
    assert {name: metadata(name) for name in DEPENDENCIES} == state['dependencies']
    assert all(sha(docker('exec', APP, 'cat', '/app/' + file)) == value for file, value in manifest['hashes'].items())
    script = """import {getSpecialStockCase,listSpecialStockCases} from './src/special-stock-request-repository.js';import {query,closeDb} from './src/db.js';
    try{const id=(await query(\"SELECT id FROM sales_stock_requests WHERE request_ref='SPREQ-000041'\")).rows[0].id;
    const d=await getSpecialStockCase(id,{audience:'scm'});const stage=(await query('SELECT stage FROM special_stock_workflow_stages WHERE request_id=$1',[id])).rows[0].stage;
    const found=(await listSpecialStockCases({audience:'scm',stages:['completed'],search:d.requestRef})).some(r=>r.id===d.id);
    const so=(await query(\"SELECT c.sales_order_ref FROM sales_special_stock_cases c JOIN sales_stock_requests r ON r.id=c.request_id WHERE r.request_ref='SPREQ-000079'\")).rows[0].sales_order_ref;
    const h=await fetch('http://127.0.0.1:3000/health').then(r=>r.json());
    console.log(JSON.stringify({healthy:h.ok,requestRef:d.requestRef,stage:d.stage,sqlStage:stage,completedFilter:found,
      completionSource:d.operationalCompletionSource,purchaseReceipt:d.purchaseOrderReceiptStatus,salesOrderStatus:d.salesOrderStatus,spreq79SalesOrder:so}));}finally{await closeDb();}"""
    result = json.loads(docker('exec', '-i', APP, 'node', '--input-type=module', input=script.encode()))
    assert result['healthy'] and result['stage'] == result['sqlStage'] == 'completed' and result['completedFilter']
    assert result['spreq79SalesOrder'] == 'SOB122575'
    save(OUT / 'live.json', {'deployed': True, 'configurationPreserved': True, 'dependenciesPreserved': True, **result})
    print(json.dumps(result), flush=True)

def apply():
    state = json.loads((RELEASE / 'state.json').read_text())
    assert json.loads((OUT / 'candidate-verified.json').read_text())['verified']
    assert not json.loads((OUT / 'candidate-cleanup.json').read_text())['testContainers']
    current(state)
    active = int(database("SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'"))
    assert active == 0, 'A Special order creation is still active; wait before restarting the app'
    migrated = False
    try:
        sql = (RELEASE / 'overlay/migrations' / MIGRATION).read_text()
        database("BEGIN; SET LOCAL lock_timeout='5s';\n" + sql + f"\nINSERT INTO schema_migrations(filename) VALUES('{MIGRATION}'); COMMIT;")
        migrated = True
        assert logged('publish', production_compose(state, RELEASE / 'compose.release.json') + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'app']) == 0
        for _ in range(40):
            if docker('inspect', '--format', '{{.State.Health.Status}}', APP).decode().strip() == 'healthy':
                break
            time.sleep(1)
        verify()
    except BaseException:
        logged('rollback-image', production_compose(state, RELEASE / 'compose.rollback.json') + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'app'])
        if migrated:
            database("BEGIN;\n" + (RELEASE / 'view.rollback.sql').read_text() + f"\nDELETE FROM schema_migrations WHERE filename='{MIGRATION}'; COMMIT;")
        raise

def interrupted(_signal, _frame):
    raise KeyboardInterrupt('Clean up disposable tests or roll back an incomplete publication')

signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
{'prepare': prepare, 'check': check, 'apply': apply, 'verify': verify}[sys.argv[1]]()
