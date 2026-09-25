"""Scoped Field Sales release over the captured live app; preserves other services."""
import argparse
import datetime
import difflib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import time

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
RELEASE = SERVER / 'test-artifacts/field-sales/deployment'
APP = 'mbbs-operator-app-app-1'
DB = 'mbbs-operator-app-db-1'
DEPENDENCIES = ['mbbs-operator-app-webhook-worker-1', DB, 'mbbs-operator-app-ollama-1']
IMAGE = 'mbbs-operator-app:field-sales-20260918-v1'
ROLLBACK = 'mbbs-operator-app:rollback-field-sales-20260918-v1'
MIGRATION = '210_field_sales.sql'
SHARED = ['src/auth-repository.js', 'src/netsuite.js', 'src/server.js', 'public/app-sidebar.js',
          'public/control.js', 'public/dispatch-auth.js', 'public/service-worker.js']
ADDED = sorted(str(p.relative_to(SERVER)) for folder in ['src/field-sales', 'public/field-sales']
               for p in (SERVER / folder).rglob('*') if p.is_file()) + ['migrations/' + MIGRATION, 'netsuite-field-sales-restlet.js']
FILES = sorted(SHARED + ADDED + ['package.json', 'package-lock.json'])
spec = importlib.util.spec_from_file_location('field_sales_release_core', SERVER / 'tools/operator-display-settings-deploy.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.RELEASE, core.APP, core.DEPENDENCIES = RELEASE, APP, DEPENDENCIES
core.IMAGE, core.ROLLBACK, core.MIGRATION = IMAGE, ROLLBACK, MIGRATION
core.FILES, core.EXISTING, core.ADDED = FILES, SHARED + ['package.json', 'package-lock.json'], ADDED
docker, save = core.docker, core.save


def read(name):
    return json.loads((RELEASE / name).read_text())


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source_gate():
    report = json.loads((SERVER / 'test-artifacts/field-sales/final/checks.json').read_text())
    assert report['passed'] and all(r['passed'] for r in report['results'])
    sha = hashlib.sha256()
    for name in report['sourceFiles']:
        sha.update((name + '\0').encode())
        sha.update((SERVER / name).read_bytes())
    assert sha.hexdigest() == report['sourceSha256'], 'Verified implementation changed'
    return sha.hexdigest()


def capture():
    source_gate()
    RELEASE.mkdir(parents=True, exist_ok=True)
    assert not (RELEASE / 'containers.before.private.json').exists(), 'Release capture already exists'
    rows = json.loads(docker('inspect', APP, *DEPENDENCIES))
    save('containers.before.private.json', rows)
    baseline = RELEASE / 'baseline'
    baseline.mkdir()
    for name in ['src', 'public', 'migrations', 'package.json', 'package-lock.json']:
        docker('cp', APP + ':/app/' + name, str(baseline / name))
    assert json.loads(docker('inspect', APP))[0]['Id'] == rows[0]['Id'], 'Application changed during capture'
    print(json.dumps({'captured': rows[0]['Image']}), flush=True)


def without_field_sales(name, text):
    """Recover only this task's additive patch from the verified shared files."""
    if name == 'src/netsuite.js':
        start = text.index('export async function callFieldSalesRestlet(')
        end = text.index('async function configuredRestletJson(', start)
        return text[:start] + text[end:]
    if name == 'src/server.js':
        branch = '  } else if (req.path === "/field-sales" || req.path.startsWith("/field-sales/")) {\n    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");\n'
        assert text.count(branch) == 1
        text = text.replace(branch, '')
    lines = text.splitlines(keepends=True)
    removed = [line for line in lines if any(word in line for word in ['field_sales', 'field-sales', 'fieldSalesRuntime', 'createFieldSalesRuntime'])]
    expected = {'src/auth-repository.js': 2, 'src/server.js': 5, 'public/app-sidebar.js': 1,
                'public/control.js': 1, 'public/dispatch-auth.js': 1, 'public/service-worker.js': 1}
    assert len(removed) == expected[name], (name, removed)
    return ''.join(line for line in lines if line not in removed)


def prepare():
    source_hash = source_gate()
    assert not (RELEASE / 'manifest.json').exists(), 'Already prepared'
    captured = read('containers.before.private.json')
    actual = json.loads(docker('inspect', APP, *DEPENDENCIES))
    assert [r['Id'] for r in actual] == [r['Id'] for r in captured], 'Live services changed since capture'
    state = {'app': core.metadata(APP), 'dependencies': [core.metadata(n) for n in DEPENDENCIES]}
    baseline, candidate = RELEASE / 'baseline', RELEASE / 'candidate'
    shutil.copytree(baseline, candidate)
    patch = ''
    for name in SHARED:
        new = (SERVER / name).read_text()
        old = without_field_sales(name, new)
        patch += ''.join(difflib.unified_diff(old.splitlines(True), new.splitlines(True), fromfile='a/' + name, tofile='b/' + name))
    (RELEASE / 'release.patch').write_text(patch)
    result = subprocess.run(['patch', '--batch', '--fuzz=0', '--no-backup-if-mismatch', '-p1', '-d', str(candidate)], input=patch, text=True, capture_output=True)
    (RELEASE / 'patch.log').write_text(result.stdout + result.stderr)
    assert result.returncode == 0, 'Review release.patch and patch.log'
    for name in ADDED:
        assert not (baseline / name).exists(), 'Module already present: ' + name
        (candidate / name).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SERVER / name, candidate / name)
    package = json.loads((baseline / 'package.json').read_text())
    package['dependencies']['pdfkit'] = '0.20.2'
    package['dependencies'] = dict(sorted(package['dependencies'].items()))
    (candidate / 'package.json').write_text(json.dumps(package, indent=2) + '\n')
    before_lock = json.loads((baseline / 'package-lock.json').read_text())
    after_lock = json.loads((SERVER / 'package-lock.json').read_text())
    for name, prior in before_lock['packages'].items():
        if not name:
            expected = {**prior, 'dependencies': package['dependencies']}
            assert after_lock['packages'][name] == expected, 'Unexpected root lock change'
        else:
            current = after_lock['packages'].get(name)
            assert current is not None, 'Existing dependency removed: ' + name
            assert {k: v for k, v in prior.items() if k not in ['dev', 'optional']} == {k: v for k, v in current.items() if k not in ['dev', 'optional']}, 'Existing dependency changed: ' + name
    shutil.copy2(SERVER / 'package-lock.json', candidate / 'package-lock.json')
    before = {name: digest(baseline / name) if (baseline / name).exists() else None for name in FILES}
    after = {name: digest(candidate / name) for name in FILES}
    assert all(before[name] != after[name] for name in FILES)
    unrelated_changes = []
    differences = []
    for folder in ['src', 'public', 'migrations']:
        for path in (candidate / folder).rglob('*'):
            if not path.is_file():
                continue
            name = str(path.relative_to(candidate))
            if name not in FILES and digest(path) != digest(baseline / name):
                unrelated_changes.append(name)
            if (SERVER / name).exists() and digest(path) != digest(SERVER / name):
                differences.append(name)
    assert not unrelated_changes, unrelated_changes
    state.update({'sourceSha256': source_hash, 'image': IMAGE, 'before': before, 'after': after,
                  'workspace': {name: digest(SERVER / name) for name in FILES}, 'changedFiles': FILES,
                  'preservedLiveDifferencesFromWorkspace': differences})
    stage = RELEASE / 'stage'
    for name in FILES:
        (stage / name).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(candidate / name, stage / name)
    (stage / 'Dockerfile').write_text('FROM ' + ROLLBACK + '\nUSER root\nCOPY package.json package-lock.json /app/\nRUN npm ci --omit=dev && npm cache clean --force\n' +
        ''.join('COPY --chown=node:node ' + name + ' /app/' + name + '\n' for name in FILES if name not in ['package.json', 'package-lock.json']) + 'USER node\n')
    (RELEASE / 'compose.release.yml').write_text('services:\n  app:\n    image: ' + IMAGE + '\n')
    (RELEASE / 'compose.rollback.yml').write_text('services:\n  app:\n    image: ' + state['app']['imageId'] + '\n')
    save('manifest.json', state)
    print(json.dumps({'prepared': True, 'files': len(FILES), 'preservedLiveDifferences': differences}), flush=True)


