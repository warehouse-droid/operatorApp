"""Deploy the three updates explicitly authorized on 2026-10-22."""
import atexit
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import urllib.request

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, SERVER / 'tools' / filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


release = module('combined_scm_release', 'scm-po-to-handoff-release.py')
cargo = module('combined_cargo_release', 'operator-progress-cargo-release.py')
core = release.core
RELEASE = SERVER / 'deployments/scm-cargo-pickup-20261022'
IMAGE = 'mbbs-operator-app:scm-cargo-pickup-20261022'
MIGRATION = '306_delivery_pickup_packing_release.sql'
MIGRATION_HASH = 'a7389af2f2b9049619904fb6ca4f8862b6733ba4187f368597e5ccc018e05145'
SCM = SERVER / 'deployments/scm-po-to-handoff-20261022'
FILES = [*release.FILES, 'src/operator-order-progress-repository.js', 'migrations/' + MIGRATION]
release.RELEASE = core.RELEASE = RELEASE
release.IMAGE = IMAGE
release.ROLLBACK = IMAGE + '-rollback'
release.FILES = FILES
release.CHECK = 'mbbs-scm-cargo-pickup-image-check'
TESTS = [
    'test/dispatch/unit/operator-progress-cargo.test.js',
    'test/dispatch/integration/operator-progress-cargo.test.js',
    'test/mbt/unit/smart-scm-po-to-handoff.test.js',
    'test/mbt/property/smart-scm-po-to-handoff.property.test.js',
    'test/mbt/unit/smart-scm-po-to-handoff-ui.test.js',
    'test/mbt/integration/smart-scm-po-to-handoff.test.js',
    'test/dispatch/integration/split-dialog-fast.test.js',
    'test/dispatch/integration/sales-split-allocation-unsplit.test.js',
    'test/dispatch/integration/resplit-sibling-group-allocations.test.js',
    'test/dispatch/integration/scm-po-split-editing.test.js',
    'test/mbt/integration/smart-scm-phased-settings.test.js',
    'test/mbt/integration/smart-scm-manual-to-backorder.test.js',
    'test/mbt/integration/delivery-pickup-release.test.js',
    'test/mbt/integration/customer-pickup-yard-scope.test.js',
    'test/mbt/integration/operator-customer-pickup-photo-gate.red.test.js',
    'test/mbt/integration/group-underpack.test.js',
]
RULE_SQL = """SELECT json_build_object(
  'functionDigest',(SELECT md5(pg_get_functiondef(oid)) FROM pg_proc
    WHERE oid=to_regprocedure('release_delivery_packing_on_pickup()')),
  'triggerDefinition',(SELECT pg_get_triggerdef(oid) FROM pg_trigger
    WHERE tgrelid='sales_orders'::regclass AND tgname='release_delivery_packing_on_pickup'),
  'enabled',(SELECT tgenabled FROM pg_trigger WHERE tgrelid='sales_orders'::regclass
    AND tgname='release_delivery_packing_on_pickup'),
  'migrationRecorded',EXISTS(SELECT 1 FROM schema_migrations
    WHERE filename='306_delivery_pickup_packing_release.sql'));"""


def rule_state():
    return json.loads(core.sql("BEGIN READ ONLY; SET LOCAL statement_timeout='5s';" + RULE_SQL + 'COMMIT;'))


def evidence():
    scm_record = RELEASE / 'scm-component-validation.json'
    scm = json.loads((scm_record if scm_record.exists() else SCM / 'validation.json').read_text())
    if scm_record.exists():
        assert core.sha((RELEASE / 'scm-component-evidence.md').read_bytes()) == scm['evidenceSha256']
    progress = json.loads((SERVER / 'test/dispatch/specs/operator-progress-cargo-20261022-evidence.json').read_text())
    assert scm['newFailures'] == 0 and scm['passed'] >= 122
    assert scm['mutationKilled'] == scm['mutationTotal'] == 6
    assert scm['policyCoverage'] == 100
    assert scm['lint'] == scm['types'] == scm['syntax'] == 'passed'
    assert progress['passed'] and progress['newFailures'] == 0
    assert progress['mutations']['killed'] == progress['mutations']['total'] == 6
    expected = {**scm['sourceHashes'], **progress['sourceHashes'], 'migrations/' + MIGRATION: MIGRATION_HASH}
    assert release.source_hashes() == expected, 'Previously tested source changed'
    assert core.sha((SERVER / 'test/mbt/integration/delivery-pickup-release.test.js').read_bytes()) == '53b1432290545a7be55992fa47ec88687aa4de9f1cb65853a4b71cb07b8ec1c3'
    return expected


