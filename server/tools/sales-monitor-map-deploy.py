"""Deploy only the Sales map admission correction over the current live image."""
import datetime
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('sales_map_release_base', SERVER / 'tools/aggregate-access-deploy.py')
access = importlib.util.module_from_spec(spec)
spec.loader.exec_module(access)
release, core = access.release, access.core
CHECKS = SERVER / 'test-artifacts/sales-monitor-map'
FILES = ['src/server.js']
VERIFIED = FILES + ['test/mbt/integration/sales-monitor-map.test.js', 'test/sales-monitor-map-spec.md', 'test/sales-monitor-map-neighbor-baseline.json',
    'test/support/sales-monitor-map-mutation-loader.mjs', 'tools/sales-monitor-map-checks.mjs',
    'tools/sales-monitor-map-eslint.config.mjs', 'tools/sales-monitor-map-gauntlet.py', 'tools/sales-monitor-map-deploy.py',
    'tools/sales-monitor-map-live.mjs', 'tools/aggregate-access-deploy.py', 'tools/aggregate-deploy.py',
    'tools/operator-display-settings-deploy.py', 'tools/aggregate-test-env.sh', 'tools/aggregate-regression.py']
for module in [access, release, core]:
    for key, value in {'RELEASE': SERVER / 'test-artifacts/sales-monitor-map-deployment-20260922',
        'IMAGE': 'mbbs-operator-app:sales-monitor-map-20260922-v1',
        'ROLLBACK': 'mbbs-operator-app:rollback-sales-monitor-map-20260922-v1',
        'FILES': FILES, 'EXISTING': FILES, 'ADDED': []}.items():
        setattr(module, key, value)
core.BEFORE = CHECKS / 'before'


def hashes():
    return {name: core.digest((SERVER / name).read_bytes()) for name in VERIFIED}


def checks_passed(require_full=False):
    assert '# pass 4\n# fail 0\n' in (CHECKS / 'tests.log').read_text()
    known = json.loads((SERVER / 'test/sales-monitor-map-neighbor-baseline.json').read_text())['knownFailures']
    for name in ['neighbors.log', 'suite-health.log']:
        assert re.findall(r'^not ok \d+ - (.+)$', (CHECKS / name).read_text(), re.M) == known, name
    assert 'Syntax, lint and strict authorization function types passed.' in (CHECKS / 'static.log').read_text()
    coverage = json.loads((CHECKS / 'sales-monitor-map-checks/coverage.json').read_text())
    assert coverage['covered'] == coverage['changedLines'] == 1
    assert coverage['branches'] == coverage['coveredBranches']
    mutants = json.loads((CHECKS / 'sales-monitor-map-checks/mutations.json').read_text())
    assert len(mutants) == 8 and all(row['killed'] for row in mutants)
    if require_full:
        assert json.loads((CHECKS / 'full-regression.json').read_text())['newFailures'] == []


def record():
    checks_passed()
    for name in VERIFIED:
        if name.endswith('.py'):
            compile((SERVER / name).read_text(), name, 'exec')
    files = hashes()
    result = {'files': files, 'sourceHash': core.digest(json.dumps(files, sort_keys=True).encode())}
    (CHECKS / 'verified-sources.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'verified': True, 'sourceHash': result['sourceHash']}), flush=True)


def source_gate(require_full=True):
    checks_passed(require_full)
    expected = json.loads((CHECKS / 'verified-sources.json').read_text())
    assert hashes() == expected['files'], 'Verified sources changed'
    return expected['sourceHash']


def build():
    original_gate = release.source_gate
    release.source_gate = lambda: source_gate(require_full=False)
    try:
        release.build()
    finally:
        release.source_gate = original_gate


def check():
    source_gate(require_full=False)
    state = core.manifest()
    core.current(state)
    root = release.RELEASE / 'candidate'

    def run(*args, **kwargs):
        return subprocess.run(['sudo', '-n', 'env', 'AGGREGATE_SOURCE_ROOT=' + str(root), 'bash', str(SERVER / 'tools/aggregate-test-env.sh'), *args], check=kwargs.pop('check', True), **kwargs)

    run('stop')
    try:
        run('start', stdout=subprocess.DEVNULL)
        run('runner', stdout=subprocess.DEVNULL)
        for log, command in {
            'candidate-migration.log': ['node', 'src/migrate.js'],
            'candidate-static.log': ['node', 'tools/sales-monitor-map-checks.mjs', 'static'],
            'candidate-feature.log': ['node', '--test', 'test/mbt/integration/sales-monitor-map.test.js'],
            'candidate-neighbors.log': ['npm', 'run', 'test:google-maps-usage']
        }.items():
            with (release.RELEASE / log).open('wb') as output:
                result = run('exec', *command, stdout=output, stderr=subprocess.STDOUT, check=log != 'candidate-neighbors.log')
            if log == 'candidate-neighbors.log':
                known = json.loads((SERVER / 'test/sales-monitor-map-neighbor-baseline.json').read_text())['knownFailures']
                assert result.returncode == 1 and re.findall(r'^not ok \d+ - (.+)$', (release.RELEASE / log).read_text(), re.M) == known
            print(json.dumps({'passed': log}), flush=True)
    finally:
        run('stop')
    core.current(state)
    core.save('candidate-checks.json', {'passed': True, 'imageId': state['candidateImageId'], 'sources': state['after']})


def no_migration():
    core.save('migration-check.json', {'required': False, 'operationalDataChanged': False})


def verify():
    state = core.manifest()
    core.ready(state['candidateImageId'])
    current = core.metadata(core.APP)
    assert current['configuration'] == state['app']['configuration']
    assert [core.metadata(name) for name in core.DEPENDENCIES] == state['dependencies']
    hashes_now = core.docker('exec', core.APP, 'sha256sum', '/app/src/server.js').decode().split()[0]
    assert hashes_now == state['after']['src/server.js']
    script = (SERVER / 'tools/sales-monitor-map-live.mjs').read_bytes()
    probes = json.loads(core.docker('exec', '-i', core.APP, 'node', '--input-type=module', input=script))
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'image': release.IMAGE, 'imageId': current['imageId'], 'runtimeFilesVerified': 1,
        'configurationPreserved': True, 'otherServicesUnchanged': True, 'checks': probes}
    core.save('deployment-result.json', result)
    print(json.dumps(result), flush=True)


access.source_gate = source_gate
release.source_gate = source_gate
release.backup_and_migrate = no_migration
release.verify = verify
if __name__ == '__main__':
    os.umask(0o077)
    {'record': record, 'prepare': access.prepare, 'build': build, 'check': check, 'apply': release.apply, 'verify': verify}[sys.argv[1]]()