def build():
    state = core.manifest()
    core.current(state)
    docker('tag', state['app']['imageId'], ROLLBACK)
    # The live image has accumulated enough overlay layers to exceed BuildKit's
    # mount option limit. Export/import its exact filesystem, retaining image
    # settings explicitly; production containers and their volumes are untouched.
    flattened = IMAGE + '-base'
    if not (RELEASE / 'flattened-base.json').exists():
        config = json.loads(docker('image', 'inspect', state['app']['imageId']))[0]['Config']
        container = docker('create', '--network', 'none', '--entrypoint', 'true', state['app']['imageId']).decode().strip()
        archive = RELEASE / 'base-filesystem.tar'
        try:
            with archive.open('wb') as output:
                subprocess.run(['sudo', '-n', 'docker', 'export', container], stdout=output, check=True)
        finally:
            docker('rm', container)
        changes = ['--change', 'USER ' + config['User'], '--change', 'WORKDIR ' + config['WorkingDir'],
                   '--change', 'ENTRYPOINT ' + json.dumps(config['Entrypoint']), '--change', 'CMD ' + json.dumps(config['Cmd'])]
        for value in config['Env']:
            key, val = value.split('=', 1)
            changes.extend(['--change', 'ENV ' + key + '=' + json.dumps(val)])
        for port in config.get('ExposedPorts', {}):
            changes.extend(['--change', 'EXPOSE ' + port])
        flat_id = docker('import', *changes, str(archive), flattened).decode().strip()
        expected = {**core.files_at(RELEASE / 'baseline'), **{name: digest(RELEASE / 'baseline' / name) for name in ['package.json', 'package-lock.json']}}
        actual = docker('run', '--rm', '--network', 'none', '--entrypoint', 'sha256sum', flattened, *['/app/' + name for name in expected]).decode().splitlines()
        assert {line.split()[1].removeprefix('/app/'): line.split()[0] for line in actual} == expected
        save('flattened-base.json', {'parent': state['app']['imageId'], 'imageId': flat_id, 'verifiedFiles': len(expected), 'archiveSha256': digest(archive)})
        archive.unlink()
    stage = RELEASE / 'stage'
    (stage / 'Dockerfile').write_text('FROM ' + flattened + '\nUSER root\nCOPY package.json package-lock.json /app/\nRUN npm ci --omit=dev && npm cache clean --force\n' +
        ''.join('COPY --chown=node:node ' + name + ' /app/' + name + '\n' for name in FILES if name not in ['package.json', 'package-lock.json']) +
        'USER node\nHEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch(\'http://127.0.0.1:3000/health\').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"\n')
    if (RELEASE / 'build.log').exists() and not (RELEASE / 'build-first-attempt.log').exists():
        shutil.copy2(RELEASE / 'build.log', RELEASE / 'build-first-attempt.log')
    with (RELEASE / 'build.log').open('wb') as output:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--pull=false', '-t', IMAGE, str(RELEASE / 'stage')], stdout=output, stderr=subprocess.STDOUT, check=True)
    state['candidateImageId'] = docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    actual = docker('run', '--rm', '--network', 'none', '--entrypoint', 'sha256sum', IMAGE, *['/app/' + name for name in FILES]).decode().splitlines()
    assert {line.split()[1].removeprefix('/app/'): line.split()[0] for line in actual} == state['after']
    save('manifest.json', state)
    print(json.dumps({'built': IMAGE, 'imageId': state['candidateImageId'], 'verifiedFiles': len(FILES)}), flush=True)


