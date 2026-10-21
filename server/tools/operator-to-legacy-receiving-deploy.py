"""Overlay only the two legacy Receiving functions on the live TO release."""
import datetime
import difflib
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import subprocess
import sys
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('to_deploy', ROOT / 'server/tools/operator-to-yard-flow-deploy.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
STATE, ARTIFACT = release.STATE, release.ARTIFACT
TAG = 'mbbs-operator-app:to-yard-legacy-receiving-20261009'
ROLLBACK = 'mbbs-operator-app:to-yard-legacy-rollback-20261009'
CANDIDATE = STATE / 'legacy-candidate/app'
FUNCTIONS = {'receiving-repository.js': 'function transferLocalLoadExistsSql() {',
             'transfer-order-posting-repository.js': 'export async function readTransferLoadedQuantities(orderId) {'}


def prepare():
    assert not CANDIDATE.exists(), 'Preserve the existing candidate'
    before = {s: release.inspect(c) for s, c in release.SERVICES.items()}
    for name in ['db', 'ollama']: before[name] = release.inspect(f'mbbs-operator-app-{name}-1')
    release.save(STATE / 'legacy-before.private.json', before)
    CANDIDATE.mkdir(parents=True)
    for name in ['src', 'public', 'package.json', 'package-lock.json']:
        subprocess.run(release.DOCKER + ['cp', f"{release.SERVICES['app']}:/app/{name}", str(CANDIDATE / name)], check=True)
    subprocess.run(['sudo', '-n', 'chown', '-R', f'{os.getuid()}:{os.getgid()}', str(CANDIDATE)], check=True)
    overlay = STATE / 'legacy-image/overlay/src'
    overlay.mkdir(parents=True)
    changes = {}
    for name, signature in FUNCTIONS.items():
        path = CANDIDATE / 'src' / name
        original = path.read_text()
        expression = re.compile('^' + re.escape(signature) + r'.*?^\}', re.M | re.S)
        replacement = expression.findall((ROOT / 'server/src' / name).read_text())
        assert len(replacement) == 1 and len(expression.findall(original)) == 1
        assert 'operator.to.legacy_receiving_enabled' not in expression.findall(original)[0]
        updated = expression.sub(lambda _: replacement[0], original)
        path.write_text(updated)
        (overlay / name).write_text(updated)
        changes['src/' + name] = {'before': hashlib.sha256(original.encode()).hexdigest(), 'after': release.digest(path)}
        (ARTIFACT / f'legacy-{name}.patch').write_text(''.join(difflib.unified_diff(original.splitlines(True), updated.splitlines(True), fromfile='before/' + name, tofile='after/' + name)))
    subprocess.run(release.DOCKER + ['tag', before['app']['Image'], ROLLBACK], check=True)
    (overlay.parent.parent / 'Dockerfile').write_text(f'FROM {ROLLBACK}\nCOPY --chown=node:node overlay/ /app/\n')
    for mode, tag in [('release', TAG), ('rollback', ROLLBACK)]:
        (STATE / f'compose.legacy.{mode}.yml').write_text(f'services:\n  app:\n    image: {tag}\n')
    release.save(ARTIFACT / 'legacy-manifest.json', {'changes': changes, 'candidateTag': TAG, 'rollbackImage': before['app']['Image']})
    print('Captured live rollback state and prepared the two-function legacy Receiving overlay.')


def build():
    with (ARTIFACT / 'legacy-build.log').open('w') as output:
        subprocess.run(release.DOCKER + ['build', '--pull=false', '--network=none', '-t', TAG, str(STATE / 'legacy-image')], stdout=output, stderr=subprocess.STDOUT, check=True)
    manifest = json.loads((ARTIFACT / 'legacy-manifest.json').read_text())
    manifest['candidateImage'] = release.inspect(TAG)['Id']
    release.save(ARTIFACT / 'legacy-manifest.json', manifest)
    before = json.loads((STATE / 'legacy-before.private.json').read_text())
    configured = json.loads(release.run(release.compose(before, 'compose.legacy.release.yml') + ['config', '--format', 'json']))
    release.save(STATE / 'legacy-compose.private.json', configured)
    image_env = dict(value.split('=', 1) for value in release.inspect(TAG)['Config']['Env'])
    environment = {**image_env, **{key: str(value) for key, value in configured['services']['app'].get('environment', {}).items()}}
    assert environment == dict(value.split('=', 1) for value in before['app']['Config']['Env']), 'Live environment drift'
    print('Legacy Receiving image built; live application environment is unchanged.')


def deploy():
    before = json.loads((STATE / 'legacy-before.private.json').read_text())
    manifest = json.loads((ARTIFACT / 'legacy-manifest.json').read_text())
    log = (ARTIFACT / 'candidate-legacy-tests.log').read_text()
    for key, count in [('tests', 115), ('pass', 115), ('fail', 0)]:
        assert int(re.findall(rf'^# {key} (\d+)$', log, re.M)[-1]) == count, 'Exact candidate tests must pass'
    assert release.runtime_hashes(release.SERVICES['app'], list(manifest['changes'])) == {name: change['before'] for name, change in manifest['changes'].items()}
    assert release.inspect(release.SERVICES['app'])['Image'] == before['app']['Image'], 'The live base image changed'
    try:
        subprocess.run(release.compose(before, 'compose.legacy.release.yml') + ['up', '-d', '--no-deps', '--no-build', 'app'], check=True)
        for _ in range(55):
            current = release.inspect(release.SERVICES['app'])
            if current['Image'] == manifest['candidateImage'] and current['State'].get('Health', {}).get('Status') == 'healthy': break
            time.sleep(1)
        else: raise RuntimeError('Legacy Receiving image did not become healthy')
        with urllib.request.urlopen('http://127.0.0.1:3000/health', timeout=5) as response: assert response.status == 200 and json.load(response)['ok']
        assert release.runtime_hashes(release.SERVICES['app'], list(manifest['changes'])) == {name: change['after'] for name, change in manifest['changes'].items()}
        for service in ['db', 'ollama', 'webhook-worker']:
            current = release.inspect(before[service]['Id'])
            assert current['Id'] == before[service]['Id'] and current['State']['Running']
        release.save(ARTIFACT / 'legacy-deployed.json', {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'appImage': manifest['candidateImage'], 'health': 'healthy', 'newMigrations': []})
        print('Legacy Receiving support deployed and verified; worker and production storage unchanged.')
    except Exception:
        subprocess.run(release.compose(before, 'compose.legacy.rollback.yml') + ['up', '-d', '--no-deps', '--no-build', 'app'], check=True)
        raise


if __name__ == '__main__':
    os.umask(0o077)
    {'prepare': prepare, 'build': build, 'deploy': deploy}[sys.argv[1]]()
