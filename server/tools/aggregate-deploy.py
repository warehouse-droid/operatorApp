"""Deploy the verified Aggregate module over the active application image."""
import datetime
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
RELEASE = SERVER / 'test-artifacts/aggregate-deployment-20260922'
CHECKS = SERVER / 'test-artifacts/aggregate-validation'
IMAGE = 'mbbs-operator-app:aggregate-requests-20260922-v1'
ROLLBACK = 'mbbs-operator-app:rollback-aggregate-requests-20260922-v1'
MIGRATION = '215_aggregate_requests.sql'
VERSION = '20260922-aggregate-v1'
EXISTING = ['src/server.js', 'public/app-sidebar.js', 'public/dispatch-auth.js',
            'public/operator.js', 'public/operator.html', 'public/service-worker.js',
            'public/scm-stock-requests.html', 'public/scm-stock-requests.js', 'public/scm-special-stock-requests.js']
ADDED = ['src/aggregate-request-domain.js', 'src/aggregate-request-repository.js', 'src/aggregate-request-router.js',
         'public/aggregate-requests.html', 'public/aggregate-requests.css', 'public/aggregate-requests.js',
         'public/scm-stock-request-tabs.js', 'migrations/' + MIGRATION]
FILES = sorted(EXISTING + ADDED)
spec = importlib.util.spec_from_file_location('aggregate_release_core', SERVER / 'tools/operator-display-settings-deploy.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
for key in ['RELEASE', 'IMAGE', 'ROLLBACK', 'EXISTING', 'ADDED', 'FILES', 'MIGRATION']:
    setattr(core, key, globals()[key])
core.BEFORE = Path('/tmp/aggregate-requests-baseline/server')
APP, DEPENDENCIES = core.APP, core.DEPENDENCIES
docker, save = core.docker, core.save


def source_gate():
    source = json.loads((CHECKS / 'aggregate-source.json').read_text())
    for name, sha in source['files'].items():
        assert core.digest((SERVER / name).read_bytes()) == sha, 'Verified source changed: ' + name
    assert json.loads((CHECKS / 'full-regression.json').read_text())['newFailures'] == []
    assert all(row['killed'] for row in json.loads((CHECKS / 'aggregate-mutations/results.json').read_text()))
    assert '# pass 36\n# fail 0' in (CHECKS / 'tests.log').read_text()
    return source['sourceHash']


def shell_assets(file, text):
    for asset in ['operator-delivery-refresh.js', 'operator.js']:
        text, count = re.subn(r'/' + re.escape(asset) + r'\?v=[^"\s]+', '/' + asset + '?v=' + VERSION, text)
        assert count == 1, 'Unexpected shell asset: ' + asset
    if file.endswith('service-worker.js'):
        text, count = re.subn(r'const CACHE_NAME = "[^"]+";', 'const CACHE_NAME = "mbbs-yard-operator-' + VERSION + '";', text)
        assert count == 1
    return text


core.shell_assets = shell_assets
original_compose = core.compose


def compose(state, override):
    return original_compose(state, override) + ['--env-file', str(ROOT / 'docker/env/.env')]


core.compose = compose


def prepare():
    source_gate()
    core.prepare()
    candidate = RELEASE / 'candidate'
    for name in ['test', 'tools']:
        (candidate / name).symlink_to(SERVER / name, target_is_directory=True)
    state = core.manifest()
    state['implementationSourceHash'] = source_gate()
    state['preservedLiveDifferences'] = [name for name in FILES if state['after'][name] != state['workspace'][name]]
    save('manifest.json', state)


def build():
    source_gate()
    state = core.manifest()
    core.current(state)
    docker('tag', state['app']['imageId'], ROLLBACK)
    overlay = RELEASE / 'build-context/overlay'
    for name in FILES:
        target = overlay / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(RELEASE / 'candidate' / name, target)
    (overlay.parent / 'Dockerfile').write_text('FROM ' + ROLLBACK + '\nCOPY --chown=node:node overlay/ /app/\n')
    with (RELEASE / 'build.log').open('wb') as output:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--network', 'none', '--pull=false', '-t', IMAGE, str(overlay.parent)],
                       stdout=output, stderr=subprocess.STDOUT, check=True)
    state['candidateImageId'] = docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    actual = docker('run', '--rm', '--network', 'none', '--entrypoint', 'sha256sum', IMAGE,
                    *['/app/' + name for name in FILES]).decode().splitlines()
    assert {line.split()[1].removeprefix('/app/'): line.split()[0] for line in actual} == state['after']
    save('manifest.json', state)
    print(json.dumps({'built': IMAGE, 'imageId': state['candidateImageId'], 'verifiedFiles': len(FILES)}), flush=True)


