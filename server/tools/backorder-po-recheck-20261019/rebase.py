"""Preserve the latest live releases when rebuilding the approved PO fix."""
import importlib.util
import io
import json
from pathlib import Path
import shutil
import tarfile

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('po_release', HERE / 'release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
r = release.r
previous = r.state()
app = r.metadata(r.APP)
assert app['imageId'] != previous['app']['imageId'], 'Live base has not changed; no rebase needed'
r.ready(app['imageId'])
dependencies = [r.metadata(name) for name in r.DEPENDENCIES]
report = json.loads((r.SERVER / 'test-artifacts/backorder-po-recheck-20261019/final/report.json').read_text())
assert report['passed']
for name in release.FILES:
    assert r.sha((r.RELEASE / 'candidate' / name).read_bytes()) == report['source'][name]

incoming = r.RELEASE / 'rebase-incoming'
incoming.mkdir(exist_ok=False)
baseline = incoming / 'before'
baseline.mkdir()
archive = r.docker('exec', r.APP, 'tar', '-cf', '-', '-C', '/app',
                   'src', 'public', 'migrations', 'package.json', 'package-lock.json')
with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
    stream.extractall(baseline, filter='data')
for path in baseline.rglob('*'):
    path.chmod(0o755 if path.is_dir() else 0o644)
before = r.files_at(baseline)
assert before == json.loads(r.docker('exec', r.APP, 'node', '-e', r.HASH_SCRIPT)), 'Live runtime changed during capture'
upstream_changes = sorted(name for name in before.keys() | previous['beforeTree'].keys()
                          if before.get(name) != previous['beforeTree'].get(name))
assert not set(release.FILES).intersection(upstream_changes), 'Overlapping release requires review'
for name in release.FILES:
    assert before[name] == previous['beforeTree'][name], 'PO workflow changed concurrently'
for name in ['package.json', 'package-lock.json']:
    assert (baseline / name).read_bytes() == (r.RELEASE / 'candidate' / name).read_bytes(), 'Dependencies changed'
candidate = incoming / 'candidate'
shutil.copytree(baseline, candidate)
for name in release.FILES:
    shutil.copy2(r.RELEASE / 'candidate' / name, candidate / name)
after = r.files_at(candidate)
assert after == {**before, **report['source']}, 'Unexpected overlay changes'
assert r.metadata(r.APP) == app
assert [r.metadata(name) for name in r.DEPENDENCIES] == dependencies

stamp = r.now().replace(':', '').replace('.', '-')
retained = r.RELEASE / ('before-rebase-' + stamp)
retained.mkdir(exist_ok=False)
for name in ['before', 'candidate', 'stage', 'capture.json', 'manifest.json',
             'validation-passed.json', 'image-check.json', 'config-check.json',
             'compose.release.yml', 'compose.rollback.yml', 'build.log', 'server-import.log']:
    path = r.RELEASE / name
    if path.exists():
        path.rename(retained / name)
baseline.rename(r.RELEASE / 'before')
candidate.rename(r.RELEASE / 'candidate')
incoming.rmdir()
capture = {'app': app, 'dependencies': dependencies}
r.save('capture.json', capture)
r.save('manifest.json', {**capture, 'files': release.FILES, 'beforeTree': before, 'candidateTree': after,
    'candidateTreeHash': r.sha(json.dumps(after, sort_keys=True).encode()),
    'workspace': previous['workspace']})
r.save('rebase.json', {'fromImageId': previous['app']['imageId'], 'ontoImageId': app['imageId'],
    'preservedFiles': {name: after.get(name) for name in upstream_changes}, 'previousArtifacts': str(retained),
    'featureHashesUnchanged': report['source'], 'requiresFreshVerification': True})
r.current(r.state())
evidence = r.SERVER / 'test-artifacts/backorder-po-recheck-20261019'
(evidence / 'final').rename(evidence / ('final-before-rebase-' + stamp))
print(json.dumps({'rebased': True, 'baseImageId': app['imageId'], 'preservedFiles': upstream_changes,
    'fixFiles': release.FILES, 'requiresFreshVerification': True}), flush=True)
