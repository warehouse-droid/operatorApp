"""Scoped completed-TO visibility and unshipped destination-edit release."""
import difflib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import time

SERVER = Path(__file__).resolve().parents[1]
REPO = SERVER.parent
OUT = SERVER / 'test-artifacts/operator-to-follow-up-20261013'
RELEASE = SERVER / 'deployments/operator-to-follow-up-20261013'
IMAGE = 'mbbs-operator-app:operator-to-follow-up-20261013'
WORKER_IMAGE = 'mbbs-operator-app:operator-to-follow-up-worker-20261013'
FILES = ['src/delivery-repository.js', 'src/receiving-repository.js',
    'src/scm-reconciliation-repository.js', 'src/operator-transfer-completion.js']
spec = importlib.util.spec_from_file_location('visibility', SERVER / 'tools/operator-direct-yard-visibility-release.py')
visibility = importlib.util.module_from_spec(spec)
spec.loader.exec_module(visibility)
direct = visibility.direct
save = visibility.save
sha = visibility.sha
metadata = visibility.metadata


def logged(label, args):
    with (OUT / (label + '.log')).open('wb') as log:
        result = subprocess.run(args, cwd=REPO, stdout=log, stderr=subprocess.STDOUT)
    if result.returncode: print((OUT / (label + '.log')).read_text()[-6000:])
    return result.returncode


def prepare(revise=False, rebase=False):
    OUT.mkdir(parents=True, exist_ok=True)
    if (RELEASE / 'state.json').exists():
        assert (revise or rebase) and not (OUT / 'deployment.json').exists(), 'Release already prepared or deployed'
        prior = json.loads((RELEASE / 'state.json').read_text())
        for name, key in [(direct.APP, 'app'), (direct.WORKER, 'worker')]:
            current = metadata(name)
            assert current['runtimeHash'] == prior[key]['runtimeHash'], name + ' runtime settings changed'
            if not rebase: assert current == prior[key], name + ' changed before candidate revision'
        archive = OUT / ('before-header-progress-guard-' + prior['sourceHashes']['src/scm-reconciliation-repository.js'][:12])
        archive.mkdir()
        for path in [RELEASE / 'state.json', OUT / 'prepared.json', OUT / 'candidate-validation.json',
            OUT / 'checks.core.json', OUT / 'checks.json', OUT / 'candidate-checks.log', OUT / 'operator-and-review-regressions.log', OUT / 'cleanup.json']:
            if path.exists(): (archive / path.name).write_bytes(path.read_bytes())
        for name in ['candidate-validation.json', 'candidate-validation.worker.json', 'checks.core.json', 'checks.json']:
            (OUT / name).unlink(missing_ok=True)
    state = json.loads((SERVER / 'test-artifacts/operator-completed-to-20261013/state-before.json').read_text())
    if rebase:
        state = {**state, 'rebasedFrom': {key: state[key]['imageRef'] for key in ['app','worker']},
            'app': metadata(direct.APP), 'worker': metadata(direct.WORKER)}
    for name, key in [(direct.APP, 'app'), (direct.WORKER, 'worker')]:
        assert metadata(name) == state[key], name + ' changed before preparation'
    assert json.loads(direct.docker('image', 'inspect', state['app']['imageRef']))[0]['Id'] == state['app']['image']
    context = RELEASE / 'context'
    patches = []
    for filename in FILES[:-1]:
        base = SERVER / 'test-artifacts' / ('to-location-review-20261013' if 'scm-' in filename else 'operator-completed-to-20261013') / 'baseline'
        before = base / Path(filename).name
        live = base / ('production-' + Path(filename).name)
        assert sha(live) == direct.docker('exec', direct.APP, 'sha256sum', '/app/' + filename).split()[0]
        result = subprocess.run(['git', 'merge-file', '-p', str(live), str(before), str(SERVER / filename)], capture_output=True)
        assert result.returncode == 0, 'Scoped merge needs review: ' + filename
        target = context / filename
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(result.stdout)
        patches.extend(difflib.unified_diff(live.read_text().splitlines(keepends=True), target.read_text().splitlines(keepends=True),
            fromfile='production/' + filename, tofile='release/' + filename))
    (context / FILES[-1]).write_bytes((SERVER / FILES[-1]).read_bytes())
    state.update({'sourceHashes': {filename: sha(context / filename) for filename in FILES},
        'workspaceHashes': {filename: sha(SERVER / filename) for filename in FILES}})
    save(RELEASE / 'state.json', state)
    (OUT / 'production.patch').write_text(''.join(patches))
    (context / 'Dockerfile').write_text('FROM ' + state['app']['imageRef'] + '\nCOPY src/ /app/src/\n')
    (context / 'Dockerfile.worker').write_text('FROM ' + state['worker']['imageRef'] + '\nCOPY src/ /app/src/\n')
    save(RELEASE / 'compose.release.json', {'services': {'app': {'image': IMAGE, 'pull_policy': 'never'},
        'webhook-worker': {'image': WORKER_IMAGE, 'pull_policy': 'never'}}})
    save(RELEASE / 'compose.rollback.json', {'services': {name: {'image': state[key]['imageRef'], 'pull_policy': 'never'}
        for name, key in [('app', 'app'), ('webhook-worker', 'worker')]}})
    assert logged('candidate-build', ['docker', 'build', '--network=none', '-t', IMAGE, str(context)]) == 0
    assert logged('worker-candidate-build', ['docker', 'build', '--network=none', '-f', str(context/'Dockerfile.worker'), '-t', WORKER_IMAGE, str(context)]) == 0
    save(OUT / 'prepared.json', {'image': IMAGE, 'imageId': json.loads(direct.docker('image', 'inspect', IMAGE))[0]['Id'],
        'workerImage': WORKER_IMAGE, 'workerImageId': json.loads(direct.docker('image', 'inspect', WORKER_IMAGE))[0]['Id'],
        'sourceHashes': state['sourceHashes'], 'mbrPreserved': True, 'directShipSyncAndVisibilityPreserved': True,
        'migrations': [], 'productionDataRepair': False})
    print(json.dumps({'prepared': IMAGE, 'runtimeFiles': len(FILES)}))


