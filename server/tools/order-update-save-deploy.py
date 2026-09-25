"""Package the Dispatch fix on the live app, verify it, migrate, and cut over."""
import argparse
import datetime
import difflib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / 'server'
ARTIFACT = SERVER / 'test-artifacts/order-update-save'
RELEASE = ARTIFACT / 'deployment'
IMAGE = 'mbbs-operator-app:order-update-save-20260918'
MIGRATION = '205_dispatch_plan_maintenance.sql'
APP, WORKER = 'mbbs-operator-app-app-1', 'mbbs-operator-app-webhook-worker-1'
SERVICES = [APP, WORKER]
DEPENDENCIES = ['mbbs-operator-app-db-1', 'mbbs-operator-app-ollama-1']
FILES = sorted(re.findall(r"'((?:src|public|migrations)/[^']+)'", (SERVER / 'tools/order-update-save-files.mjs').read_text()))
spec = importlib.util.spec_from_file_location('release_core', SERVER / 'tools/operator-improvements-deploy.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.RELEASE, core.FILES, core.SERVICES, core.DEPENDENCIES = RELEASE, FILES, SERVICES, DEPENDENCIES
run, inspect, save = core.run, core.inspect, core.save


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read(name):
    return json.loads((RELEASE / name).read_text())


def source_gate():
    final = json.loads((ARTIFACT / 'final-run-complete.json').read_text())
    assert final['status'] == 'complete_with_user_accepted_performance_exception'
    for name, expected in final['sources'].items():
        assert digest(SERVER / name) == expected, f'Verified source changed: {name}'
    acceptance = json.loads((ARTIFACT / 'performance-acceptance.json').read_text())
    assert acceptance['performanceReportSha256'] == digest(ARTIFACT / 'performance-comparison.json')
    assert acceptance['verifiedTreeSha256'] == final['verificationTreeSha256']
    for name in ['full-comparison.json', 'adjacent-comparison.json']:
        assert not json.loads((ARTIFACT / name).read_text())['newFailures']
    static = json.loads((ARTIFACT / 'static-comparison.json').read_text())
    assert not static['newLint'] and not static['newTypes']
    checks = json.loads((ARTIFACT / 'checks.json').read_text())
    assert len(checks['kills']) == len(checks['propertyKills']) == 7
    assert all(digest(SERVER / name) == expected for name, expected in checks['sources'].items())
    return checks['sources']


def extract(image, destination):
    destination.mkdir(parents=True, exist_ok=True)
    container = run('docker', 'create', '--entrypoint', 'true', image).decode().strip()
    try:
        for folder in ['src', 'public', 'migrations']:
            run('docker', 'cp', f'{container}:/app/{folder}', str(destination / folder))
    finally:
        run('docker', 'rm', container)


def prepare():
    source_gate()
    assert not (RELEASE / 'manifest.json').exists(), 'Release already prepared'
    before = read('containers.before.private.json')
    current = inspect(*SERVICES, *DEPENDENCIES)
    assert [row['Id'] for row in current] == [row['Id'] for row in before]
    base = before[0]['Image']
    prior = core.image_files(base)
    worker_prior = core.image_files(before[1]['Image'])
    # The worker imports server.js. Use the deployed app's compatible backend
    # module set; preserve its entry point and current webhook queue semantics.
    for name in prior:
        if name.startswith('src/netsuite-order-webhook-') or name in ['package.json', 'package-lock.json']:
            assert prior[name] == worker_prior.get(name), f'Worker-specific implementation: {name}'
    extract(base, RELEASE / 'app-before')
    stage = RELEASE / 'image'
    for name in FILES:
        target = stage / name
        target.parent.mkdir(parents=True, exist_ok=True)
        if name == 'src/server.js':
            shutil.copy2(RELEASE / 'app-before' / name, target)
            patch = ''.join(difflib.unified_diff(
                (ARTIFACT / 'baseline' / name).read_text().splitlines(keepends=True),
                (SERVER / name).read_text().splitlines(keepends=True),
                fromfile='a/' + name, tofile='b/' + name))
            (RELEASE / 'server-task.patch').write_text(patch)
            result = subprocess.run(['patch', '--batch', '--fuzz=0', '-p1'], cwd=stage,
                                    input=patch, text=True, capture_output=True, check=True)
            (RELEASE / 'server-patch.log').write_text(result.stdout + result.stderr)
        else:
            baseline = ARTIFACT / 'baseline' / name
            expected = digest(baseline) if baseline.exists() else None
            assert prior.get(name) == expected, f'Live baseline changed: {name}'
            shutil.copy2(SERVER / name, target)
    rollback = {}
    for service, row in zip(['app', 'webhook-worker'], before[:2]):
        rollback[service] = f'mbbs-operator-app:rollback-order-update-save-20260918-{service}'
        run('docker', 'tag', row['Image'], rollback[service])
    for name, images in [('release', {service: IMAGE for service in rollback}), ('rollback', rollback)]:
        (RELEASE / f'compose.{name}.yml').write_text('services:\n' + ''.join(
            f'  {service}:\n    image: {image}\n' for service, image in images.items()))
    (stage / 'Dockerfile').write_text(f"FROM {rollback['app']}\n" + ''.join(
        f'COPY --chown=node:node {name} /app/{name}\n' for name in FILES))
    with (RELEASE / 'build.log').open('wb') as output:
        subprocess.run(['docker', 'build', '--network', 'none', '--pull=false', '-t', IMAGE, str(stage)],
                       stdout=output, stderr=subprocess.STDOUT, check=True)
    image_id = inspect(IMAGE)[0]['Id']
    candidate = core.image_files(image_id)
    changed = sorted(name for name in prior.keys() | candidate.keys() if prior.get(name) != candidate.get(name))
    assert changed == FILES, changed
    assert all(candidate[name] == digest(stage / name) for name in FILES)
    core.config_gate(before[:2], core.compose(before, 'compose.release.yml'), image_id)
    extract(image_id, RELEASE / 'candidate')
    (RELEASE / 'candidate-artifacts/order-update-save').mkdir(parents=True)
    (RELEASE / 'baseline-artifacts/order-update-save').mkdir(parents=True)
    manifest = {'image': IMAGE, 'imageId': image_id, 'beforeImages': [row['Image'] for row in before[:2]],
                'before': {name: prior.get(name) for name in FILES},
                'after': {name: candidate[name] for name in FILES}, 'changedAppFiles': changed,
                'changedWorkerFiles': sorted(name for name in worker_prior.keys() | candidate.keys()
                                             if worker_prior.get(name) != candidate.get(name)),
                'candidateFiles': candidate, 'rollbackImages': rollback,
                'workerBackend': 'Current deployed app module set plus the verified Dispatch fix',
                'serverPatch': 'Only task diff applied to deployed server.js; unrelated workspace work excluded'}
    save('manifest.json', manifest)
    print(json.dumps({'prepared': IMAGE, 'imageId': image_id, 'changedAppFiles': changed,
                      'workerAlignedWithApp': True}), flush=True)


def preflight():
    return core.node_read("""import {query,withTransaction,closeDb} from './src/db.js';
      try {console.log(JSON.stringify(await withTransaction(async()=>{
        await query('SET TRANSACTION READ ONLY'); await query("SET LOCAL statement_timeout='10s'");
        return (await query(`SELECT
          (SELECT count(*)::int FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing')) AS postings,
          (SELECT count(*)::int FROM netsuite_order_webhook_inbox WHERE status='running') AS webhooks,
          (SELECT count(*)::int FROM dispatch_plan_edit_leases WHERE expires_at>clock_timestamp()) AS editors`)).rows[0];
      })));} finally {await closeDb();}""")


def migrate():
    # This additive release applies exactly 205. Unrelated pending migrations
    # (including the undeployed return-authorization work) remain untouched.
    for name, options in [('schema-before.dump', ['--schema-only']),
                          ('dispatch-before.dump', ['--table=public.dispatch_plans', '--table=public.dispatch_plan_snapshots',
                                                   '--table=public.dispatch_plan_edit_leases', '--table=public.schema_migrations'])]:
        with (RELEASE / name).open('wb') as output:
            subprocess.run(['docker', 'exec', DEPENDENCIES[0], 'sh', '-c',
                            'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom "$@"', 'backup', *options],
                           stdout=output, stderr=subprocess.PIPE, check=True)
        with (RELEASE / name).open('rb') as source:
            toc = subprocess.check_output(['docker', 'exec', '-i', DEPENDENCIES[0], 'pg_restore', '--list'], stdin=source)
        assert b'schema_migrations' in toc and b'dispatch_plans' in toc
        (RELEASE / (name + '.toc')).write_bytes(toc)
    sql = (RELEASE / 'candidate/migrations' / MIGRATION).read_text()
    result = core.node_read("""import {query,withTransaction,closeDb} from './src/db.js';
      try {console.log(JSON.stringify(await withTransaction(async()=>{
        await query("SET LOCAL lock_timeout='5s'"); await query("SET LOCAL statement_timeout='30s'");
        await query("SELECT pg_advisory_xact_lock(hashtext('order-update-save-migration'))");
        const filename=FILENAME;
        if ((await query('SELECT 1 FROM schema_migrations WHERE filename=$1',[filename])).rowCount) return {alreadyApplied:filename};
        await query(SQL); await query('INSERT INTO schema_migrations(filename) VALUES($1)',[filename]);
        return {applied:filename};
      })));} finally {await closeDb();}""".replace('FILENAME', json.dumps(MIGRATION)).replace('SQL', json.dumps(sql)))
    save('migration.json', result)


def package_gate():
    source_gate()
    manifest = read('manifest.json')
    assert inspect(IMAGE)[0]['Id'] == manifest['imageId']
    for name, expected in manifest['candidateFiles'].items():
        if name.startswith(('src/', 'public/', 'migrations/')):
            assert digest(RELEASE / 'candidate' / name) == expected, name
    for name in ['focused.log', 'full-comparison.json', 'adjacent-comparison.json', 'image-smoke.json',
                 'candidate-artifacts/order-update-save/browser.json']:
        assert (RELEASE / name).stat().st_mtime >= (RELEASE / 'manifest.json').stat().st_mtime, f'Stale release check: {name}'
    for name in ['full-comparison.json', 'adjacent-comparison.json']:
        assert not read(name)['newFailures']
    focused = (RELEASE / 'focused.log').read_text()
    assert 'Isolated Order update focused run passed: 6 file(s), 50 test(s).' in focused
    browser = json.loads((RELEASE / 'candidate-artifacts/order-update-save/browser.json').read_text())
    assert len(browser) == 2 and all(all(save['status'] == 200 for save in row['saves']) for row in browser)
    smoke = read('image-smoke.json')
    assert smoke['passed'] is True and smoke['imageId'] == manifest['imageId']
    return manifest


def ready(expected):
    for _ in range(55):
        rows = inspect(*SERVICES)
        if all(row['Image'] == image and row['State']['Running'] and row['RestartCount'] == 0
               for row, image in zip(rows, expected)) and rows[0]['State'].get('Health', {}).get('Status') == 'healthy':
            return core.health()
        time.sleep(1)
    raise RuntimeError('Deployed services did not become healthy')


def verify():
    manifest = read('manifest.json')
    before, after = read('containers.before.private.json'), inspect(*SERVICES, *DEPENDENCIES)
    for prior, current in zip(before[:2], after[:2]):
        assert current['Image'] == manifest['imageId'] and current['State']['Running'] and current['RestartCount'] == 0
        assert sorted(prior['Config']['Env']) == sorted(current['Config']['Env'])
        assert sorted(prior['Mounts'], key=lambda row: row['Destination']) == sorted(current['Mounts'], key=lambda row: row['Destination'])
        for field in ['Cmd', 'Entrypoint', 'User', 'WorkingDir']:
            assert prior['Config'][field] == current['Config'][field], field
        assert prior['HostConfig']['PortBindings'] == current['HostConfig']['PortBindings']
        assert core.hashes(current['Name']) == manifest['after']
    assert [(row['Id'], row['State']['StartedAt']) for row in before[2:]] == [(row['Id'], row['State']['StartedAt']) for row in after[2:]]
    assets = []
    for route, name in [('/dispatch/planning', 'public/dispatch.html'),
                        ('/dispatch.js?v=20260917-order-update-save-v1', 'public/dispatch.js')]:
        request = urllib.request.Request('http://127.0.0.1:3000' + route, headers={'Cache-Control': 'no-cache'})
        with urllib.request.urlopen(request, timeout=10) as response:
            assert response.status == 200 and hashlib.sha256(response.read()).hexdigest() == manifest['after'][name]
        assets.append({'route': route, 'hashMatched': True})
    for route in ['/api/dispatch/v2/bootstrap', '/api/dispatch/plans/330/revision']:
        try:
            urllib.request.urlopen('http://127.0.0.1:3000' + route, timeout=10)
            raise AssertionError('Unauthenticated Dispatch request succeeded')
        except urllib.error.HTTPError as error:
            assert error.code == 401, (route, error.code)
    live = core.node_read((SERVER / 'tools/order-update-save-live.mjs').read_text())
    return {'health': core.health(), 'assets': assets, 'configurationPreserved': True,
            'dependenciesUnchanged': True, 'readOnlyProductionChecks': live}


def apply():
    manifest = package_gate()
    before = read('containers.before.private.json')
    current = inspect(*SERVICES, *DEPENDENCIES)
    assert [row['Id'] for row in current] == [row['Id'] for row in before], 'Live containers changed'
    assert core.hashes(APP) == manifest['before']
    core.config_gate(before[:2], core.compose(before, 'compose.release.yml'), manifest['imageId'])
    active = preflight()
    assert not any(active.values()), f'Wait for idle cutover: {active}'
    core.health()
    migrate()
    # Recheck immediately before replacing services after the backup/migration.
    active = preflight()
    assert not any(active.values()), f'Wait for idle cutover: {active}'
    started = datetime.datetime.now(datetime.timezone.utc).isoformat()
    command = ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'app', 'webhook-worker']
    try:
        with (RELEASE / 'cutover.log').open('wb') as output:
            subprocess.run(core.compose(before, 'compose.release.yml') + command, cwd=ROOT,
                           stdout=output, stderr=subprocess.STDOUT, check=True, timeout=120)
        ready([manifest['imageId']] * 2)
        result = verify()
        for kind, container in zip(['app', 'worker'], SERVICES):
            logs = run('docker', 'logs', '--since', started, container, stderr=subprocess.STDOUT).decode()
            (RELEASE / f'{kind}-startup.log').write_text(logs)
            assert not re.search(r'SyntaxError|ReferenceError|ERR_MODULE_NOT_FOUND|uncaughtException|Dispatch maintenance (?:sweep )?failed', logs)
            if kind == 'worker':
                assert 'NetSuite order webhook serial worker' in logs and 'started.' in logs
        save('result.json', {'deployed': True, 'startedAt': started, 'readyAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                             'image': IMAGE, 'imageId': manifest['imageId'], 'migration': MIGRATION, **result})
        print(json.dumps({'deployed': True, 'image': IMAGE, **result}), flush=True)
    except Exception:
        with (RELEASE / 'rollback.log').open('wb') as output:
            subprocess.run(core.compose(before, 'compose.rollback.yml') + command, cwd=ROOT,
                           stdout=output, stderr=subprocess.STDOUT, check=True, timeout=120)
        ready(manifest['beforeImages'])
        save('rolled-back.json', {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                                  'queuePreserved': True, 'migrationKept': MIGRATION})
        raise


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['prepare', 'preflight', 'check', 'apply', 'verify'])
    mode = parser.parse_args().mode
    if mode == 'prepare': prepare()
    elif mode == 'preflight': print(json.dumps(preflight()))
    elif mode == 'check': package_gate(); print('Release evidence and source hashes verified.')
    elif mode == 'apply': apply()
    else: print(json.dumps(verify()))
