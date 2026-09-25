"""Deploy only the verified parent PO split balance and Operator count correction."""
import datetime
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('receiving_display_release', SERVER / 'tools/aggregate-access-deploy.py')
access = importlib.util.module_from_spec(spec)
spec.loader.exec_module(access)
release, core = access.release, access.core
CHECKS = SERVER / 'test-artifacts/receiving-split-balance'
VERSION = '20260922-receiving-split-balance-v1'
FILES = sorted(['public/operator.html', 'public/operator.js', 'public/service-worker.js',
                'src/receiving-repository.js', 'src/receiving-po-split-progress.js'])
ADDED = ['src/receiving-po-split-progress.js']
EXISTING = [name for name in FILES if name not in ADDED]
for module in [access, release, core]:
    for key, value in {'RELEASE': SERVER / 'test-artifacts/receiving-split-balance-deployment-20260922',
        'IMAGE': 'mbbs-operator-app:receiving-split-balance-20260922-v1',
        'ROLLBACK': 'mbbs-operator-app:rollback-receiving-split-balance-20260922-v1',
        'FILES': FILES, 'EXISTING': EXISTING, 'ADDED': ADDED}.items():
        setattr(module, key, value)
core.BEFORE = CHECKS / 'before'


def source_gate(require_full=True):
    hashes = {name: core.digest((SERVER / name).read_bytes()) for name in FILES}
    assert hashes == json.loads((CHECKS / 'focused-source.json').read_text()), 'Focused source changed'
    assert '# fail 0\n' in (CHECKS / 'tests.log').read_text()
    assert not re.search(r'# fail [1-9]', (CHECKS / 'tests.log').read_text())
    assert not re.search(r'# fail [1-9]', (CHECKS / 'suite-health.log').read_text())
    assert json.loads((CHECKS / 'static.json').read_text())['newTypeDiagnostics'] == 0
    assert all(row['killed'] for row in json.loads((CHECKS / 'mutations.json').read_text()))
    assert all(row['changedExecutableLines'] == row['covered'] for row in json.loads((CHECKS / 'coverage.json').read_text()).values())
    assert json.loads((CHECKS / 'browser.log').read_text())['passed']
    if require_full:
        assert hashes == json.loads((CHECKS / 'full-source.json').read_text()), 'Full suite source changed'
        assert json.loads((CHECKS / 'full-regression.json').read_text())['newFailures'] == []
    return core.digest(json.dumps(hashes, sort_keys=True).encode())


def shell_assets(name, content):
    content, count = re.subn(r'/operator\.js\?v=[^"\s]+', '/operator.js?v=' + VERSION, content)
    assert count == 1
    if name.endswith('service-worker.js'):
        content, count = re.subn(r'const CACHE_NAME = "[^"]+";',
            'const CACHE_NAME = "mbbs-yard-operator-' + VERSION + '";', content)
        assert count == 1
    return content


def build():
    # Staging can run alongside full regression; apply still requires every gate.
    release.source_gate = lambda: source_gate(require_full=False)
    try:
        release.build()
    finally:
        release.source_gate = source_gate


