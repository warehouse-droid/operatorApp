"""Deploy the scoped Aggregate alert, timestamps and confirmation date together."""
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('aggregate_date_release', SERVER / 'tools/aggregate-access-deploy.py')
access = importlib.util.module_from_spec(spec)
spec.loader.exec_module(access)
release, core = access.release, access.core
CHECKS = SERVER / 'test-artifacts/aggregate-confirmation-date'
RELEASE = SERVER / 'test-artifacts/aggregate-scm-alert-date-deployment-20260925'
VERSION = '20260925-aggregate-scm-alert-date-v1'
FILES = sorted([
    'src/aggregate-request-domain.js', 'src/aggregate-request-repository.js',
    'public/scm-aggregate-alert.js', 'public/app-sidebar.js', 'public/aggregate-requests-i18n.js',
    'public/aggregate-requests.js', 'public/aggregate-requester.js', 'public/aggregate-requests.css',
    'public/aggregate-requests.html', 'public/scm-stock-requests.html', 'public/operator.html',
    'public/field-sales/index.html'
])
ADDED = ['public/scm-aggregate-alert.js']
TESTS = [
    'test/mbt/unit/aggregate-request-domain.test.js', 'test/mbt/unit/aggregate-request-access.test.js',
    'test/mbt/unit/aggregate-request-time.test.js', 'test/mbt/integration/aggregate-request-access.test.js',
    'test/mbt/integration/aggregate-request-repository.test.js', 'test/mbt/integration/aggregate-request-http.test.js',
    'test/mbt/integration/aggregate-request-browser.test.js', 'test/mbt/integration/aggregate-request-alert-browser.test.js'
]
VERIFIED = FILES + TESTS + [
    'package.json', 'tools/aggregate-checks.mjs', 'tools/aggregate-eslint.config.mjs',
    'tools/aggregate-confirmation-date-checks.mjs', 'tools/aggregate-confirmation-date-changed-lines.json',
    'test/support/aggregate-confirmation-date-mutation-loader.mjs',
    'tools/aggregate-confirmation-date-gauntlet.sh', 'tools/aggregate-scm-alert-date-deploy.py',
    'test/aggregate-confirmation-date-spec.md'
]
for module in [access, release, core]:
    for key, value in {
        'RELEASE': RELEASE, 'CHECKS': CHECKS, 'VERSION': VERSION,
        'IMAGE': 'mbbs-operator-app:aggregate-scm-alert-date-20260925-v1',
        'ROLLBACK': 'mbbs-operator-app:rollback-aggregate-scm-alert-date-20260925-v1',
        'FILES': FILES, 'ADDED': ADDED, 'EXISTING': [name for name in FILES if name not in ADDED]
    }.items():
        setattr(module, key, value)
core.BEFORE = SERVER / 'test-artifacts/scm-aggregate-alert/before'


def source_hashes():
    return {name: core.digest((SERVER / name).read_bytes()) for name in VERIFIED}


def check_evidence():
    for name in ['tests-coverage.log', 'neighbors.log', 'suite-health.log']:
        text = (CHECKS / name).read_text()
        assert '# fail 0\n' in text and not re.search(r'# fail [1-9]', text), name
    assert '# pass 70\n# fail 0\n' in (CHECKS / 'tests-coverage.log').read_text()
    assert 'Syntax, lint and domain type checks passed.' in (CHECKS / 'static.log').read_text()
    assert 'Secret scan passed:' in (CHECKS / 'secrets.log').read_text()
    mutations = json.loads((CHECKS / 'mutations.json').read_text())
    assert len(mutations) == 5 and all(row['killed'] for row in mutations)
    coverage = json.loads((CHECKS / 'coverage.json').read_text())
    assert coverage and all(row['covered'] == row['changedLines'] and not row['uncovered'] for row in coverage.values())


def source_gate(require_full=True):
    check_evidence()
    verified = json.loads((CHECKS / 'verified-sources.json').read_text())
    assert source_hashes() == verified['files'], 'Release source changed after verification'
    return verified['sourceHash']


def record():
    check_evidence()
    files = source_hashes()
    source = {'files': files, 'sourceHash': hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()}
    (CHECKS / 'verified-sources.json').write_text(json.dumps(source, indent=2) + '\n')
    print(json.dumps({'verified': True, 'sourceHash': source['sourceHash']}), flush=True)


