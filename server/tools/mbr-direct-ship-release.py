"""Deploy the approved MBR and linked direct-ship changes over the live image."""
import difflib
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
REPO = SERVER.parent
OUT = SERVER / 'test-artifacts/mbr-direct-ship-release'
RELEASE = SERVER / 'deployments/mbr-direct-ship-20261013'
MBR = SERVER / 'test-artifacts/mbr-contract'
DIRECT = SERVER / 'test-artifacts/linked-direct-ship-sync'
IMAGE = 'mbbs-operator-app:mbr-direct-ship-20261013'
ROLLBACK_IMAGE = 'mbbs-operator-app:mbr-direct-ship-rollback-20261013'
MIGRATIONS = ['285_mbr_contracts.sql', '286_linked_direct_ship_quantity_sync.sql']
spec = importlib.util.spec_from_file_location('direct_release', SERVER / 'tools/linked-direct-ship-sync-release.py')
direct = importlib.util.module_from_spec(spec)
spec.loader.exec_module(direct)


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + '\n')


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def configuration_without_mbr(name):
    row = json.loads(direct.docker('inspect', name))[0]
    cfg = {key: row['Config'][key] for key in ['Env', 'User', 'Entrypoint', 'Cmd', 'WorkingDir']}
    cfg['Env'] = sorted(value for value in cfg['Env'] if not value.startswith('MBR_CONTRACTS_ENABLED='))
    host = dict(row['HostConfig'])
    host['Binds'] = sorted(host.get('Binds') or [])
    return direct.digest(json.dumps({'config': cfg, 'host': host}, sort_keys=True).encode())


def logged(label, command):
    with (OUT / (label + '.log')).open('wb') as log:
        result = subprocess.run(command, cwd=REPO, stdout=log, stderr=subprocess.STDOUT)
    if result.returncode:
        print((OUT / (label + '.log')).read_text()[-5000:])
    return result.returncode


def compose_command(state, override):
    # Existing rollout files are in root-owned operational backup directories.
    return ['sudo', '-n', *direct.compose(state, override)]


def validated_sources():
    mbr = json.loads((MBR / 'source-state.json').read_text())
    for filename, expected in mbr['files'].items():
        assert sha(SERVER / filename) == expected, 'MBR source changed: ' + filename
    checks = json.loads((DIRECT / 'checks.json').read_text())
    assert all(check['exit'] == 0 for check in checks['checks'].values())
    candidate = json.loads((DIRECT / 'candidate-validation.json').read_text())
    assert candidate['passed'] and candidate['sourceHashes'] == checks['sourceHashes']
    for filename, expected in checks['sourceHashes'].items():
        assert sha(SERVER / filename) == expected, 'Direct-ship source changed: ' + filename
    return mbr, checks