def check():
    source_gate()
    state = core.manifest()
    core.current(state)
    tool = SERVER / 'tools/aggregate-test-env.sh'
    environment = {**os.environ, 'AGGREGATE_SOURCE_ROOT': str(RELEASE / 'candidate'), 'AGGREGATE_TEST_NAME': 'mbbs-aggregate-requests'}
    commands = {
        'candidate-migration.log': ['node', 'src/migrate.js'],
        'candidate-static.log': ['node', 'tools/aggregate-checks.mjs', 'static'],
        'candidate-feature.log': ['node', '--test', '--test-concurrency=1',
            'test/mbt/unit/aggregate-request-domain.test.js', 'test/mbt/integration/aggregate-request-repository.test.js',
            'test/mbt/integration/aggregate-request-http.test.js', 'test/mbt/integration/aggregate-request-browser.test.js'],
        'candidate-neighbors.log': ['node', '--test', '--test-concurrency=1',
            'test/mbt/unit/stock-request-ui-contract.test.js', 'test/mbt/unit/stock-request-server-contract.test.js',
            'test/mbt/unit/special-stock-request-wiring.red.test.js', 'test/mbt/unit/special-stock-request-domain.red.test.js',
            'test/mbt/property/special-stock-request-domain.property.test.js', 'test/mbt/unit/operator-delivery-refresh.test.js'],
        'candidate-navigation.log': ['node', '--test', '--test-name-pattern=main sidebar modules follow',
            'test/mbt/unit/operations-navigation-enhancements.test.js'],
    }
    def run(*args, **kwargs):
        return subprocess.run(['bash', str(tool), *args], cwd=ROOT, env=environment, check=True, **kwargs)
    run('stop')
    try:
        run('start', stdout=subprocess.DEVNULL)
        run('runner', stdout=subprocess.DEVNULL)
        for name, command in commands.items():
            with (RELEASE / name).open('wb') as output:
                run('exec', *command, stdout=output, stderr=subprocess.STDOUT)
            print(json.dumps({'passed': name}), flush=True)
        with (RELEASE / 'candidate-browser-artifacts.tar').open('wb') as output:
            subprocess.run(['sudo', '-n', 'docker', 'exec', 'mbbs-aggregate-requests-runner',
                            'tar', '-C', '/app/test-artifacts', '-cf', '-', '.'], stdout=output, check=True)
    finally:
        run('stop')
    core.current(state)
    save('candidate-checks.json', {'passed': True, 'imageId': state['candidateImageId'], 'sources': state['after']})


def config_gate(state):
    resolved = json.loads(subprocess.check_output(compose(state, 'compose.release.yml') + ['config', '--format', 'json'], cwd=ROOT))['services']['app']
    image = json.loads(docker('image', 'inspect', state['candidateImageId']))[0]['Config']
    runtime = json.loads(docker('inspect', APP))[0]['Config']
    environment = dict(value.split('=', 1) for value in image['Env'])
    environment.update({key: str(value) for key, value in resolved.get('environment', {}).items()})
    assert environment == dict(value.split('=', 1) for value in runtime['Env']), 'Environment would change'
    for field, option in [('Cmd', 'command'), ('Entrypoint', 'entrypoint'), ('User', 'user'), ('WorkingDir', 'working_dir')]:
        assert (image.get(field) if resolved.get(option) is None else resolved[option]) == runtime.get(field), field


def preflight():
    counts = json.loads(core.database("SELECT json_build_object('operatorPostings',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing')),'fulfillments',(SELECT count(*) FROM dispatch_sales_order_if_candidates WHERE status='posting'),'dispatchEditors',(SELECT count(*) FROM dispatch_plan_edit_leases WHERE expires_at>clock_timestamp()));"))
    save('preflight.json', counts)
    assert not any(counts.values()), 'Wait for active application work to finish before cutover'


