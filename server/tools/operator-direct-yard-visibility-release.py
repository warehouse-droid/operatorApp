"""Release only the clarified operator-list filter over the deployed MBR image."""
import difflib
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import time

SERVER = Path(__file__).resolve().parents[1]
REPO = SERVER.parent
OUT = SERVER / 'test-artifacts/operator-direct-yard-visibility'
RELEASE = SERVER / 'deployments/operator-direct-yard-visibility-20261013'
IMAGE = 'mbbs-operator-app:operator-direct-yard-visibility-20261013'
FILE = 'src/delivery-repository.js'
spec = importlib.util.spec_from_file_location('direct_release', SERVER / 'tools/linked-direct-ship-sync-release.py')
direct = importlib.util.module_from_spec(spec)
spec.loader.exec_module(direct)


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + '\n')


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def metadata(name):
    row = json.loads(direct.docker('inspect', name))[0]
    config = {key: value for key, value in row['Config'].items() if key not in ['Image', 'Labels', 'Hostname']}
    config['Env'] = sorted(config.get('Env') or [])
    host = dict(row['HostConfig'])
    host['Binds'] = sorted(host.get('Binds') or [])
    return {'image': row['Image'], 'imageRef': row['Config']['Image'],
        'runtimeHash': direct.digest(json.dumps({'config': config, 'host': host}, sort_keys=True).encode()),
        'compose': row['Config']['Labels']}


def logged(label, args):
    with (OUT / (label + '.log')).open('wb') as log:
        result = subprocess.run(args, cwd=REPO, stdout=log, stderr=subprocess.STDOUT)
    if result.returncode:
        print((OUT / (label + '.log')).read_text()[-5000:])
    return result.returncode


def prepare(revise=False):
    context = RELEASE / 'context'
    if (RELEASE / 'state.json').exists():
        assert revise and not (OUT / 'deployment.json').exists(), 'Release is already prepared or deployed'
        prior = json.loads((RELEASE / 'state.json').read_text())
        for name, key in [(direct.APP, 'app'), (direct.WORKER, 'worker')]:
            assert metadata(name) == prior[key], name + ' changed before candidate revision'
        archive = OUT / ('candidate-before-' + prior['sourceHashes'][FILE][:12])
        archive.mkdir()
        for path in [RELEASE / 'state.json', OUT / 'prepared.json', context / FILE,
            OUT / 'candidate-checks.log', OUT / 'yard-and-direct-regressions.log', OUT / 'cleanup.json']:
            if path.exists():
                (archive / path.name).write_bytes(path.read_bytes())
        (OUT / 'prepared.json').unlink(missing_ok=True)
    state = {'app': metadata(direct.APP), 'worker': metadata(direct.WORKER)}
    assert state['app']['image'] == state['worker']['image']
    assert state['app']['imageRef'] == 'mbbs-operator-app:mbr-direct-ship-20261013'
    for name in [direct.APP, direct.WORKER]:
        row = json.loads(direct.docker('inspect', name))[0]
        assert 'MBR_CONTRACTS_ENABLED=true' in row['Config']['Env']
    live = OUT / 'baseline/production-delivery-repository.js'
    assert sha(live) == direct.docker('exec', direct.APP, 'sha256sum', '/app/' + FILE).split()[0]
    baseline = OUT / 'baseline/delivery-repository.js'
    working = SERVER / FILE
    result = subprocess.run(['git', 'merge-file', '-p', str(live), str(baseline), str(working)], capture_output=True)
    assert result.returncode == 0, 'Scoped filter patch conflicts with live source'
    target = context / FILE
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(result.stdout)
    assert b'<<<<<<< ' not in result.stdout
    (OUT / 'production.patch').write_text(''.join(difflib.unified_diff(
        live.read_text().splitlines(keepends=True), target.read_text().splitlines(keepends=True),
        fromfile='production/' + FILE, tofile='release/' + FILE)))
    (context / 'Dockerfile').write_text('FROM ' + state['app']['imageRef'] + '\nCOPY ' + FILE + ' /app/' + FILE + '\n')
    state.update({'sourceHashes': {FILE: sha(target)}, 'beforeHash': sha(live),
        'workspaceBeforeHash': sha(baseline), 'workspaceAfterHash': sha(working)})
    save(RELEASE / 'state.json', state)
    save(RELEASE / 'compose.release.json', {'services': {name: {'image': IMAGE, 'pull_policy': 'never'}
        for name in ['app', 'webhook-worker']}})
    save(RELEASE / 'compose.rollback.json', {'services': {name: {'image': state[key]['imageRef'], 'pull_policy': 'never'}
        for name, key in [('app', 'app'), ('webhook-worker', 'worker')]}})
    build()


