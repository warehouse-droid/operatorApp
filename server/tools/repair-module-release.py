#!/usr/bin/env python3
"""Deploy the reviewed Repair module over a captured production image."""
import difflib
import hashlib
import json
import os
import re
import runpy
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

base = runpy.run_path(str(Path(__file__).with_name('bin-selection-release.py')))
scope = base['prepare'].__globals__
SERVER, REPO = base['SERVER'], base['REPO']
OUT = SERVER / 'deployments/repair-module-20261027'
SHARED = ['src/auth-repository.js', 'src/config.js', 'src/server.js', 'src/netsuite.js',
    'src/dispatch-plan-repository.js', 'src/driver-repository.js', 'src/photo-upload.js',
    'src/photo-archive-repository.js', 'public/mbr/domain.js', 'public/staff-login-routes.js',
    'public/login.js', 'public/control.js', 'public/app-sidebar.js', 'public/operator.js',
    'public/operator.html', 'public/service-worker.js', 'public/driver.js',
    'public/driver.html', 'public/driver-service-worker.js']
NEW = sorted(str(p.relative_to(SERVER)) for folder in ['src/repair', 'public/repair']
    for p in (SERVER / folder).iterdir() if p.is_file()) + ['migrations/310_repair.sql']
FILES = SHARED + NEW
scope.update(OUT=OUT, FILES=FILES, IMAGE='mbbs-operator-app:repair-module-20261027',
    ROLLBACK='mbbs-operator-app:repair-module-rollback-20261027')
save, sha, docker, db = [base[key] for key in ['save', 'sha', 'docker', 'db']]


def replace_once(text, old, new):
    assert text.count(old) == 1, 'Release anchor changed: ' + old[:90]
    return text.replace(old, new, 1)


