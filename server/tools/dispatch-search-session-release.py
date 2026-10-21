"""Capture, verify and deploy the Dispatch search delta over the running image."""
import datetime
import difflib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import urllib.request

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
OUT = SERVER / 'test-artifacts/dispatch-search-session'
RELEASE = SERVER / 'deployments/dispatch-search-session-20260930'
APP = 'mbbs-operator-app-app-1'
DEPENDENCIES = ['mbbs-operator-app-db-1', 'mbbs-operator-app-ollama-1', 'mbbs-operator-app-webhook-worker-1']
FILES = ['public/dispatch.js', 'public/dispatch.html']
IMAGE = 'mbbs-operator-app:dispatch-search-session-20260930'
spec = importlib.util.spec_from_file_location('regular_release', SERVER / 'tools/regular-stock-v2-deploy.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.RELEASE, release.CONTAINERS, release.DEPENDENCIES = RELEASE, {'app': APP}, DEPENDENCIES
docker, digest, metadata = release.docker, release.digest, release.metadata


def save(name, value):
    (RELEASE / name).write_text(json.dumps(value, indent=2) + '\n')


def state():
    return json.loads((RELEASE / 'manifest.json').read_text())


def current(data):
    assert metadata(APP) == data['services']['app']['before'], 'App changed during verification'
    assert {name: metadata(name) for name in DEPENDENCIES} == data['dependencies'], 'Dependency changed'
    for file, sha in data['beforeHashes'].items():
        assert digest(docker('exec', APP, 'cat', '/app/' + file)) == sha, 'Live asset changed: ' + file
    assert release.core.files_at(OUT / 'candidate') == data['candidateRuntime'], 'Candidate source changed'


def capture():
    os.umask(0o077)
    RELEASE.mkdir(exist_ok=True)
    assert not (RELEASE / 'manifest.json').exists(), 'Capture already complete'
    OUT.mkdir(parents=True, exist_ok=True)
    before = metadata(APP)
    baseline = OUT / 'production-before'
    if baseline.exists():
        shutil.rmtree(baseline)
    baseline.mkdir()
    for folder in ['src', 'public', 'migrations', 'package.json', 'package-lock.json']:
        docker('cp', APP + ':/app/' + folder, str(baseline / folder))
    subprocess.run(['sudo', '-n', 'chown', '-R', f'{os.getuid()}:{os.getgid()}', str(baseline)], check=True)
    assert metadata(APP) == before, 'App changed during capture'
    candidate = OUT / 'candidate'
    if candidate.exists():
        shutil.rmtree(candidate)
    shutil.copytree(baseline, candidate)
    patch = (SERVER / 'test/dispatch-search-session.changes.patch').read_text()
    js_patch = patch.split('--- a/public/dispatch.html')[0]
    applied = subprocess.run(['patch', '--batch', '--fuzz=0', '--no-backup-if-mismatch', '-p1', '-d', str(candidate)],
        input=js_patch, text=True, capture_output=True, check=True)
    (OUT / 'patch-application.log').write_text(applied.stdout + applied.stderr)
    html = candidate / 'public/dispatch.html'
    updated, count = re.subn(r'(/dispatch\.js\?v=)[^"\s]+', r'\g<1>20260930-search-session-v1', html.read_text())
    assert count == 1
    html.write_text(updated)
    release_patch = ''.join(''.join(difflib.unified_diff((baseline / file).read_text().splitlines(True),
        (candidate / file).read_text().splitlines(True), fromfile='a/' + file, tofile='b/' + file)) for file in FILES)
    (RELEASE / 'release.patch').write_text(release_patch)
    for source_root in [baseline, candidate]:
        for folder in ['test', 'tools', 'contracts']:
            (source_root / folder).symlink_to(SERVER / folder, target_is_directory=True)
        shutil.copy2(SERVER / 'eslint.mbt.config.js', source_root / 'eslint.mbt.config.js')
    data = {'services': {'app': {'before': before, 'image': IMAGE}},
        'dependencies': {name: metadata(name) for name in DEPENDENCIES},
        'beforeHashes': {file: digest((baseline / file).read_bytes()) for file in FILES},
        'sourceHashes': {file: digest((candidate / file).read_bytes()) for file in FILES},
        'candidateRuntime': release.core.files_at(candidate)}
    expected = release.core.files_at(baseline)
    expected.update(data['sourceHashes'])
    assert data['candidateRuntime'] == expected, 'Unexpected runtime change'
    save('manifest.json', data)
    current(data)
    print(json.dumps({'captured': True, 'runtimeFiles': len(expected), 'changedFiles': FILES}), flush=True)


def offline(source, phase):
    args = ['sudo', '-n', 'docker', 'run', '--rm', '--network', 'none', '--ipc=host',
        '--user', f'{os.getuid()}:{os.getgid()}', '-e', 'PLAYWRIGHT_BROWSERS_PATH=/ms-playwright',
        '-e', 'MBBS_ENV_FILE=/nonexistent']
    for folder in ['src', 'public', 'migrations']:
        args += ['-v', f'{source / folder}:/app/{folder}:ro']
    for folder in ['test', 'tools']:
        args += ['-v', f'{SERVER / folder}:/app/{folder}:ro']
    args += ['-v', f'{SERVER / "eslint.mbt.config.js"}:/app/eslint.mbt.config.js:ro',
        '-v', f'{OUT}:/app/test-artifacts/dispatch-search-session',
        '-v', '/tmp/return-batch-playwright:/ms-playwright:ro', '--entrypoint', 'node',
        'mbbs-bin-planning-test:20260927', 'tools/dispatch-search-session-check.mjs', phase]
    with (OUT / f'{phase}-check.log').open('wb') as log:
        subprocess.run(args, cwd=SERVER, stdout=log, stderr=subprocess.STDOUT, check=True)


def refresh():
    data = state()
    current(data)
    candidate = OUT / 'candidate'
    baseline = OUT / 'production-before'
    target = candidate / 'public/dispatch.js'
    shutil.copy2(baseline / 'public/dispatch.js', target)
    js_patch = (SERVER / 'test/dispatch-search-session.changes.patch').read_text().split('--- a/public/dispatch.html')[0]
    applied = subprocess.run(['patch', '--batch', '--fuzz=0', '--no-backup-if-mismatch', '-p1', '-d', str(candidate)],
        input=js_patch, text=True, capture_output=True, check=True)
    (OUT / 'patch-application.log').write_text(applied.stdout + applied.stderr)
    data['sourceHashes'] = {file: digest((candidate / file).read_bytes()) for file in FILES}
    data['candidateRuntime'] = release.core.files_at(candidate)
    expected = release.core.files_at(baseline)
    expected.update(data['sourceHashes'])
    assert data['candidateRuntime'] == expected
    (RELEASE / 'release.patch').write_text(''.join(''.join(difflib.unified_diff((baseline / file).read_text().splitlines(True),
        (candidate / file).read_text().splitlines(True), fromfile='a/' + file, tofile='b/' + file)) for file in FILES))
    save('manifest.json', data)
    current(data)
    print(json.dumps({'refreshed': True, 'changedFiles': FILES}), flush=True)


def check():
    data = state()
    current(data)
    offline(OUT / 'production-before', 'baseline')
    offline(OUT / 'candidate', 'current')
    env = dict(os.environ, BIN_PLANNING_SOURCE_ROOT=str(OUT / 'candidate'), BIN_PLANNING_CHECK='dispatch-search-session-final')
    with (OUT / 'http-final.log').open('wb') as log:
        subprocess.run(['bash', str(SERVER / 'tools/bin-planning-test.sh'), 'node', '--test', '--test-concurrency=1',
            'test/dispatch/integration/dispatch-search-session.test.js'], cwd=SERVER, env=env,
            stdout=log, stderr=subprocess.STDOUT, check=True)
    validation = json.loads((OUT / 'validation.json').read_text())
    assert validation['passed'] and validation['sourceHashes'] == data['sourceHashes']
    current(data)
    save('verified.json', {'passed': True, 'sourceHashes': data['sourceHashes'],
        'validation': validation, 'httpTests': 6})
    print(json.dumps({'verified': True, 'focusedBrowserTests': validation['focused']['tests'],
        'httpTests': 6, 'changedLineCoverage': validation['changedLineCoverage']}), flush=True)


def prepare():
    data = state()
    current(data)
    verified = json.loads((RELEASE / 'verified.json').read_text())
    assert verified['passed'] and verified['sourceHashes'] == data['sourceHashes']
    stage = RELEASE / 'stage'
    for file in FILES:
        target = stage / 'overlay' / file
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(OUT / 'candidate' / file, target)
    base = data['services']['app']['before']
    assert docker('image', 'inspect', '--format', '{{.Id}}', base['image']).decode().strip() == base['imageId']
    (stage / 'Dockerfile').write_text('FROM ' + base['image'] + '\nCOPY --chown=node:node overlay/ /app/\n')
    with (RELEASE / 'build.log').open('wb') as log:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--network', 'none', '--pull=false', '-t', IMAGE, str(stage)],
            stdout=log, stderr=subprocess.STDOUT, check=True)
    data['services']['app']['candidateImageId'] = docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    (RELEASE / 'compose.release.yml').write_text('services:\n  app:\n    image: ' + IMAGE + '\n')
    (RELEASE / 'compose.rollback.yml').write_text('services:\n  app:\n    image: ' + base['imageId'] + '\n')
    tree = json.loads(docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', IMAGE,
        '-e', HASH_SCRIPT))
    assert tree == data['candidateRuntime'], 'Built image has unexpected runtime content'
    for file in FILES:
        if file.endswith('.js'):
            docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', IMAGE, '--check', file)
    release.config_check(data)
    current(data)
    save('manifest.json', data)
    print(json.dumps({'prepared': True, 'image': IMAGE, 'verifiedRuntimeFiles': len(tree)}), flush=True)