def checked():
    data = core.state()
    assert evidence() == data['sourceHashes']
    return data


def json_result(output):
    # Compose may print a progress message before the command's JSON result.
    rows = [json.loads(line) for line in output.splitlines() if line.startswith('{')]
    assert len(rows) == 1, 'Expected exactly one structured command result'
    return rows[0]


def capture():
    hashes = evidence()
    app = core.metadata(core.APP)
    dependencies = [core.metadata(name) for name in core.DEPENDENCIES]
    before = json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT))
    scm = json.loads((SCM / 'manifest.json').read_text())
    progress = json.loads((SERVER / 'deployments/operator-progress-cargo-20261022/manifest.json').read_text())
    baseline = {name: scm['beforeTree'].get(name) for name in scm['files']}
    baseline.update(progress['beforeHashes'])
    baseline['migrations/' + MIGRATION] = None
    assert all(before.get(name) == value for name, value in baseline.items()), 'Live scoped baseline changed'
    packages = {}
    for name in ['package.json', 'package-lock.json']:
        value = core.docker('exec', core.APP, 'cat', '/app/' + name)
        packages[name] = core.sha(value)
        workspace = (SERVER / name).read_bytes()
        if name == 'package-lock.json':
            assert value == workspace, 'Test dependency lock differs from production'
        else:
            live_package, test_package = json.loads(value), json.loads(workspace)
            assert {k: v for k, v in live_package.items() if k != 'scripts'} == {k: v for k, v in test_package.items() if k != 'scripts'}
            assert live_package['scripts']['migrate'] == test_package['scripts']['migrate']
    rule = rule_state()
    assert rule == {'functionDigest': None, 'triggerDefinition': None, 'enabled': None, 'migrationRecorded': False}
    RELEASE.mkdir(parents=True, exist_ok=False)
    for name in FILES:
        if name in before:
            path = RELEASE / 'before' / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(core.docker('exec', core.APP, 'cat', '/app/' + name))
            assert core.sha(path.read_bytes()) == before[name]
    core.save('manifest.json', {'at': core.now(), 'app': app, 'dependencies': dependencies,
        'authorization': ['deploy with the smart SCM update',
            'also include the Delivery > pickup automatic release update as well'],
        'files': FILES, 'sourceHashes': hashes, 'beforeTree': before,
        'candidateTree': {**before, **hashes}, 'packages': packages,
        'ruleBefore': rule, 'orderBefore': cargo.order_state()})
    release.current(checked())
    print(json.dumps({'captured': True, 'files': FILES}), flush=True)


