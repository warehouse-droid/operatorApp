"""Publish only the verified request-scroll public assets, with automatic rollback."""
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
TASK = SERVER / 'tools/stock-request-scroll-20261009'
OUT = SERVER / 'test-artifacts/stock-request-scroll-20261009'
RELEASE = SERVER / 'deployments/stock-request-scroll-20261009'
APP = 'mbbs-operator-app-app-1'
DB = 'mbbs-operator-app-db-1'
DEPENDENCIES = [DB, 'mbbs-operator-app-webhook-worker-1', 'mbbs-operator-app-ollama-1']
BASE = 'mbbs-operator-app:request-scroll-base-20261009'
IMAGE = 'mbbs-operator-app:request-scroll-20261009'
TEST_LABEL = 'mbbs-stock-request-scroll-image-20261009'
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


def compose(state, override):
    labels = state['compose']
    args = DOCKER + ['compose', '--project-name', labels['com.docker.compose.project'], '--project-directory', labels['com.docker.compose.project.working_dir']]
    if labels.get('com.docker.compose.project.environment_file'):
        args += ['--env-file', labels['com.docker.compose.project.environment_file']]
    for file in labels['com.docker.compose.project.config_files'].split(','):
        args += ['-f', file]
    return args + ['-f', str(override)]


def database(sql):
    return docker('exec', '-i', DB, 'psql', '-U', 'mbbs_app', '-d', 'mbbs_yard', '-XAt', '-v', 'ON_ERROR_STOP=1', input=sql.encode()).decode().strip()


def current(state):
    assert metadata(APP) == state['app'], 'Application changed; rebase onto the current release'
    assert {name: metadata(name) for name in DEPENDENCIES} == state['dependencies'], 'A production dependency changed'


def cleanup_images():
    active = docker('ps', '--format', '{{.Names}}\t{{.Status}}').decode()
    all_rows = docker('ps', '-a', '--format', '{{.Names}}\t{{.Status}}').decode()
    residual = docker('ps', '-a', '--filter', 'label=com.mbbs.task=' + TEST_LABEL, '--format', '{{.Names}}').decode().strip()
    health = json.loads(docker('exec', APP, 'node', '-e', "fetch('http://127.0.0.1:3000/health').then(r=>r.json()).then(h=>console.log(JSON.stringify(h)))"))
    (OUT / 'cleanup-images.json').write_text(json.dumps({'dockerPs': active, 'dockerPsA': all_rows, 'testContainers': residual, 'productionHealthy': health.get('ok') is True}, indent=2))
    assert not residual and health.get('ok') is True


