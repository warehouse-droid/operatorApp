"""Release only the validated sales-unit pickup overlay, with automatic rollback."""
import importlib.util
import base64
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
RELEASE = SERVER / 'deployments/gob122647-sales-pickup-20261023'
IMAGE = 'mbbs-operator-app:dispatch-sales-pickup-20261023'
ROLLBACK = IMAGE + '-rollback'
FILES = json.loads((SERVER / 'tools/dispatch-sales-pickup-files.json').read_text())
INPUTS = json.loads((SERVER / 'tools/dispatch-sales-pickup-inputs.json').read_text())
spec = importlib.util.spec_from_file_location('pickup_release_core', SERVER / 'tools/delivery-scm-release.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.RELEASE = RELEASE


def checked():
    evidence = json.loads((SERVER / 'test/dispatch-sales-pickup-evidence.json').read_text())
    hashes = {name: core.sha((SERVER / INPUTS.get(name, name)).read_bytes()) for name in FILES}
    assert evidence['passed'] and evidence['sourceHashes'] == hashes
    assert len(evidence['mutations']) == 9 and all(m['killed'] for m in evidence['mutations'])
    assert not evidence['changedLineCoverage']['uncovered'], 'Changed executable lines need coverage'
    return evidence, hashes


def prepare():
    evidence, hashes = checked()
    capture = json.loads((RELEASE / 'capture.json').read_text())
    app = core.metadata(core.APP)
    assert app['imageId'] == capture['imageId'] == evidence['runtimeBaseImage']
    for name, data in capture['files'].items():
        assert core.sha(core.docker('exec', core.APP, 'cat', '/app/' + name)) == data['live']
    data = {'app': app, 'dependencies': [core.metadata(name) for name in core.DEPENDENCIES],
            'files': FILES, 'candidateHashes': hashes, 'authorization':
            'User authorized removing the empty GOB 3445 pickup and using sales units as pickup quantity authority.'}
    core.save('runtime-source-hashes.json', json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT)))
    stage = RELEASE / 'stage'
    for name in FILES:
        target = stage / 'overlay' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SERVER / INPUTS.get(name, name), target)
    core.docker('tag', app['imageId'], ROLLBACK)
    (stage / 'Dockerfile').write_text('FROM ' + ROLLBACK + '\nCOPY --chown=node:node overlay/ /app/\n')
    for mode, tag in [('release', IMAGE), ('rollback', ROLLBACK)]:
        (RELEASE / ('compose.' + mode + '.yml')).write_text('services:\n  app:\n    image: ' + tag + '\n    pull_policy: never\n')
    result = subprocess.run(['docker', 'build', '--network=none', '--pull=false', '-t', IMAGE, str(stage)],
                            capture_output=True, timeout=180)
    assert result.returncode == 0, result.stdout.decode() + result.stderr.decode()
    data['candidateImageId'] = core.docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    core.save('manifest.json', data)
    core.config_check(data)
    print(json.dumps({'prepared': True, 'image': IMAGE, 'files': FILES}), flush=True)


def verify():
    _, hashes = checked()
    data = core.state()
    core.ready(data['candidateImageId'])
    actual = core.metadata(core.APP)
    assert actual['configuration'] == data['app']['configuration']
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies']
    expected = {**json.loads((RELEASE / 'runtime-source-hashes.json').read_text()), **hashes}
    raw = core.docker('exec', core.APP, 'sha256sum', *['/app/' + name for name in expected]).decode().splitlines()
    observed = {line.split()[1].removeprefix('/app/'): line.split()[0] for line in raw}
    assert observed == expected
    result = {'deployed': True, 'at': core.now(), 'image': IMAGE, 'imageId': actual['imageId'],
              'healthy': True, 'configurationPreserved': True, 'dependenciesUnchanged': True,
              'runtimeFilesVerified': len(expected), 'rollbackImage': ROLLBACK}
    core.save('deployed.json', result)
    print(json.dumps(result), flush=True)


def deploy():
    checked()
    data = core.state()
    assert core.metadata(core.APP) == data['app'], 'Live app changed; revalidate before cutover'
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies']
    core.config_check(data)
    core.assert_no_active_operations(core.preflight())
    try:
        subprocess.run(core.compose(data, 'release') + ['up', '-d', '--no-deps', '--no-build', 'app'], check=True, timeout=120)
        verify()
    except BaseException:
        subprocess.run(core.compose(data, 'rollback') + ['up', '-d', '--no-deps', '--no-build', 'app'], check=True, timeout=120)
        core.ready(data['app']['imageId'])
        raise


def check_routes():
    oracle = (SERVER / 'tools/dispatch-history-cargo-oracle.mjs').read_text()
    oracle = oracle.replace("'../src/", "'file:///app/src/")
    oracle = oracle.replace("new URL('../public/dispatch.js',import.meta.url)", "new URL('file:///app/public/dispatch.js')")
    oracle_url = 'data:text/javascript;base64,' + base64.b64encode(oracle.encode()).decode()
    source = (SERVER / 'tools/verify-dispatch-sales-pickup.mjs').read_text().replace("'../src/", "'./src/")
    source = source.replace('./dispatch-history-cargo-oracle.mjs', oracle_url)
    result = json.loads(core.docker('exec', '-i', core.APP, 'node', '--input-type=module', input=source.encode()))
    core.save('post-release-route-verification.json', result)
    print(json.dumps(result), flush=True)


if __name__ == '__main__':
    os.umask(0o077)
    {'prepare': prepare, 'deploy': deploy, 'verify': verify, 'check-routes': check_routes}[sys.argv[1]]()
