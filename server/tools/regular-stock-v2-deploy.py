"""Scoped regular stock release. Captures live sources; never copies the dirty workspace wholesale."""
import datetime
import difflib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import time
import re
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / 'server'
RELEASE = SERVER / 'deployments/regular-stock-v2-20260929'
ARTIFACTS = SERVER / 'test-artifacts/regular-stock-v2-release-20260929'
FILES = json.loads((SERVER / 'tools/regular-stock-v2-files.json').read_text())
WORKER_FILES = ['src/stock-request-domain.js', 'src/stock-request-repository.js']
CONTAINERS = {'app': 'mbbs-operator-app-app-1', 'webhook-worker': 'mbbs-operator-app-webhook-worker-1'}
DEPENDENCIES = ['mbbs-operator-app-db-1', 'mbbs-operator-app-ollama-1']
MIGRATION = '239_regular_stock_approval_workflow.sql'
spec = importlib.util.spec_from_file_location('release_core', SERVER / 'tools/operator-display-settings-deploy.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
docker, digest, metadata, files_at = core.docker, core.digest, core.metadata, core.files_at


def save(name, data):
    (RELEASE / name).write_text(json.dumps(data, indent=2) + '\n')


def state():
    return json.loads((RELEASE / 'manifest.json').read_text())


def database(sql):
    return docker('exec', '-i', DEPENDENCIES[0], 'psql', '-U', 'mbbs_app', '-d', 'mbbs_yard',
                  '-XAt', '-v', 'ON_ERROR_STOP=1', input=sql.encode()).decode().strip()


def prepare():
    os.umask(0o077)
    RELEASE.mkdir(parents=True, exist_ok=True)
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    assert not (RELEASE / 'manifest.json').exists(), 'Capture already completed'
    data = {'services': {}, 'dependencies': {name: metadata(name) for name in DEPENDENCIES},
            'workspace': {file: digest((SERVER / file).read_bytes()) for file in FILES}}
    patch = (SERVER / 'test/regular-stock-v2.changes.patch').read_text()
    (RELEASE / 'workspace.patch').write_text(patch)
    for service, container in CONTAINERS.items():
        before = metadata(container)
        baseline = ARTIFACTS / ('live-' + service)
        if baseline.exists():
            shutil.rmtree(baseline)
        baseline.mkdir()
        for path in ['src', 'public', 'migrations', 'package.json', 'package-lock.json']:
            with tarfile.open(fileobj=io.BytesIO(docker('cp', container + ':/app/' + path, '-'))) as archive:
                archive.extractall(baseline, filter='data')
        assert metadata(container) == before, 'Live container changed during capture'
        candidate = ARTIFACTS / ('candidate-' + service)
        if candidate.exists():
            shutil.rmtree(candidate)
        shutil.copytree(baseline, candidate)
        result = subprocess.run(['patch', '--batch', '--fuzz=0', '-p2', '-d', str(candidate)],
                                input=patch, text=True, capture_output=True)
        (ARTIFACTS / (service + '-patch.log')).write_text(result.stdout + result.stderr)
        for path in candidate.rglob('*.orig'):
            path.unlink()
        before_hashes, after_hashes = files_at(baseline), files_at(candidate)
        changed = sorted(file for file in after_hashes if after_hashes[file] != before_hashes.get(file))
        data['services'][service] = {'before': before, 'patchExitCode': result.returncode,
            'beforeHashes': {file: before_hashes.get(file) for file in FILES},
            'afterHashes': {file: after_hashes.get(file) for file in FILES}, 'changed': changed,
            'image': 'mbbs-operator-app:regular-stock-v2-' + service + '-20260929'}
        print(json.dumps({'captured': service, 'image': before['image'], 'patchExitCode': result.returncode,
                          'changedFiles': len(changed), 'matchesWorkspace': sum(after_hashes.get(file) == data['workspace'][file] for file in FILES)}), flush=True)
    data['migrationApplied'] = database("SELECT count(*) FROM schema_migrations WHERE filename='" + MIGRATION + "';")
    save('manifest.json', data)
    assert all(row['patchExitCode'] == 0 for row in data['services'].values()), 'Inspect patch logs before continuing'
    assert all(row['changed'] == sorted(FILES) for row in data['services'].values()), 'Unexpected patch scope'


def stage():
    data = state()
    # The worker only reconciles TO events. Its existing server and NetSuite
    # implementation stay intact; status derivation must understand v2 lines.
    worker = ARTIFACTS / 'candidate-webhook-worker'
    shutil.rmtree(worker)
    shutil.copytree(ARTIFACTS / 'live-webhook-worker', worker)
    patch = (RELEASE / 'workspace.patch').read_text()
    chunks = ['--- a/' + part for part in patch.split('--- a/')[1:]]
    selected = ''.join(chunk for chunk in chunks if chunk.splitlines()[0].removeprefix('--- a/server/') in WORKER_FILES)
    result = subprocess.run(['patch', '--batch', '--fuzz=0', '-p2', '-d', str(worker)], input=selected,
                            text=True, capture_output=True)
    (ARTIFACTS / 'webhook-worker-patch.log').write_text(result.stdout + result.stderr)
    assert result.returncode == 0, 'Worker status patch must apply cleanly'
    for service, row in data['services'].items():
        files = sorted(FILES if service == 'app' else WORKER_FILES)
        candidate = ARTIFACTS / ('candidate-' + service)
        before_hashes = files_at(ARTIFACTS / ('live-' + service))
        after_hashes = files_at(candidate)
        row['changed'] = sorted(file for file in after_hashes if after_hashes[file] != before_hashes.get(file))
        assert row['changed'] == files, 'Unexpected release file scope: ' + service
        row['beforeHashes'] = {file: before_hashes.get(file) for file in files}
        row['afterHashes'] = {file: after_hashes[file] for file in files}
        assert all(row['afterHashes'][file] == data['workspace'][file] for file in files), 'Candidate differs from tested runtime'
        row['patchExitCode'] = 0
        directory = ARTIFACTS / ('stage-' + service)
        directory.mkdir(exist_ok=False)
        diff = ''
        for file in files:
            target = directory / file
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(candidate / file, target)
            old = ARTIFACTS / ('live-' + service) / file
            diff += ''.join(difflib.unified_diff(old.read_text().splitlines(True) if old.exists() else [],
                (candidate / file).read_text().splitlines(True), fromfile='a/' + file, tofile='b/' + file))
        (RELEASE / (service + '.patch')).write_text(diff)
        (directory / 'Dockerfile').write_text('FROM ' + row['before']['image'] + '\n' +
            ''.join('COPY --chown=node:node ' + file + ' /app/' + file + '\n' for file in files))
    for kind in ['release', 'rollback']:
        (RELEASE / ('compose.' + kind + '.yml')).write_text('services:\n' + ''.join(
            '  ' + service + ':\n    image: ' + (row['image'] if kind == 'release' else row['before']['imageId']) + '\n'
            for service, row in data['services'].items()))
    save('manifest.json', data)
    print(json.dumps({'staged': {service: len(row['changed']) for service, row in data['services'].items()}}))


def current(data):
    assert {name: metadata(name) for name in DEPENDENCIES} == data['dependencies'], 'Dependency changed'
    for service, row in data['services'].items():
        assert metadata(CONTAINERS[service]) == row['before'], 'Live service changed: ' + service
        assert all(digest((ARTIFACTS / ('candidate-' + service) / file).read_bytes()) == value
                   for file, value in row['afterHashes'].items()), 'Candidate changed'
        existing = {file: value for file, value in row['beforeHashes'].items() if value}
        actual = docker('exec', CONTAINERS[service], 'sha256sum', *['/app/' + file for file in existing]).decode().splitlines()
        assert {line.split()[1].removeprefix('/app/'): line.split()[0] for line in actual} == existing, 'Live source changed'
    assert all(digest((SERVER / file).read_bytes()) == value for file, value in data['workspace'].items()), 'Workspace changed'


def build():
    data = state()
    current(data)
    for service, row in data['services'].items():
        assert docker('image', 'inspect', '--format', '{{.Id}}', row['before']['image']).decode().strip() == row['before']['imageId']
        (ARTIFACTS / ('stage-' + service) / 'Dockerfile').write_text('FROM ' + row['before']['image'] + '\n' +
            ''.join('COPY --chown=node:node ' + file + ' /app/' + file + '\n' for file in row['changed']))
        with (ARTIFACTS / (service + '-build.log')).open('wb') as output:
            subprocess.run(['sudo', '-n', 'docker', 'build', '--network', 'none', '--pull=false', '-t', row['image'],
                str(ARTIFACTS / ('stage-' + service))], stdout=output, stderr=subprocess.STDOUT, check=True)
        row['candidateImageId'] = docker('image', 'inspect', '--format', '{{.Id}}', row['image']).decode().strip()
        actual = docker('run', '--rm', '--network', 'none', '--entrypoint', 'sha256sum', row['image'],
                        *['/app/' + file for file in row['changed']]).decode().splitlines()
        assert {line.split()[1].removeprefix('/app/'): line.split()[0] for line in actual} == row['afterHashes']
        code = 'const{execFileSync}=require("node:child_process");for(const file of ' + json.dumps(row['changed']) + ')if(file.endsWith(".js"))execFileSync(process.execPath,["--check",file]);console.log("syntax passed")'
        docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', row['image'], '-e', code)
        print(json.dumps({'built': service, 'imageId': row['candidateImageId'], 'verifiedFiles': len(row['changed'])}), flush=True)
    save('manifest.json', data)


def validate():
    data = state()
    runner = json.loads(docker('inspect', 'mbbs-regular-v2-runner'))[0]
    env = dict(value.split('=', 1) for value in runner['Config']['Env'])
    assert env.get('MBT_TEST_ISOLATED') == '1' and env.get('NETSUITE_DIRECT_ACCESS_ENABLED') == 'false'
    network = 'mbbs-regular-v2-release-internal'
    docker('network', 'create', '--internal', network)
    assert json.loads(docker('network', 'inspect', network))[0]['Internal'] is True
    db = 'mbbs-regular-v2-release-db'
    db_image = json.loads(docker('inspect', 'mbbs-regular-v2-db-1'))[0]['Image']
    docker('run', '-d', '--name', db, '--network', network, '--network-alias', 'db',
        '--tmpfs', '/var/lib/postgresql', '-e', 'POSTGRES_DB=mbt_test', '-e', 'POSTGRES_USER=mbt_test',
        '-e', 'POSTGRES_PASSWORD=mbt_test_password', '-e', 'PGDATA=/var/lib/postgresql/data', db_image)
    for attempt in range(60):
        probe = subprocess.run(['sudo', '-n', 'docker', 'exec', db, 'pg_isready', '-U', 'mbt_test', '-d', 'mbt_test'], capture_output=True)
        if probe.returncode == 0:
            break
        time.sleep(0.5)
    else:
        raise RuntimeError('Disposable database did not start')
    results = []
    for service, row in data['services'].items():
        # Check module resolution with the actual production dependency tree.
        docker('run', '--rm', '--network', 'none', '-e', 'MBBS_ENV_FILE=/nonexistent',
            '-e', 'NETSUITE_DIRECT_ACCESS_ENABLED=false', '-e', 'NETSUITE_MIRROR_ROLE=disabled',
            '--entrypoint', 'node', row['image'], '--input-type=module', '-e',
            "await import('./src/server.js'); console.log('release imports passed'); process.exit(0)")
        results.append({'service': service, 'check': 'production-image-imports', 'exitCode': 0})
        directory = ARTIFACTS / ('checks-' + service)
        directory.mkdir(exist_ok=True)
        args = ['sudo', '-n', 'docker', 'run', '--rm', '--network', network, '--read-only',
            '--tmpfs', '/tmp:uid=1000,gid=1000,mode=1777', '--tmpfs', '/app/data:uid=1000,gid=1000,mode=0700']
        for key, value in env.items():
            args += ['-e', key + '=' + value]
        candidate = ARTIFACTS / ('candidate-' + service)
        for folder in ['src', 'public', 'migrations']:
            args += ['-v', str(candidate / folder) + ':/app/' + folder + ':ro']
        for folder in ['test', 'tools']:
            args += ['-v', str(SERVER / folder) + ':/app/' + folder + ':ro']
        args += ['-v', str(directory) + ':/app/test-artifacts',
                 '-v', str(candidate / 'package.json') + ':/app/package.json:ro']
        if service == 'app':
            with (directory / 'migrations.log').open('wb') as log:
                subprocess.run(args + ['mbbs-regular-v2:test', 'node', 'src/migrate.js'],
                    stdout=log, stderr=subprocess.STDOUT, check=True)
        suites = [('regressions', 'mbbs-regular-v2:test', ['node', 'tools/regular-stock-v2-tests.mjs']),
                  ('browser', 'mbbs-regular-v2:e2e', ['node', 'tools/regular-stock-v2-browser.mjs'])] if service == 'app' else [
                  ('worker-reconciliation', 'mbbs-regular-v2:test', ['node', '--test', '--test-concurrency=1',
                    'test/mbt/integration/stock-request-repository.test.js', 'test/mbt/unit/stock-request-domain.test.js',
                    'test/mbt/adversarial/stock-request-repository-adversarial.test.js'])]
        for name, image, command in suites:
            started = time.monotonic()
            with (directory / (name + '.log')).open('wb') as log:
                result = subprocess.run(args + ['-e', 'PLAYWRIGHT_BROWSERS_PATH=/ms-playwright', image] + command,
                                        stdout=log, stderr=subprocess.STDOUT)
            record = {'service': service, 'check': name, 'exitCode': result.returncode,
                      'seconds': round(time.monotonic() - started, 1)}
            results.append(record)
            save('candidate-checks.json', {'images': {key: value['candidateImageId'] for key, value in data['services'].items()}, 'results': results})
            print(json.dumps(record), flush=True)
            assert result.returncode == 0, 'Candidate validation failed: ' + name
    config_check(data)


def compose(data, override='compose.release.yml'):
    args = ['sudo', '-n', 'docker', 'compose', '-p', 'mbbs-operator-app']
    for name in data['services']['app']['before']['configFiles'].split(','):
        args += ['-f', name]
    return args + ['-f', str(RELEASE / override), '--env-file', str(ROOT / 'docker/env/.env')]


def config_check(data):
    config = json.loads(subprocess.check_output(compose(data) + ['config', '--format', 'json'], cwd=ROOT))['services']
    for service, container in CONTAINERS.items():
        image = json.loads(docker('image', 'inspect', data['services'][service]['image']))[0]['Config']
        live = json.loads(docker('inspect', container))[0]['Config']
        env = dict(value.split('=', 1) for value in image['Env'])
        env.update({key: str(value) for key, value in config[service].get('environment', {}).items()})
        assert env == dict(value.split('=', 1) for value in live['Env']), service + ' environment changed'
        for field, key in [('Cmd', 'command'), ('Entrypoint', 'entrypoint'), ('User', 'user'), ('WorkingDir', 'working_dir')]:
            assert (image.get(field) if config[service].get(key) is None else config[service][key]) == live.get(field), field + ' changed'
    print(json.dumps({'configurationPreserved': True}), flush=True)


def verify(data=None):
    data = data or state()
    core.ready(data['services']['app']['candidateImageId'])
    tree_counts = {}
    for service, container in CONTAINERS.items():
        expected = data['services'][service]
        actual = metadata(container)
        assert actual['imageId'] == expected['candidateImageId'], 'Image differs: ' + service
        assert actual['configuration'] == expected['before']['configuration'], 'Configuration changed: ' + service
        hashes = docker('exec', container, 'sha256sum', *['/app/' + file for file in expected['changed']]).decode().splitlines()
        assert {line.split()[1].removeprefix('/app/'): line.split()[0] for line in hashes} == expected['afterHashes']
        script = """const fs=require('node:fs'),crypto=require('node:crypto');const hashes={};
function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const path=dir+'/'+entry.name;
 if(entry.isDirectory())walk(path);else if(entry.isFile())hashes[path]=crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex');}}
for(const dir of ['src','public','migrations'])walk(dir);console.log(JSON.stringify(hashes));"""
        all_hashes = json.loads(docker('exec', container, 'node', '-e', script))
        assert all_hashes == files_at(ARTIFACTS / ('candidate-' + service)), 'Live tree differs from validated candidate: ' + service
        tree_counts[service] = len(all_hashes)
        row = json.loads(docker('inspect', container))[0]
        assert row['State']['Running'] and row['RestartCount'] == 0
    assert {name: metadata(name) for name in DEPENDENCIES} == data['dependencies'], 'Dependencies changed'
    local = """import assert from 'node:assert/strict';
for(const path of ['/api/scm/smart/settings','/api/sales/stock-requests/alerts','/api/scm/stock-requests/alerts']) {
 const response=await fetch('http://127.0.0.1:3000'+path);assert.equal(response.status,401,path);
}console.log(JSON.stringify({protectedEndpoints:3,anonymousStatus:401}));"""
    auth = json.loads(docker('exec', '-i', CONTAINERS['app'], 'node', '--input-type=module', input=local.encode()))
    live = json.loads(docker('exec', '-i', CONTAINERS['app'], 'node', '--input-type=module',
        input=(SERVER / 'tools/regular-stock-v2-live.mjs').read_bytes()))
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'images': {service: row['candidateImageId'] for service, row in data['services'].items()},
        'configurationPreserved': True, 'databaseAndOllamaContainersUnchanged': True,
        'runtimeFilesVerified': 32, 'completeSourceTreesVerified': tree_counts, 'migration': MIGRATION, **auth, **live}
    save('deployment-result.json', result)
    print(json.dumps(result), flush=True)