def prepare():
    OUT.mkdir(parents=True, exist_ok=True)
    mbr, checks = validated_sources()
    original = json.loads((direct.RELEASE / 'state.json').read_text())
    for name, key in [(direct.APP, 'app'), (direct.WORKER, 'worker')]:
        assert direct.metadata(name) == original[key], name + ' changed since preparation'
    context = RELEASE / 'context'
    assert not (context / 'Dockerfile').exists(), 'The combined context is already prepared'
    context.mkdir(parents=True, exist_ok=True)
    before = RELEASE / 'before'
    shared = json.loads((MBR / 'baseline/manifest.json').read_text())
    deltas = []
    before_hashes = {}
    for filename in shared:
        relative = Path(filename).relative_to('server')
        live = before / relative
        expected = direct.docker('exec', direct.APP, 'sha256sum', '/app/' + str(relative)).split()[0]
        assert sha(live) == expected, 'Live source changed: ' + str(relative)
        before_hashes[str(relative)] = expected
        baseline = MBR / 'baseline' / filename
        current = SERVER / relative
        if baseline.read_bytes() == current.read_bytes():
            continue
        result = subprocess.run(['git', 'merge-file', '-p', str(live), str(baseline), str(current)], capture_output=True)
        merged = result.stdout
        if result.returncode == 1 and str(relative) == 'src/server.js':
            # The MBR insertion touches a driver parser present only in the MBR
            # snapshot. Preserve the deployed driver's parser setup and insert MBR.
            addition = "const mbrRuntime = createMbrRuntime({ authenticate: requireOperator, config, dataDir });\n" \
                + "// Bound contract inputs before the application-wide large photo parser.\n" \
                + "app.use('/api/mbr', mbrRuntime.router);\n\n"
            conflict = '<<<<<<< ' + str(live) + '\n=======\n' + addition \
                + 'app.use("/api/driver/upload-failures", express.json({ limit: "16kb" }));\n' \
                + '>>>>>>> ' + str(current) + '\n'
            assert merged.count(conflict.encode()) == 1, 'Unexpected server merge conflict'
            merged = merged.replace(conflict.encode(), addition.encode())
            assert b'<<<<<<< ' not in merged and b'>>>>>>> ' not in merged
            save(OUT / 'source-merge.json', {'file': str(relative), 'resolution':
                'Insert the MBR router ahead of the deployed general parser; preserve live driver behavior.'})
        else:
            assert result.returncode == 0, 'MBR merge requires review: ' + str(relative)
        target = context / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(merged)
        deltas.extend(difflib.unified_diff(live.read_text().splitlines(keepends=True),
            target.read_text().splitlines(keepends=True), fromfile='production/' + str(relative), tofile='release/' + str(relative)))
    for filename in mbr['files']:
        if not filename.startswith(('src/mbr/', 'public/mbr/')) and filename != 'migrations/' + MIGRATIONS[0]:
            continue
        target = context / filename
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(SERVER / filename, target)
    for filename in direct.OLD + direct.NEW + ['migrations/' + MIGRATIONS[1]]:
        assert sha(direct.RELEASE / 'context' / filename) == sha(SERVER / filename)
    (context / 'Dockerfile').write_text('FROM ' + direct.IMAGE + '\nCOPY src/ /app/src/\nCOPY public/ /app/public/\nCOPY migrations/ /app/migrations/\n')
    (OUT / 'production-mbr.patch').write_text(''.join(deltas))
    files = {str(path.relative_to(context)): sha(path) for path in sorted(context.rglob('*')) if path.is_file() and path.name != 'Dockerfile'}
    for filename in direct.OLD + direct.NEW + ['migrations/' + MIGRATIONS[1]]:
        files[filename] = sha(SERVER / filename)
    state = {**original, 'sourceHashes': files, 'beforeHashes': before_hashes,
        'mbrSourceState': mbr['sha256'], 'directSourceHashes': checks['sourceHashes'],
        'configurationWithoutMbr': {key: configuration_without_mbr(name)
            for name, key in [(direct.APP, 'app'), (direct.WORKER, 'worker')]}}
    save(RELEASE / 'state.json', state)
    save(RELEASE / 'compose.release.json', {'services': {name: {'image': IMAGE,
        'environment': {'MBR_CONTRACTS_ENABLED': 'true'}} for name in ['app', 'webhook-worker']}})
    # Keep role compatibility when disabling MBR; records and signing keys survive rollback.
    rollback = RELEASE / 'rollback-context'
    (rollback / 'src').mkdir(parents=True)
    shutil.copyfile(context / 'src/auth-repository.js', rollback / 'src/auth-repository.js')
    (rollback / 'Dockerfile').write_text('FROM ' + original['app']['imageRef'] + '\nCOPY src/ /app/src/\n')
    save(RELEASE / 'compose.rollback.json', {'services': {name: {'image': ROLLBACK_IMAGE,
        'environment': {'MBR_CONTRACTS_ENABLED': 'false'}} for name in ['app', 'webhook-worker']}})
    assert logged('candidate-build', ['docker', 'build', '--network=none', '-t', IMAGE, str(context)]) == 0
    assert logged('rollback-build', ['docker', 'build', '--network=none', '-t', ROLLBACK_IMAGE, str(rollback)]) == 0
    image_id = json.loads(direct.docker('image', 'inspect', IMAGE))[0]['Id']
    save(OUT / 'prepared.json', {'image': IMAGE, 'imageId': image_id, 'sourceHashes': files,
        'migrationFiles': MIGRATIONS, 'mbrEnabled': True, 'rollbackImage': ROLLBACK_IMAGE})
    print(json.dumps({'prepared': IMAGE, 'runtimeFiles': len(files), 'mbrEnabled': True}))


