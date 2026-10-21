"""Compare only the closure correction to its captured deployed baseline."""
from pathlib import Path
import difflib
import json

server = Path(__file__).resolve().parents[1]
out = server / 'test-artifacts/special-operation-progress'
chunks = []
for file in json.loads((out / 'runtime-files.json').read_text()):
    baseline = out / 'baseline' / file
    before = baseline.read_text() if baseline.exists() else ''
    chunks.extend(difflib.unified_diff(before.splitlines(True), (server / file).read_text().splitlines(True),
                                     fromfile='a/server/' + file, tofile='b/server/' + file, n=0))
(out / 'runtime.diff').write_text(''.join(chunks))
