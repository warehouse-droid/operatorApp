"""Capture the current app and apply only the persisted Dispatch task patch."""
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'test-artifacts/dispatch-recent-cards'
spec = importlib.util.spec_from_file_location('recent_release', ROOT / 'tools/dispatch-recent-cards-release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

before = release.metadata(release.APP)
dependencies = {name: release.metadata(name) for name in release.DEPENDENCIES}
baseline, candidate = OUT / 'production-before', OUT / 'candidate'
resume = '--resume' in sys.argv
if baseline.exists() and not resume:
    archive = OUT / ('production-before-' + json.loads((OUT / 'baseline-metadata.json').read_text())['app']['image'].split(':')[-1])
    assert not archive.exists(), 'Already archived this baseline'
    baseline.rename(archive)
if candidate.exists():
    shutil.rmtree(candidate)
if not resume:
    baseline.mkdir(parents=True)
    for file in ['src', 'public', 'migrations', 'package.json', 'package-lock.json']:
        with tarfile.open(fileobj=io.BytesIO(release.docker('cp', release.APP + ':/app/' + file, '-'))) as archive:
            archive.extractall(baseline, filter='data')
    for directory in ['test', 'tools', 'contracts']:
        (baseline / directory).symlink_to(ROOT / directory, target_is_directory=True)
    shutil.copy2(ROOT / 'eslint.mbt.config.js', baseline / 'eslint.mbt.config.js')
assert release.metadata(release.APP) == before, 'App changed while capturing'
assert {name: release.metadata(name) for name in release.DEPENDENCIES} == dependencies, 'Dependency changed while capturing'
assert release.release.core.files_at(baseline) == json.loads(release.docker('exec', release.APP, 'node', '-e', release.HASH_SCRIPT)), 'Captured runtime differs'
(OUT / 'baseline-metadata.json').write_text(json.dumps({'app': before, 'dependencies': dependencies}, indent=2) + '\n')
shutil.copytree(baseline, candidate, symlinks=True)
subprocess.run(['patch', '--batch', '--fuzz=0', '--no-backup-if-mismatch', '-p1', '-d', str(candidate), '-i', str(ROOT / 'test/dispatch-recent-cards.changes.patch')], check=True)
before_hashes, after_hashes, hashes, _ = release.candidate_scope()
for directory in [baseline, candidate]:
    for parent, children, files in os.walk(directory):
        for path in [Path(parent), *(Path(parent) / name for name in children + files)]:
            if not path.is_symlink():
                os.chown(path, ROOT.stat().st_uid, ROOT.stat().st_gid)
print(json.dumps({'captured': True, 'image': before['image'], 'imageId': before['imageId'], 'beforeFiles': len(before_hashes), 'afterFiles': len(after_hashes), 'sourceHashes': hashes}), flush=True)