def prepare():
    state = json.loads((OUT / 'capture.json').read_text())
    assert {k: base['metadata'](n) for k, n in base['SERVICES'].items()} == state, 'Live changed; rebase first'
    before, candidate = OUT / 'live-before', OUT / 'candidate'
    shutil.copytree(before, candidate, dirs_exist_ok=True)
    for name in NEW:
        assert not (before / name).exists(), 'Repair is already present: ' + name
    for name in FILES:
        target = candidate / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(SERVER / name, target)

    # Keep unrelated live imports/comments and the pending Estimate PDF work.
    name = 'src/server.js'
    text = (before / name).read_text()
    text = replace_once(text, 'import { createMbrRuntime } from "./mbr/runtime.js";',
        'import { createMbrRuntime } from "./mbr/runtime.js";\nimport { createRepairRuntime } from "./repair/runtime.js";')
    anchor = 'const mbrRuntime = createMbrRuntime({ authenticate: requireOperator, config, dataDir });'
    text = replace_once(text, anchor, anchor + "\nconst repairRuntime = createRepairRuntime({authenticate:requireOperator,authenticateDriver:requireDriver,config,dataDir});\napp.use('/api/repair',repairRuntime.router);")
    text = replace_once(text, 'app.use(express.static(publicDir));',
        "app.use(express.static(publicDir));\napp.get(['/repair','/repair/','/repair/workshop','/repair/office'],(_req,res)=>res.sendFile(path.join(publicDir,'repair/index.html')));\napp.get('/repair/quote',(_req,res)=>res.sendFile(path.join(publicDir,'repair/quote.html')));")
    anchor = '    let ref = String(req.query.ref || req.query.key || "");'
    text = replace_once(text, anchor, anchor + "\n    if (normalizeR2Key(ref).startsWith('repair/')) return res.status(403).json({error:'Open Repair evidence through its authorized attachment download.'});")
    text = replace_once(text, '    mbrRuntime.start();', '    mbrRuntime.start();\n    repairRuntime.start();')
    (candidate / name).write_text(text)
    name = 'src/netsuite.js'
    source = (SERVER / name).read_text()
    addition = source[source.index('export async function repairNetSuiteRecord('):source.index('export async function transformSalesOrderToItemFulfillment(')]
    text = replace_once((before / name).read_text(), 'export async function transformSalesOrderToItemFulfillment(', addition + 'export async function transformSalesOrderToItemFulfillment(')
    (candidate / name).write_text(text)

    # Preserve recent Operator cache keys and publish the Repair history entry.
    html = (before / 'public/operator.html').read_text()
    asset = re.search(r'(?<=src=")/operator\.js\?[^" ]+', html).group()
    new_asset = asset + '&repair=20261027'
    (candidate / 'public/operator.html').write_text(replace_once(html, asset, new_asset))
    worker = (before / 'public/service-worker.js').read_text()
    worker, count = re.subn(r'const CACHE_NAME = "[^"]+";', 'const CACHE_NAME = "mbbs-yard-operator-20261027-repair";', worker)
    assert count == 1
    worker, count = re.subn(r'/operator\.js\?[^" ]+', lambda _: new_asset, worker)
    assert count == 1
    anchor = '  if (url.pathname === "/mbr" || url.pathname.startsWith("/mbr/")) return;'
    worker = replace_once(worker, anchor, anchor + '\n  if (url.pathname === "/repair" || url.pathname.startsWith("/repair/")) return;')
    (candidate / 'public/service-worker.js').write_text(worker)

    patch = []
    for name in FILES:
        old = (before / name).read_text() if (before / name).exists() else ''
        patch.extend(difflib.unified_diff(old.splitlines(True), (candidate / name).read_text().splitlines(True), fromfile='live/' + name, tofile='candidate/' + name))
    (OUT / 'release.patch').write_text(''.join(patch))
    changed = {str(p.relative_to(candidate)) for p in candidate.rglob('*') if p.is_file()
        and (not (before / p.relative_to(candidate)).exists() or sha(p) != sha(before / p.relative_to(candidate)))}
    assert changed == set(FILES), changed.symmetric_difference(FILES)
    assert all(sha(candidate / name) == sha(before / name) for name in ['package.json', 'package-lock.json'])
    save(OUT / 'prepared.json', {'baseImage': state['app']['imageRef'], 'conflicts': [],
        'sourceHashes': {name: sha(candidate / name) for name in FILES},
        'workspaceHashes': {name: sha(SERVER / name) for name in FILES}})
    print(json.dumps({'prepared': True, 'files': len(FILES), 'baseImage': state['app']['imageRef']}))


def validate():
    if not os.environ.get('MBBS_TEST_ARTIFACT_DIR'):
        subprocess.run(['sudo', '-n', 'python3', str(REPO / 'docker/retention/retention.py'),
            'run', '--root', '/tmp', '--', sys.executable, __file__, 'validate'], check=True)
        return
    prepared = base['ensure_sources']()
    artifact = Path(os.environ['MBBS_TEST_ARTIFACT_DIR'])
    log = artifact / 'repair-release.log'
    environment = dict(os.environ, REPAIR_TEST_RUNTIME=str(OUT / 'candidate'), REPAIR_TEST_DIFF=str(OUT / 'release.patch'))
    with log.open('w') as output:
        result = subprocess.run(['bash', 'docker/run-repair-tests.sh', '--source', 'node', 'tools/repair-gauntlet.mjs'],
            cwd=REPO, env=environment, stdout=output, stderr=subprocess.STDOUT)
    output = log.read_text()
    summaries = []
    for line in output.splitlines():
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if isinstance(value, dict):
            summaries.append(value)
            print(json.dumps(value), flush=True)
    if result.returncode:
        print(output[-16000:])
    assert result.returncode == 0, 'Repair release gauntlet failed'
    assert base['ensure_sources']() == prepared
    assert 'Repair gauntlet complete.' in output
    save(OUT / 'validation.json', {'passed': True, 'sourceHashes': prepared['sourceHashes'],
        'checks': summaries, 'runner': 'docker/run-repair-tests.sh --source', 'cleanupVerified': True})