def validate():
    data = checked()
    assert os.environ.get('MBBS_TEST_ARTIFACT_DIR'), 'Use the repository retention runner'
    artifact = Path(os.environ['MBBS_TEST_ARTIFACT_DIR'])
    artifact.chmod(0o777)
    project = 'mbbs-combined-release-' + str(os.getpid())
    test_image = 'mbbs-combined-release-test:' + str(os.getpid())
    override = artifact / 'compose.json'
    compose = ['docker', 'compose', '-p', project, '-f', str(ROOT / 'docker-compose.mbt-test.yml'), '-f', str(override)]
    cleaned = False

    def cleanup():
        nonlocal cleaned
        if cleaned:
            return
        if override.exists():
            subprocess.run(compose + ['down', '--volumes', '--remove-orphans'], check=True, timeout=60)
        subprocess.run(['docker', 'rm', '-fv', release.CHECK], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(['docker', 'image', 'rm', test_image], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for resource in ['container', 'volume', 'network']:
            assert not core.docker(resource, 'ls', '-q', '--filter', 'label=com.docker.compose.project=' + project).strip()
        containers = {key: core.docker(*args, '--format', '{{.Names}} {{.Status}}').decode().splitlines()
            for key, args in [('running', ['ps']), ('all', ['ps', '-a'])]}
        for rows in containers.values():
            assert {row.split()[0] for row in rows} == {core.APP, *core.DEPENDENCIES}
        with urllib.request.urlopen('http://127.0.0.1:3000/health', timeout=5) as response:
            assert json.loads(response.read())['ok']
        core.save('test-cleanup.json', {'at': core.now(), 'project': project, 'passed': True, 'containers': containers})
        print(json.dumps({'cleanupPassed': True, 'containers': containers}), flush=True)
        cleaned = True

    def command(label, args):
        log = artifact / (label + '.log')
        with log.open('wb') as output:
            result = subprocess.run(args, cwd=ROOT, stdout=output, stderr=subprocess.STDOUT, timeout=300)
        content = log.read_text()
        if result.returncode:
            print(content[-18000:], flush=True)
            raise RuntimeError(label + ' failed: ' + str(result.returncode))
        print(json.dumps({'stage': label, 'passed': True}), flush=True)
        return content

    atexit.register(cleanup)
    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, lambda number, frame: sys.exit(128 + number))
    try:
        command('memory-budget', ['python3', str(ROOT / 'docker/verify-memory-limits.py')])
        actual = json.loads(core.bounded(data['candidateImageId'], release.CHECK, 'node', '-e', core.HASH_SCRIPT))
        assert actual == data['candidateTree']
        runtime = artifact / 'runtime'
        runtime.mkdir(mode=0o755)
        archive = core.bounded(data['candidateImageId'], release.CHECK, 'tar', '-cf', '-', '-C', '/app',
            'src', 'public', 'migrations', 'package.json', 'package-lock.json')
        with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
            stream.extractall(runtime, filter='data')
        assert core.files_at(runtime) == data['candidateTree']
        build = artifact / 'build'
        build.mkdir()
        for name in ['package.json', 'package-lock.json']:
            assert core.sha((runtime / name).read_bytes()) == data['packages'][name]
            shutil.copy2(runtime / name, build / name)
        shutil.copy2(SERVER / 'Dockerfile.test', build / 'Dockerfile.test')
        command('test-dependencies', ['docker', 'build', '--target', 'test-dependencies', '-f', str(build / 'Dockerfile.test'), '-t', test_image, str(build)])
        mounts = [{'type': 'bind', 'source': str(artifact), 'target': '/app/test-artifacts'}]
        for name in ['src', 'public', 'migrations', 'package.json', 'package-lock.json']:
            mounts.append({'type': 'bind', 'source': str(runtime / name), 'target': '/app/' + name, 'read_only': True})
        for name in ['test', 'tools', 'contracts', '.env.example', 'eslint.mbt.config.js', 'netsuite-ifir-posting-restlet.js']:
            mounts.append({'type': 'bind', 'source': str(SERVER / name), 'target': '/app/' + name, 'read_only': True})
        services = {name: {'image': test_image, 'pull_policy': 'never', 'user': 'node', 'volumes': mounts,
            'labels': {'com.mbbs.lifecycle': 'disposable-test'}} for name in ['test', 'migrate']}
        services['db'] = {'labels': {'com.mbbs.lifecycle': 'disposable-test'}}
        override.write_text(json.dumps({'services': services}))
        command('disposable-db', compose + ['up', '-d', '--wait', 'db'])
        command('candidate-migrations', compose + ['run', '--rm', '--no-deps', '-T', 'migrate'])
        mounted = command('candidate-runtime', compose + ['run', '--rm', '--no-deps', '-T', 'test', 'node', '-e', core.HASH_SCRIPT])
        assert json_result(mounted) == data['candidateTree']
        output = command('combined-tests', compose + ['run', '--rm', '--no-deps', '-T', 'test',
            'node', '--test', '--test-concurrency=1', *TESTS])
        counts = {name: int(re.search(r'^# ' + name + r' (\d+)$', output, re.M)[1])
            for name in ['tests', 'pass', 'fail', 'skipped', 'cancelled']}
        assert counts['tests'] == counts['pass'] and counts['fail'] == counts['skipped'] == counts['cancelled'] == 0
        rule = json_result(command('candidate-rule', compose + ['exec', '-T', 'db', 'psql', '-X', '-qAt', '-v',
            'ON_ERROR_STOP=1', '-U', 'mbt_test', '-d', 'mbt_test', '-c', RULE_SQL]))
        assert rule['functionDigest'] and rule['enabled'] == 'O' and rule['migrationRecorded']
        core.save('validation.json', {'passed': True, 'at': core.now(), 'imageId': data['candidateImageId'],
            'tests': counts, 'testFiles': TESTS, 'sourceHashes': data['sourceHashes'],
            'runtimeFilesVerified': len(actual), 'rule': rule,
            'testHashes': {name: core.sha((SERVER / name).read_bytes()) for name in TESTS}})
        core.save('image-check.json', {'passed': True, 'imageId': data['candidateImageId'], 'filesVerified': len(actual)})
        print(json.dumps({'combinedValidation': True, **counts}), flush=True)
    finally:
        cleanup()


def verify():
    data = checked()
    validation = json.loads((RELEASE / 'validation.json').read_text())
    core.ready(data['candidateImageId'])
    live = core.metadata(core.APP)
    assert live['configuration'] == data['app']['configuration']
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies']
    assert json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT)) == data['candidateTree']
    for name, url in [('public/scm-smart-proposals.js', '/scm-smart-proposals.js'), ('public/scm-smart.html', '/scm/smart')]:
        with urllib.request.urlopen('http://127.0.0.1:3000' + url, timeout=10) as response:
            assert response.status == 200 and core.sha(response.read()) == data['sourceHashes'][name]
    rule = rule_state()
    assert rule == validation['rule'], 'Live database rule differs from the tested rule'
    order = cargo.order_state()
    if order['canonical'] == data['orderBefore']['canonical']:
        assert order['operatorStatus'] == 'open' and order['yardStatus'] == 'Open'
    containers = {key: core.docker(*args, '--format', '{{.Names}} {{.Status}}').decode().splitlines()
        for key, args in [('running', ['ps']), ('all', ['ps', '-a'])]}
    for rows in containers.values():
        assert {row.split()[0] for row in rows} == {core.APP, *core.DEPENDENCIES}
    result = {'deployed': True, 'at': core.now(), 'image': IMAGE, 'imageId': live['imageId'],
        'healthy': True, 'configurationPreserved': True, 'dependenciesUnchanged': True,
        'filesVerified': len(data['candidateTree']), 'changedFiles': FILES, 'rollbackImage': release.ROLLBACK,
        'order': order, 'orderDataUnchanged': order['canonical'] == data['orderBefore']['canonical'], 'rule': rule}
    core.save('containers.json', containers)
    core.save('deployed.json', result)
    print(json.dumps(result), flush=True)


