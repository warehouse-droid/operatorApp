"""Publish only the verified Special commercial review changes and worker reconciliation fix."""
import difflib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
OUT = SERVER / 'test-artifacts/special-workflow-review/po-line-discount-20260928'
RELEASE = SERVER / 'deployments/special-po-line-20260928'
APP = 'mbbs-operator-app-app-1'
WORKER = 'mbbs-operator-app-webhook-worker-1'
DEPENDENCIES = ['mbbs-operator-app-db-1', 'mbbs-operator-app-ollama-1']
BASE = {'app': 'sha256:9f64f66febd92f4156ba45e128ff065ec7a7a3b3875e43c7dd25d0eb4d1adb3c',
        'webhook-worker': 'sha256:5a83d9a2ca455d312e36bb1589f6418265439003ba5c63a6e73d4691b73591d4'}
IMAGE = {'app': 'mbbs-operator-app:special-po-line-20260928',
         'webhook-worker': 'mbbs-operator-app:special-po-line-worker-20260928'}
CONTAINERS = {'app': APP, 'webhook-worker': WORKER}
FILES = [name for name in json.loads((OUT / 'runtime-files.json').read_text()) if name != 'netsuite-smart-scm-picking-ticket-restlet.js']
REPO = 'src/special-stock-request-repository.js'
MIGRATION = '236_special_order_commercial_review.sql'
spec = importlib.util.spec_from_file_location('release_core', SERVER / 'tools/operator-display-settings-deploy.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
docker = core.docker
digest = lambda data: hashlib.sha256(data).hexdigest()

def save(name, value):
    (RELEASE / name).write_text(json.dumps(value, indent=2) + '\n')

def source_hashes():
    return {name: digest((SERVER / name).read_bytes()) for name in FILES}

def live_hashes(container, files):
    rows = docker('exec', container, 'sha256sum', *['/app/' + name for name in files]).decode().splitlines()
    return {row.split()[1].removeprefix('/app/'): row.split()[0] for row in rows}

def compose(info, filename='compose.release.yml'):
    args = ['sudo', '-n', 'docker', 'compose', '-p', 'mbbs-operator-app']
    for name in info['services']['app']['before']['configFiles'].split(','):
        args += ['-f', name]
    return args + ['-f', str(RELEASE / filename), '--env-file', str(ROOT / 'docker/env/.env')]

def current(info):
    assert source_hashes() == info['files'], 'Verified workspace changed'
    for service, container in CONTAINERS.items():
        state = info['services'][service]
        assert core.metadata(container) == state['before'], 'Live service changed: ' + service
        assert live_hashes(container, list(state['beforeFiles'])) == state['beforeFiles'], 'Live source changed'
    assert [core.metadata(name) for name in DEPENDENCIES] == info['dependencies'], 'Dependencies changed'

def config_check(info):
    config = json.loads(subprocess.check_output(compose(info) + ['config', '--format', 'json'], cwd=ROOT))['services']
    for service, container in CONTAINERS.items():
        image = json.loads(docker('image', 'inspect', IMAGE[service]))[0]['Config']
        live = json.loads(docker('inspect', container))[0]['Config']
        env = dict(value.split('=', 1) for value in image['Env'])
        env.update({key: str(value) for key, value in config[service].get('environment', {}).items()})
        assert env == dict(value.split('=', 1) for value in live['Env']), service + ' environment changed'
        for field, key in [('Cmd', 'command'), ('Entrypoint', 'entrypoint'), ('User', 'user'), ('WorkingDir', 'working_dir')]:
            assert (image.get(field) if config[service].get(key) is None else config[service][key]) == live.get(field), field + ' changed'

def reconciliation(source):
    start = source.index('async function reconcileCanonicalOrderLines(')
    end = source.index('\nasync function canonicalLinksReady(', start)
    return source[start:end]

def prepare():
    os.umask(0o077)
    checks = json.loads((OUT / 'checks.json').read_text())
    assert checks['completed'] and checks['fail'] == 0 and checks['tests'] == checks['pass'] and checks['mutantsKilled'] == 4
    assert source_hashes() == {name: digest for name, digest in json.loads((OUT / 'source-manifest.json').read_text()).items() if name in FILES}
    RELEASE.mkdir(mode=0o700, exist_ok=True)
    assert not (RELEASE / 'manifest.json').exists(), 'Release already prepared'
    baseline = json.loads((OUT / 'baseline-manifest.json').read_text())
    info = {'files': source_hashes(), 'services': {}, 'dependencies': [core.metadata(name) for name in DEPENDENCIES]}
    for service, container in CONTAINERS.items():
        before = core.metadata(container)
        # Other scoped app releases may publish while tests run. Its selected
        # source files must still match the captured baseline (checked below).
        if service == 'webhook-worker':
            assert before['imageId'] == BASE[service], 'Unexpected worker base image'
        info['services'][service] = {'before': before}
    info['services']['app']['beforeFiles'] = {name: baseline[name] for name in FILES if name in baseline}
    worker_original = (OUT / 'worker-baseline' / REPO).read_text()
    assert reconciliation(worker_original) == reconciliation((OUT / 'baseline' / REPO).read_text())
    worker_updated = worker_original.replace(reconciliation(worker_original), reconciliation((SERVER / REPO).read_text()), 1)
    info['services']['webhook-worker']['beforeFiles'] = {REPO: digest(worker_original.encode())}
    current(info)
    for name in FILES:
        if name not in baseline:
            docker('exec', APP, 'test', '!', '-e', '/app/' + name)
    for service in CONTAINERS:
        stage = RELEASE / ('stage-' + service)
        files = FILES if service == 'app' else [REPO]
        for name in files:
            target = stage / name
            target.parent.mkdir(parents=True, exist_ok=True)
            if service == 'app':
                shutil.copy2(SERVER / name, target)
            else:
                target.write_text(worker_updated)
        if service == 'webhook-worker':
            (RELEASE / 'worker.patch').write_text(''.join(difflib.unified_diff(worker_original.splitlines(True), worker_updated.splitlines(True), fromfile='a/' + REPO, tofile='b/' + REPO)))
        before = info['services'][service]['before']
        assert docker('image', 'inspect', '--format', '{{.Id}}', before['image']).decode().strip() == before['imageId']
        (stage / 'Dockerfile').write_text('FROM ' + before['image'] + '\n' + ''.join('COPY --chown=node:node ' + name + ' /app/' + name + '\n' for name in files))
        with (RELEASE / ('build-' + service + '.log')).open('wb') as log:
            subprocess.run(['sudo', '-n', 'docker', 'build', '--network', 'none', '--pull=false', '-t', IMAGE[service], str(stage)], stdout=log, stderr=subprocess.STDOUT, check=True)
        after = {name: digest((stage / name).read_bytes()) for name in files}
        rows = docker('run', '--rm', '--network', 'none', '--entrypoint', 'sha256sum', IMAGE[service], *['/app/' + name for name in files]).decode().splitlines()
        assert {row.split()[1].removeprefix('/app/'): row.split()[0] for row in rows} == after
        docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', IMAGE[service], '--check', '/app/' + REPO)
        info['services'][service].update({'afterFiles': after, 'imageId': docker('image', 'inspect', '--format', '{{.Id}}', IMAGE[service]).decode().strip()})
    (RELEASE / 'compose.release.yml').write_text('services:\n' + ''.join('  ' + service + ':\n    image: ' + image + '\n' for service, image in IMAGE.items()))
    current(info)
    config_check(info)
    save('manifest.json', info)
    print(json.dumps({'prepared': True, 'appFiles': len(FILES), 'workerFiles': 1, 'backupsRun': False}), flush=True)

def database(sql):
    return docker('exec', '-i', DEPENDENCIES[0], 'psql', '-U', 'mbbs_app', '-d', 'mbbs_yard', '-XAt', '-v', 'ON_ERROR_STOP=1', input=sql.encode()).decode()

def verify(info):
    core.ready(info['services']['app']['imageId'])
    for service, container in CONTAINERS.items():
        expected = info['services'][service]
        actual = core.metadata(container)
        assert actual['imageId'] == expected['imageId']
        assert actual['configuration'] == expected['before']['configuration'], 'Configuration changed'
        assert live_hashes(container, list(expected['afterFiles'])) == expected['afterFiles']
        row = json.loads(docker('inspect', container))[0]
        assert row['State']['Running'] and row['RestartCount'] == 0
    assert [core.metadata(name) for name in DEPENDENCIES] == info['dependencies']
    result = {'deployed': True, 'images': IMAGE, 'configurationPreserved': True, 'databaseAndOllamaUnchanged': True,
              'migration': None, 'backupsRun': False, 'fullRegressionRun': False}
    save('result.json', result)
    print(json.dumps(result), flush=True)

def apply():
    info = json.loads((RELEASE / 'manifest.json').read_text())
    current(info)
    config_check(info)
    active = json.loads(database("""SELECT json_build_object(
      'operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),
      'driverExecuting',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing'),
      'specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'),
      'quantityApplying',(SELECT count(*) FROM sales_special_stock_cases WHERE quantity_review->>'status'='applying'),
      'webhookRunning',(SELECT count(*) FROM netsuite_order_webhook_inbox WHERE status='running'))"""))
    assert not any(active.values()), 'Wait for active work: ' + json.dumps(active)
    current(info)
    try:
        with (RELEASE / 'publish.log').open('wb') as log:
            subprocess.run(compose(info) + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', *CONTAINERS], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        verify(info)
    except Exception:
        (RELEASE / 'compose.restore.yml').write_text('services:\n' + ''.join('  ' + service + ':\n    image: ' + state['before']['imageId'] + '\n' for service, state in info['services'].items()))
        with (RELEASE / 'restore.log').open('wb') as log:
            subprocess.run(compose(info, 'compose.restore.yml') + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', *CONTAINERS], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        core.ready(info['services']['app']['before']['imageId'])
        raise

if __name__ == '__main__':
    {'prepare': prepare, 'apply': apply}[sys.argv[1]]()