def deploy():
    state = json.loads((RELEASE / 'state.json').read_text())
    prepared = json.loads((OUT / 'prepared.json').read_text())
    validated = json.loads((OUT / 'candidate-validation.json').read_text())
    assert validated['passed'] and validated['imageId'] == prepared['imageId']
    assert validated['sourceHashes'] == state['sourceHashes']
    assert json.loads(direct.docker('image', 'inspect', IMAGE))[0]['Id'] == prepared['imageId']
    validated_sources()
    for filename, expected in state['sourceHashes'].items():
        path = RELEASE / 'context' / filename
        if not path.exists():
            path = SERVER / filename
        assert sha(path) == expected, filename + ' changed after validation'
    for name, key in [(direct.APP, 'app'), (direct.WORKER, 'worker')]:
        actual = direct.metadata(name)
        assert actual == state[key] or actual == state.get('activationBaseline', {}).get(key), name + ' changed after preparation'
    read_sql = "SET default_transaction_read_only=on; SELECT COALESCE(json_agg(filename ORDER BY filename),'[]'::json) " \
        + "FROM schema_migrations WHERE filename IN ('285_mbr_contracts.sql','286_linked_direct_ship_quantity_sync.sql');\n"
    registry = direct.docker('exec', '-i', direct.DB, 'sh', '-c',
        'psql -X -t -A -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"', data=read_sql.encode())
    already = json.loads(registry)
    if already:
        assert already == MIGRATIONS, 'Partial migration state requires inspection'
        assert json.loads((OUT / 'migration.json').read_text()) == {'applied': MIGRATIONS, 'transactional': True}
        save(OUT / 'migration-recheck.json', {'registry': already, 'reusedThisReleaseMigration': True})
    else:
        sql = "BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';\n"
        for filename in MIGRATIONS:
            sql += "DO $$ BEGIN IF EXISTS(SELECT 1 FROM schema_migrations WHERE filename='" + filename \
                + "') THEN RAISE EXCEPTION 'Migration already applied; recheck release state'; END IF; END $$;\n"
            sql += (SERVER / 'migrations' / filename).read_text().replace('BEGIN;', '').replace('COMMIT;', '')
            sql += "\nINSERT INTO schema_migrations(filename) VALUES('" + filename + "');\n"
        sql += 'COMMIT;\n'
        result = direct.docker('exec', '-i', direct.DB, 'sh', '-c',
            'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"', data=sql.encode())
        (OUT / 'migration.log').write_text(result + '\n')
        save(OUT / 'migration.json', {'applied': MIGRATIONS, 'transactional': True})
    try:
        assert logged('production-deploy', compose_command(state, RELEASE / 'compose.release.json')
            + ['up', '-d', '--no-deps', '--no-build', 'app', 'webhook-worker']) == 0
        assert direct.healthy(), 'Application health did not recover'
        for name, key in [(direct.APP, 'app'), (direct.WORKER, 'worker')]:
            row = json.loads(direct.docker('inspect', name))[0]
            assert row['Image'] == prepared['imageId'], name + ' image mismatch'
            assert 'MBR_CONTRACTS_ENABLED=true' in row['Config']['Env'], 'MBR flag missing'
            assert configuration_without_mbr(name) == state['configurationWithoutMbr'][key], name + ' configuration changed'
        flags = json.loads(direct.docker('exec', '-w', '/app', direct.APP, 'node', '--input-type=module', '-e',
            "const {config}=await import('./src/config.js');console.log(JSON.stringify({mbr:config.mbr.enabled}));"))
        assert flags['mbr'], 'Selected application environment disables MBR'
    except BaseException:
        logged('production-rollback', compose_command(state, RELEASE / 'compose.rollback.json')
            + ['up', '-d', '--no-deps', '--no-build', 'app', 'webhook-worker'])
        raise
    save(OUT / 'deployment.json', {'image': IMAGE, 'imageId': prepared['imageId'], 'healthy': True,
        'migrations': MIGRATIONS, 'mbrEnabled': True})
    print(json.dumps({'deployed': IMAGE, 'healthy': True, 'mbrEnabled': True}))


if __name__ == '__main__':
    {'prepare': prepare, 'deploy': deploy}[sys.argv[1]]()
