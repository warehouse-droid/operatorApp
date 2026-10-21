"""Release the verified Delivery Request SO/TO linkage over the live image."""
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.request

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
EVIDENCE = SERVER / 'test-artifacts/delivery-transfer-orders-20261015'
RELEASE = SERVER / 'deployments/delivery-transfer-orders-20261015'
FILES = ['src/delivery-request-domain.js', 'src/delivery-request-documents.js', 'src/delivery-request-orders.js',
         'src/delivery-request-repository.js', 'src/delivery-request-router.js', 'public/delivery-requests.js',
         'public/delivery-requests.html', 'public/delivery-request-alert.js', 'public/app-sidebar.js']
IMAGE = 'mbbs-operator-app:delivery-transfer-orders-20261015'
CHECK_NAME = 'mbbs-delivery-transfer-orders-image-check'
spec = importlib.util.spec_from_file_location('delivery_release', SERVER / 'tools/delivery-scm-release.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.RELEASE = RELEASE


def save(name, data):
    (RELEASE / name).write_text(json.dumps(data, indent=2) + '\n')


def evidence():
    final = EVIDENCE / 'final'
    assert 'Isolated Delivery transfer green run passed: 32 file(s), 252 test(s).' in (final / 'checks.log').read_text()
    assert 'teardown_exit=0' in (final / 'teardown.log').read_text()
    for name in ['types', 'lint']:
        assert json.loads((final / 'results' / (name + '-status.json')).read_text())['exitCode'] == 0
    mutations = json.loads((final / 'results/mutations/results.json').read_text())
    assert mutations['restored'] and len(mutations['mutants']) == 6
    assert all(row['killed'] and (not row.get('propertyOnly') or row['propertyOnly']['killed']) for row in mutations['mutants'])
    coverage = json.loads((final / 'results/changed-coverage.json').read_text())
    assert coverage['covered'] == coverage['total'] and not coverage['uncovered'] and not coverage['unmeasured']
    hashes = json.loads((final / 'results/source-hashes.json').read_text())
    assert set(hashes) == set(FILES)
    for name, digest in hashes.items():
        assert core.sha((SERVER / name).read_bytes()) == digest, 'Workspace changed: ' + name
        assert core.sha((EVIDENCE / 'candidate' / name).read_bytes()) == digest, 'Candidate changed: ' + name
    return hashes


def current(data):
    assert core.metadata(core.APP) == data['app'], 'Live app changed; recapture before release'
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies'], 'Dependency changed'
    assert json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT)) == data['beforeTree']