def database(sql):
    return core.database(sql)


def preflight():
    state = core.manifest()
    core.current(state)
    result = json.loads(database("SELECT json_build_object('operatorPostings',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing')),'webhooks',(SELECT count(*) FROM netsuite_order_webhook_inbox WHERE status='running'),'dispatchEditors',(SELECT count(*) FROM dispatch_plan_edit_leases WHERE expires_at>clock_timestamp()),'fulfillments',(SELECT count(*) FROM dispatch_sales_order_if_candidates WHERE status='posting'));"))
    save('preflight.json', result)
    print(json.dumps(result), flush=True)
    return result


def config_gate(state):
    resolved = json.loads(subprocess.check_output(core.compose(state, 'compose.release.yml') + ['config', '--format', 'json'], cwd=ROOT))['services']['app']
    image = json.loads(docker('image', 'inspect', IMAGE))[0]['Config']
    runtime = json.loads(docker('inspect', APP))[0]['Config']
    expected = dict(entry.split('=', 1) for entry in image['Env'])
    expected.update({key: str(value) for key, value in resolved.get('environment', {}).items()})
    assert expected == dict(entry.split('=', 1) for entry in runtime['Env']), 'Environment would change'
    for field, option in [('Cmd', 'command'), ('Entrypoint', 'entrypoint'), ('User', 'user'), ('WorkingDir', 'working_dir')]:
        assert (image.get(field) if resolved.get(option) is None else resolved[option]) == runtime.get(field), field