def check():
    source_gate(require_full=False)
    state = core.manifest()
    core.current(state)
    environment = {**os.environ, 'AGGREGATE_SOURCE_ROOT': str(release.RELEASE / 'candidate'), 'AGGREGATE_TEST_NAME': 'mbbs-aggregate-requests'}
    tool = SERVER / 'tools/aggregate-test-env.sh'
    def run(*args, **kwargs):
        return subprocess.run(['sudo', '-n', 'env', 'AGGREGATE_SOURCE_ROOT=' + environment['AGGREGATE_SOURCE_ROOT'],
                               'AGGREGATE_TEST_NAME=mbbs-aggregate-requests', 'bash', str(tool), *args], check=True, **kwargs)
    commands = {
        'candidate-migration.log': ['node', 'src/migrate.js'],
        'candidate-syntax.log': ['sh', '-c', 'node --check src/receiving-repository.js && node --check src/receiving-po-split-progress.js && node --check public/operator.js && node --check public/service-worker.js'],
        'candidate-receiving.log': ['node', 'tools/receiving-split-balance-checks.mjs', 'suite'],
        'candidate-browser.log': ['node', 'tools/receiving-split-balance-browser.mjs'],
        'candidate-page-confirm.log': ['node', '--test', '--test-name-pattern=Customer Pickup reuses|PO Receiving exposes|server exposes',
                                      'test/mbt/unit/operator-page-confirm-ui.contract.test.js'],
        'candidate-existing-fixes.log': ['node', '--test', '--test-concurrency=1',
            'test/mbt/integration/sales-monitor-map.test.js', 'test/mbt/integration/aggregate-request-repository.test.js',
            'test/mbt/integration/aggregate-request-access.test.js']
    }
    run('stop')
    try:
        run('start', stdout=subprocess.DEVNULL)
        run('runner', stdout=subprocess.DEVNULL)
        for log, command in commands.items():
            with (release.RELEASE / log).open('wb') as output:
                run('exec', *command, stdout=output, stderr=subprocess.STDOUT)
            print(json.dumps({'passed': log}), flush=True)
    finally:
        run('stop')
    core.current(state)
    core.save('candidate-checks.json', {'passed': True, 'imageId': state['candidateImageId'], 'sources': state['after']})


def incident_state():
    return json.loads(core.database("""SELECT json_build_object(
        'lines', (SELECT md5(json_agg(t ORDER BY id)::text) FROM
          (SELECT id,line_id,purchase_order_id,quantity,pallet_qty,layer_qty,section_qty,piece_qty,
                  netsuite_received_qty,netsuite_received_baseline_qty,netsuite_active
           FROM purchase_order_lines WHERE purchase_order_id IN (945685,-260063887792827)) t),
        'splits', (SELECT md5(json_agg(t ORDER BY id)::text) FROM
          (SELECT ledger.* FROM dispatch_scm_po_split_lines ledger JOIN dispatch_scm_po_splits split ON split.id=ledger.split_id
           WHERE split.source_po_id=945685) t));"""))


def no_migration():
    core.save('migration-check.json', {'required': False, 'operationalDataChanged': False, 'incidentSourceState': incident_state()})


def verify():
    state = core.manifest()
    core.ready(state['candidateImageId'])
    current = core.metadata(core.APP)
    assert current['configuration'] == state['app']['configuration']
    assert [core.metadata(name) for name in core.DEPENDENCIES] == state['dependencies']
    actual = core.docker('exec', core.APP, 'sha256sum', *['/app/' + name for name in FILES]).decode().splitlines()
    assert {line.split()[1].removeprefix('/app/'): line.split()[0] for line in actual} == state['after']
    script = (SERVER / 'tools/receiving-split-balance-live.mjs').read_text().replace('EXPECTED_ASSETS', json.dumps({
        name: sha for name, sha in state['after'].items() if name.startswith('public/')}))
    probes = json.loads(core.docker('exec', '-i', core.APP, 'node', '--input-type=module', input=script.encode()))
    assert incident_state() == json.loads((release.RELEASE / 'migration-check.json').read_text())['incidentSourceState'], 'Incident source quantities changed during cutover'
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'image': release.IMAGE, 'imageId': current['imageId'], 'runtimeFilesVerified': len(FILES),
        'configurationPreserved': True, 'otherServicesUnchanged': True, 'incidentQuantitiesUnchanged': True, 'checks': probes}
    core.save('deployment-result.json', result)
    print(json.dumps(result), flush=True)


access.source_gate = source_gate
access.shell_assets = shell_assets
release.source_gate = source_gate
release.backup_and_migrate = no_migration
release.verify = verify
if __name__ == '__main__':
    os.umask(0o077)
    {'prepare': access.prepare, 'build': build, 'check': check, 'apply': release.apply, 'verify': verify}[sys.argv[1]]()
