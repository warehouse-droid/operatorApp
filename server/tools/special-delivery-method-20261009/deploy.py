"""Release only the verified delivery-method changes on the current live image."""
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
OUT = SERVER / 'test-artifacts/special-delivery-method-20261009'
RELEASE = SERVER / 'deployments/special-delivery-method-20261009'
APP = 'mbbs-operator-app-app-1'
DB = 'mbbs-operator-app-db-1'
DEPENDENCIES = [DB, 'mbbs-operator-app-webhook-worker-1', 'mbbs-operator-app-ollama-1']
BASE = 'mbbs-operator-app:special-delivery-method-base-20261009'
IMAGE = 'mbbs-operator-app:special-delivery-method-20261009'
MIGRATION = '277_special_delivery_method_alerts.sql'
FILES = json.loads((TASK / 'files.json').read_text())
DOCKER = ['sudo', '-n', 'docker']

def docker(*args, **kwargs):
    return subprocess.check_output(DOCKER + list(args), **kwargs)

def sha(value):
    return hashlib.sha256(value).hexdigest()

def metadata(name):
    row = json.loads(docker('inspect', name))[0]
    config = {'Config': {key: value for key, value in row['Config'].items() if key not in ['Image', 'Labels', 'Hostname']}, 'HostConfig': row['HostConfig']}
    config['Config']['Env'] = sorted(config['Config']['Env'])
    config['HostConfig']['Binds'] = sorted(config['HostConfig'].get('Binds') or [])
    return {'image': row['Image'], 'configHash': sha(json.dumps(config, sort_keys=True).encode())}

def save(name, value):
    (RELEASE / name).write_text(json.dumps(value, indent=2) + '\n')

def database(sql):
    return docker('exec', '-i', DB, 'psql', '-U', 'mbbs_app', '-d', 'mbbs_yard', '-XAt', '-v', 'ON_ERROR_STOP=1', input=sql.encode()).decode().strip()

def current(state):
    assert metadata(APP) == state['app'], 'Another app release occurred; prepare again on the current image'
    assert {name: metadata(name) for name in DEPENDENCIES} == state['dependencies'], 'Production dependency changed'

def compose(state, override):
    labels = state['compose']
    args = DOCKER + ['compose', '--project-name', labels['com.docker.compose.project'], '--project-directory', labels['com.docker.compose.project.working_dir']]
    if labels.get('com.docker.compose.project.environment_file'):
        args += ['--env-file', labels['com.docker.compose.project.environment_file']]
    for file in labels['com.docker.compose.project.config_files'].split(','):
        args += ['-f', file]
    return args + ['-f', str(override)]

def cleanup_checks(label):
    active = docker('ps', '--format', '{{.Names}}\t{{.Status}}').decode()
    all_containers = docker('ps', '-a', '--format', '{{.Names}}\t{{.Status}}').decode()
    tests = docker('ps', '-a', '--filter', 'label=com.mbbs.lifecycle=disposable-test', '--format', '{{.Names}}').decode().strip()
    # Other tasks can be testing concurrently on this shared application host.
    # Only this task's test resources are ours to remove; never stop active peers.
    owned_tests = '\n'.join(name for name in tests.splitlines() if name.startswith(('mbbs-special-delivery-method-', 'mbbs-special-method-image-')))
    other_tests = '\n'.join(name for name in tests.splitlines() if name not in owned_tests.splitlines())
    health = json.loads(docker('exec', APP, 'node', '-e', "fetch('http://127.0.0.1:3000/health').then(r=>r.json()).then(h=>console.log(JSON.stringify({ok:h.ok})))"))
    (OUT / ('cleanup-' + label + '.json')).write_text(json.dumps({'dockerPs': active, 'dockerPsA': all_containers, 'testContainers': owned_tests, 'otherActiveTestContainers': other_tests, 'productionHealthy': health.get('ok') is True}, indent=2))
    assert not owned_tests and health.get('ok') is True

def image_check(budget, args, kind):
    name = 'mbbs-special-method-image-' + kind + '-' + str(time.time_ns())
    try:
        return docker(*budget, '--name', name, *args)
    finally:
        # --rm normally removes it. On interruption, remove the exact disposable ID.
        result = subprocess.run(DOCKER + ['inspect', name], capture_output=True)
        if result.returncode == 0:
            row = json.loads(result.stdout)[0]
            assert row['Config']['Labels'].get('com.mbbs.lifecycle') == 'disposable-test'
            subprocess.run(DOCKER + ['rm', '-f', '-v', row['Id']], check=True, stdout=subprocess.DEVNULL)

