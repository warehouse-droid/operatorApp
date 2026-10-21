"""Deploy the verified BIN planner over the captured production image."""
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('release', SERVER / 'tools/special-workflow-native-deploy.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.RELEASE = SERVER / 'test-artifacts/mbt-bin-planning-release-20260927'
release.IMAGE = 'mbbs-operator-app:mbt-bin-planning-20260927'
release.ROLLBACK = 'mbbs-operator-app:rollback-mbt-bin-planning-20260927'
CAPTURE = json.loads((release.RELEASE / 'capture.json').read_text())
release.FILES = sorted(CAPTURE['files'])
MIGRATION = '235_mbt_bin_planning.sql'
original_verify = release.verify


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def sql(statement):
    return release.docker('exec', '-i', release.DEPENDENCIES[0], 'psql', '-U', 'mbbs_app', '-d', 'mbbs_yard',
                          '-XqAt', '-v', 'ON_ERROR_STOP=1', input=statement.encode()).decode().strip()


def evidence():
    verified = json.loads((SERVER / 'test-artifacts/mbt-bin-planning/final/result.json').read_text())
    assert not verified['unexpected_failures']
    assert verified['source_tree_sha256'] == CAPTURE['verificationTreeHash']
    for file, digest in verified['files'].items():
        assert release.core.digest((SERVER / file).read_bytes()) == digest, 'Verified source changed: ' + file
    return CAPTURE['files']


release.evidence = evidence


def image_hashes(image, files):
    code = """import fs from 'node:fs';import crypto from 'node:crypto';
const files=JSON.parse(fs.readFileSync(0,'utf8'));
console.log(JSON.stringify(Object.fromEntries(files.map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync('/app/'+f)).digest('hex')]))));"""
    return json.loads(release.docker('run', '--rm', '-i', '--network', 'none', '--entrypoint', 'node', image,
                                    '--input-type=module', '-e', code, input=json.dumps(files).encode()))


def prepare():
    assert not (release.RELEASE / 'manifest.json').exists(), 'Preserve the prepared release'
    evidence()
    info = {'files': CAPTURE['files'], 'services': CAPTURE['services'], 'dependencies': CAPTURE['dependencies']}
    release.current(info)
    baseline = release.RELEASE / 'baseline'
    assert release.core.files_at(baseline) == CAPTURE['before']
    candidate = release.RELEASE / 'candidate'
    shutil.copytree(baseline, candidate)
    for file in release.FILES:
        (candidate / file).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SERVER / file, candidate / file)
    info['runtimeFiles'] = release.core.files_at(candidate)
    changed = sorted(f for f in info['runtimeFiles'] if info['runtimeFiles'][f] != CAPTURE['before'].get(f))
    assert changed == release.FILES
    # Tests use the exact candidate runtime while retaining local test tooling.
    for folder in ['test', 'tools', 'contracts']:
        shutil.copytree(SERVER / folder, candidate / folder, dirs_exist_ok=True)
    for file in SERVER.glob('tsconfig*.json'):
        shutil.copy2(file, candidate / file.name)
    stage = release.RELEASE / 'stage'
    for file in release.FILES:
        (stage / file).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(candidate / file, stage / file)
    base = info['services']['app']['imageId']
    assert {row['imageId'] for row in info['services'].values()} == {base}
    release.docker('tag', base, release.ROLLBACK)
    (stage / 'Dockerfile').write_text('FROM ' + release.ROLLBACK + '\n' + ''.join(
        'COPY --chown=node:node ' + file + ' /app/' + file + '\n' for file in release.FILES))
    with (release.RELEASE / 'build.log').open('wb') as output:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--network', 'none', '--pull=false', '-t', release.IMAGE, str(stage)],
                       stdout=output, stderr=subprocess.STDOUT, check=True)
    info['imageId'] = release.docker('image', 'inspect', '--format', '{{.Id}}', release.IMAGE).decode().strip()
    assert image_hashes(info['imageId'], list(info['runtimeFiles'])) == info['runtimeFiles']
    for name, images in [('compose.release.yml', {s: info['imageId'] for s in release.SERVICES}),
                         ('compose.rollback.yml', {s: row['imageId'] for s, row in info['services'].items()})]:
        (release.RELEASE / name).write_text('services:\n' + ''.join(f'  {s}:\n    image: {image}\n' for s, image in images.items()))
    release.save('manifest.json', info)
    release.current(info)
    release.config_gate(info)
    print(json.dumps({'prepared': True, 'imageId': info['imageId'], 'changedFiles': len(changed),
                      'runtimeFilesVerified': len(info['runtimeFiles']), 'configurationPreserved': True}), flush=True)


def preflight():
    counts = json.loads(sql("""BEGIN READ ONLY; SET LOCAL statement_timeout='10s';
SELECT json_build_object(
 'dispatchEditors',(SELECT count(*) FROM dispatch_plan_edit_leases WHERE expires_at>clock_timestamp()),
 'operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),
 'fulfillments',(SELECT count(*) FROM dispatch_sales_order_if_candidates WHERE status='posting'),
 'webhooks',(SELECT count(*) FROM netsuite_order_webhook_inbox WHERE status IN ('running','processing')),
 'specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'),
 'quantityApplying',(SELECT count(*) FROM sales_special_stock_cases WHERE quantity_review->>'status'='applying'),
 'closureApplying',(SELECT count(*) FROM sales_special_stock_cases WHERE to_jsonb(sales_special_stock_cases)->'closure_review'->>'status'='applying'),
 'netSuiteRequests',(SELECT count(*) FROM netsuite_request_queue WHERE expires_at>clock_timestamp())); COMMIT;"""))
    release.save('preflight.json', {'at': now(), **counts})
    print(json.dumps({'preflight': counts}), flush=True)
    return counts


