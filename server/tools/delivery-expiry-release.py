"""Publish only the verified delivery expiry files, retaining an image rollback."""
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time

SERVER = Path(__file__).resolve().parents[1]
EVIDENCE = SERVER / 'test-artifacts/delivery-expiry-20261016'
RELEASE = SERVER / 'deployments/delivery-expiry-20261016'
IMAGE = 'mbbs-operator-app:delivery-expiry-20261016'
CHECK_NAME = 'mbbs-delivery-expiry-image-check'
spec = importlib.util.spec_from_file_location('delivery_release_core', SERVER / 'tools/delivery-scm-release.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.RELEASE = RELEASE


def save(name, value):
    (RELEASE / name).write_text(json.dumps(value, indent=2) + '\n')


def evidence():
    final = EVIDENCE / 'final'
    log = (final / 'run.log').read_text()
    assert 'Isolated Delivery expiry final run passed: 35 file(s), 275 test(s).' in log
    assert 'types: 0' in log and 'lint: 0' in log and 'syntax: 0' in log
    assert 'teardown_exit=0' in (final / 'teardown.log').read_text()
    mutations = json.loads((final / 'results/mutations.json').read_text())
    assert len(mutations) == 7 and all(row['killed'] and row['restored'] for row in mutations)
    assert all(row.get('propertyKilled', True) for row in mutations)
    coverage = json.loads((final / 'results/changed-coverage.json').read_text())
    assert not coverage['unmeasured'] and not coverage['uncovered']
    sources = json.loads((final / 'results/source-hashes.json').read_text())
    for name, row in sources.items():
        assert core.sha((SERVER / name).read_bytes()) == row['sha256'], 'Verified source changed: ' + name
    return {name: row['sha256'] for name, row in sources.items()}


def current(data):
    assert core.metadata(core.APP) == data['app'], 'Live app changed; recapture before release'
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies'], 'Dependency changed'
    assert json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT)) == data['beforeTree']


def cleanup_check():
    subprocess.run(['docker', 'rm', '-fv', CHECK_NAME], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for args, filename in [(['ps'], 'docker-ps.log'), (['ps', '-a'], 'docker-ps-a.log')]:
        (RELEASE / filename).write_bytes(core.docker(*args, '--format', '{{.Names}} {{.Status}}'))
    assert not core.docker('ps', '-a', '--filter', 'name=^/' + CHECK_NAME + '$', '--format', '{{.ID}}').strip()


def prepare():
    hashes = evidence()
    app = core.metadata(core.APP)
    before = json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT))
    for name in hashes:
        original = EVIDENCE / 'baseline' / Path(name).name
        if original.exists():
            assert core.sha(original.read_bytes()) == before[name], 'Delivery source changed in production: ' + name
        else:
            assert name not in before
    data = {'app': app, 'dependencies': [core.metadata(name) for name in core.DEPENDENCIES],
            'beforeTree': before, 'sourceHashes': hashes, 'candidateTree': {**before, **hashes}}
    RELEASE.mkdir(exist_ok=False)
    candidate = RELEASE / 'candidate'
    for name in hashes:
        destination = candidate / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SERVER / name, destination)
        original = EVIDENCE / 'baseline' / Path(name).name
        if original.exists():
            previous = RELEASE / 'before' / name
            previous.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(original, previous)
    shutil.copy2(EVIDENCE / 'changes.patch', RELEASE / 'changes.patch')
    rollback = IMAGE + '-rollback'
    core.docker('tag', app['imageId'], rollback)
    (candidate / 'Dockerfile').write_text('FROM ' + rollback + '\n' + ''.join(
        'COPY --chown=node:node ' + name + ' /app/' + name + '\n' for name in hashes))
    (RELEASE / 'compose.release.yml').write_text('services:\n  app:\n    image: ' + IMAGE + '\n')
    (RELEASE / 'compose.rollback.yml').write_text('services:\n  app:\n    image: ' + app['imageId'] + '\n')
    save('manifest.json', data)
    with (RELEASE / 'build.log').open('wb') as output:
        subprocess.run(['docker', 'build', '--pull=false', '--network=none', '-t', IMAGE, str(candidate)],
                       stdout=output, stderr=subprocess.STDOUT, check=True, timeout=120)
    data['candidateImageId'] = core.docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    save('manifest.json', data)
    try:
        actual = json.loads(core.bounded(data['candidateImageId'], CHECK_NAME, 'node', '-e', core.HASH_SCRIPT))
        assert actual == data['candidateTree'], 'Unexpected runtime file change'
        core.bounded(data['candidateImageId'], CHECK_NAME, 'node', '--input-type=module', '-e',
                     "import assert from 'node:assert/strict'; import {deliveryExpiryDeadline} from './public/delivery-request-expiry-time.js'; "
                     "assert.equal(deliveryExpiryDeadline('530pm','2028-10-01T12:00Z'),'2028-10-01T21:30:00.000Z');")
    finally:
        cleanup_check()
    core.config_check(data)
    configs = [json.loads(subprocess.check_output(core.compose(data, mode) + ['config', '--format', 'json'], cwd=SERVER.parent))
               for mode in ['release', 'rollback']]
    for config in configs:
        config['services']['app'].pop('image')
    assert configs[0] == configs[1], 'Compose configuration would change'
    current(data)
    save('image-check.json', {'passed': True, 'imageId': data['candidateImageId'], 'runtimeFiles': len(actual)})
    print(json.dumps({'prepared': True, 'changedFiles': list(hashes), 'runtimeFilesVerified': len(actual)}), flush=True)


def verify():
    data = core.state()
    core.ready(data['candidateImageId'])
    actual = core.metadata(core.APP)
    assert actual['configuration'] == data['app']['configuration']
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies']
    assert json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT)) == data['candidateTree']
    public = {name: digest for name, digest in data['sourceHashes'].items() if name.startswith('public/')}
    http = core.http_check(public, ['/api/sales/delivery-requests', '/api/dispatch/delivery-requests'])
    cleanup_check()
    result = {'deployed': True, 'at': core.now(), 'imageId': actual['imageId'], 'changedFiles': list(data['sourceHashes']),
              'runtimeFilesVerified': len(data['candidateTree']), 'configurationPreserved': True,
              'dependenciesUnchanged': True, 'schemaChanged': False, 'testsPassed': 275, 'http': http}
    save('deployment-result.json', result)
    (EVIDENCE / 'deployment-result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result), flush=True)


def apply():
    data = core.state()
    evidence()
    current(data)
    assert json.loads((RELEASE / 'image-check.json').read_text())['imageId'] == data['candidateImageId']
    core.config_check(data)
    for attempt in range(20):
        try:
            core.assert_no_active_operations(core.preflight())
            break
        except AssertionError:
            if attempt == 19:
                raise
            time.sleep(2)
    current(data)
    args = ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app']
    try:
        with (RELEASE / 'publish.log').open('wb') as output:
            subprocess.run(core.compose(data, 'release') + args, cwd=SERVER.parent,
                           stdout=output, stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except BaseException:
        with (RELEASE / 'rollback.log').open('wb') as output:
            subprocess.run(core.compose(data, 'rollback') + args, cwd=SERVER.parent,
                           stdout=output, stderr=subprocess.STDOUT, check=True, timeout=60)
        core.ready(data['app']['imageId'])
        save('rollback-result.json', {'previousImageRestored': True})
        raise


if __name__ == '__main__':
    {'prepare': prepare, 'apply': apply, 'verify': verify}[sys.argv[1]]()