def prepare():
    verified = json.loads((OUT / 'summary.json').read_text())
    assert verified['measured']['fail'] == verified['restored']['fail'] == verified['reverse']['fail'] == 0
    assert not verified['newFailures'] and all(row['killed'] for row in verified['mutations'])
    coverage = json.loads((OUT / 'changed-coverage.json').read_text())
    assert coverage['changedLines'] == coverage['executedLines'] and coverage['changedLines'] > 0
    static = json.loads((OUT / 'static.json').read_text())
    assert not static['newTypes'] and not static['newLint']
    cleanup = json.loads((OUT / 'cleanup-final.json').read_text())
    assert not cleanup['testContainers'] and cleanup['productionHealthy']
    assert all(sha((SERVER / file).read_bytes()) == verified['hashes'][file] for file in FILES)
    assert not database(f"SELECT filename FROM schema_migrations WHERE filename='{MIGRATION}'")
    original = json.loads(docker('inspect', APP))[0]
    state = {'app': metadata(APP), 'dependencies': {name: metadata(name) for name in DEPENDENCIES},
             'compose': {key: value for key, value in original['Config']['Labels'].items() if key.startswith('com.docker.compose.project')}}
    RELEASE.mkdir(parents=True, exist_ok=False)
    save('state.json', state)
    candidate_hashes = {}
    exclusions = []
    for file in FILES:
        target = RELEASE / 'overlay' / file
        target.parent.mkdir(parents=True, exist_ok=True)
        before = (TASK / 'baseline' / file).read_bytes()
        source = (SERVER / file).read_bytes()
        if before:
            live = docker('exec', APP, 'cat', '/app/' + file)
            if live != before:
                # The shared workspace has an unrelated, unpublished comment.
                # Keep that workspace edit and preserve the current live comment.
                pending = b'// Account preferences and phone layout policy are independent of the selected yard.'
                existing = b'// Account preferences are independent of the currently selected yard.'
                assert file == 'src/server.js' and before.count(pending) == source.count(pending) == 1
                assert live == before.replace(pending, existing), 'A task source changed in production; rebase it: ' + file
                source = source.replace(pending, existing)
                exclusions.append({'file': file, 'difference': 'One unrelated comment remains as currently deployed; executable code matches the tested source.'})
            backup = RELEASE / 'before' / file
            backup.parent.mkdir(parents=True, exist_ok=True)
            backup.write_bytes(live)
        target.write_bytes(source)
        candidate_hashes[file] = sha(source)
    save('workspace-exclusions.json', exclusions)
    current(state)
    docker('tag', state['app']['image'], BASE)
    (RELEASE / 'Dockerfile').write_text('FROM ' + BASE + '\nCOPY --chown=node:node overlay/ /app/\n')
    with (OUT / 'build.log').open('wb') as log:
        subprocess.run(DOCKER + ['build', '--network=none', '--pull=false', '-t', IMAGE, str(RELEASE)], check=True, stdout=log, stderr=subprocess.STDOUT)
    candidate = docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    budget = ['run', '--rm', '--init', '--network=none', '--cgroup-parent=mbbs-tests.slice', '--memory=1g', '--memory-swap=1g', '--cpus=1', '--pids-limit=256',
              '--label=com.mbbs.lifecycle=disposable-test', '--tmpfs=/tmp:rw,size=128m', '--tmpfs=/app/data:rw,uid=1000,gid=1000,size=128m', '--entrypoint=node']
    hashes = {'/app/' + file: value for file, value in candidate_hashes.items()}
    code = "const f=require('fs'),c=require('crypto'),p=JSON.parse(process.argv[1]);for(const[file,expected]of Object.entries(p)){if(c.createHash('sha256').update(f.readFileSync(file)).digest('hex')!==expected)throw Error(file)}console.log('Verified candidate sources')"
    image_check(budget, [IMAGE, '-e', code, json.dumps(hashes)], 'sources')
    image_check(budget, ['-e', 'MBBS_ENV_FILE=/nonexistent', '-e', 'DATABASE_URL=postgres://mbt_test:mbt_test_password@127.0.0.1:9/mbt_test',
                        '-e', 'NETSUITE_DIRECT_ACCESS_ENABLED=false', '-e', 'NETSUITE_MIRROR_ROLE=disabled', IMAGE, '--input-type=module', '-e',
                        "await import('./src/server.js');console.log('Verified candidate server import');process.exit(0)"], 'startup')
    cleanup_checks('images')
    (RELEASE / 'compose.release.yml').write_text(f'services:\n  app:\n    image: {IMAGE}\n    pull_policy: never\n')
    (RELEASE / 'compose.rollback.yml').write_text(f'services:\n  app:\n    image: {BASE}\n    pull_policy: never\n')
    service = json.loads(subprocess.check_output(compose(state, RELEASE / 'compose.release.yml') + ['config', '--format', 'json'], stderr=subprocess.PIPE))['services']['app']
    environment = dict(value.split('=', 1) for value in original['Config']['Env'])
    assert all(environment.get(key) == str(value) for key, value in service.get('environment', {}).items()), 'Environment drift'
    save('manifest.json', {'candidateImage': candidate, 'baseImage': state['app']['image'], 'hashes': candidate_hashes, 'testedHashes': verified['hashes'], 'migration': MIGRATION})
    current(state)
    print(json.dumps({'prepared': True, 'files': FILES, 'configurationPreserved': True}), flush=True)

