"""Scoped aggregate fix rollout with live-source checks and image rollback."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.request

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
RELEASE = SERVER / 'deployments/mbt-aggregate-standard-20261023'
APP = 'mbbs-operator-app-app-1'
DEPENDENCIES = ['mbbs-operator-app-db-1', 'mbbs-operator-app-webhook-worker-1', 'mbbs-operator-app-ollama-1']
IMAGE = 'mbbs-operator-app:mbt-aggregate-standard-20261023'
ROLLBACK = IMAGE + '-rollback'
BEFORE = {
    'src/mbt/customer-charge-calculator.js': '3a5bf0c1feea0f097773af9f2617a9470579a27c4c4fc4fe0e12391d88e3bca2',
    'src/mbt/customer-charge-request-service.js': 'ff9b367aa456076671e91f6222a84f186c6bdb199e56dfd2ea937e7a7d9a3a99',
    'src/mbt/local-master-data-service.js': '68e392ed4bb074113ae31f9a74c4e9b7e77cbf7a13d02879963a273aa3d48e2d',
    'src/mbt/local-item-settings-repository.js': 'ad7d083beffb17d5fc27cb3bcbfb93ba9e23e0be023db65eff1ba25e6c692b20',
    'public/mbt-config.html': 'd05e07a1b896f5aada31d340a6d2b51995f95410ea9386d1db2c8d049094c4d5',
    'public/mbt-shell.js': '6ebb5856ca0ef12a16acb4883587f0e433f86220a7bc33fb4a03f8950099a6ec'
}


def docker(*args):
    return subprocess.check_output(['docker', *args], cwd=ROOT)


def digest(value):
    return hashlib.sha256(value).hexdigest()


def inspect(name):
    return json.loads(docker('inspect', name))[0]


def configuration_values(row):
    selected = {key: row['Config'].get(key) for key in ('Env', 'Cmd', 'Entrypoint', 'WorkingDir', 'User', 'Healthcheck')}
    # Docker Compose emits environment variables in map iteration order.
    # Ordering of distinct environment keys is not a configuration change.
    selected['Env'] = sorted(selected['Env'] or [])
    selected['host'] = dict(row['HostConfig'])
    # Compose also emits independent mount specifications in varying order.
    # Keep every source, target and access mode in the comparison.
    if selected['host'].get('Binds') is not None:
        selected['host']['Binds'] = sorted(selected['host']['Binds'])
    return selected


def configuration(row):
    return digest(json.dumps(configuration_values(row), sort_keys=True).encode())


def configuration_fingerprints(row):
    values = configuration_values(row)
    host = values.pop('host')
    values.update({'HostConfig.' + key: value for key, value in host.items()})
    return {key: digest(json.dumps(value, sort_keys=True).encode()) for key, value in values.items()}


def metadata(name):
    row = inspect(name)
    return {'id': row['Id'], 'image': row['Image'], 'configuration': configuration(row)}


def save(name, value):
    (RELEASE / name).write_text(json.dumps(value, indent=2) + '\n')


def compose(state, mode=None):
    result = ['docker', 'compose', '-p', state['project']]
    for file in state['composeFiles']:
        result.extend(['-f', file])
    if mode:
        result.extend(['-f', str(RELEASE / ('compose.' + mode + '.json'))])
    return result


def assert_current(state):
    assert metadata(APP) == state['app'], 'Live app changed; recapture before rollout'
    assert {name: metadata(name) for name in DEPENDENCIES} == state['dependencies']
    assert {name: digest((SERVER / name).read_bytes()) for name in state['files']} == state['files'], 'Verified source changed'


def prepare():
    evidence = json.loads((SERVER / 'test/mbt/aggregate-standard-evidence.json').read_text())
    assert evidence['validationPassed'] is True
    row = inspect(APP)
    state = {'app': metadata(APP), 'dependencies': {name: metadata(name) for name in DEPENDENCIES},
             'project': row['Config']['Labels']['com.docker.compose.project'],
             'composeFiles': row['Config']['Labels']['com.docker.compose.project.config_files'].split(','),
             'files': evidence['sourceHashes'], 'databaseChanges': False}
    assert_current(state)
    os.umask(0o077)
    assert not (RELEASE / 'manifest.json').exists(), 'A completed release preparation already exists'
    RELEASE.mkdir(parents=True, exist_ok=True)
    for name, expected in BEFORE.items():
        source = docker('exec', APP, 'cat', '/app/' + name)
        assert digest(source) == expected, 'Live source changed: ' + name
        target = RELEASE / 'before' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(source)
    docker('exec', APP, 'test', '!', '-e', '/app/src/mbt/aggregate-density.js')
    docker('tag', state['app']['image'], ROLLBACK)
    for name in state['files']:
        target = RELEASE / 'stage/overlay' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SERVER / name, target)
    (RELEASE / 'stage/Dockerfile').write_text('FROM ' + ROLLBACK + '\nCOPY --chown=node:node overlay/ /app/\n')
    for mode, image in [('release', IMAGE), ('rollback', ROLLBACK)]:
        save('compose.' + mode + '.json', {'services': {'app': {'image': image}}})
    subprocess.run(['docker', 'build', '--network=none', '--pull=false', '-t', IMAGE, str(RELEASE / 'stage')], check=True, cwd=ROOT)
    state['candidateImage'] = json.loads(docker('image', 'inspect', IMAGE))[0]['Id']
    current = json.loads(subprocess.check_output(compose(state) + ['config', '--format', 'json'], cwd=ROOT))
    candidate = json.loads(subprocess.check_output(compose(state, 'release') + ['config', '--format', 'json'], cwd=ROOT))
    current['services']['app'].pop('image', None)
    candidate['services']['app'].pop('image', None)
    assert current == candidate, 'Compose changes beyond the app image'
    assert_current(state)
    save('manifest.json', state)
    print(json.dumps({'prepared': True, 'image': state['candidateImage'], 'files': list(state['files'])}))


def healthy(expected_image):
    for _ in range(45):
        row = inspect(APP)
        if row['Image'] == expected_image and row['State'].get('Health', {}).get('Status') == 'healthy':
            with urllib.request.urlopen('http://127.0.0.1:3000/health', timeout=5) as response:
                assert response.status == 200
            return
        time.sleep(1)
    raise RuntimeError('App did not become healthy')


def refresh_after_rollback():
    state = json.loads((RELEASE / 'manifest.json').read_text())
    assert (RELEASE / 'rollback-result.json').exists(), 'Only refresh after a verified rollback'
    row = inspect(APP)
    assert row['Image'] == state['app']['image'], 'Unexpected live image'
    for name, expected in BEFORE.items():
        assert digest(docker('exec', APP, 'cat', '/app/' + name)) == expected
    desired = json.loads(subprocess.check_output(compose(state) + ['config', '--format', 'json'], cwd=ROOT))['services']['app']
    base = json.loads(docker('image', 'inspect', state['app']['image']))[0]['Config']
    expected_env = dict(value.split('=', 1) for value in base['Env'])
    expected_env.update({key: str(value) for key, value in desired.get('environment', {}).items()})
    actual_env = dict(value.split('=', 1) for value in row['Config']['Env'])
    assert actual_env == expected_env, 'Effective environment differs from the original Compose configuration'
    for key, compose_key in [('Cmd', 'command'), ('Entrypoint', 'entrypoint'), ('User', 'user'), ('WorkingDir', 'working_dir')]:
        expected = desired.get(compose_key)
        if expected is None:
            expected = base[key]
        assert row['Config'][key] == expected, 'Startup setting differs: ' + key
    for name in DEPENDENCIES:
        current = metadata(name)
        assert current['id'] == state['dependencies'][name]['id'], 'Dependency container changed'
        assert current['image'] == state['dependencies'][name]['image'], 'Dependency image changed'
    state['app'] = metadata(APP)
    state['dependencies'] = {name: metadata(name) for name in DEPENDENCIES}
    state['configurationFingerprints'] = configuration_fingerprints(row)
    state['configurationGuard'] = 'Environment and mount-list order normalized; effective startup settings verified against original resolved Compose and base image'
    save('manifest.json', state)
    print(json.dumps({'readyToRetry': True, 'effectiveEnvironmentMatches': True, 'commandAndIdentityMatch': True}))


def apply():
    state = json.loads((RELEASE / 'manifest.json').read_text())
    assert_current(state)
    assert json.loads(docker('image', 'inspect', IMAGE))[0]['Id'] == state['candidateImage']
    assert json.loads(docker('image', 'inspect', ROLLBACK))[0]['Id'] == state['app']['image']
    try:
        subprocess.run(compose(state, 'release') + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', 'app'], check=True, cwd=ROOT)
        healthy(state['candidateImage'])
        deployed = inspect(APP)
        if configuration(deployed) != state['app']['configuration']:
            actual = configuration_fingerprints(deployed)
            changed = [key for key in actual if actual[key] != state.get('configurationFingerprints', {}).get(key)]
            save('configuration-mismatch.json', {'changedFields': changed, 'actualFingerprints': actual, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat()})
            raise AssertionError('Deployment configuration changed: ' + ', '.join(changed))
        assert {name: metadata(name) for name in DEPENDENCIES} == state['dependencies']
        for name, expected in state['files'].items():
            assert digest(docker('exec', APP, 'cat', '/app/' + name)) == expected
    except BaseException:
        if inspect(APP)['Image'] == state['candidateImage']:
            subprocess.run(compose(state, 'rollback') + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', 'app'], check=True, cwd=ROOT)
            healthy(state['app']['image'])
            save('rollback-result.json', {'rolledBack': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat()})
        raise
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'image': state['candidateImage'], 'sourceHashes': state['files'], 'databaseChanges': False,
              'appHealthy': True, 'configurationPreserved': True, 'dependenciesUnchanged': True,
              'rollbackImage': state['app']['image']}
    save('deployment-result.json', result)
    print(json.dumps(result))


if __name__ == '__main__':
    {'prepare': prepare, 'apply': apply, 'refresh-after-rollback': refresh_after_rollback}[sys.argv[1]]()