def cleanup_check():
    subprocess.run(['docker', 'rm', '-fv', CHECK_NAME], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for args, filename in [(['ps'], 'docker-ps.log'), (['ps', '-a'], 'docker-ps-a.log')]:
        (RELEASE / filename).write_bytes(core.docker(*args, '--format', '{{.Names}} {{.Status}}'))
    assert not core.docker('ps', '-a', '--filter', 'name=^/' + CHECK_NAME + '$', '--format', '{{.ID}}').strip()
    with urllib.request.urlopen('http://127.0.0.1:3000/health', timeout=5) as response:
        assert response.status == 200 and json.loads(response.read())['ok']


def prepare():
    hashes = evidence()
    data = json.loads((EVIDENCE / 'capture.json').read_text())
    current(data)
    RELEASE.mkdir(exist_ok=False)
    candidate = RELEASE / 'candidate'
    for name in FILES:
        for folder, source in [('before', EVIDENCE / 'baseline'), ('candidate', EVIDENCE / 'candidate')]:
            if not (source / name).exists():
                assert folder == 'before' and name == 'src/delivery-request-orders.js'
                continue
            destination = RELEASE / folder / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source / name, destination)
    shutil.copy2(EVIDENCE / 'changes.patch', RELEASE / 'changes.patch')
    data.update(files=FILES, sourceHashes=hashes, candidateTree={**data['beforeTree'], **hashes})
    assert sorted(name for name in data['candidateTree'] if data['beforeTree'].get(name) != data['candidateTree'][name]) == sorted(FILES)
    rollback = IMAGE + '-rollback'
    core.docker('tag', data['app']['imageId'], rollback)
    (candidate / 'Dockerfile').write_text('FROM ' + rollback + '\n' + ''.join(
        'COPY --chown=node:node ' + name + ' /app/' + name + '\n' for name in FILES))
    (RELEASE / 'compose.release.yml').write_text('services:\n  app:\n    image: ' + IMAGE + '\n')
    (RELEASE / 'compose.rollback.yml').write_text('services:\n  app:\n    image: ' + data['app']['imageId'] + '\n')
    save('manifest.json', data)
    with (RELEASE / 'build.log').open('wb') as output:
        subprocess.run(['docker', 'build', '--pull=false', '--network=none', '-t', IMAGE, str(candidate)],
                       stdout=output, stderr=subprocess.STDOUT, check=True, timeout=120)
    data['candidateImageId'] = core.docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    save('manifest.json', data)
    try:
        actual = json.loads(core.bounded(data['candidateImageId'], CHECK_NAME, 'node', '-e', core.HASH_SCRIPT))
        assert actual == data['candidateTree'], 'Built image contains unexpected source changes'
    finally:
        cleanup_check()
    core.config_check(data)
    configs = [json.loads(subprocess.check_output(core.compose(data, mode) + ['config', '--format', 'json'], cwd=ROOT))
               for mode in ['release', 'rollback']]
    for config in configs:
        config['services']['app'].pop('image')
    assert configs[0] == configs[1], 'Compose configuration would change'
    current(data)
    save('image-check.json', {'passed': True, 'imageId': data['candidateImageId'], 'runtimeFiles': len(actual)})
    print(json.dumps({'prepared': True, 'changedFiles': FILES, 'runtimeFilesVerified': len(actual)}), flush=True)


def verify():
    data = core.state()
    core.ready(data['candidateImageId'])
    actual = core.metadata(core.APP)
    assert actual['imageId'] == data['candidateImageId']
    assert actual['configuration'] == data['app']['configuration']
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies']
    assert json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT)) == data['candidateTree']
    public = {name: digest for name, digest in data['sourceHashes'].items() if name.startswith('public/')}
    http = core.http_check(public, ['/api/sales/delivery-requests', '/api/dispatch/delivery-requests'])
    cleanup_check()
    result = {'deployed': True, 'at': core.now(), 'imageId': actual['imageId'], 'changedFiles': FILES,
              'runtimeFilesVerified': len(data['candidateTree']), 'configurationPreserved': True,
              'dependenciesUnchanged': True, 'schemaChanged': False, 'testsPassed': 252, 'http': http}
    save('deployment-result.json', result)
    (EVIDENCE / 'deployment-result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result), flush=True)


def apply():
    data = core.state()
    evidence()
    current(data)
    image_check = json.loads((RELEASE / 'image-check.json').read_text())
    assert image_check['passed'] and image_check['imageId'] == data['candidateImageId']
    assert core.docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip() == data['candidateImageId']
    core.config_check(data)
    for attempt in range(30):
        active = core.preflight()
        try:
            core.assert_no_active_operations(active)
            break
        except AssertionError:
            if attempt == 29:
                raise
            time.sleep(2)
    current(data)
    args = ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app']
    try:
        with (RELEASE / 'publish.log').open('wb') as output:
            subprocess.run(core.compose(data, 'release') + args, cwd=ROOT,
                           stdout=output, stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except BaseException:
        with (RELEASE / 'rollback.log').open('wb') as output:
            subprocess.run(core.compose(data, 'rollback') + args, cwd=ROOT,
                           stdout=output, stderr=subprocess.STDOUT, check=True, timeout=60)
        core.ready(data['app']['imageId'])
        save('rollback-result.json', {'previousImageRestored': True})
        raise


if __name__ == '__main__':
    {'prepare': prepare, 'apply': apply, 'verify': verify}[sys.argv[1]]()