def verify():
    state = json.loads((RELEASE / 'state.json').read_text())
    manifest = json.loads((RELEASE / 'manifest.json').read_text())
    deployed = metadata(APP)
    assert deployed['image'] == manifest['candidateImage'] and deployed['configHash'] == state['app']['configHash']
    assert {name: metadata(name) for name in DEPENDENCIES} == state['dependencies']
    assert all(sha(docker('exec', APP, 'cat', '/app/' + file)) == value for file, value in manifest['hashes'].items())
    assert database(f"SELECT filename FROM schema_migrations WHERE filename='{MIGRATION}'") == MIGRATION
    result = json.loads(docker('exec', '-i', APP, 'node', '--input-type=module', input=(TASK / 'live.mjs').read_bytes()))
    assert result['healthy'] and result['workflowGuardsVerified'] and result['routesProtected']
    (OUT / 'live.json').write_text(json.dumps(result, indent=2) + '\n')
    cleanup_checks('release')
    print(json.dumps({'deployed': True, 'configurationPreserved': True, 'dependenciesPreserved': True, **result}), flush=True)

def apply():
    state = json.loads((RELEASE / 'state.json').read_text())
    manifest = json.loads((RELEASE / 'manifest.json').read_text())
    current(state)
    active = json.loads(database("SELECT json_build_object('specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'), 'quantityApplying',(SELECT count(*) FROM sales_special_stock_cases WHERE quantity_review->>'status'='applying'),'operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),'driverExecuting',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing'),'regularExecuting',(SELECT count(*) FROM regular_stock_handoffs WHERE status='executing'))"))
    assert not any(active.values()), 'Active writes must finish before the app restart: ' + json.dumps(active)
    try:
        database("BEGIN; SET LOCAL lock_timeout='5s';\n" + (SERVER / 'migrations' / MIGRATION).read_text() + f"\nINSERT INTO schema_migrations(filename) VALUES('{MIGRATION}') ON CONFLICT(filename) DO NOTHING; COMMIT;")
        with (OUT / 'publish.log').open('wb') as log:
            subprocess.run(compose(state, RELEASE / 'compose.release.yml') + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'app'], check=True, stdout=log, stderr=subprocess.STDOUT, timeout=60)
        for _ in range(30):
            if docker('inspect', '--format', '{{.State.Health.Status}}', APP).decode().strip() == 'healthy':
                break
            time.sleep(1)
        verify()
    except BaseException:
        # Additive production schema and operational receipts remain intact.
        # Never roll back over an unrelated concurrent release.
        if metadata(APP)['image'] in [state['app']['image'], manifest['candidateImage']]:
            with (OUT / 'rollback.log').open('wb') as log:
                subprocess.run(compose(state, RELEASE / 'compose.rollback.yml') + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'app'], check=True, stdout=log, stderr=subprocess.STDOUT, timeout=60)
        raise

def interrupted(_signal, _frame):
    raise KeyboardInterrupt('Interrupted: remove one-off tests and restore any incomplete app release')

signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
{'prepare': prepare, 'apply': apply, 'verify': verify}[sys.argv[1]]()
