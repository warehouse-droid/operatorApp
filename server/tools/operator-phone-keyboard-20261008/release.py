"""Apply only the phone keyboard changes over the currently running image."""
import atexit
import difflib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import time

SERVER = Path(__file__).resolve().parents[2]
ARTIFACTS = SERVER / 'test-artifacts/operator-phone-keyboard-20261008'
RELEASE = SERVER / 'deployments/operator-phone-keyboard-20261008'
spec = importlib.util.spec_from_file_location('phone_keyboard_release', SERVER / 'tools/delivery-scm-release.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
r.RELEASE = RELEASE
r.IMAGE = 'mbbs-operator-app:operator-phone-keyboard-20261008'
r.ROLLBACK = r.IMAGE + '-rollback'
r.READ_NAME = 'mbbs-phone-keyboard-release-reader'
r.CHECK_NAME = 'mbbs-phone-keyboard-release-check'
FILES = ['public/' + name for name in ['operator-phone.js', 'operator-phone.css', 'operator-order-keypad.js',
                                     'operator.css', 'operator-inventory.css', 'operator-display-settings.js',
                                     'operator.js', 'operator.html', 'service-worker.js']]
ASSETS = ['operator-phone.css', 'operator-phone.js', 'operator-order-keypad.js', 'operator.js',
          'operator.css', 'operator-inventory.css', 'operator-display-settings.js']


def capture():
    os.umask(0o077)
    RELEASE.mkdir(exist_ok=False)
    before = r.metadata(r.APP)
    dependencies = [r.metadata(name) for name in r.DEPENDENCIES]
    baseline = RELEASE / 'before'
    baseline.mkdir()
    archive = r.docker('exec', r.APP, 'tar', '-cf', '-', '-C', '/app',
                       'src', 'public', 'migrations', 'package.json', 'package-lock.json')
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        stream.extractall(baseline, filter='data')
    assert r.metadata(r.APP) == before
    candidate = RELEASE / 'candidate'
    shutil.copytree(baseline, candidate)
    patch = ''
    for name in FILES:
        old = (ARTIFACTS / 'baseline' / Path(name).name).read_text()
        new = (SERVER / name).read_text()
        # Asset cache versions may have advanced independently in production.
        if name in ['public/operator.html', 'public/service-worker.js']:
            import re
            source = (candidate / name).read_text()
            for asset in ASSETS:
                source, count = re.subn(r'(/' + re.escape(asset) + r'\?v=)[^"<>]+',
                                       r'\g<1>20261008-phone-keyboard-v1', source)
                assert count == 1
            if name.endswith('service-worker.js'):
                source, count = re.subn(r'const CACHE_NAME = "[^"]+";',
                    'const CACHE_NAME = "mbbs-yard-operator-20261008-phone-keyboard-v1";', source)
                assert count == 1
            (candidate / name).write_text(source)
        else:
            patch += ''.join(difflib.unified_diff(old.splitlines(True), new.splitlines(True),
                                                fromfile='a/' + name, tofile='b/' + name))
    r.apply_patch(candidate, patch, 'keyboard')
    before_tree, after_tree = r.files_at(baseline), r.files_at(candidate)
    changed = sorted(name for name in before_tree.keys() | after_tree.keys() if before_tree.get(name) != after_tree.get(name))
    assert changed == sorted(FILES), changed
    (RELEASE / 'release.patch').write_text(''.join(''.join(difflib.unified_diff(
        (baseline / name).read_text().splitlines(True), (candidate / name).read_text().splitlines(True),
        fromfile='a/' + name, tofile='b/' + name)) for name in changed))
    r.save('manifest.json', {'capturedAt': r.now(), 'app': before, 'dependencies': dependencies,
        'files': changed, 'beforeTree': before_tree, 'candidateTree': after_tree,
        'candidateTreeHash': r.sha(json.dumps(after_tree, sort_keys=True).encode()),
        'workspace': {name: r.sha((SERVER / name).read_bytes()) for name in FILES}})
    r.current(r.state())
    print(json.dumps({'captured': True, 'files': changed}), flush=True)


def validated():
    data = r.state()
    r.current(data)
    result = json.loads((ARTIFACTS / 'browser-results.json').read_text())
    assert len(result['results']) > 600 and all(row['pass'] for row in result['results']) and not result['errors']
    assert (ARTIFACTS / 'checks-passed').read_text().strip() == data['candidateTreeHash']
    r.save('validation-passed.json', {'passed': True, 'candidateTreeHash': data['candidateTreeHash'],
                                    'browserChecks': len(result['results']), 'at': r.now()})
    print(json.dumps({'candidateValidated': True, 'browserChecks': len(result['results'])}), flush=True)


def refresh():
    """Refresh task-owned assets after a regression fix, before revalidation."""
    data = r.state()
    assert r.metadata(r.APP) == data['app'], 'Live app advanced; recapture required'
    for name in ['public/operator-order-keypad.js', 'public/operator-phone.js', 'public/operator-phone.css']:
        shutil.copy2(SERVER / name, RELEASE / 'candidate' / name)
    for name in ['public/operator.css', 'public/operator-inventory.css', 'public/operator-display-settings.js']:
        original = (ARTIFACTS / 'baseline' / Path(name).name).read_text()
        final = (SERVER / name).read_text()
        shutil.copy2(RELEASE / 'before' / name, RELEASE / 'candidate' / name)
        patch = ''.join(difflib.unified_diff(original.splitlines(True), final.splitlines(True), fromfile='a/' + name, tofile='b/' + name))
        r.apply_patch(RELEASE / 'candidate', patch, Path(name).stem + '-font')
    import re
    for name in ['public/operator.html', 'public/service-worker.js']:
        target = RELEASE / 'candidate' / name
        source = target.read_text()
        for asset in ASSETS:
            source, count = re.subn(r'(/' + re.escape(asset) + r'\?v=)[^"<>]+', r'\g<1>20261008-phone-keyboard-v1', source)
            assert count == 1
        target.write_text(source)
    data['files'] = sorted(FILES)
    data['candidateTree'] = r.files_at(RELEASE / 'candidate')
    data['candidateTreeHash'] = r.sha(json.dumps(data['candidateTree'], sort_keys=True).encode())
    data['workspace'] = {name: r.sha((SERVER / name).read_bytes()) for name in FILES}
    r.save('manifest.json', data)
    for stale in [RELEASE / 'validation-passed.json', RELEASE / 'image-check.json', ARTIFACTS / 'checks-passed']:
        stale.unlink(missing_ok=True)
    r.current(data)
    (RELEASE / 'release.patch').write_text(''.join(''.join(difflib.unified_diff(
        (RELEASE / 'before' / name).read_text().splitlines(True), (RELEASE / 'candidate' / name).read_text().splitlines(True),
        fromfile='a/' + name, tofile='b/' + name)) for name in FILES))


def verify():
    data = r.state()
    r.ready(data['candidateImageId'])
    live = r.metadata(r.APP)
    assert live['imageId'] == data['candidateImageId']
    assert live['configuration'] == data['app']['configuration']
    assert [r.metadata(name) for name in r.DEPENDENCIES] == data['dependencies']
    assert json.loads(r.docker('exec', r.APP, 'node', '-e', r.HASH_SCRIPT)) == data['candidateTree']
    public = {name: data['candidateTree'][name] for name in FILES}
    for attempt in range(3):
        try:
            checked = r.http_check(public, ['/api/operator/phone-layout-policy'])
            break
        except subprocess.CalledProcessError:
            if attempt == 2:
                raise
            time.sleep(2)
    r.save('deployment-result.json', {'deployed': True, 'at': r.now(), 'imageId': live['imageId'],
        'files': FILES, 'configurationPreserved': True, 'dependenciesUnchanged': True, 'http': checked})
    print(json.dumps({'deployed': True, 'productionHealthy': True, 'http': checked}), flush=True)


def accept_rollback():
    data = r.state()
    live = r.metadata(r.APP)
    assert live['imageId'] == data['app']['imageId'], 'Rollback image differs'
    assert live['configuration'] == data['app']['configuration'], 'Rollback configuration differs'
    assert [r.metadata(name) for name in r.DEPENDENCIES] == data['dependencies']
    assert json.loads(r.docker('exec', r.APP, 'node', '-e', r.HASH_SCRIPT)) == data['beforeTree']
    r.save('first-attempt-rollback.json', {'at': r.now(), 'reason': 'Public URL connect timeout',
                                        'before': data['app'], 'restored': live})
    data['app'] = live
    r.save('manifest.json', data)
    r.current(data)


def apply():
    data = r.state()
    r.current(data)
    check = json.loads((RELEASE / 'image-check.json').read_text())
    assert check['passed'] and check['imageId'] == data['candidateImageId']
    r.config_check(data)
    r.assert_no_active_operations(r.preflight())
    args = ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app']
    try:
        with (RELEASE / 'cutover.log').open('wb') as output:
            subprocess.run(r.compose(data, 'release') + args, cwd=SERVER.parent,
                           stdout=output, stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except BaseException:
        with (RELEASE / 'rollback.log').open('wb') as output:
            subprocess.run(r.compose(data, 'rollback') + args, cwd=SERVER.parent,
                           stdout=output, stderr=subprocess.STDOUT, check=True, timeout=60)
        r.ready(data['app']['imageId'])
        raise


if __name__ == '__main__':
    {'capture': capture, 'refresh': refresh, 'validated': validated, 'build': r.build, 'apply': apply,
     'verify': verify, 'accept-rollback': accept_rollback}[sys.argv[1]]()
