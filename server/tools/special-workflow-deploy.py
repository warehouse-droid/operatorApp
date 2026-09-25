"""Scoped production release. Run prepare/build/check/apply/verify with sudo."""
import datetime
import difflib
import hashlib
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
RELEASE = Path('/home/ubuntu/operatorapp-deploy-backups/special-workflow-20260924-v1')
ORIGINAL = Path('/home/ubuntu/operatorapp-investigations/special-workflow-20260924/baseline')
ART = SERVER / 'test-artifacts/special-workflow-review'
SERVICES = {'app': 'mbbs-operator-app-app-1', 'worker': 'mbbs-operator-app-webhook-worker-1'}
DEPENDENCIES = ['mbbs-operator-app-db-1', 'mbbs-operator-app-ollama-1']
MIGRATION = '225_special_workflow_review.sql'
NEW = {'src/special-stock-netsuite-adapter.js', 'public/special-stock-workflow.js', 'migrations/' + MIGRATION}
SMALL_REVIEWED = {'src/dispatch-special-order-pallets.js', 'public/stock-requests.css', 'public/sales-stock-requests.html', 'public/scm-stock-requests.html'}
VERSION = '20260924-special-workflow-v1'


def run(*args, **kwargs):
    return subprocess.check_output(args, cwd=ROOT, **kwargs)


def docker(*args, **kwargs):
    return run('docker', *args, **kwargs)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def save(name, value):
    path = RELEASE / name
    path.write_text(json.dumps(value, indent=2) + '\n')
    path.chmod(0o600)


def read(name):
    return json.loads((RELEASE / name).read_text())


def inspect(*names):
    return json.loads(docker('inspect', *names))


def files_at(root):
    return {str(p.relative_to(root)): digest(p.read_bytes()) for p in root.rglob('*') if p.is_file()}


def config(row, pickup=False):
    result = {key: row['Config'].get(key) for key in ['Cmd', 'Entrypoint', 'User', 'WorkingDir', 'Healthcheck']}
    env = dict(entry.split('=', 1) for entry in row['Config']['Env'])
    if pickup:
        env['SPECIAL_STOCK_PICKUP_METHOD_ID'] = '1'
    result.update(env=env, mounts=sorted(row['Mounts'], key=lambda x: x['Destination']),
                  ports=row['HostConfig']['PortBindings'], restart=row['HostConfig']['RestartPolicy'])
    return result


def source_gate():
    expected = json.loads((ART / 'final/source-manifest.json').read_text())
    for file, sha in expected.items():
        assert digest((SERVER / file).read_bytes()) == sha, 'Verified source changed: ' + file
    assert int(re.search(r'^# pass (\d+)$', (ART / 'final/tests-coverage.txt').read_text(), re.M)[1]) >= 71
    assert '# fail 0\n' in (ART / 'final/tests-coverage.txt').read_text()
    assert all(not row['pageErrors'] and row['sevenStages'] for row in json.loads((ART / 'final-browser/results.json').read_text()))
    return sorted(f for f in expected if f.startswith(('src/', 'public/', 'migrations/')))


def current():
    before = read('containers.before.private.json')
    now = inspect(*SERVICES.values(), *DEPENDENCIES)
    for a, b in zip(before, now):
        assert a['Id'] == b['Id'] and a['Image'] == b['Image'], 'Live service changed during release preparation'
        assert config(a) == config(b), 'Live configuration changed during preparation'
    source_gate()


def make_diff(file, old, new):
    return ''.join(difflib.unified_diff(old.splitlines(True), new.splitlines(True), fromfile='a/' + file, tofile='b/' + file))


def pallet_patch(file):
    old = (RELEASE / 'app-before' / file).read_text()
    new = (SERVER / file).read_text()
    patch = make_diff(file, old, new)
    header, *hunks = re.split(r'(?=^@@ )', patch, flags=re.M)
    selected = [hunk for hunk in hunks if any(re.search(r'specialPallet|special_pallet', line) for line in hunk.splitlines() if line.startswith(('+', '-')))]
    assert len(selected) == 3, 'Unexpected pallet patch scope: ' + file
    return header + ''.join(selected)