def backup_and_migrate():
    for filename, options in [('schema-before.dump', ['--schema-only']), ('migrations-before.dump', ['--table=public.schema_migrations'])]:
        target = RELEASE / filename
        if not target.exists():
            with target.open('wb') as output:
                subprocess.run(['sudo', '-n', 'docker', 'exec', DEPENDENCIES[1], 'pg_dump', '-U', 'mbbs_app', '-d', 'mbbs_yard',
                                '--format=custom', *options], stdout=output, check=True)
        with target.open('rb') as source:
            toc = docker('exec', '-i', DEPENDENCIES[1], 'pg_restore', '--list', stdin=source)
        assert b'schema_migrations' in toc, 'Backup validation failed'
        (RELEASE / (filename + '.toc')).write_bytes(toc)
    save('backup.json', {name: {'bytes': (RELEASE / name).stat().st_size, 'sha256': core.digest((RELEASE / name).read_bytes())}
                        for name in ['schema-before.dump', 'migrations-before.dump']})
    if core.database("SELECT count(*) FROM schema_migrations WHERE filename='" + MIGRATION + "';").strip() == '0':
        assert core.database("SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('aggregate_requests','aggregate_request_lines','aggregate_request_events');").strip() == '0'
        sql = (RELEASE / 'candidate/migrations' / MIGRATION).read_text()
        output = core.database("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='45s';\n" + sql +
                               "\nINSERT INTO schema_migrations(filename) VALUES ('" + MIGRATION + "'); COMMIT;")
        (RELEASE / 'migration.log').write_text(output)


def verify():
    state = core.manifest()
    core.ready(state['candidateImageId'])
    current = core.metadata(APP)
    assert current['configuration'] == state['app']['configuration'], 'Application configuration changed'
    assert [core.metadata(name) for name in DEPENDENCIES] == state['dependencies'], 'Another service changed'
    hashes = docker('exec', APP, 'sha256sum', *['/app/' + name for name in FILES]).decode().splitlines()
    assert {line.split()[1].removeprefix('/app/'): line.split()[0] for line in hashes} == state['after']
    assert core.database("SELECT count(*) FROM schema_migrations WHERE filename='" + MIGRATION + "';").strip() == '1'
    script = (SERVER / 'tools/aggregate-live.mjs').read_text().replace('EXPECTED_ASSETS', json.dumps({
        name: sha for name, sha in state['after'].items() if name.startswith('public/')}))
    checks = json.loads(docker('exec', '-i', APP, 'node', '--input-type=module', input=script.encode()))
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'image': IMAGE, 'imageId': current['imageId'], 'migration': MIGRATION, 'runtimeFilesVerified': len(FILES),
              'configurationPreserved': True, 'otherServicesUnchanged': True, 'checks': checks}
    save('deployment-result.json', result)
    print(json.dumps(result), flush=True)


def apply():
    source_gate()
    state = core.manifest()
    core.current(state)
    assert json.loads((RELEASE / 'candidate-checks.json').read_text()) == {
        'passed': True, 'imageId': state['candidateImageId'], 'sources': state['after']}
    assert docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip() == state['candidateImageId']
    config_gate(state)
    preflight()
    backup_and_migrate()
    core.current(state)
    preflight()
    command = ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app']
    started = datetime.datetime.now(datetime.timezone.utc).isoformat()
    print(json.dumps({'cutoverStarted': started}), flush=True)
    try:
        with (RELEASE / 'cutover.log').open('wb') as output:
            subprocess.run(compose(state, 'compose.release.yml') + command, cwd=ROOT, stdout=output,
                           stderr=subprocess.STDOUT, check=True, timeout=100)
        verify()
        logs = docker('logs', '--since', started, APP, stderr=subprocess.STDOUT).decode()
        (RELEASE / 'startup.log').write_text(logs)
        assert not re.search(r'SyntaxError|ReferenceError|ERR_MODULE_NOT_FOUND|uncaughtException', logs)
    except Exception:
        with (RELEASE / 'rollback.log').open('wb') as output:
            subprocess.run(compose(state, 'compose.rollback.yml') + command, cwd=ROOT, stdout=output,
                           stderr=subprocess.STDOUT, check=True, timeout=100)
        core.ready(state['app']['imageId'])
        save('rolled-back.json', {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'migrationRetained': True})
        raise


if __name__ == '__main__':
    os.umask(0o077)
    {'prepare': prepare, 'build': build, 'check': check, 'apply': apply, 'verify': verify}[sys.argv[1]]()
