"""Prepare and publish only the tested task patch on the current production image."""
import difflib
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'test-artifacts/special-so-preview-20261006'
RELEASE = Path('/home/ubuntu/operatorapp-investigations/special-so-preview-20261006/release')
APP = 'mbbs-operator-app-app-1'
BASE = 'mbbs-operator-app:special-so-preview-base-20261006'
IMAGE = 'mbbs-operator-app:special-so-preview-20261006'
FILES = ['src/special-stock-rest-orders.js', 'src/special-stock-request-repository.js',
         'public/special-stock-fulfillment.js', 'public/sales-special-stock-requests.js', 'public/sales-stock-requests.html']

def docker(*args, **kwargs):
    return subprocess.check_output(['docker', *args], **kwargs)

def sha(value):
    return hashlib.sha256(value).hexdigest()

def metadata(name):
    original = json.loads(docker('inspect', name))[0]
    config = {'Config': {key: value for key, value in original['Config'].items() if key not in ['Image', 'Labels', 'Hostname']},
              'HostConfig': original['HostConfig']}
    config['Config']['Env'] = sorted(config['Config']['Env'])
    return {'image': original['Image'], 'configHash': sha(json.dumps(config, sort_keys=True).encode())}

def compose(state, override):
    labels = state['compose']
    args = ['sudo', '-n', 'docker', 'compose', '--project-name', labels['com.docker.compose.project'],
            '--project-directory', labels['com.docker.compose.project.working_dir'],
            '--env-file', labels['com.docker.compose.project.environment_file']]
    for file in labels['com.docker.compose.project.config_files'].split(','):
        args += ['-f', file]
    return args + ['-f', str(override)]

def prepare():
    evidence = json.loads((OUT / 'summary.json').read_text())
    assert not evidence['newFailures'] and evidence['focused']['fail'] == 0
    assert evidence['types'] == evidence['lint'] == 'pass'
    assert all(value['killed'] for value in evidence['mutations'])
    assert evidence['changedLines']['total'] == evidence['changedLines']['covered']
    original = json.loads(docker('inspect', APP))[0]
    state = {**metadata(APP), 'compose': {key: value for key, value in original['Config']['Labels'].items() if key.startswith('com.docker.compose.project')}}
    RELEASE.mkdir(parents=True, exist_ok=True)
    if (RELEASE / 'state.json').exists():
        assert json.loads((RELEASE / 'state.json').read_text()) == state, 'Preserve prior preparation; rebase into a new release directory'
    else:
        (RELEASE / 'state.json').write_text(json.dumps(state, indent=2))
    for file in FILES:
        assert sha((ROOT / file).read_bytes()) == evidence['manifest'][file], 'Tested local source changed'
        live = docker('exec', APP, 'cat', '/app/' + file)
        old = (ROOT / 'tools/special-so-preview-20261006/baseline' / file).read_text()
        candidate = (ROOT / file).read_text()
        target = RELEASE / 'overlay' / file
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(live)
        delta = ''.join(difflib.unified_diff(old.splitlines(True), candidate.splitlines(True), fromfile='a/' + file, tofile='b/' + file))
        if delta:
            result = subprocess.run(['patch', '-p1', '--batch', '--forward', '--directory', str(RELEASE / 'overlay')], input=delta, text=True,
                                    capture_output=True)
            assert result.returncode == 0, 'Current deployed source needs a fresh rebase: ' + result.stderr
        assert sha(target.read_bytes()) == evidence['manifest'][file], 'Rebased candidate needs validation'
    assert metadata(APP) == {key: state[key] for key in ['image', 'configHash']}, 'Application changed during preparation'
    docker('tag', state['image'], BASE)
    (RELEASE / 'Dockerfile').write_text('FROM ' + BASE + '\n' + ''.join(f'COPY --chown=node:node overlay/{file} /app/{file}\n' for file in FILES))
    (RELEASE / 'compose.release.yml').write_text(f'services:\n  app:\n    image: {IMAGE}\n    pull_policy: never\n')
    (RELEASE / 'compose.rollback.yml').write_text(f'services:\n  app:\n    image: {BASE}\n    pull_policy: never\n')
    with (OUT / 'build.log').open('wb') as log:
        subprocess.run(['docker', 'build', '--network=none', '--pull=false', '-t', IMAGE, str(RELEASE)], stdout=log, stderr=subprocess.STDOUT, check=True)
    candidate_id = docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    service = json.loads(subprocess.check_output(compose(state, RELEASE / 'compose.release.yml') + ['config', '--format', 'json'], stderr=subprocess.PIPE))['services']['app']
    environment = dict(value.split('=', 1) for value in original['Config']['Env'])
    assert all(environment.get(key) == str(value) for key, value in service.get('environment', {}).items()), 'Environment drift'
    manifest = {'candidateImage': candidate_id, 'baseImage': state['image'], 'files': {file: evidence['manifest'][file] for file in FILES}}
    (RELEASE / 'manifest.json').write_text(json.dumps(manifest, indent=2))
    print(json.dumps({'prepared': True, 'environmentPreserved': True, **manifest}), flush=True)