def build():
    state = json.loads((RELEASE / 'state.json').read_text())
    context = RELEASE / 'context'
    assert not (OUT / 'prepared.json').exists(), 'Candidate is already built'
    assert json.loads(direct.docker('image', 'inspect', state['app']['imageRef']))[0]['Id'] == state['app']['image']
    assert sha(context / FILE) == state['sourceHashes'][FILE]
    (context / 'Dockerfile').write_text('FROM ' + state['app']['imageRef'] + '\nCOPY ' + FILE + ' /app/' + FILE + '\n')
    assert logged('candidate-build', ['docker', 'build', '--network=none', '-t', IMAGE, str(context)]) == 0
    image_id = json.loads(direct.docker('image', 'inspect', IMAGE))[0]['Id']
    save(OUT / 'prepared.json', {'image': IMAGE, 'imageId': image_id, 'sourceHashes': state['sourceHashes'],
        'preservesMbr': True, 'preservesDirectShipSync': True, 'databaseChanges': False})
    print(json.dumps({'prepared': IMAGE, 'sourceHashes': state['sourceHashes']}))


def deploy():
    state = json.loads((RELEASE / 'state.json').read_text())
    prepared = json.loads((OUT / 'prepared.json').read_text())
    checked = json.loads((OUT / 'candidate-validation.json').read_text())
    assert checked['passed'] and checked['cleanupVerified']
    assert checked['imageId'] == prepared['imageId'] and checked['sourceHashes'] == state['sourceHashes']
    results = json.loads((OUT / 'checks.json').read_text())
    assert results['sourceHashes'] == state['sourceHashes']
    assert results['results']['yard-and-direct-regressions']['pass'] == 139
    assert results['results']['mbr-regressions']['pass'] == 34
    assert all(results['results']['mutant-' + name]['exit'] == 1 for name in results['mutants'])
    lint = json.loads((OUT / 'lint.json').read_text())
    assert lint['exit'] == 0 and lint['sourceHashes'] == state['sourceHashes']
    coverage = json.loads((OUT / 'changed-coverage.json').read_text())
    assert coverage['covered'] == coverage['changedExecutableLines'] and not coverage['missing']
    assert json.loads(direct.docker('image', 'inspect', IMAGE))[0]['Id'] == prepared['imageId']
    assert sha(RELEASE / 'context' / FILE) == state['sourceHashes'][FILE]
    assert sha(SERVER / FILE) == state['workspaceAfterHash'], 'Source changed after candidate preparation'
    for name, key in [(direct.APP, 'app'), (direct.WORKER, 'worker')]:
        assert metadata(name) == state[key], name + ' changed after preparation'
    command = ['sudo', '-n', *direct.compose(state, RELEASE / 'compose.release.json')]
    try:
        assert logged('production-deploy', command + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never',
            'app', 'webhook-worker']) == 0
        assert direct.healthy(), 'Application health did not recover'
        for name, key in [(direct.APP, 'app'), (direct.WORKER, 'worker')]:
            current = metadata(name)
            assert current['image'] == prepared['imageId'], name + ' image mismatch'
            assert current['runtimeHash'] == state[key]['runtimeHash'], name + ' runtime settings changed'
            assert direct.docker('exec', name, 'sha256sum', '/app/' + FILE).split()[0] == state['sourceHashes'][FILE]
    except BaseException:
        rollback = ['sudo', '-n', *direct.compose(state, RELEASE / 'compose.rollback.json')]
        logged('production-rollback', rollback + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never',
            'app', 'webhook-worker'])
        assert direct.healthy(), 'Rollback health failed'
        raise
    save(OUT / 'deployment.json', {**prepared, 'healthy': True, 'runtimeSettingsPreserved': True})
    print(json.dumps({'deployed': IMAGE, 'healthy': True, 'mbrEnabled': True}))