def rebase_after_rollback():
    data = state()
    assert json.loads((RELEASE / 'rollback-result.json').read_text())['rolledBack']
    previous = data['services']['app']['before']
    actual = metadata(APP)
    assert actual['imageId'] == previous['imageId'] and actual['configuration'] == previous['configuration']
    assert {name: metadata(name) for name in DEPENDENCIES} == data['dependencies']
    expected = dict(data['candidateRuntime'])
    expected.update(data['beforeHashes'])
    assert json.loads(docker('exec', APP, 'node', '-e', HASH_SCRIPT)) == expected
    save('previous-deployment-baseline.json', previous)
    data['services']['app']['before'] = actual
    save('manifest.json', data)
    current(data)
    print(json.dumps({'rollbackBaselineVerified': True}), flush=True)


HASH_SCRIPT = """const fs=require('node:fs'),crypto=require('node:crypto'),hashes={};
function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const path=dir+'/'+entry.name;
if(entry.isDirectory())walk(path);else if(entry.isFile())hashes[path]=crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex');}}
for(const dir of ['src','public','migrations'])walk(dir);console.log(JSON.stringify(hashes));"""


def verify():
    data = state()
    release.core.ready(data['services']['app']['candidateImageId'])
    actual = metadata(APP)
    assert actual['configuration'] == data['services']['app']['before']['configuration']
    assert {name: metadata(name) for name in DEPENDENCIES} == data['dependencies']
    assert json.loads(docker('exec', APP, 'node', '-e', HASH_SCRIPT)) == data['candidateRuntime']
    public = {}
    for file, path in [('health', '/health'), ('public/dispatch.js', '/dispatch.js'), ('public/dispatch.html', '/dispatch/planning')]:
        request = urllib.request.Request('https://test.mbbsoperation.com' + path,
            headers={'User-Agent': 'Mozilla/5.0', 'Cache-Control': 'no-cache'})
        with urllib.request.urlopen(request, timeout=30) as response:
            body = response.read()
            assert response.status == 200
            if file == 'health':
                assert json.loads(body)['ok'] is True
            else:
                body = re.sub(rb'<script type="module" src="https://static\.cloudflareinsights\.com/beacon\.min\.js/[^>]+></script>\n', b'', body)
                assert digest(body) == data['sourceHashes'][file], file
            public[path] = {'status': 200, 'sha256': digest(body)}
    save('public-check.json', public)
    code = (SERVER / 'tools/dispatch-search-session-live.mjs').read_text().replace('from "../src/', 'from "./src/')
    try:
        live = json.loads(docker('exec', '-i', APP, 'node', '--input-type=module', input=code.encode()))
    except subprocess.CalledProcessError as error:
        if error.output:
            save('live-check-failed.json', json.loads(error.output))
        raise
    assert live['ordersUnchanged'] and live['diagnosticRecordsRemoved']
    assert len(live['requests']) == 8 and all(row['status'] == 200 for row in live['requests'])
    assert all(row['found'] for row in live['requests']), 'A reported order was absent from a live search'
    save('live-check.json', live)
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'image': IMAGE, 'imageId': actual['imageId'], 'configurationPreserved': True,
        'dependenciesUnchanged': True, 'sourceFiles': FILES, 'public': public, 'live': live}
    save('result.json', result)
    print(json.dumps(result), flush=True)