def deploy():
    state = json.loads((RELEASE / 'state.json').read_text())
    prepared = json.loads((OUT / 'prepared.json').read_text())
    checks = json.loads((OUT / 'candidate-validation.json').read_text())
    assert checks['passed'] and checks['cleanupVerified']
    assert checks['sourceHashes'] == state['sourceHashes'] and checks['imageId'] == prepared['imageId']
    worker_checks = json.loads((OUT / 'candidate-validation.worker.json').read_text())
    assert worker_checks['passed'] and worker_checks['cleanupVerified']
    assert worker_checks['sourceHashes'] == state['sourceHashes'] and worker_checks['testedImageId'] == prepared['workerImageId']
    assert json.loads(direct.docker('image', 'inspect', IMAGE))[0]['Id'] == prepared['imageId']
    assert json.loads(direct.docker('image', 'inspect', WORKER_IMAGE))[0]['Id'] == prepared['workerImageId']
    results = json.loads((OUT / 'checks.json').read_text())
    assert results['sourceHashes'] == state['sourceHashes']
    assert all(results['results'][name]['exit'] == 0 for name in ['operator-and-review-regressions','scm-reconciliation-harness','mbr-regressions','new-module-types','lint'])
    assert all(results['results']['mutant-' + name]['exit'] == 1 for name in results['mutants'])
    coverage = json.loads((OUT / 'changed-coverage.json').read_text())
    assert len(coverage) == 4 and all(row['covered'] == row['changedExecutableLines'] and not row['missing'] for row in coverage.values())
    for filename in FILES:
        assert sha(SERVER / filename) == state['workspaceHashes'][filename]
        assert sha(RELEASE / 'context' / filename) == state['sourceHashes'][filename]
    for name, key in [(direct.APP, 'app'), (direct.WORKER, 'worker')]:
        assert metadata(name) == state[key], name + ' changed after candidate preparation'
    try:
        command = ['sudo', '-n', *direct.compose(state, RELEASE / 'compose.release.json')]
        assert logged('production-deploy', command + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'app', 'webhook-worker']) == 0
        assert direct.healthy()
        for name, key in [(direct.APP, 'app'), (direct.WORKER, 'worker')]:
            current = metadata(name)
            expected_image = prepared['imageId'] if key == 'app' else prepared['workerImageId']
            assert current['image'] == expected_image and current['runtimeHash'] == state[key]['runtimeHash']
            for filename, expected in state['sourceHashes'].items():
                assert direct.docker('exec', name, 'sha256sum', '/app/' + filename).split()[0] == expected
    except BaseException:
        command = ['sudo', '-n', *direct.compose(state, RELEASE / 'compose.rollback.json')]
        logged('production-rollback', command + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'app', 'webhook-worker'])
        assert direct.healthy()
        raise
    save(OUT / 'deployment.json', {**prepared, 'healthy': True, 'runtimeSettingsPreserved': True})
    print(json.dumps({'deployed': IMAGE, 'healthy': True, 'mbrEnabled': True}))


