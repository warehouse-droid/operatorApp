"""Rebase the exact validated feature patch onto a newer live image, preserving prior evidence."""
import difflib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import tarfile
import time

spec = importlib.util.spec_from_file_location('feature_release', Path(__file__).with_name('release.py'))
feature = importlib.util.module_from_spec(spec)
spec.loader.exec_module(feature)
r = feature.r
stamp = time.strftime('%Y%m%d-%H%M%S', time.gmtime())
work = r.RELEASE / ('refresh-' + stamp)
work.mkdir()
app = r.metadata(r.APP)
dependencies = [r.metadata(name) for name in r.DEPENDENCIES]
before = work / 'before'
before.mkdir()
archive = r.docker('exec', r.APP, 'tar', '-cf', '-', '-C', '/app',
    'src', 'public', 'migrations', 'package.json', 'package-lock.json')
with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
    stream.extractall(before, filter='data')
for path in before.rglob('*'):
    path.chmod(0o755 if path.is_dir() else 0o644)
candidate = work / 'candidate'
shutil.copytree(before, candidate)
patch = (r.RELEASE / 'feature.patch').read_text()
r.apply_patch(candidate, patch, 'feature')
old, new = r.files_at(before), r.files_at(candidate)
changed = sorted(name for name in old.keys() | new.keys() if old.get(name) != new.get(name))
assert changed == sorted(feature.FILES), changed
assert all((candidate / name).read_bytes() == (feature.SERVER / name).read_bytes() for name in changed), 'Refreshed candidate differs from workspace; inspect before continuing'
assert r.metadata(r.APP) == app, 'Live application changed during capture'
assert [r.metadata(name) for name in r.DEPENDENCIES] == dependencies

previous = r.RELEASE / ('previous-' + stamp)
previous.mkdir()
for name in ['before', 'candidate', 'capture.json', 'manifest.json', 'changed-lines.json',
             'validation-passed.json', 'image-check.json', 'build.log', 'stage',
             'config-check.json', 'compose.release.yml', 'compose.rollback.yml', 'server-import.log']:
    path = r.RELEASE / name
    if path.exists():
        path.rename(previous / name)
shutil.copy2(r.RELEASE / 'feature.patch', previous / 'feature.patch')
before.rename(r.RELEASE / 'before')
candidate.rename(r.RELEASE / 'candidate')
work.rmdir()
r.save('capture.json', {'app': app, 'dependencies': dependencies})
r.save('manifest.json', {'app': app, 'dependencies': dependencies, 'files': changed,
    'beforeTree': old, 'candidateTree': new,
    'candidateTreeHash': r.sha(json.dumps(new, sort_keys=True).encode()),
    'workspace': {name: r.sha((feature.SERVER / name).read_bytes()) for name in changed},
    'previousRelease': str(previous), 'refreshReason': 'Preserve newer live changes before the user-authorized deployment.'})
lines = {}
for name in changed:
    baseline = (r.RELEASE / 'before' / name).read_text().splitlines()
    updated = (r.RELEASE / 'candidate' / name).read_text().splitlines()
    lines[name] = [i+1 for tag, _a, _b, start, end in difflib.SequenceMatcher(a=baseline, b=updated).get_opcodes()
        if tag in ('replace', 'insert') for i in range(start, end)
        if updated[i].strip() and not updated[i].strip().startswith(('//', '/*', '*'))]
r.save('changed-lines.json', lines)
r.current(r.state())
evidence = feature.SERVER / 'test-artifacts/backorder-confirmed-links-20261016'
for name in ['baseline', 'final', 'evidence.json']:
    path = evidence / name
    if path.exists():
        path.rename(evidence / ('previous-' + stamp + '-' + name))
print(json.dumps({'refreshed': True, 'baseImage': app['imageId'], 'files': changed, 'previousRelease': str(previous)}))