def deploy():
    data = checked()
    release.current(data)
    validation = json.loads((RELEASE / 'validation.json').read_text())
    assert validation['passed'] and validation['imageId'] == data['candidateImageId']
    assert json.loads((RELEASE / 'test-cleanup.json').read_text())['passed']
    assert rule_state() == data['ruleBefore'], 'Database rule changed before deployment'
    core.config_check(data)
    core.assert_no_active_operations(core.preflight())
    installed = False
    try:
        subprocess.run(['python3', str(SERVER / 'tools/delivery-pickup-release-deploy.py'), '--install-rule'], check=True, timeout=30)
        installed = True
        assert rule_state() == validation['rule']
        subprocess.run(release.compose(data, 'release') + ['up', '-d', '--no-deps', '--no-build', 'app'], check=True, timeout=120)
        verify()
    except BaseException as error:
        subprocess.run(release.compose(data, 'rollback') + ['up', '-d', '--no-deps', '--no-build', 'app'], check=True, timeout=120)
        core.ready(data['app']['imageId'])
        current_rule = rule_state()
        if installed or current_rule == validation['rule']:
            assert current_rule == validation['rule'], 'Rule changed; refusing an unsafe schema rollback'
            core.sql("BEGIN; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='15s'; "
                'DROP TRIGGER release_delivery_packing_on_pickup ON sales_orders; '
                'DROP FUNCTION release_delivery_packing_on_pickup(); '
                "DELETE FROM schema_migrations WHERE filename='306_delivery_pickup_packing_release.sql'; COMMIT;")
        core.save('rollback.json', {'at': core.now(), 'error': str(error), 'rule': rule_state(), 'appImageId': core.metadata(core.APP)['imageId']})
        raise


release.checked = checked

if __name__ == '__main__':
    os.umask(0o077)
    {'capture': capture, 'build': release.build, 'validate': validate, 'deploy': deploy, 'verify': verify}[sys.argv[1]]()