def build():
    base['build']()
    save(OUT / 'compose.release.json', {'services': {'app': {'image': scope['IMAGE'],
        'environment': {'REPAIR_ENABLED': 'true', 'REPAIR_NETSUITE_POSTING_ENABLED': 'false'}}}})


def backup():
    target = OUT / 'operators-and-migrations-before.dump'
    if not target.exists():
        with target.open('xb') as output:
            target.chmod(0o600)
            subprocess.run(['sudo', '-n', 'docker', 'exec', base['SERVICES']['db'], 'sh', '-c',
                'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -t public.operators -t public.schema_migrations'],
                check=True, stdout=output)
    assert target.stat().st_size > 0
    listing = docker('exec', '-i', base['SERVICES']['db'], 'pg_restore', '--list', data=target.read_bytes())
    assert 'TABLE DATA public operators' in listing and 'TABLE DATA public schema_migrations' in listing
    constraints = db("SELECT json_agg(json_build_object('name',conname,'definition',pg_get_constraintdef(oid))) FROM pg_constraint WHERE conrelid='operators'::regclass AND contype='c';")
    save(OUT / 'database-backup-audit.json', {'file': target.name, 'sha256': sha(target),
        'restoreListingVerified': True, 'constraints': json.loads(constraints),
        'rollbackPolicy': 'Restore the previous application image; retain additive Repair tables and history.'})
    print(json.dumps({'databaseBackupVerified': True}))


def migrate():
    name = '310_repair.sql'
    assert not db("SELECT filename FROM schema_migrations WHERE filename='310_repair.sql';"), 'Migration already applied; inspect its audit before retrying'
    sql = (OUT / 'candidate/migrations' / name).read_text()
    db("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s';\n" + sql +
        "\nINSERT INTO schema_migrations(filename) VALUES ('310_repair.sql'); COMMIT;")
    result = {'filename': name, 'applied': True, 'sha256': sha(OUT / 'candidate/migrations' / name)}
    save(OUT / 'migration-audit.json', result)
    return result


def fetch(origin, path):
    request = urllib.request.Request(origin + path, headers={'User-Agent': 'Mozilla/5.0', 'Cache-Control': 'no-cache'})
    try:
        response = urllib.request.urlopen(request, timeout=20)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        return response.status, response.read()


def verify():
    prepared = base['ensure_sources']()
    for name, expected in prepared['sourceHashes'].items():
        assert docker('exec', base['APP'], 'sha256sum', '/app/' + name).split()[0] == expected, name
    assert base['health']()
    checks = []
    for origin in ['http://127.0.0.1:3000', 'https://test.mbbsoperation.com']:
        for path, expected in [('/health', 200), ('/repair/', 200), ('/repair/workshop', 200),
            ('/repair/office', 200), ('/repair/quote', 200), ('/api/repair/availability', 200),
            ('/api/repair/jobs', 401), ('/api/repair/settings', 401), ('/api/repair/public/quote', 404)]:
            status, content = fetch(origin, path)
            assert status == expected, (origin + path, status, expected)
            if path == '/api/repair/availability':
                assert json.loads(content) == {'enabled': True}
            elif path.startswith('/repair/'):
                assert b'id="repairApp"' in content or b'id="quoteApp"' in content
            checks.append({'url': origin + path, 'status': status})
        for name in NEW:
            if not name.startswith('public/repair/') or name.endswith('.html'):
                continue
            status, content = fetch(origin, '/' + name.removeprefix('public/'))
            assert status == 200 and hashlib.sha256(content).hexdigest() == prepared['sourceHashes'][name], name
    flags = json.loads(docker('exec', base['APP'], 'node', '--input-type=module', '-e',
        "import {config} from './src/config.js';console.log(JSON.stringify(config.repair));"))
    assert flags == {'enabled': True, 'postingEnabled': False}, flags
    assert db("SELECT data->>'postingEnabled' FROM repair_settings;") == 'false'
    assert db("SELECT filename FROM schema_migrations WHERE filename='310_repair.sql';") == '310_repair.sql'
    save(OUT / 'live-verification.json', {'sourceHashesVerified': True, 'flags': flags,
        'adminPostingEnabled': False, 'healthy': True, 'http': checks})
    print(json.dumps({'liveVerification': 'passed', 'files': len(FILES), 'httpChecks': len(checks), 'flags': flags}))


