"""Persist the task-only diff and changed lines; reconstruct its baseline if needed."""
from pathlib import Path
import difflib
import json
import shutil
import subprocess

root = Path(__file__).resolve().parents[1]
artifact = root / 'test-artifacts/split-address'
baseline = artifact / 'baseline'
patch_path = root / 'test/dispatch-split-address.changes.patch'
files = ['src/dispatch-delivery-group-repository.js', 'src/dispatch-repository.js',
         'src/delivery-repository.js', 'src/dispatch-planner-optimization.js',
         'public/dispatch.js', 'public/dispatch.html']
if not all((baseline / file).exists() for file in files):
    assert patch_path.exists(), 'The pre-fix baseline or persisted task patch is required.'
    for file in files:
        target = baseline / file
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(root / file, target)
    subprocess.run(['patch', '--batch', '-R', '-p1', '-i', str(patch_path)], cwd=baseline, check=True)
changes = {}
patch = []
for file in files:
    before = (baseline / file).read_text().splitlines(True)
    after = (root / file).read_text().splitlines(True)
    patch.extend(difflib.unified_diff(before, after, fromfile='a/' + file, tofile='b/' + file))
    if file.endswith('.js'):
        changes[file] = [line for tag, i, j, a, b in difflib.SequenceMatcher(None, before, after).get_opcodes()
                         if tag in ('insert', 'replace') for line in range(a + 1, b + 1)]
patch_path.write_text(''.join(patch))
(artifact / 'changed-lines.json').write_text(json.dumps(changes, indent=2) + '\n')