def apply():
    data = state()
    current(data)
    verified = json.loads((RELEASE / 'verified.json').read_text())
    assert verified['passed'] and verified['sourceHashes'] == data['sourceHashes'], 'Verification is stale'
    assert docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip() == data['services']['app']['candidateImageId'], 'Candidate image changed'
    assert json.loads(docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', IMAGE,
        '-e', HASH_SCRIPT)) == data['candidateRuntime'], 'Candidate image bytes differ from verified source'
    release.config_check(data)
    active = json.loads(release.database("""SELECT json_build_object(
      'operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),
      'driverExecuting',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing'),
      'specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'),
      'stockTransferConfirming',(SELECT count(*) FROM sales_stock_transfers WHERE confirmation_status IN ('creating','approving','hydrating','printing')),
      'regularExecuting',(SELECT count(*) FROM regular_stock_handoffs WHERE status='executing'),
      'deliveryOperations',(SELECT count(*) FROM regular_stock_delivery_operations WHERE status IN ('queued','running')),
      'stockingExecuting',(SELECT count(*) FROM sales_stock_requests WHERE regular_details->'pickupTransfer'->>'status'='executing'),
      'scmExecuting',(SELECT count(*) FROM scm_smart_proposals WHERE status='executing'),
      'webhookRunning',(SELECT count(*) FROM netsuite_order_webhook_inbox WHERE status='running'))"""))
    save('active-before-release.json', active)
    assert not any(active.values()), 'Wait for active operations: ' + json.dumps(active)
    try:
        with (RELEASE / 'publish.log').open('wb') as log:
            subprocess.run(release.compose(data) + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'],
                cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except Exception:
        with (RELEASE / 'rollback.log').open('wb') as log:
            subprocess.run(release.compose(data, 'compose.rollback.yml') + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'],
                cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        release.core.ready(data['services']['app']['before']['imageId'])
        save('rollback-result.json', {'rolledBack': True})
        raise


if __name__ == '__main__':
    {'capture': capture, 'refresh': refresh, 'check': check, 'prepare': prepare,
        'rebase-after-rollback': rebase_after_rollback, 'apply': apply, 'verify': verify}[sys.argv[1]]()
