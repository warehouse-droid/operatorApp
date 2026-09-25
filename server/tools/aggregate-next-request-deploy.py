"""Deploy Aggregate request cycles and SCM material memos without replacing unrelated work."""
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
spec = importlib.util.spec_from_file_location('aggregate_cycle_release', SERVER / 'tools/aggregate-actuals-deploy.py')
previous = importlib.util.module_from_spec(spec)
spec.loader.exec_module(previous)
access, release, core = previous.access, previous.release, previous.core
CHECKS = SERVER / 'test-artifacts/aggregate-next-request'
VERSION = '20260922-aggregate-next-request-v5'
MIGRATIONS = ['217_aggregate_request_cycles.sql', '218_aggregate_material_memos.sql']
ADDED = ['migrations/' + name for name in MIGRATIONS]
FILES = sorted(ADDED + ['src/aggregate-request-repository.js', 'src/aggregate-request-domain.js',
    'src/aggregate-request-router.js', 'public/aggregate-requests.js', 'public/aggregate-requests.css',
    'public/aggregate-requests-i18n.js', 'public/aggregate-requests.html', 'public/scm-stock-requests.html'])
TESTS = previous.TESTS
VERIFIED = FILES + TESTS + ['test/aggregate-next-request-spec.md',
    'tools/aggregate-next-request-deploy.py', 'tools/aggregate-next-request-checks.mjs',
    'tools/aggregate-next-request-changed-lines.json', 'tools/aggregate-next-request-migration.mjs',
    'tools/aggregate-next-request-concurrency.mjs', 'tools/aggregate-next-request-gauntlet.sh',
    'test/support/aggregate-next-request-mutation-loader.mjs', 'tools/aggregate-actuals-deploy.py',
    'tools/aggregate-access-deploy.py', 'tools/aggregate-deploy.py', 'tools/operator-display-settings-deploy.py',
    'tools/aggregate-test-env.sh', 'tools/aggregate-checks.mjs', 'tools/aggregate-access-live.mjs']
for module in [previous, access, release, core]:
    for key, value in {
        'RELEASE': SERVER / 'test-artifacts/aggregate-next-request-deployment-20260922',
        'CHECKS': CHECKS, 'VERSION': VERSION,
        'IMAGE': 'mbbs-operator-app:aggregate-next-request-20260922-v5',
        'ROLLBACK': 'mbbs-operator-app:rollback-aggregate-next-request-20260922-v5',
        'FILES': FILES, 'EXISTING': [name for name in FILES if name not in ADDED], 'ADDED': ADDED
    }.items():
        setattr(module, key, value)
core.BEFORE = CHECKS / 'before'


def hashes():
    return {name: core.digest((SERVER / name).read_bytes()) for name in VERIFIED}


def checks_passed(require_full=False):
    assert '# pass 66\n# fail 0\n' in (CHECKS / 'tests.log').read_text()
    shuffled = (CHECKS / 'suite-health.log').read_text()
    assert not re.search(r'# fail [1-9]', shuffled)
    assert sum(map(int, re.findall(r'# pass (\d+)', shuffled))) == 66
    assert 'Syntax, lint and domain type checks passed.' in (CHECKS / 'static.log').read_text()
    assert 'Migration rehearsal rolled back completely.' in (CHECKS / 'migration-rehearsal.log').read_text()
    assert 'one fresh request and the complete prior history remain' in (CHECKS / 'concurrency.log').read_text()
    assert all(row['covered'] == row['changedLines'] for row in json.loads((CHECKS / 'aggregate-next-request-coverage.json').read_text()).values())
    mutants = json.loads((CHECKS / 'aggregate-next-request-mutations/results.json').read_text())
    assert len(mutants) == 12 and all(row['killed'] for row in mutants)
    if require_full:
        assert json.loads((CHECKS / 'full-regression.json').read_text())['newFailures'] == []


