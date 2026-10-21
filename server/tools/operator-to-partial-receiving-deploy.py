"""Overlay the proven incomplete-shipment header repair on the live TO image."""
import datetime
import difflib
import hashlib
import importlib.util
import json
import os
import re
import subprocess
import sys
import time
import urllib.request

spec = importlib.util.spec_from_file_location('to_release', __file__.replace('operator-to-partial-receiving-deploy.py', 'operator-to-yard-flow-deploy.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
STATE, ARTIFACT = release.STATE, release.ARTIFACT
TAG = 'mbbs-operator-app:to-yard-partial-receiving-20261009'
ROLLBACK = 'mbbs-operator-app:to-yard-partial-rollback-20261009'
CANDIDATE = STATE / 'partial-candidate/app'
NAME = 'src/receiving-repository.js'
PREFIX = 'partial'
EXPECTED_TESTS = 117


def prepare():
    assert not CANDIDATE.exists(), 'Preserve the reviewed source snapshot'
    before = {name: release.inspect(container) for name, container in release.SERVICES.items()}
    for name in ['db', 'ollama']:
        before[name] = release.inspect(f'mbbs-operator-app-{name}-1')
    release.save(STATE / f'{PREFIX}-before.private.json', before)
    CANDIDATE.mkdir(parents=True)
    for name in ['src', 'public', 'migrations', 'package.json', 'package-lock.json']:
        subprocess.run(release.DOCKER + ['cp', f"{release.SERVICES['app']}:/app/{name}", str(CANDIDATE / name)], check=True)
    subprocess.run(['sudo', '-n', 'chown', '-R', f'{os.getuid()}:{os.getgid()}', str(CANDIDATE)], check=True)
    source = (CANDIDATE / NAME).read_text()
    if PREFIX == 'terminal':
        start = source.index('export async function listDeliveryOrders(')
        end = source.index('export async function listDeliveryLoadTrucks(', start)
        section = source[start:end]
        anchor = '\t         AND NOT ${netSuiteClosedOrderFamilySql("transfer_orders", "TO")}\n'
        assert section.count(anchor) == 1
        replacement = section.replace(anchor, anchor + "           AND (outbound_operator_status IS DISTINCT FROM 'loaded' OR receiving_status IS DISTINCT FROM 'received')\n")
        replacements = [(section, replacement)]
    else:
        helper = re.findall(r'^async function transferReceiptCompletionLines\(orderId\) \{.*?^\}',
                            (release.SERVER / NAME).read_text(), re.M | re.S)
        assert len(helper) == 1 and 'transferReceiptCompletionLines' not in source
        replacements = [
            ('async function recordReceivingReceiptUnlocked(orderId, operatorId, {',
             helper[0] + '\n\nasync function recordReceivingReceiptUnlocked(orderId, operatorId, {'),
            ('  const remainingLines = (order.lines || []).filter((line) => {',
             "  const completionLines=order.order_type==='transfer_order' && !allowNetSuiteCompleted\n"
             '    ? await transferReceiptCompletionLines(orderId) : order.lines || [];\n'
             '  const remainingLines = completionLines.filter((line) => {'),
            ('    if (!receivedIds.includes(Number(line.line_id))) return true;\n', '')]
    updated = source
    for anchor, replacement in replacements:
        assert updated.count(anchor) == 1, 'The live receipt function changed; re-review its scope'
        updated = updated.replace(anchor, replacement)
    (CANDIDATE / NAME).write_text(updated)
    overlay = STATE / f'{PREFIX}-image/overlay/src'
    overlay.mkdir(parents=True)
    (overlay / NAME.removeprefix('src/')).write_text(updated)
    (ARTIFACT / f'{PREFIX}-{NAME.removeprefix("src/")}.patch').write_text(''.join(difflib.unified_diff(
        source.splitlines(True), updated.splitlines(True), fromfile='before/' + NAME, tofile='after/' + NAME)))
    subprocess.run(release.DOCKER + ['tag', before['app']['Image'], ROLLBACK], check=True)
    (overlay.parent.parent / 'Dockerfile').write_text(f'FROM {ROLLBACK}\nCOPY --chown=node:node overlay/ /app/\n')
    for mode, tag in [('release', TAG), ('rollback', ROLLBACK)]:
        (STATE / f'compose.{PREFIX}.{mode}.yml').write_text(f'services:\n  app:\n    image: {tag}\n')
    release.save(ARTIFACT / f'{PREFIX}-manifest.json', {
        'candidateTag': TAG, 'rollbackImage': before['app']['Image'],
        'changes': {NAME: {'before': hashlib.sha256(source.encode()).hexdigest(),
                           'after': release.digest(CANDIDATE / NAME)}}})
    assert release.runtime_hashes(release.SERVICES['app'], [NAME])[NAME] == json.loads((ARTIFACT / f'{PREFIX}-manifest.json').read_text())['changes'][NAME]['before']
    print('Prepared only the incomplete-shipment receipt header repair on the current live image.')


def build():
    with (ARTIFACT / f'{PREFIX}-build.log').open('w') as output:
        subprocess.run(release.DOCKER + ['build', '--pull=false', '--network=none', '-t', TAG, str(STATE / f'{PREFIX}-image')],
                       stdout=output, stderr=subprocess.STDOUT, check=True)
    manifest = json.loads((ARTIFACT / f'{PREFIX}-manifest.json').read_text())
    manifest['candidateImage'] = release.inspect(TAG)['Id']
    release.save(ARTIFACT / f'{PREFIX}-manifest.json', manifest)
    before = json.loads((STATE / f'{PREFIX}-before.private.json').read_text())
    configured = json.loads(release.run(release.compose(before, f'compose.{PREFIX}.release.yml') + ['config', '--format', 'json']))
    release.save(STATE / f'{PREFIX}-compose.private.json', configured)
    image_env = dict(value.split('=', 1) for value in release.inspect(TAG)['Config']['Env'])
    environment = {**image_env, **{key: str(value) for key, value in configured['services']['app'].get('environment', {}).items()}}
    assert environment == dict(value.split('=', 1) for value in before['app']['Config']['Env']), 'Unexpected configuration change'
    print('Built the small receipt repair image; environment and dependency graph unchanged.')


def deploy():
    before = json.loads((STATE / f'{PREFIX}-before.private.json').read_text())
    manifest = json.loads((ARTIFACT / f'{PREFIX}-manifest.json').read_text())
    log = (ARTIFACT / f'candidate-{PREFIX}-tests.log').read_text()
    for key, count in [('tests', EXPECTED_TESTS), ('pass', EXPECTED_TESTS), ('fail', 0)]:
        assert int(re.findall(rf'^# {key} (\d+)$', log, re.M)[-1]) == count, 'Exact candidate verification must pass'
    assert release.inspect(release.SERVICES['app'])['Image'] == before['app']['Image'], 'Live application image changed'
    assert release.runtime_hashes(release.SERVICES['app'], [NAME])[NAME] == manifest['changes'][NAME]['before']
    try:
        subprocess.run(release.compose(before, f'compose.{PREFIX}.release.yml') + ['up', '-d', '--no-deps', '--no-build', 'app'], check=True)
        for _ in range(55):
            current = release.inspect(release.SERVICES['app'])
            if current['Image'] == manifest['candidateImage'] and current['State'].get('Health', {}).get('Status') == 'healthy':
                break
            time.sleep(1)
        else:
            raise RuntimeError('Receipt repair did not become healthy')
        with urllib.request.urlopen('http://127.0.0.1:3000/health', timeout=5) as response:
            assert response.status == 200 and json.load(response)['ok']
        assert release.runtime_hashes(release.SERVICES['app'], [NAME])[NAME] == manifest['changes'][NAME]['after']
        for name in ['db', 'ollama', 'webhook-worker']:
            current = release.inspect(before[name]['Id'])
            assert current['Id'] == before[name]['Id'] and current['State']['Running']
        release.save(ARTIFACT / f'{PREFIX}-deployed.json', {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'appImage': manifest['candidateImage'], 'health': 'healthy', 'newMigrations': []})
        print('Partial-shipment receipt repair deployed; worker and production storage preserved.')
    except Exception:
        subprocess.run(release.compose(before, f'compose.{PREFIX}.rollback.yml') + ['up', '-d', '--no-deps', '--no-build', 'app'], check=True)
        raise


if __name__ == '__main__':
    os.umask(0o077)
    mode = sys.argv[1]
    if mode.startswith('terminal-'):
        PREFIX = 'terminal'
        TAG = 'mbbs-operator-app:to-yard-terminal-outbound-20261009'
        ROLLBACK = 'mbbs-operator-app:to-yard-terminal-rollback-20261009'
        CANDIDATE = STATE / 'terminal-candidate/app'
        NAME = 'src/delivery-repository.js'
        EXPECTED_TESTS = 118
        mode = mode.removeprefix('terminal-')
    {'prepare': prepare, 'build': build, 'deploy': deploy}[mode]()