def apply():
    data = state()
    current(data)
    checks = json.loads((RELEASE / 'candidate-checks.json').read_text())
    assert checks['images'] == {key: value['candidateImageId'] for key, value in data['services'].items()}
    assert len(checks['results']) == 5 and all(row['exitCode'] == 0 for row in checks['results'])
    assert json.loads((SERVER / 'test-artifacts/regular-stock-v2/source-manifest.json').read_text()) == data['workspace']
    assert all(row['exitCode'] == 0 for row in json.loads((SERVER / 'test-artifacts/regular-stock-v2/gauntlet.json').read_text()))
    config_check(data)
    active = json.loads(database("""SELECT json_build_object(
      'operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),
      'driverExecuting',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing'),
      'specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'),
      'quantityApplying',(SELECT count(*) FROM sales_special_stock_cases WHERE quantity_review->>'status'='applying'),
      'stockTransferConfirming',(SELECT count(*) FROM sales_stock_transfers WHERE confirmation_status IN ('creating','approving','hydrating','printing')),
      'scmExecuting',(SELECT count(*) FROM scm_smart_proposals WHERE status='executing'),
      'webhookRunning',(SELECT count(*) FROM netsuite_order_webhook_inbox WHERE status='running'))"""))
    save('active-before-release.json', active)
    assert not any(active.values()), 'Wait for active work: ' + json.dumps(active)
    current(data)
    count = database("SELECT count(*) FROM schema_migrations WHERE filename='" + MIGRATION + "';")
    if count == '0':
        sql = (ARTIFACTS / 'candidate-app/migrations' / MIGRATION).read_text()
        output = database("BEGIN;\nSET LOCAL lock_timeout='5s';\nSET LOCAL statement_timeout='30s';\n" + sql +
            "\nINSERT INTO schema_migrations(filename) VALUES('" + MIGRATION + "');\nCOMMIT;")
        (RELEASE / 'migration.log').write_text(output + '\n')
    else:
        assert count == '1'
    print(json.dumps({'migrationApplied': MIGRATION, 'activeOperations': active}), flush=True)
    try:
        with (RELEASE / 'publish.log').open('wb') as log:
            subprocess.run(compose(data) + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', *CONTAINERS],
                           cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        verify(data)
    except Exception:
        with (RELEASE / 'rollback.log').open('wb') as log:
            subprocess.run(compose(data, 'compose.rollback.yml') + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', *CONTAINERS],
                           cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        core.ready(data['services']['app']['before']['imageId'])
        save('rollback-result.json', {'rolledBack': True, 'additiveMigrationRetained': True})
        raise


def public():
    data = state()
    routes = {'public/sales-stock-requests.html': '/sales/stock-requests', 'public/scm-stock-requests.html': '/scm/stock-requests',
        'public/scm-menu.html': '/scm', 'public/sales.html': '/sales', 'public/scm-smart.html': '/scm/smart'}
    headers = {'User-Agent': 'Mozilla/5.0', 'Cache-Control': 'no-cache'}
    base = 'https://test.mbbsoperation.com'
    def check(entry):
        file, expected = entry
        url = base + routes.get(file, '/' + file.removeprefix('public/')) + '?regular=20260929-release'
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=20) as response:
            assert response.status == 200, file
            body = response.read()
        if file.endswith('.html'):
            body = re.sub(rb'<script type="module" src="https://static\.cloudflareinsights\.com/beacon\.min\.js/[^>]+></script>\n', b'', body)
        assert digest(body) == expected, 'Public source differs: ' + file
        return file
    with ThreadPoolExecutor(max_workers=5) as pool:
        assets = list(pool.map(check, [(file, value) for file, value in data['services']['app']['afterHashes'].items() if file.startswith('public/')]))
    with urllib.request.urlopen(urllib.request.Request(base + '/health', headers=headers), timeout=20) as response:
        assert response.status == 200 and json.loads(response.read())['ok'] is True
    result = {'healthy': True, 'publicAssetsVerified': assets, 'baseUrl': base, 'liveMutations': False}
    save('public-check.json', result)
    print(json.dumps(result), flush=True)


if __name__ == '__main__':
    {'prepare': prepare, 'stage': stage, 'build': build, 'validate': validate,
     'apply': apply, 'verify': verify, 'public': public}[sys.argv[1]]()
