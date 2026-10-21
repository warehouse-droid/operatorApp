"""Build the exact task diff against its captured pre-task baseline for secret scanning."""
import difflib
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
artifact = root / 'test-artifacts/direct-ship-lifecycle-20260925'
baseline = artifact / 'baseline'
files = set(json.loads((root / 'tools/direct-ship-files.json').read_text()))
for pattern in ['tools/direct-ship*', 'test/dispatch/**/direct-ship*', 'test/direct-ship*']:
    files.update(str(path.relative_to(root)) for path in root.glob(pattern) if path.is_file())
parts = []
for name in sorted(files):
    before = (baseline / name).read_text().splitlines(keepends=True) if (baseline / name).is_file() else []
    after = (root / name).read_text().splitlines(keepends=True)
    parts.extend(difflib.unified_diff(before, after, fromfile='a/' + name, tofile='b/' + name))
(artifact / 'task.diff').write_text(''.join(parts))