def normalized_config():
    row = json.loads(docker('inspect', base['APP']))[0]
    config = {key: row['Config'][key] for key in ['Env', 'User', 'Entrypoint', 'Cmd', 'WorkingDir']}
    config['Env'] = sorted(value for value in config['Env'] if not value.startswith(('REPAIR_ENABLED=', 'REPAIR_NETSUITE_POSTING_ENABLED=')))
    host = row['HostConfig']
    host['Binds'] = sorted(host.get('Binds') or [])
    return hashlib.sha256(json.dumps({'config': config, 'host': host}, sort_keys=True).encode()).hexdigest()


def deploy():
    prepared = base['ensure_sources']()
    state, built, validation = [json.loads((OUT / name).read_text()) for name in ['capture.json', 'built.json', 'validation.json']]
    assert validation['passed'] and validation['sourceHashes'] == prepared['sourceHashes'] == built['sourceHashes']
    assert {k: base['metadata'](n) for k, n in base['SERVICES'].items()} == state, 'Live services changed before release'
    assert json.loads(docker('image', 'inspect', scope['IMAGE']))[0]['Id'] == built['imageId']
    active = json.loads(db("""SELECT json_build_object(
      'operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),
      'driverExecuting',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing'),
      'specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'),
      'stockTransferConfirming',(SELECT count(*) FROM sales_stock_transfers WHERE confirmation_status IN ('creating','approving','hydrating','printing')),
      'regularExecuting',(SELECT count(*) FROM regular_stock_handoffs WHERE status='executing'),
      'deliveryOperations',(SELECT count(*) FROM regular_stock_delivery_operations WHERE status IN ('queued','running')),
      'scmExecuting',(SELECT count(*) FROM scm_smart_proposals WHERE status='executing'))"""))
    save(OUT / 'active-before-release.json', active)
    assert not any(active.values()), 'Wait for active operations: ' + json.dumps(active)
    previous_config = normalized_config()
    backup()
    migration = migrate()
    try:
        assert base['metadata'](base['APP']) == state['app'], 'Live changed during migration'
        result = subprocess.run(base['compose'](state, OUT / 'compose.release.json'), capture_output=True, text=True)
        (OUT / 'deployment-audit.log').write_text(result.stdout + result.stderr)
        assert result.returncode == 0, (result.stdout + result.stderr)[-4000:]
        assert base['health'](), 'Application health did not recover'
        assert base['metadata'](base['APP'])['imageId'] == built['imageId']
        assert normalized_config() == previous_config, 'Unexpected configuration change'
        for key, name in base['SERVICES'].items():
            if key != 'app':
                assert base['metadata'](name) == state[key], 'Other service changed: ' + key
        verify()
    except BaseException:
        if base['metadata'](base['APP'])['imageId'] == built['imageId']:
            result = subprocess.run(base['compose'](state, OUT / 'compose.rollback.json'), capture_output=True, text=True)
            (OUT / 'rollback-audit.log').write_text(result.stdout + result.stderr)
            assert result.returncode == 0 and base['health'](), 'Rollback failed'
        raise
    save(OUT / 'deployment.json', {'deployedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'image': scope['IMAGE'], 'imageId': built['imageId'], 'healthy': True,
        'otherConfigurationPreserved': True, 'otherServicesPreserved': True, 'migration': migration,
        'repairEnabled': True, 'netSuitePostingEnabled': False})
    print(json.dumps({'deployed': scope['IMAGE'], 'healthy': True, 'repairEnabled': True}))


if __name__ == '__main__':
    {'prepare': prepare, 'validate': validate, 'build': build, 'deploy': deploy, 'verify': verify}[sys.argv[1]]()