def verify():
    state = json.loads((RELEASE / 'state.json').read_text())
    manifest = json.loads((RELEASE / 'manifest.json').read_text())
    current = metadata(APP)
    assert current['image'] == manifest['candidateImage'] and current['configHash'] == state['configHash']
    assert all(sha(docker('exec', APP, 'cat', '/app/' + file)) == expected for file, expected in manifest['files'].items())
    health = json.loads(docker('exec', APP, 'node', '-e', "fetch('http://127.0.0.1:3000/health').then(r=>r.json()).then(v=>console.log(JSON.stringify(v)))"))
    assert health['ok'] is True
    result = {'deployed': True, 'image': current['image'], 'configurationPreserved': True, 'files': manifest['files'], 'health': 'healthy'}
    (OUT / 'deployed.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result), flush=True)

def apply():
    state = json.loads((RELEASE / 'state.json').read_text())
    assert metadata(APP) == {key: state[key] for key in ['image', 'configHash']}, 'Production changed; rebuild on the new image'
    dependencies = {name: metadata(name) for name in ['mbbs-operator-app-db-1', 'mbbs-operator-app-webhook-worker-1', 'mbbs-operator-app-ollama-1']}
    script = """import {query,closeDb} from './src/db.js';
    try {console.log(JSON.stringify((await query(`SELECT json_build_object(
      'specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'),
      'quantityApplying',(SELECT count(*) FROM sales_special_stock_cases WHERE quantity_review->>'status'='applying'),
      'operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),
      'driverExecuting',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing'),
      'regularExecuting',(SELECT count(*) FROM regular_stock_handoffs WHERE status='executing')) AS counts`)).rows[0].counts));}
    finally {await closeDb();}"""
    active = json.loads(docker('exec', '-i', '-w', '/app', APP, 'node', '--input-type=module', input=script.encode()))
    assert not any(active.values()), 'Active application work must finish: ' + json.dumps(active)
    try:
        with (OUT / 'publish.log').open('wb') as log:
            subprocess.run(compose(state, RELEASE / 'compose.release.yml') + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'app'],
                           stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        for _attempt in range(20):
            healthy = docker('inspect', '--format', '{{.State.Health.Status}}', APP).decode().strip()
            if healthy == 'healthy':
                break
            time.sleep(2)
        assert healthy == 'healthy'
        verify()
        assert dependencies == {name: metadata(name) for name in dependencies}, 'Other production services changed'
    except Exception:
        with (OUT / 'rollback.log').open('wb') as log:
            subprocess.run(compose(state, RELEASE / 'compose.rollback.yml') + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'app'],
                           stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        raise

try:
    {'prepare': prepare, 'apply': apply, 'verify': verify}[sys.argv[1]]()
except subprocess.CalledProcessError as error:
    print('Deployment command failed; see the task build/publish logs. ' + (error.stderr or b'').decode()[-1200:])
    raise SystemExit(error.returncode)
