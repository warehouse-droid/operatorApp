"""Release the 25px Operator input font update over the active app image."""
import difflib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tarfile

SERVER = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('font_release_helpers', SERVER / 'tools/operator-phone-keyboard-20261008/release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
r = release.r
release.ARTIFACTS = SERVER / 'test-artifacts/operator-input-font-20261008'
release.RELEASE = r.RELEASE = SERVER / 'deployments/operator-input-font-20261008'
r.IMAGE = 'mbbs-operator-app:operator-input-font-20261008'
r.ROLLBACK = r.IMAGE + '-rollback'
r.READ_NAME = 'mbbs-input-font-release-reader'
r.CHECK_NAME = 'mbbs-input-font-release-check'
release.ASSETS = ['operator.css', 'operator-inventory.css', 'operator-phone.css',
                  'operator-display-settings.css', 'operator-display-settings.js']
release.FILES = ['public/' + name for name in release.ASSETS + ['operator.html', 'service-worker.js']]
VERSION = '20261008-input-font25-v1'


def patch_candidate():
    candidate = r.RELEASE / 'candidate'
    patch = ''
    for name in release.FILES:
        original = (release.ARTIFACTS / 'baseline' / Path(name).name).read_text()
        final = (SERVER / name).read_text()
        shutil.copy2(r.RELEASE / 'before' / name, candidate / name)
        if name in ['public/operator.html', 'public/service-worker.js']:
            source = (candidate / name).read_text()
            for asset in release.ASSETS:
                source, count = re.subn(r'(/' + re.escape(asset) + r'\?v=)[^"<>]+',
                                       r'\g<1>' + VERSION, source)
                assert count == 1
            if name.endswith('service-worker.js'):
                source, count = re.subn(r'const CACHE_NAME = "[^"]+";',
                                       'const CACHE_NAME = "mbbs-yard-operator-' + VERSION + '";', source)
                assert count == 1
            (candidate / name).write_text(source)
        else:
            patch += ''.join(difflib.unified_diff(original.splitlines(True), final.splitlines(True),
                                                fromfile='a/' + name, tofile='b/' + name))
    r.apply_patch(candidate, patch, 'input-font')
    before_tree, after_tree = r.files_at(r.RELEASE / 'before'), r.files_at(candidate)
    changed = sorted(name for name in before_tree.keys() | after_tree.keys() if before_tree.get(name) != after_tree.get(name))
    assert changed == sorted(release.FILES), changed
    (r.RELEASE / 'release.patch').write_text(''.join(''.join(difflib.unified_diff(
        (r.RELEASE / 'before' / name).read_text().splitlines(True), (candidate / name).read_text().splitlines(True),
        fromfile='a/' + name, tofile='b/' + name)) for name in changed))
    return {'files': changed, 'beforeTree': before_tree, 'candidateTree': after_tree,
            'candidateTreeHash': r.sha(json.dumps(after_tree, sort_keys=True).encode()),
            'workspace': {name: r.sha((SERVER / name).read_bytes()) for name in release.FILES}}


def capture():
    os.umask(0o077)
    r.RELEASE.mkdir(exist_ok=False)
    before = r.metadata(r.APP)
    dependencies = [r.metadata(name) for name in r.DEPENDENCIES]
    baseline = r.RELEASE / 'before'
    baseline.mkdir()
    archive = r.docker('exec', r.APP, 'tar', '-cf', '-', '-C', '/app',
                       'src', 'public', 'migrations', 'package.json', 'package-lock.json')
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        stream.extractall(baseline, filter='data')
    assert r.metadata(r.APP) == before
    shutil.copytree(baseline, r.RELEASE / 'candidate')
    r.save('manifest.json', {'capturedAt': r.now(), 'app': before, 'dependencies': dependencies, **patch_candidate()})
    r.current(r.state())
    print(json.dumps({'captured': True, 'files': release.FILES}), flush=True)


def refresh():
    data = r.state()
    assert r.metadata(r.APP) == data['app']
    data.update(patch_candidate())
    r.save('manifest.json', data)
    for stale in [r.RELEASE / 'validation-passed.json', r.RELEASE / 'image-check.json', release.ARTIFACTS / 'checks-passed']:
        stale.unlink(missing_ok=True)
    r.current(data)


if __name__ == '__main__':
    {'capture': capture, 'refresh': refresh, 'validated': release.validated, 'build': r.build,
     'apply': release.apply, 'verify': release.verify, 'accept-rollback': release.accept_rollback}[sys.argv[1]]()
