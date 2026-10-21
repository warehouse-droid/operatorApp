"""Refresh a non-overlapping live baseline before the final SO/TO release checks."""
import importlib.util
import io
import json
from pathlib import Path
import shutil
import tarfile

SERVER = Path(__file__).resolve().parents[1]
ARTIFACT = SERVER / 'test-artifacts/delivery-transfer-orders-20261015'
spec = importlib.util.spec_from_file_location('release', SERVER / 'tools/delivery-scm-release.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)


def main():
    project = 'mbbs-delivery-transfer-orders-test'
    assert not core.docker('ps', '-a', '--filter', 'label=com.docker.compose.project=' + project,
                           '--format', '{{.ID}}').strip(), 'Wait for test teardown before refreshing'
    previous = json.loads((ARTIFACT / 'capture.json').read_text())
    files = json.loads((ARTIFACT / 'source-hashes.json').read_text())
    app = core.metadata(core.APP)
    dependencies = [core.metadata(name) for name in core.DEPENDENCIES]
    assert dependencies == previous['dependencies'], 'Dependency changed; inspect before refresh'
    before = json.loads(core.docker('exec', core.APP, 'node', '-e', core.HASH_SCRIPT))
    drift = sorted(name for name in previous['beforeTree'].keys() | before.keys()
                   if previous['beforeTree'].get(name) != before.get(name))
    assert drift and not set(drift).intersection(files), 'Overlapping changes need manual reconciliation'
    refreshed = ARTIFACT / 'live-refresh'
    refreshed.mkdir(exist_ok=False)
    archive = core.docker('exec', core.APP, 'tar', '-cf', '-', '-C', '/app',
                          'src', 'public', 'migrations', 'package.json', 'package-lock.json')
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        stream.extractall(refreshed, filter='data')
    assert core.metadata(core.APP) == app, 'App changed during capture'
    assert core.files_at(refreshed) == before
    for name in ['package.json', 'package-lock.json']:
        assert (refreshed / name).read_bytes() == (ARTIFACT / 'baseline' / name).read_bytes(), 'Dependencies changed'
    for name, digest in files.items():
        assert core.sha((SERVER / name).read_bytes()) == digest, 'Feature source changed'
    shutil.copy2(ARTIFACT / 'capture.json', ARTIFACT / 'capture-before-live-refresh.json')
    for name in ['baseline', 'candidate']:
        (ARTIFACT / name).rename(ARTIFACT / (name + '-before-live-refresh'))
    refreshed.rename(ARTIFACT / 'baseline')
    shutil.copytree(ARTIFACT / 'baseline', ARTIFACT / 'candidate')
    for name in files:
        shutil.copy2(SERVER / name, ARTIFACT / 'candidate' / name)
    current = {'app': app, 'dependencies': dependencies, 'beforeTree': before}
    (ARTIFACT / 'capture.json').write_text(json.dumps(current, indent=2) + '\n')
    report = {'at': core.now(), 'preservedUnrelatedChanges': drift, 'overlap': [],
              'previousImageId': previous['app']['imageId'], 'currentImageId': app['imageId'],
              'featureSourceHashesUnchanged': True, 'dependenciesUnchanged': True,
              'originalBaseline': 'baseline-before-live-refresh', 'nextCheck': 'bash server/tools/delivery-transfer-orders-test.sh final'}
    (ARTIFACT / 'live-refresh.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