def prepare():
    verified = json.loads((OUT / 'summary.json').read_text())
    assert verified['tests'] > 0 and verified['pass'] == verified['tests'] and verified['fail'] == verified['skipped'] == 0
    assert not any(json.loads((OUT / 'static.json').read_text())[key] for key in ['newTypes', 'newLint'])
    cleanup = json.loads((OUT / 'cleanup-final.json').read_text())
    assert not cleanup['testContainers'] and not cleanup['networks'] and not cleanup['volumes'] and cleanup['productionHealthy']
    assert all(sha((SERVER / file).read_bytes()) == verified['hashes'][file] for file in FILES)
    original = json.loads(docker('inspect', APP))[0]
    state = {'app': metadata(APP), 'dependencies': {name: metadata(name) for name in DEPENDENCIES},
             'compose': {key: value for key, value in original['Config']['Labels'].items() if key.startswith('com.docker.compose.project')}}
    # Check the original assets before creating an immutable release overlay.
    baselines = {file: docker('exec', APP, 'cat', '/app/' + file) for file in FILES}
    assert all(live == (OUT / 'live-public' / Path(file).name).read_bytes() for file, live in baselines.items()), 'A task asset changed in production; rebase and test'
    RELEASE.mkdir(parents=True, exist_ok=False)
    save('state.json', state)
    patch = ''
    for file in FILES:
        target, backup = RELEASE / 'overlay' / file, RELEASE / 'before' / file
        target.parent.mkdir(parents=True, exist_ok=True)
        backup.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((SERVER / file).read_bytes())
        backup.write_bytes(baselines[file])
        patch += ''.join(difflib.unified_diff(backup.read_text().splitlines(True), target.read_text().splitlines(True), fromfile='a/' + file, tofile='b/' + file))
    (RELEASE / 'task.patch').write_text(patch)
    current(state)
    docker('tag', state['app']['image'], BASE)
    (RELEASE / 'Dockerfile').write_text('FROM ' + BASE + '\nCOPY --chown=node:node overlay/ /app/\n')
    with (OUT / 'build.log').open('wb') as log:
        subprocess.run(DOCKER + ['build', '--network=none', '--pull=false', '-t', IMAGE, str(RELEASE)], stdout=log, stderr=subprocess.STDOUT, check=True)
    candidate = docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    name = TEST_LABEL + '-' + str(time.time_ns())
    # Register exact-container cleanup before the one-off, bounded, offline image check.
    try:
        code = "const f=require('fs'),c=require('crypto'),p=JSON.parse(process.argv[1]);for(const [file,expected] of Object.entries(p)){if(c.createHash('sha256').update(f.readFileSync(file)).digest('hex')!==expected)throw Error(file)}console.log('Candidate source hashes verified');"
        result = docker('run', '--rm', '--init', '--read-only', '--network=none', '--cgroup-parent=mbbs-tests.slice', '--memory=1g', '--memory-swap=1g',
                        '--cpus=1', '--pids-limit=256', '--label=com.mbbs.lifecycle=disposable-test', '--label=com.mbbs.task=' + TEST_LABEL,
                        '--tmpfs=/tmp:rw,size=128m', '--tmpfs=/app/data:rw,uid=1000,gid=1000,size=128m', '--entrypoint=node', '--name', name,
                        IMAGE, '-e', code, json.dumps(verified['hashes']))
        (OUT / 'image-check.log').write_bytes(result)
    finally:
        subprocess.run(DOCKER + ['rm', '-f', '-v', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        cleanup_images()
    for suffix, tag in [('release', IMAGE), ('rollback', BASE)]:
        (RELEASE / ('compose.' + suffix + '.yml')).write_text(f'services:\n  app:\n    image: {tag}\n    pull_policy: never\n')
    service = json.loads(subprocess.check_output(compose(state, RELEASE / 'compose.release.yml') + ['config', '--format', 'json'], stderr=subprocess.PIPE))['services']['app']
    environment = dict(value.split('=', 1) for value in original['Config']['Env'])
    assert all(environment.get(key) == str(value) for key, value in service.get('environment', {}).items()), 'Environment drift'
    save('manifest.json', {'candidateImage': candidate, 'baseImage': state['app']['image'], 'hashes': verified['hashes']})
    current(state)
    print(json.dumps({'prepared': True, 'candidateImage': candidate, 'files': FILES, 'configurationPreserved': True}), flush=True)


def verify():
    state = json.loads((RELEASE / 'state.json').read_text())
    manifest = json.loads((RELEASE / 'manifest.json').read_text())
    deployed = metadata(APP)
    assert deployed['image'] == manifest['candidateImage'] and deployed['configHash'] == state['app']['configHash']
    assert {name: metadata(name) for name in DEPENDENCIES} == state['dependencies']
    assert all(sha(docker('exec', APP, 'cat', '/app/' + file)) == expected for file, expected in manifest['hashes'].items())
    code = """import {createHash} from 'node:crypto';import {getSpecialStockCase} from './src/special-stock-request-repository.js';import {closeDb} from './src/db.js';
    try {const paths=JSON.parse(process.argv[1]),served={};for(const [file,expected] of Object.entries(paths)){const r=await fetch('http://127.0.0.1:3000/'+file.replace(/^public\\//,''));if(!r.ok)throw Error(file+': '+r.status);const hash=createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex');if(hash!==expected)throw Error('Served asset differs: '+file);served[file]=hash;}
    const h=await fetch('http://127.0.0.1:3000/health').then(r=>r.json());const d=await getSpecialStockCase(162,{audience:'scm'});console.log(JSON.stringify({healthy:h.ok===true,ref:d.requestRef,revision:d.revision,stage:d.stage,served}));}finally{await closeDb();}"""
    evidence = json.loads(docker('exec', APP, 'node', '--input-type=module', '-e', code, json.dumps(manifest['hashes'])))
    assert evidence['healthy'] and evidence['ref'] == 'SPREQ-000063'
    # The workflow remains driven by current request data; verification is read-only.
    evidence.update({'deployed': True, 'configurationPreserved': True, 'dependenciesPreserved': True, 'image': deployed['image']})
    (OUT / 'live.json').write_text(json.dumps(evidence, indent=2) + '\n')
    print(json.dumps(evidence), flush=True)


def apply():
    state = json.loads((RELEASE / 'state.json').read_text())
    current(state)
    active = json.loads(database("SELECT json_build_object('specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'), 'quantityApplying',(SELECT count(*) FROM sales_special_stock_cases WHERE quantity_review->>'status'='applying'),'operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),'driverExecuting',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing'),'regularExecuting',(SELECT count(*) FROM regular_stock_handoffs WHERE status='executing'))"))
    assert not any(active.values()), 'Active application writes must finish before the short app restart: ' + json.dumps(active)
    try:
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
        raise


if __name__ == '__main__':
    def interrupted(_signal, _frame):
        raise KeyboardInterrupt('Interrupted: remove tests and roll back any incomplete release')
    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGTERM, interrupted)
    {'prepare': prepare, 'apply': apply, 'verify': verify}[sys.argv[1]]()
