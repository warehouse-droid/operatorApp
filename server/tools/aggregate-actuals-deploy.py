"""Release the narrow Aggregate actual-report follow-up over the current image."""
import datetime
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('aggregate_actuals_release', SERVER / 'tools/aggregate-access-deploy.py')
access = importlib.util.module_from_spec(spec)
spec.loader.exec_module(access)
release, core = access.release, access.core
CHECKS = SERVER / 'test-artifacts/aggregate-actuals-ui'
VERSION = '20260922-aggregate-actuals-v4'
FILES = sorted([
    'src/aggregate-request-domain.js', 'public/aggregate-requester.js', 'public/aggregate-requests.js',
    'public/aggregate-requests.css', 'public/aggregate-requests-i18n.js',
    'public/aggregate-requests.html', 'public/scm-stock-requests.html'
])
TESTS = access.SCOPE['tests']
VERIFIED = FILES + TESTS + [
    'test/aggregate-actuals-ui-spec.md', 'tools/aggregate-actuals-deploy.py',
    'tools/aggregate-access-deploy.py', 'tools/aggregate-deploy.py',
    'tools/operator-display-settings-deploy.py', 'tools/aggregate-test-env.sh',
    'tools/aggregate-checks.mjs', 'tools/aggregate-access-live.mjs', 'test/support/aggregate-mutation-loader.mjs'
]
for module in [access, release, core]:
    for key, value in {
        'RELEASE': SERVER / 'test-artifacts/aggregate-actuals-deployment-20260922',
        'CHECKS': CHECKS, 'VERSION': VERSION,
        'IMAGE': 'mbbs-operator-app:aggregate-actuals-20260922-v4',
        'ROLLBACK': 'mbbs-operator-app:rollback-aggregate-actuals-20260922-v4',
        'FILES': FILES, 'EXISTING': FILES, 'ADDED': []
    }.items():
        setattr(module, key, value)
core.BEFORE = CHECKS / 'before'


def hashes():
    return {name: core.digest((SERVER / name).read_bytes()) for name in VERIFIED}


def checks_passed():
    log = (CHECKS / 'tests.log').read_text()
    assert '# fail 0\n' in log and '# pass 57\n' in log
    assert 'Syntax, lint and domain type checks passed.' in (CHECKS / 'static.log').read_text()
    assert 'AGGREGATE_REPORT_NOT_DUE' in (CHECKS / 'red-immediate-report.log').read_text()


def record():
    checks_passed()
    files = hashes()
    result = {'files': files, 'sourceHash': core.digest(json.dumps(files, sort_keys=True).encode())}
    (CHECKS / 'verified-sources.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'verified': True, 'sourceHash': result['sourceHash']}))


def source_gate(require_full=False):
    checks_passed()
    verified = json.loads((CHECKS / 'verified-sources.json').read_text())
    assert hashes() == verified['files'], 'Verified follow-up source changed'
    return verified['sourceHash']


def check():
    source_gate()
    state = core.manifest()
    core.current(state)
    environment = {**os.environ, 'AGGREGATE_SOURCE_ROOT': str(release.RELEASE / 'candidate')}

    def run(*args, **kwargs):
        return subprocess.run(['bash', str(SERVER / 'tools/aggregate-test-env.sh'), *args],
                              cwd=SERVER.parent, env=environment, check=True, **kwargs)

    run('stop')
    try:
        run('start', stdout=subprocess.DEVNULL)
        run('runner', stdout=subprocess.DEVNULL)
        for name, command in {
            'candidate-migration.log': ['node', 'src/migrate.js'],
            'candidate-static.log': ['node', 'tools/aggregate-checks.mjs', 'static'],
            'candidate-feature.log': ['node', '--test', '--test-concurrency=1', *TESTS]
        }.items():
            with (release.RELEASE / name).open('wb') as output:
                run('exec', *command, stdout=output, stderr=subprocess.STDOUT)
            print(json.dumps({'passed': name}), flush=True)
        with (release.RELEASE / 'candidate-browser-artifacts.tar').open('wb') as output:
            subprocess.run(['sudo', '-n', 'docker', 'exec', 'mbbs-aggregate-requests-runner',
                            'tar', '-C', '/app/test-artifacts', '-cf', '-', '.'], stdout=output, check=True)
    finally:
        run('stop')
    source_gate()
    core.current(state)
    core.save('candidate-checks.json', {'passed': True, 'imageId': state['candidateImageId'], 'sources': state['after']})


def no_migration():
    assert core.database("SELECT count(*) FROM schema_migrations WHERE filename='216_aggregate_request_access.sql';").strip() == '1'
    core.save('migration-check.json', {'required': False, 'operationalDataChanged': False})


def verify():
    state = core.manifest()
    core.ready(state['candidateImageId'])
    current = core.metadata(core.APP)
    assert current['configuration'] == state['app']['configuration']
    assert [core.metadata(name) for name in core.DEPENDENCIES] == state['dependencies']
    actual = core.docker('exec', core.APP, 'sha256sum', *['/app/' + name for name in FILES]).decode().splitlines()
    assert {line.split()[1].removeprefix('/app/'): line.split()[0] for line in actual} == state['after']
    script = (SERVER / 'tools/aggregate-access-live.mjs').read_text().replace(
        '20260922-aggregate-access-flow-v3', VERSION).replace('EXPECTED_ASSETS', json.dumps({
            name: sha for name, sha in state['after'].items() if name.startswith('public/')}))
    probes = json.loads(core.docker('exec', '-i', core.APP, 'node', '--input-type=module', input=script.encode()))
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'image': release.IMAGE, 'imageId': current['imageId'], 'runtimeFilesVerified': len(FILES),
              'configurationPreserved': True, 'otherServicesUnchanged': True, 'checks': probes}
    core.save('deployment-result.json', result)
    print(json.dumps(result), flush=True)


access.source_gate = source_gate
release.source_gate = source_gate
release.backup_and_migrate = no_migration
release.verify = verify
if __name__ == '__main__':
    os.umask(0o077)
    {'record': record, 'prepare': access.prepare, 'build': release.build,
     'check': check, 'apply': release.apply, 'verify': verify}[sys.argv[1]]()