def shell_assets(name, text):
    assert name == 'public/operator.html'
    assert 'scm-aggregate-alert.js' not in text
    assert text.count('  </body>') == 1
    return text.replace('  </body>', '    <script src="/scm-aggregate-alert.js?v=20260925-aggregate-alert-v1"></script>\n  </body>')


access.source_gate = source_gate
release.source_gate = source_gate
access.shell_assets = shell_assets


def check():
    source_gate()
    state = core.manifest()
    core.current(state)
    environment = {**os.environ, 'AGGREGATE_SOURCE_ROOT': str(RELEASE / 'candidate'), 'AGGREGATE_TEST_NAME': 'mbbs-aggregate-baseline'}
    tool = SERVER / 'tools/aggregate-test-env.sh'
    def run(*args, **kwargs):
        return subprocess.run(['bash', str(tool), *args], cwd=SERVER, env=environment, check=True, **kwargs)
    run('start', stdout=subprocess.DEVNULL)
    try:
        run('runner', stdout=subprocess.DEVNULL)
        commands = {
            'candidate-migrate.log': ['node', 'src/migrate.js'],
            'candidate-static.log': ['node', 'tools/aggregate-checks.mjs', 'static'],
            'candidate-tests.log': ['node', '--test', '--test-concurrency=1', *TESTS],
            'candidate-neighbors.log': ['node', '--test', 'test/mbt/unit/operator-yard-assets.test.js',
                'test/mbt/unit/stock-request-ui-contract.test.js'],
        }
        for name, command in commands.items():
            with (RELEASE / name).open('wb') as output:
                run('exec', *command, stdout=output, stderr=subprocess.STDOUT)
            print(json.dumps({'passed': name}), flush=True)
        with (RELEASE / 'candidate-browser-artifacts.tar').open('wb') as output:
            subprocess.run(['sudo', '-n', 'docker', 'exec', 'mbbs-aggregate-baseline-runner', 'tar', '-C', '/app/test-artifacts', '-cf', '-', '.'], stdout=output, check=True)
    finally:
        run('stop')
    core.current(state)
    source_gate()
    core.save('candidate-checks.json', {'passed': True, 'imageId': state['candidateImageId'], 'sources': state['after']})


def schema_check():
    # No migration or operational write is needed; existing columns and their
    # database constraint already enforce one day between the linked dates.
    sql = """BEGIN READ ONLY;
    SELECT count(*) FROM schema_migrations WHERE filename IN ('215_aggregate_requests.sql','217_aggregate_request_cycles.sql');
    SELECT indisvalid AND indisunique FROM pg_index WHERE indexrelid='aggregate_requests_one_unfinished_yard_idx'::regclass;
    SELECT count(*) FROM aggregate_requests WHERE report_due_date <> service_date + 1;
    COMMIT;"""
    output = core.database(sql)
    assert output.splitlines() == ['BEGIN', '2', 't', '0', 'COMMIT'], 'Unexpected Aggregate schema or dates'
    core.save('schema-check.json', {'readOnly': True, 'migrationNeeded': False, 'invalidSchedules': 0})


def verify():
    state = core.manifest()
    core.ready(state['candidateImageId'])
    current = core.metadata(core.APP)
    assert current['configuration'] == state['app']['configuration'], 'Application configuration changed'
    assert [core.metadata(name) for name in core.DEPENDENCIES] == state['dependencies'], 'Another service changed'
    hashes = core.docker('exec', core.APP, 'sha256sum', *['/app/' + name for name in FILES]).decode().splitlines()
    assert {line.split()[1].removeprefix('/app/'): line.split()[0] for line in hashes} == state['after']
    script = (SERVER / 'tools/aggregate-access-live.mjs').read_text().replace('EXPECTED_ASSETS', json.dumps({
        name: sha for name, sha in state['after'].items() if name.startswith('public/')}))
    checks = json.loads(core.docker('exec', '-i', core.APP, 'node', '--input-type=module', input=script.encode()))
    schema_check()
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'image': release.IMAGE, 'imageId': current['imageId'], 'runtimeFilesVerified': len(FILES),
        'configurationPreserved': True, 'otherServicesUnchanged': True, 'migrationNeeded': False, 'checks': checks}
    core.save('deployment-result.json', result)
    print(json.dumps(result), flush=True)
    return result


release.backup_and_migrate = schema_check
release.verify = verify
if __name__ == '__main__':
    os.umask(0o077)
    {'record': record, 'prepare': access.prepare, 'build': release.build,
     'check': check, 'apply': release.apply, 'verify': verify}[sys.argv[1]]()