def prepare():
    current()
    assert not (RELEASE / 'manifest.json').exists(), 'Release already prepared'
    scope = source_gate()
    manifest = {'services': {}, 'migration': MIGRATION, 'pickupMethodId': '1',
                'preparedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    before = read('containers.before.private.json')
    for index, role in enumerate(SERVICES):
        baseline = RELEASE / (role + '-before')
        candidate = RELEASE / (role + '-candidate')
        if candidate.exists():
            shutil.rmtree(candidate)
        shutil.copytree(baseline, candidate)
        chosen = scope if role == 'app' else [f for f in scope if f.startswith(('src/', 'migrations/')) or f == 'public/special-stock-workflow.js']
        patch = ''
        for file in chosen:
            if file in NEW:
                assert not (baseline / file).exists(), 'New runtime file already exists: ' + file
                shutil.copy2(SERVER / file, candidate / file)
            elif role == 'worker' and file == 'src/netsuite.js':
                old = (baseline / file).read_text()
                parser = re.search(r'^    const idMatch = location\.match\(.+;$', old, re.M)
                assert parser and 'salesOrder' not in parser.group() and 'purchaseOrder' in parser.group()
                replacement = parser.group().replace('purchaseOrder', 'purchaseOrder|salesOrder')
                new = old.replace(parser.group(), replacement)
                helpers = (SERVER / file).read_text().split('// Narrow Special Item boundary;', 1)
                assert len(helpers) == 2 and 'let restMutationQueue' in old
                new += '\n// Narrow Special Item boundary;' + helpers[1]
                patch += make_diff(file, old, new)
            elif (ORIGINAL / file).exists():
                patch += make_diff(file, (ORIGINAL / file).read_text(), (SERVER / file).read_text())
            elif file in SMALL_REVIEWED:
                # These small diffs were reviewed against the live app snapshot.
                patch += make_diff(file, (RELEASE / 'app-before' / file).read_text(), (SERVER / file).read_text())
            elif file in ['src/dispatch-repository.js', 'public/dispatch.js']:
                patch += pallet_patch(file)
            else:
                raise AssertionError('No scoped patch recipe for ' + file)
        if role == 'app':
            file = 'public/dispatch.html'
            old = (baseline / file).read_text()
            new, count = re.subn(r'/dispatch\.js\?v=[^"\s]+', '/dispatch.js?v=' + VERSION, old)
            assert count == 1
            patch += make_diff(file, old, new)
            chosen = sorted([*chosen, file])
        (RELEASE / (role + '.patch')).write_text(patch)
        result = subprocess.run(['patch', '--batch', '--fuzz=0', '-p1', '-d', str(candidate)], input=patch, text=True, capture_output=True)
        (RELEASE / (role + '-patch.log')).write_text(result.stdout + result.stderr)
        if result.returncode:
            raise RuntimeError('Patch requires inspection: ' + role + '-patch.log')
        for p in candidate.rglob('*.orig'):
            p.unlink()
        before_hashes, after_hashes = files_at(baseline), files_at(candidate)
        changed = sorted(f for f in before_hashes.keys() | after_hashes.keys() if before_hashes.get(f) != after_hashes.get(f))
        assert changed == sorted(chosen), 'Unexpected changed files: ' + role
        image = 'mbbs-operator-app:special-workflow-20260924-v1-' + role
        rollback = 'mbbs-operator-app:rollback-special-workflow-20260924-v1-' + role
        stage = RELEASE / (role + '-stage')
        for file in chosen:
            target = stage / file
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(candidate / file, target)
        (stage / 'Dockerfile').write_text('FROM ' + rollback + '\n' + ''.join('COPY --chown=node:node ' + f + ' /app/' + f + '\n' for f in chosen))
        manifest['services'][role] = {'image': image, 'rollback': rollback, 'baseImageId': before[index]['Image'],
                                     'files': chosen, 'allFiles': after_hashes, 'after': {f: after_hashes[f] for f in chosen}}
    save('manifest.json', manifest)
    for name, release in [('release', True), ('rollback', False)]:
        body = 'services:\n'
        for index, (role, row) in enumerate(manifest['services'].items()):
            service = 'app' if role == 'app' else 'webhook-worker'
            body += '  ' + service + ':\n    image: ' + (row['image'] if release else row['baseImageId']) + '\n'
            old = dict(entry.split('=', 1) for entry in before[index]['Config']['Env']).get('SPECIAL_STOCK_PICKUP_METHOD_ID')
            # Null removes the release override on rollback if the old process
            # inherited its blank setting from the mounted environment file.
            body += '    environment:\n      SPECIAL_STOCK_PICKUP_METHOD_ID: ' + (json.dumps('1' if release else old) if (release or old is not None) else 'null') + '\n'
        (RELEASE / ('compose.' + name + '.yml')).write_text(body)
    print(json.dumps({'prepared': True, 'changed': {role: len(row['files']) for role, row in manifest['services'].items()}}), flush=True)


def build():
    current()
    manifest = read('manifest.json')
    for role, row in manifest['services'].items():
        docker('tag', row['baseImageId'], row['rollback'])
        with (RELEASE / (role + '-build.log')).open('wb') as output:
            subprocess.run(['docker', 'build', '--network', 'none', '--pull=false', '-t', row['image'], str(RELEASE / (role + '-stage'))], stdout=output, stderr=subprocess.STDOUT, check=True)
        row['imageId'] = inspect(row['image'])[0]['Id']
        actual = docker('run', '--rm', '--network', 'none', '--entrypoint', 'sha256sum', row['image'], *['/app/' + f for f in row['allFiles']]).decode().splitlines()
        assert {line.split()[1].removeprefix('/app/'): line.split()[0] for line in actual} == row['allFiles']
        print(json.dumps({'built': role, 'imageId': row['imageId'], 'runtimeHashes': len(row['allFiles'])}), flush=True)
    save('manifest.json', manifest)


def database(sql):
    return docker('exec', '-i', DEPENDENCIES[0], 'psql', '-U', 'mbbs_app', '-d', 'mbbs_yard', '-X', '-v', 'ON_ERROR_STOP=1', '-At', input=sql.encode()).decode()


def preflight():
    return json.loads(database("SELECT jsonb_build_object('operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing')),'webhooksRunning',(SELECT count(*) FROM netsuite_order_webhook_inbox WHERE status='running'),'specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'),'migration225',(SELECT count(*) FROM schema_migrations WHERE filename='225_special_workflow_review.sql'),'specialFlag',(SELECT enabled FROM mbt_feature_flags WHERE flag_key='special_stock_request_workflow'),'specialRequests',(SELECT count(*) FROM sales_special_stock_cases));").strip())


def netsuite_readiness():
    # Run only the candidate's production read adapters. Do not start its HTTP
    # server or workers, and do not expose credentials in command output.
    current()
    before = read('containers.before.private.json')[0]
    networks = list(before['NetworkSettings']['Networks'])
    assert len(networks) == 1
    env_args = [part for entry in before['Config']['Env'] for part in ['-e', entry]]
    script = """import assert from 'node:assert/strict';
import {resolveSpecialOrderUnitsFromNetSuite,suiteqlAll} from './src/netsuite.js';import {closeDb} from './src/db.js';
try {
const methods=await suiteqlAll(\"SELECT t.custbody3 AS id, BUILTIN.DF(t.custbody3) AS label FROM transaction t WHERE t.type='SalesOrd' AND t.custbody3 IS NOT NULL GROUP BY t.custbody3, BUILTIN.DF(t.custbody3)\");
assert.equal(methods.find(x=>x.id==='1')?.label,'Pick-Up');assert.equal(methods.find(x=>x.id==='2')?.label,'Delivery');
const lines=await resolveSpecialOrderUnitsFromNetSuite([{itemId:2055,uom:'PC',quantity:1},{itemId:1784,uom:'EACH',quantity:1}]);
assert.ok(lines.every(x=>x.unitId>0));console.log(JSON.stringify({passed:true,methods,units:lines,ordersSubmitted:0}));
}finally{await closeDb();}"""
    result = json.loads(docker('run', '--rm', '--network', networks[0], '--volumes-from', SERVICES['app'] + ':ro',
                              '--no-healthcheck', *env_args, '--entrypoint', 'node', read('manifest.json')['services']['app']['imageId'],
                              '--input-type=module', '-e', script))
    save('netsuite-readiness.json', result)
    print(json.dumps(result), flush=True)


def compose(role, override):
    index = list(SERVICES).index(role)
    paths = read('containers.before.private.json')[index]['Config']['Labels']['com.docker.compose.project.config_files'].split(',')
    args = ['docker', 'compose', '-p', 'mbbs-operator-app']
    for file in dict.fromkeys(paths):
        args.extend(['-f', file])
    return args + ['-f', str(RELEASE / ('compose.' + override + '.yml'))]


def config_gate():
    manifest = read('manifest.json')
    for index, (role, row) in enumerate(manifest['services'].items()):
        service = 'app' if role == 'app' else 'webhook-worker'
        resolved = json.loads(run(*compose(role, 'release'), 'config', '--format', 'json'))['services'][service]
        image = inspect(row['imageId'])[0]['Config']
        prior = read('containers.before.private.json')[index]
        expected_env = dict(value.split('=', 1) for value in image['Env'])
        expected_env.update({key: str(value) for key, value in resolved.get('environment', {}).items() if value is not None})
        assert expected_env == config(prior, pickup=True)['env'], 'Unexpected environment drift: ' + role
        for field, key in [('Cmd', 'command'), ('Entrypoint', 'entrypoint'), ('User', 'user'), ('WorkingDir', 'working_dir')]:
            value = resolved.get(key)
            assert (image.get(field) if value is None else value) == prior['Config'].get(field), 'Command drift: ' + role + '/' + key
        save(role + '-compose.private.json', resolved)


def backup_and_migrate():
    options = [('schema-before.dump', ['--schema-only']), ('special-before.dump', ['--table=public.schema_migrations', '--table=public.sales_stock_requests', '--table=public.sales_stock_request_lines', '--table=public.sales_stock_request_events', '--table=public.sales_special_stock_*'])]
    for name, flags in options:
        with (RELEASE / name).open('wb') as output:
            subprocess.run(['docker', 'exec', DEPENDENCIES[0], 'pg_dump', '-U', 'mbbs_app', '-d', 'mbbs_yard', '--format=custom', *flags], stdout=output, check=True)
        with (RELEASE / name).open('rb') as source:
            toc = docker('exec', '-i', DEPENDENCIES[0], 'pg_restore', '--list', stdin=source)
        assert b'schema_migrations' in toc and b'sales_special_stock_cases' in toc
        (RELEASE / (name + '.toc')).write_bytes(toc)
    save('database-backups.json', {name: {'sha256': digest((RELEASE / name).read_bytes()), 'bytes': (RELEASE / name).stat().st_size} for name, _ in options})
    state = preflight()
    assert not any(state[k] for k in ['operatorPosting', 'webhooksRunning', 'specialCreating']), 'An operation became active; retry when idle'
    if not state['migration225']:
        sql = (RELEASE / 'app-candidate/migrations' / MIGRATION).read_text()
        result = database("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'; SELECT pg_advisory_xact_lock(hashtext('special-workflow-225'));\n" + sql + "\nINSERT INTO schema_migrations(filename) VALUES('" + MIGRATION + "'); COMMIT;")
        (RELEASE / 'migration.log').write_text(result)


def ready(images):
    for _ in range(55):
        rows = inspect(*SERVICES.values())
        if all(row['Image'] == images[role] and row['State']['Running'] and row['RestartCount'] == 0 for role, row in zip(SERVICES, rows)):
            probe = subprocess.run(['docker', 'exec', SERVICES['app'], 'node', '-e', "fetch('http://127.0.0.1:3000/health').then(async r=>{if(!r.ok||!(await r.json()).ok)process.exit(1)}).catch(()=>process.exit(1))"], capture_output=True)
            if probe.returncode == 0:
                return
        time.sleep(1)
    raise RuntimeError('Released services did not become ready')


def verify():
    manifest = read('manifest.json')
    ready({role: row['imageId'] for role, row in manifest['services'].items()})
    after = inspect(*SERVICES.values(), *DEPENDENCIES)
    before = read('containers.before.private.json')
    for index, (role, row) in enumerate(manifest['services'].items()):
        assert config(after[index]) == config(before[index], pickup=True), 'Runtime configuration drift: ' + role
        actual = docker('exec', SERVICES[role], 'sha256sum', *['/app/' + f for f in row['allFiles']]).decode().splitlines()
        assert {line.split()[1].removeprefix('/app/'): line.split()[0] for line in actual} == row['allFiles']
    assert [(r['Id'], r['State']['StartedAt']) for r in after[2:]] == [(r['Id'], r['State']['StartedAt']) for r in before[2:]]
    state = preflight()
    assert state['migration225'] == 1 and state['specialFlag'] is True
    script = (SERVER / 'tools/special-workflow-live-verify.mjs').read_text().replace('EXPECTED_ASSETS', json.dumps({f: h for f, h in manifest['services']['app']['after'].items() if f.startswith('public/')}))
    live = json.loads(docker('exec', '-i', SERVICES['app'], 'node', '--input-type=module', input=script.encode()))
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'images': {role: row['imageId'] for role, row in manifest['services'].items()}, 'migration': MIGRATION, 'pickupMethodId': 1,
              'runtimeFileCounts': {role: len(row['allFiles']) for role, row in manifest['services'].items()}, 'configurationPreservedExceptPickupMapping': True, 'databaseAndOllamaUnchanged': True, 'checks': live}
    save('deployment-result.json', result)
    print(json.dumps(result), flush=True)
    return result