def verify():
    prepared = json.loads((OUT / 'prepared.json').read_text())
    combined = json.loads((SERVER / 'deployments/mbr-direct-ship-20261013/state.json').read_text())
    expected = {**combined['sourceHashes'], **prepared['sourceHashes']}
    for name in [direct.APP, direct.WORKER]:
        assert metadata(name)['image'] == prepared['imageId']
    prefix = 'globalThis.expectedReleaseSourceHashes=' + json.dumps(expected) + ';\n' \
        + "(await import('./src/config.js')).config.netsuite.directAccessEnabled=false;\n"
    code = prefix + (SERVER / 'tools/mbr-direct-ship-release-verify.mjs').read_text()
    features = json.loads(direct.docker('exec', '-i', '-w', '/app', direct.APP,
        'node', '--input-type=module', data=code.encode()))
    save(OUT / 'combined-feature-verification.json', features)
    code = (SERVER / 'tools/operator-direct-yard-visibility-live.mjs').read_text()
    visibility = json.loads(direct.docker('exec', '-i', '-w', '/app', direct.APP,
        'node', '--input-type=module', data=code.encode()))
    save(OUT / 'live-verification.json', visibility)
    names = [direct.APP, direct.WORKER, direct.DB, 'mbbs-operator-app-ollama-1']
    for _ in range(30):
        rows = json.loads(direct.docker('inspect', *names))
        if all(row['State']['Running'] and row['State'].get('Health', {}).get('Status', 'healthy') == 'healthy' for row in rows):
            break
        time.sleep(1)
    assert all(row['State']['Running'] and row['State'].get('Health', {}).get('Status', 'healthy') == 'healthy' for row in rows)
    cleanup = {'dockerPs': direct.docker('ps', '--format', '{{.Names}} {{.Status}}'),
        'dockerPsA': direct.docker('ps', '-a', '--format', '{{.Names}} {{.Status}}'),
        'testContainers': direct.docker('ps', '-a', '--filter', 'label=com.mbbs.lifecycle=disposable-test', '--format', '{{.Names}}'),
        'testNetworks': direct.docker('network', 'ls', '--filter', 'name=mbbs-operator-yard-visibility-', '--format', '{{.Name}}'),
        'testVolumes': direct.docker('volume', 'ls', '--filter', 'name=mbbs-operator-yard-visibility-', '--format', '{{.Name}}'),
        'productionHealth': [{'name': row['Name'].lstrip('/'), 'running': row['State']['Running'],
            'health': row['State'].get('Health', {}).get('Status', 'no-healthcheck')} for row in rows]}
    assert not any(cleanup[key] for key in ['testContainers', 'testNetworks', 'testVolumes'])
    assert set(direct.docker('ps', '-a', '--format', '{{.Names}}').splitlines()) == set(names)
    save(OUT / 'final-health-and-cleanup.json', cleanup)
    print(json.dumps({'verified': True, 'operatorLists': visibility['checks'], 'mbrEnabled': True,
        'directShipQuantities': '90 PC, 91.88 SQFT, 3 PALLET', 'productionHealthy': True, 'testCleanupComplete': True}))


if __name__ == '__main__':
    {'prepare': prepare, 'revise': lambda: prepare(revise=True), 'build': build, 'deploy': deploy, 'verify': verify}[sys.argv[1]]()