def record():
    checks_passed()
    compile(Path(__file__).read_text(), __file__, 'exec')
    files = hashes()
    result = {'files': files, 'sourceHash': core.digest(json.dumps(files, sort_keys=True).encode())}
    (CHECKS / 'verified-sources.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'verified': True, 'sourceHash': result['sourceHash']}), flush=True)


def source_gate(require_full=False):
    checks_passed(require_full)
    verified = json.loads((CHECKS / 'verified-sources.json').read_text())
    assert hashes() == verified['files'], 'Verified release source changed'
    return verified['sourceHash']


def build():
    release.build()
    state = core.manifest()
    rollback = release.RELEASE / 'rollback-candidate'
    shutil.copytree(release.RELEASE / 'baseline', rollback)
    # The prior requester UI is the fallback; its writes need the new SQL
    # conflict target so rollback never requires deleting completed requests.
    marker = 'export async function getAggregateRequesterWorkspace'
    current_repo = (release.RELEASE / 'candidate/src/aggregate-request-repository.js').read_text()
    old_repo = (rollback / 'src/aggregate-request-repository.js').read_text()
    (rollback / 'src/aggregate-request-repository.js').write_text(current_repo.split(marker)[0] + marker + old_repo.split(marker)[1])
    client = rollback / 'public/aggregate-requests.js'
    client.write_text(client.read_text().replace('t(actionLabels[event.action])', 't(actionLabels[event.action] || event.action)'))
    for name in MIGRATIONS:
        shutil.copy2(release.RELEASE / 'candidate/migrations' / name, rollback / 'migrations' / name)
    for name in ['test', 'tools']:
        (rollback / name).symlink_to(SERVER / name, target_is_directory=True)
    base = release.ROLLBACK + '-base'
    core.docker('tag', state['app']['imageId'], base)
    overlay = release.RELEASE / 'rollback-build/overlay'
    rollback_files = ['src/aggregate-request-repository.js', 'public/aggregate-requests.js', *ADDED]
    for name in rollback_files:
        target = overlay / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(rollback / name, target)
    (overlay.parent / 'Dockerfile').write_text('FROM ' + base + '\nCOPY --chown=node:node overlay/ /app/\n')
    with (release.RELEASE / 'rollback-build.log').open('wb') as output:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--network', 'none', '--pull=false', '-t', release.ROLLBACK, str(overlay.parent)],
                       stdout=output, stderr=subprocess.STDOUT, check=True)
    state['rollbackImageId'] = core.docker('image', 'inspect', '--format', '{{.Id}}', release.ROLLBACK).decode().strip()
    state['rollbackSources'] = {name: core.digest((rollback / name).read_bytes()) for name in rollback_files}
    actual = core.docker('run', '--rm', '--network', 'none', '--entrypoint', 'sha256sum', release.ROLLBACK,
                        *['/app/' + name for name in rollback_files]).decode().splitlines()
    assert {line.split()[1].removeprefix('/app/'): line.split()[0] for line in actual} == state['rollbackSources']
    (release.RELEASE / 'compose.rollback.yml').write_text('services:\n  app:\n    image: ' + state['rollbackImageId'] + '\n')
    core.save('manifest.json', state)
    print(json.dumps({'rollbackCompatibleImage': state['rollbackImageId']}), flush=True)


def check_environment(root, name, commands, capture=False):
    def run(*args, **kwargs):
        return subprocess.run(['sudo', '-n', 'env', 'AGGREGATE_SOURCE_ROOT=' + str(root), 'AGGREGATE_TEST_NAME=' + name,
                               'bash', str(SERVER / 'tools/aggregate-test-env.sh'), *args], check=True, **kwargs)
    run('stop')
    try:
        run('start', stdout=subprocess.DEVNULL)
        run('runner', stdout=subprocess.DEVNULL)
        for log, command in commands.items():
            with (release.RELEASE / log).open('wb') as output:
                run('exec', *command, stdout=output, stderr=subprocess.STDOUT)
            print(json.dumps({'passed': log}), flush=True)
        if capture:
            with (release.RELEASE / 'candidate-browser-artifacts.tar').open('wb') as output:
                subprocess.run(['sudo', '-n', 'docker', 'exec', name + '-runner', 'tar', '-C', '/app/test-artifacts', '-cf', '-', '.'], stdout=output, check=True)
    finally:
        run('stop')


def check():
    source_gate()
    state = core.manifest()
    core.current(state)
    assert {name: core.digest((release.RELEASE / 'rollback-candidate' / name).read_bytes()) for name in state['rollbackSources']} == state['rollbackSources']
    rollback_tests = '^(?:creates seven local lines|same operation retries|two independent submissions|unconfirmed requests|a completed acknowledged request|an unfinished request|concurrent fresh submissions|reporting a shortage|SCM rejection|competing confirmations|SCM proxy reporting|invalid writes|an audit insertion failure|reporting and SCM revision racing|25 identical|a detail read waiting|filters, pagination|a former SCM)'
    check_environment(release.RELEASE / 'rollback-candidate', 'mbbs-aggregate-baseline', {
        'rollback-migration.log': ['node', 'src/migrate.js'],
        'rollback-writes.log': ['node', '--test', '--test-name-pattern=' + rollback_tests, 'test/mbt/integration/aggregate-request-repository.test.js']
    })
    assert '# pass 18\n# fail 0\n' in (release.RELEASE / 'rollback-writes.log').read_text()
    check_environment(release.RELEASE / 'candidate', 'mbbs-aggregate-requests', {
        'candidate-migration.log': ['node', 'src/migrate.js'],
        'candidate-static.log': ['node', 'tools/aggregate-next-request-checks.mjs', 'static'],
        'candidate-feature.log': ['node', '--test', '--test-concurrency=1', *TESTS],
        'candidate-migration-rehearsal.log': ['node', 'tools/aggregate-next-request-migration.mjs'],
        'candidate-concurrency.log': ['node', 'tools/aggregate-next-request-concurrency.mjs']
    }, capture=True)
    source_gate()
    core.current(state)
    assert {name: core.digest((release.RELEASE / 'rollback-candidate' / name).read_bytes()) for name in state['rollbackSources']} == state['rollbackSources']
    core.save('candidate-checks.json', {'passed': True, 'imageId': state['candidateImageId'], 'sources': state['after'],
                                      'rollbackImageId': state['rollbackImageId'], 'rollbackSources': state['rollbackSources']})