def apply():
    current()
    manifest = read('manifest.json')
    verified = read('verified.json')
    assert verified['images'] == {role: row['imageId'] for role, row in manifest['services'].items()} and verified['passed']
    assert read('netsuite-readiness.json')['passed'], 'Production NetSuite read readiness is required'
    config_gate()
    initial = preflight()
    save('preflight.json', initial)
    assert not any(initial[k] for k in ['operatorPosting', 'webhooksRunning', 'specialCreating']), 'In-flight operations: retry when idle'
    backup_and_migrate()
    current()
    idle = preflight()
    assert not any(idle[k] for k in ['operatorPosting', 'webhooksRunning', 'specialCreating']), 'In-flight operation before restart'
    save('cutover-start.json', {'at': datetime.datetime.now(datetime.timezone.utc).isoformat()})
    try:
        for role in ['worker', 'app']:
            with (RELEASE / (role + '-cutover.log')).open('wb') as output:
                subprocess.run([*compose(role, 'release'), 'up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app' if role == 'app' else 'webhook-worker'], cwd=ROOT, stdout=output, stderr=subprocess.STDOUT, check=True)
        verify()
    except Exception:
        for role in ['worker', 'app']:
            with (RELEASE / (role + '-rollback.log')).open('wb') as output:
                subprocess.run([*compose(role, 'rollback'), 'up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app' if role == 'app' else 'webhook-worker'], cwd=ROOT, stdout=output, stderr=subprocess.STDOUT, check=True)
        ready({role: row['baseImageId'] for role, row in manifest['services'].items()})
        raise


if __name__ == '__main__':
    os.umask(0o077)
    {'prepare': prepare, 'build': build, 'apply': apply, 'verify': verify, 'config': config_gate, 'readiness': netsuite_readiness}[sys.argv[1]]()