def verify():
    prepared = json.loads((OUT / 'prepared.json').read_text())
    state = json.loads((RELEASE / 'state.json').read_text())
    for name, key in [(direct.APP, 'app'), (direct.WORKER, 'worker')]:
        current = metadata(name)
        expected_image = prepared['imageId'] if key == 'app' else prepared['workerImageId']
        assert current['image'] == expected_image and current['runtimeHash'] == state[key]['runtimeHash']
    code = (SERVER / 'tools/operator-to-follow-up-live.mjs').read_text()
    result = json.loads(direct.docker('exec', '-i', '-w', '/app', direct.APP, 'node', '--input-type=module', data=code.encode()))
    save(OUT / 'live-verification.json', result)
    original = json.loads((SERVER / 'deployments/mbr-direct-ship-20261013/state.json').read_text())
    expected = {**original['sourceHashes'], **prepared['sourceHashes']}
    equipment = json.loads((SERVER / 'test-artifacts/mbr-equipment/prepared.json').read_text())
    expected.update(equipment['sourceHashes'])
    code = 'globalThis.expectedReleaseSourceHashes=' + json.dumps(expected) + ';\n' \
        + "(await import('./src/config.js')).config.netsuite.directAccessEnabled=false;\n" \
        + (SERVER / 'tools/mbr-direct-ship-release-verify.mjs').read_text()
    features = json.loads(direct.docker('exec', '-i', '-w', '/app', direct.APP, 'node', '--input-type=module', data=code.encode()))
    save(OUT / 'preserved-feature-verification.json', features)
    names = [direct.APP, direct.WORKER, direct.DB, 'mbbs-operator-app-ollama-1']
    for _ in range(30):
        rows = json.loads(direct.docker('inspect', *names))
        if all(row['State']['Running'] and row['State'].get('Health', {}).get('Status','healthy') == 'healthy' for row in rows): break
        time.sleep(1)
    assert all(row['State']['Running'] and row['State'].get('Health', {}).get('Status','healthy') == 'healthy' for row in rows)
    cleanup = {'dockerPs': direct.docker('ps', '--format', '{{.Names}} {{.Status}}'),
        'dockerPsA': direct.docker('ps', '-a', '--format', '{{.Names}} {{.Status}}'),
        'testContainers': direct.docker('ps', '-a', '--filter', 'label=com.mbbs.lifecycle=disposable-test', '--format','{{.Names}}'),
        'testNetworks': direct.docker('network','ls','--filter','name=mbbs-operator-to-follow-up-','--format','{{.Name}}'),
        'testVolumes': direct.docker('volume','ls','--filter','name=mbbs-operator-to-follow-up-','--format','{{.Name}}'),
        'productionHealthy': True}
    assert not any(cleanup[key] for key in ['testContainers','testNetworks','testVolumes'])
    assert set(direct.docker('ps','-a','--format','{{.Names}}').splitlines()) == set(names)
    save(OUT / 'final-health-and-cleanup.json', cleanup)
    print(json.dumps({'verified': True, 'completedTransferFiltered': True, 'destinationEditStatus':'Planned',
        'review412StillResolved':True,'mbrEnabled':True,'productionHealthy':True,'testCleanupComplete':True}))


if __name__ == '__main__':
    {'prepare': prepare, 'revise': lambda: prepare(revise=True), 'rebase': lambda: prepare(rebase=True), 'deploy': deploy, 'verify': verify}[sys.argv[1]]()
