"""Deploy only the verified independent Aggregate access and guided requester flow."""
import datetime
import difflib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('aggregate_access_release', SERVER / 'tools/aggregate-deploy.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
core = release.core
CHECKS = SERVER / 'test-artifacts/aggregate-access-flow'
SCOPE = json.loads((SERVER / 'tools/aggregate-access-files.json').read_text())
VERSION = '20260922-aggregate-access-flow-v3'
MIGRATION = '216_aggregate_request_access.sql'
FILES = sorted(SCOPE['runtime'])
ADDED = ['src/aggregate-request-access-repository.js', 'src/aggregate-request-access-router.js',
         'public/aggregate-requester.js', 'migrations/' + MIGRATION]
EXISTING = [name for name in FILES if name not in ADDED]
for key, value in {
    'RELEASE': SERVER / 'test-artifacts/aggregate-access-deployment-20260922',
    'IMAGE': 'mbbs-operator-app:aggregate-access-flow-20260922-v3',
    'ROLLBACK': 'mbbs-operator-app:rollback-aggregate-access-flow-20260922-v3',
    'VERSION': VERSION, 'MIGRATION': MIGRATION, 'EXISTING': EXISTING, 'ADDED': ADDED, 'FILES': FILES
}.items():
    setattr(release, key, value)
    setattr(core, key, value)
core.BEFORE = CHECKS / 'baseline'
original_docker = core.docker


def workspace_docker(*args, **kwargs):
    if args[0] != 'cp':
        return original_docker(*args, **kwargs)
    assert len(args) == 3
    target = Path(args[2])
    assert target.resolve().is_relative_to(release.RELEASE.resolve())
    archive_bytes = original_docker('cp', args[1], '-', **kwargs)
    with tarfile.open(fileobj=io.BytesIO(archive_bytes)) as archive:
        assert all(Path(member.name).parts[0] == target.name for member in archive.getmembers())
        archive.extractall(target.parent, filter='data')
    return b''


core.docker = workspace_docker


def source_gate(require_full=True):
    source = json.loads((CHECKS / 'aggregate-access-source.json').read_text())
    for name, sha in source['files'].items():
        assert core.digest((SERVER / name).read_bytes()) == sha, 'Verified source changed: ' + name
    for name in ['tests.log', 'neighbors.log', 'navigation.log', 'suite-health.log']:
        assert '# fail 0\n' in (CHECKS / name).read_text(), name
        assert not re.search(r'# fail [1-9]', (CHECKS / name).read_text()), name
    assert 'Syntax, lint and domain type checks passed.' in (CHECKS / 'static.log').read_text()
    if require_full:
        assert json.loads((CHECKS / 'full-regression.json').read_text())['newFailures'] == []
    assert all(row['killed'] for row in json.loads((CHECKS / 'aggregate-access-mutations/results.json').read_text()))
    assert all(row.get('uninstrumented') or row['changedLines'] == row['covered']
               for row in json.loads((CHECKS / 'aggregate-access-coverage.json').read_text()).values())
    return source['sourceHash']


def shell_assets(file, text):
    assets = ['i18n.js', 'app-sidebar.js', 'control.js', 'control.css'] if file in ['public/admin.html', 'public/control.html'] else ['i18n.js', 'operator-delivery-refresh.js', 'operator.js']
    for asset in assets:
        text, count = re.subn(r'/' + re.escape(asset) + r'\?v=[^"\s]+', '/' + asset + '?v=' + VERSION, text)
        assert count == 1, asset
    if file.endswith('service-worker.js'):
        text, count = re.subn(r'const CACHE_NAME = "[^"]+";',
                             'const CACHE_NAME = "mbbs-yard-operator-' + VERSION + '";', text)
        assert count == 1
    return text


def prepare():
    verified = source_gate(require_full=False)
    target = release.RELEASE
    target.mkdir(parents=True, exist_ok=False)
    state = {'app': core.metadata(core.APP), 'dependencies': [core.metadata(name) for name in core.DEPENDENCIES]}
    baseline = target / 'baseline'
    baseline.mkdir()
    for name in ['src', 'public', 'migrations', 'package.json', 'package-lock.json']:
        core.docker('cp', core.APP + ':/app/' + name, str(baseline / name))
    assert core.metadata(core.APP) == state['app']
    candidate = target / 'candidate'
    shutil.copytree(baseline, candidate)
    patch = ''
    for name in EXISTING:
        if name in ['public/operator.html', 'public/service-worker.js', 'public/admin.html', 'public/control.html']:
            old = (baseline / name).read_text()
            new = shell_assets(name, old)
        else:
            old, new = (core.BEFORE / name).read_text(), (SERVER / name).read_text()
        patch += ''.join(difflib.unified_diff(old.splitlines(True), new.splitlines(True), fromfile='a/' + name, tofile='b/' + name))
    (target / 'release.patch').write_text(patch)
    result = subprocess.run(['patch', '--batch', '--fuzz=0', '-p1', '-d', str(candidate)], input=patch, text=True, capture_output=True)
    (target / 'patch.log').write_text(result.stdout + result.stderr)
    assert result.returncode == 0, 'Release patch requires review'
    for name in ADDED:
        assert not (baseline / name).exists()
        shutil.copy2(SERVER / name, candidate / name)
    for path in candidate.rglob('*.orig'):
        path.unlink()
    before, after = core.files_at(baseline), core.files_at(candidate)
    changed = sorted(name for name in after if after[name] != before.get(name))
    assert changed == FILES
    state.update({'image': release.IMAGE, 'before': {name: before.get(name) for name in FILES},
                  'after': {name: after[name] for name in FILES},
                  'workspace': {name: core.digest((SERVER / name).read_bytes()) for name in FILES},
                  'changedFiles': changed, 'implementationSourceHash': verified})
    state['preservedLiveDifferences'] = [name for name in FILES if state['after'][name] != state['workspace'][name]]
    for name in ['test', 'tools']:
        (candidate / name).symlink_to(SERVER / name, target_is_directory=True)
    (target / 'compose.release.yml').write_text('services:\n  app:\n    image: ' + release.IMAGE + '\n')
    (target / 'compose.rollback.yml').write_text('services:\n  app:\n    image: ' + state['app']['imageId'] + '\n')
    core.save('manifest.json', state)
    core.current(state)
    print(json.dumps({'prepared': True, 'baseImage': state['app']['image'], 'files': changed}), flush=True)


def backup_and_migrate():
    for filename, options in [('schema-before.dump', ['--schema-only']), ('migrations-before.dump', ['--table=public.schema_migrations'])]:
        target = release.RELEASE / filename
        if not target.exists():
            with target.open('wb') as output:
                subprocess.run(['sudo', '-n', 'docker', 'exec', core.DEPENDENCIES[1], 'pg_dump', '-U', 'mbbs_app', '-d', 'mbbs_yard',
                                '--format=custom', *options], stdout=output, check=True)
        with target.open('rb') as source:
            toc = core.docker('exec', '-i', core.DEPENDENCIES[1], 'pg_restore', '--list', stdin=source)
        assert b'schema_migrations' in toc
        (release.RELEASE / (filename + '.toc')).write_bytes(toc)
    normal_access = "SELECT md5(COALESCE(json_agg(t ORDER BY t.id)::text,'')) FROM (SELECT id,role,roles,yard_location_ids,operator_yard_location_ids FROM operators) t;"
    before = core.database(normal_access).strip()
    if core.database("SELECT count(*) FROM schema_migrations WHERE filename='" + MIGRATION + "';").strip() == '0':
        assert core.database("SELECT to_regclass('public.aggregate_request_yard_assignments') IS NULL;").strip() == 't'
        sql = (release.RELEASE / 'candidate/migrations' / MIGRATION).read_text()
        output = core.database("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='45s';\n" + sql +
                               "\nINSERT INTO schema_migrations(filename) VALUES ('" + MIGRATION + "'); COMMIT;")
        (release.RELEASE / 'migration.log').write_text(output)
    assert core.database(normal_access).strip() == before, 'Normal account access changed during migration'
    core.save('migration-check.json', {'migration': MIGRATION, 'normalAccessUnchanged': True,
        'assignmentRows': int(core.database('SELECT count(*) FROM aggregate_request_yard_assignments;').strip())})


def check():
    source_gate(require_full=False)
    state = core.manifest()
    core.current(state)
    tool = SERVER / 'tools/aggregate-test-env.sh'
    environment = {**os.environ, 'AGGREGATE_SOURCE_ROOT': str(release.RELEASE / 'candidate'), 'AGGREGATE_TEST_NAME': 'mbbs-aggregate-requests'}
    commands = {
        'candidate-migration.log': ['node', 'src/migrate.js'],
        'candidate-static.log': ['node', 'tools/aggregate-access-checks.mjs', 'static'],
        'candidate-feature.log': ['node', '--test', '--test-concurrency=1', *SCOPE['tests']],
        'candidate-neighbors.log': ['node', '--test', '--test-concurrency=1',
            'test/mbt/unit/stock-request-ui-contract.test.js', 'test/mbt/unit/stock-request-server-contract.test.js',
            'test/mbt/unit/special-stock-request-wiring.red.test.js', 'test/mbt/unit/special-stock-request-domain.red.test.js',
            'test/mbt/property/special-stock-request-domain.property.test.js', 'test/mbt/unit/operator-delivery-refresh.test.js'],
        'candidate-navigation.log': ['node', '--test', '--test-name-pattern=main sidebar modules follow|Aggregate navigation',
            'test/mbt/unit/operations-navigation-enhancements.test.js']
    }
    def run(*args, **kwargs):
        return subprocess.run(['bash', str(tool), *args], cwd=SERVER.parent, env=environment, check=True, **kwargs)
    run('stop')
    try:
        run('start', stdout=subprocess.DEVNULL)
        run('runner', stdout=subprocess.DEVNULL)
        for name, command in commands.items():
            with (release.RELEASE / name).open('wb') as output:
                run('exec', *command, stdout=output, stderr=subprocess.STDOUT)
            print(json.dumps({'passed': name}), flush=True)
    finally:
        run('stop')
    core.current(state)
    core.save('candidate-checks.json', {'passed': True, 'imageId': state['candidateImageId'], 'sources': state['after']})


def verify():
    state = core.manifest()
    core.ready(state['candidateImageId'])
    current = core.metadata(core.APP)
    assert current['configuration'] == state['app']['configuration']
    assert [core.metadata(name) for name in core.DEPENDENCIES] == state['dependencies']
    hashes = core.docker('exec', core.APP, 'sha256sum', *['/app/' + name for name in FILES]).decode().splitlines()
    assert {line.split()[1].removeprefix('/app/'): line.split()[0] for line in hashes} == state['after']
    assert core.database("SELECT count(*) FROM schema_migrations WHERE filename='" + MIGRATION + "';").strip() == '1'
    script = (SERVER / 'tools/aggregate-access-live.mjs').read_text().replace('EXPECTED_ASSETS', json.dumps({
        name: sha for name, sha in state['after'].items() if name.startswith('public/')}))
    checks = json.loads(core.docker('exec', '-i', core.APP, 'node', '--input-type=module', input=script.encode()))
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'image': release.IMAGE, 'imageId': current['imageId'], 'migration': MIGRATION,
              'runtimeFilesVerified': len(FILES), 'configurationPreserved': True, 'otherServicesUnchanged': True, 'checks': checks}
    core.save('deployment-result.json', result)
    print(json.dumps(result), flush=True)


def candidate_gate():
    return source_gate(require_full=False)


def apply():
    source_gate()
    release.apply()


release.source_gate = candidate_gate
release.backup_and_migrate = backup_and_migrate
release.verify = verify
core.shell_assets = shell_assets
if __name__ == '__main__':
    os.umask(0o077)
    commands = {name: getattr(release, name) for name in ['prepare', 'build', 'apply']}
    commands.update({'prepare': prepare, 'check': check, 'apply': apply, 'verify': verify})
    commands[sys.argv[1]]()