def backup_and_migrate():
    backup = RELEASE / 'database-before.dump'
    with backup.open('wb') as output:
        subprocess.run(['sudo', '-n', 'docker', 'exec', DB, 'pg_dump', '-U', 'mbbs_app', '-d', 'mbbs_yard', '--format=custom'], stdout=output, check=True)
    with backup.open('rb') as source:
        toc = docker('exec', '-i', DB, 'pg_restore', '--list', stdin=source)
    assert b'schema_migrations' in toc and b'operators' in toc
    (RELEASE / 'database-before.dump.toc').write_bytes(toc)
    save('backup.json', {'bytes': backup.stat().st_size, 'sha256': digest(backup), 'validated': True})
    if database("SELECT count(*) FROM schema_migrations WHERE filename='" + MIGRATION + "';").strip() == '0':
        assert not database("SELECT to_regclass('public.field_sales_settings');").strip(), 'Untracked module tables exist'
        sql = (RELEASE / 'candidate/migrations' / MIGRATION).read_text()
        output = database("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='45s';\n" + sql + "\nINSERT INTO schema_migrations(filename) VALUES ('" + MIGRATION + "'); COMMIT;")
        (RELEASE / 'migration.log').write_text(output)


def verify():
    state = core.manifest()
    core.ready(state['candidateImageId'])
    current = core.metadata(APP)
    assert current['configuration'] == state['app']['configuration'], 'Service configuration changed'
    assert [core.metadata(n) for n in DEPENDENCIES] == state['dependencies'], 'Another service changed'
    actual = docker('exec', APP, 'sha256sum', *['/app/' + name for name in FILES]).decode().splitlines()
    assert {line.split()[1].removeprefix('/app/'): line.split()[0] for line in actual} == state['after']
    assert database("SELECT count(*) FROM schema_migrations WHERE filename='" + MIGRATION + "';").strip() == '1'
    http = json.loads(docker('exec', '-i', APP, 'node', '--input-type=module', input=(SERVER / 'tools/field-sales-live.mjs').read_bytes()))
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'image': IMAGE, 'imageId': current['imageId'], 'configurationPreserved': True,
              'otherServicesUnchanged': True, 'runtimeFilesVerified': len(FILES), **http}
    save('deployment-result.json', result)
    print(json.dumps(result), flush=True)
    return result


def apply():
    source_gate()
    state = core.manifest()
    core.current(state)
    verified = read('candidate-checks.json')
    assert verified['passed'] and verified['imageId'] == state['candidateImageId']
    assert docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip() == state['candidateImageId']
    config_gate(state)
    assert not any(preflight().values()), 'Wait for an idle cutover'
    backup_and_migrate()
    core.current(state)
    assert not any(preflight().values()), 'Activity began during backup; retry cutover when idle'
    command = ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app']
    print(json.dumps({'cutoverStarted': datetime.datetime.now(datetime.timezone.utc).isoformat()}), flush=True)
    try:
        with (RELEASE / 'cutover.log').open('wb') as output:
            subprocess.run(core.compose(state, 'compose.release.yml') + command, cwd=ROOT, stdout=output, stderr=subprocess.STDOUT, check=True, timeout=100)
        verify()
    except Exception:
        with (RELEASE / 'rollback.log').open('wb') as output:
            subprocess.run(core.compose(state, 'compose.rollback.yml') + command, cwd=ROOT, stdout=output, stderr=subprocess.STDOUT, check=True, timeout=100)
        core.ready(state['app']['imageId'])
        save('rolled-back.json', {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'migrationRetained': True})
        raise


def activate():
    state = core.manifest()
    assert core.metadata(APP)['imageId'] == state['candidateImageId']
    result = json.loads(docker('exec', '-i', '-e', 'FIELD_SALES_RELEASE_ACTIVATION=1', APP, 'node', '--input-type=module', input=(SERVER / 'tools/field-sales-activate.mjs').read_bytes()))
    save('activation.json', result)
    print(json.dumps(result), flush=True)


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['capture', 'prepare', 'build', 'preflight', 'apply', 'activate', 'verify'])
    globals()[parser.parse_args().action]()