def backup_and_migrate():
    database = core.DEPENDENCIES[1]
    for filename, options in [
        ('schema-before.dump', ['--schema-only']), ('migrations-before.dump', ['--table=public.schema_migrations']),
        ('aggregate-data-before.dump', ['--data-only', '--table=public.aggregate_requests', '--table=public.aggregate_request_lines', '--table=public.aggregate_request_events'])
    ]:
        target = release.RELEASE / filename
        if not target.exists():
            with target.open('wb') as output:
                subprocess.run(['sudo', '-n', 'docker', 'exec', database, 'pg_dump', '-U', 'mbbs_app', '-d', 'mbbs_yard', '--format=custom', *options], stdout=output, check=True)
        with target.open('rb') as source:
            toc = core.docker('exec', '-i', database, 'pg_restore', '--list', stdin=source)
        assert b'aggregate_request' in toc or b'schema_migrations' in toc
        (release.RELEASE / (filename + '.toc')).write_bytes(toc)
    release.preflight()
    fingerprint = "md5(jsonb_build_object('headers',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM aggregate_requests r),'lines',(SELECT jsonb_agg(to_jsonb(l)-'scm_memo' ORDER BY request_id,material_code) FROM aggregate_request_lines l),'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM aggregate_request_events e))::text)"
    sql = "BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='45s';\n"
    sql += "LOCK TABLE aggregate_requests,aggregate_request_lines,aggregate_request_events IN ACCESS EXCLUSIVE MODE;\n"
    sql += "SELECT 'before:'||" + fingerprint + ';\n'
    for name in MIGRATIONS:
        sql += (release.RELEASE / 'candidate/migrations' / name).read_text()
        sql += "\nINSERT INTO schema_migrations(filename) VALUES ('" + name + "') ON CONFLICT(filename) DO NOTHING;\n"
    sql += "SELECT 'after:'||" + fingerprint + ';\nCOMMIT;'
    output = core.database(sql)
    (release.RELEASE / 'migration.log').write_text(output)
    before = re.search(r'^before:(\w+)$', output, re.M).group(1)
    after = re.search(r'^after:(\w+)$', output, re.M).group(1)
    assert before == after, 'Migration changed existing operational data'
    assert core.database("SELECT indisvalid AND indisunique FROM pg_index WHERE indexrelid='aggregate_requests_one_unfinished_yard_idx'::regclass;").strip() == 't'
    core.save('migration-check.json', {'migrations': MIGRATIONS, 'existingRowsPreserved': True, 'rowHashBefore': before, 'rowHashAfter': after})


def verify():
    previous.verify()
    assert core.database("SELECT count(*) FROM schema_migrations WHERE filename IN ('217_aggregate_request_cycles.sql','218_aggregate_material_memos.sql');").strip() == '2'


def apply():
    source_gate(require_full=True)
    state = core.manifest()
    core.current(state)
    assert json.loads((release.RELEASE / 'candidate-checks.json').read_text()) == {
        'passed': True, 'imageId': state['candidateImageId'], 'sources': state['after'],
        'rollbackImageId': state['rollbackImageId'], 'rollbackSources': state['rollbackSources']}
    assert core.docker('image', 'inspect', '--format', '{{.Id}}', release.IMAGE).decode().strip() == state['candidateImageId']
    assert core.docker('image', 'inspect', '--format', '{{.Id}}', release.ROLLBACK).decode().strip() == state['rollbackImageId']
    release.config_gate(state)
    release.preflight()
    backup_and_migrate()
    core.current(state)
    command = ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app']
    started = datetime.datetime.now(datetime.timezone.utc).isoformat()
    print(json.dumps({'cutoverStarted': started}), flush=True)
    try:
        with (release.RELEASE / 'cutover.log').open('wb') as output:
            subprocess.run(release.compose(state, 'compose.release.yml') + command, cwd=SERVER.parent, stdout=output, stderr=subprocess.STDOUT, check=True, timeout=100)
        verify()
        logs = core.docker('logs', '--since', started, core.APP, stderr=subprocess.STDOUT).decode()
        (release.RELEASE / 'startup.log').write_text(logs)
        assert not re.search(r'SyntaxError|ReferenceError|ERR_MODULE_NOT_FOUND|uncaughtException', logs)
    except Exception:
        with (release.RELEASE / 'rollback.log').open('wb') as output:
            subprocess.run(release.compose(state, 'compose.rollback.yml') + command, cwd=SERVER.parent, stdout=output, stderr=subprocess.STDOUT, check=True, timeout=100)
        core.ready(state['rollbackImageId'])
        core.save('rolled-back.json', {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'migrationsRetained': True, 'historyPreserved': True})
        raise


previous.source_gate = source_gate
access.source_gate = source_gate
release.source_gate = source_gate
if __name__ == '__main__':
    os.umask(0o077)
    {'record': record, 'prepare': access.prepare, 'build': build, 'check': check, 'apply': apply, 'verify': verify}[sys.argv[1]]()