def preview():
    migration = (release.RELEASE / 'candidate/migrations' / MIGRATION).read_text()
    where = migration.split('FROM mbt_service_visits predecessor\n', 1)[1].split('  RETURNING ', 1)[0]
    result = json.loads(sql("BEGIN READ ONLY; SET LOCAL statement_timeout='10s'; SELECT json_build_object('successorsToRelease',count(*)) FROM mbt_service_visits successor, mbt_service_visits predecessor " + where + '; COMMIT;'))
    applied = set(json.loads(sql('SELECT json_agg(filename) FROM schema_migrations;')))
    pending = sorted(set(p.name for p in (release.RELEASE / 'candidate/migrations').glob('*.sql')) - applied)
    assert pending in ([MIGRATION], []), 'Unrelated pending migrations: ' + repr(pending)
    result['pendingMigrations'] = pending
    release.save('migration-preview.json', result)
    print(json.dumps(result), flush=True)


def backup():
    info = release.load()
    release.current(info)
    target = release.RELEASE / 'postgres-before.dump'
    assert not target.exists(), 'Preserve the existing backup'
    with target.open('wb') as output:
        subprocess.run(['sudo', '-n', 'docker', 'exec', release.DEPENDENCIES[0], 'pg_dump', '-U', 'mbbs_app',
                        '-d', 'mbbs_yard', '--format=custom'], stdout=output, check=True)
    with target.open('rb') as source:
        toc = release.docker('exec', '-i', release.DEPENDENCIES[0], 'pg_restore', '--list', stdin=source)
    assert all(name in toc for name in [b'schema_migrations', b'mbt_service_visits', b'dispatch_plan_snapshots'])
    with target.open('rb') as source:
        digest = hashlib.file_digest(source, 'sha256').hexdigest()
    result = {'validated': True, 'createdAt': now(), 'bytes': target.stat().st_size, 'sha256': digest}
    release.save('backup-result.json', result)
    print(json.dumps(result), flush=True)


def migrate(info):
    assert not any(preflight().values()), 'Active work; retry when idle'
    migration = (release.RELEASE / 'candidate/migrations' / MIGRATION).read_text()
    assert release.core.digest(migration.encode()) == info['files']['migrations/' + MIGRATION]
    if sql("SELECT count(*) FROM schema_migrations WHERE filename='" + MIGRATION + "';") == '1':
        return
    preview()
    result = sql("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';\n" + migration +
                 "\nINSERT INTO schema_migrations(filename) VALUES ('" + MIGRATION + "'); COMMIT;")
    (release.RELEASE / 'migration.log').write_text(result)
    released = int(sql("SELECT count(*) FROM mbt_bin_planning_events WHERE actor_id='migration-235';"))
    release.save('migration-result.json', {'migration': MIGRATION, 'applied': True, 'successorsReleased': released, 'at': now()})
    assert not any(preflight().values()), 'Active work after migration; retry cutover when idle'


release.migrate = migrate


def verify():
    original_verify()
    info = release.load()
    assert image_hashes(info['imageId'], list(info['runtimeFiles'])) == info['runtimeFiles']
    assert sql("SELECT count(*) FROM schema_migrations WHERE filename='" + MIGRATION + "';") == '1'
    assert sql("SELECT to_regclass('public.mbt_bin_planning_assignments');") == 'mbt_bin_planning_assignments'
    script = (SERVER / 'tools/bin-planning-live.mjs').read_text().replace('from "../src/', 'from "./src/')
    result = json.loads(release.docker('exec', '-i', '-w', '/app', release.SERVICES['app'], 'node', '--input-type=module', '-', input=script.encode()))
    release.save('live-probe.json', result)
    for service, container in release.SERVICES.items():
        logs = release.docker('logs', '--since', json.loads((release.RELEASE / 'cutover-start.json').read_text())['at'],
                              container, stderr=subprocess.STDOUT).decode()
        (release.RELEASE / ('startup-' + service + '.log')).write_text(logs)
        assert not any(marker in logs for marker in ['SyntaxError', 'ReferenceError', 'ERR_MODULE_NOT_FOUND', 'uncaughtException'])
        if service == 'webhook-worker':
            assert 'serial worker ' in logs and ' started.' in logs
    receipt = json.loads((release.RELEASE / 'deployment-result.json').read_text())
    receipt.update({'at': now(), 'migration': MIGRATION, 'liveProbe': result, 'runtimeFilesVerified': len(info['runtimeFiles'])})
    release.save('deployment-result.json', receipt)
    print(json.dumps({'deployed': True, 'imageId': info['imageId'], 'migration': MIGRATION, **result}), flush=True)


release.verify = verify


def apply():
    info = release.load()
    release.current(info)
    checks = json.loads((release.RELEASE / 'release-checks.json').read_text())
    smoke = json.loads((release.RELEASE / 'release-smoke.json').read_text())
    assert checks['passed'] and smoke['passed'] and smoke['candidateImageId'] == info['imageId']
    backup_info = json.loads((release.RELEASE / 'backup-result.json').read_text())
    assert backup_info['validated'] and (release.RELEASE / 'postgres-before.dump').stat().st_size == backup_info['bytes']
    assert not any(preflight().values()), 'Active work; retry when idle'
    release.save('cutover-start.json', {'at': now()})
    release.apply()


if __name__ == '__main__':
    os.umask(0o077)
    {'prepare': prepare, 'preview': preview, 'backup': backup, 'preflight': preflight, 'apply': apply, 'verify': verify}[sys.argv[1]]()
