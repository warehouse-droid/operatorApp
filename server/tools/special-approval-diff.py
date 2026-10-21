from pathlib import Path
import json
import difflib
root = Path(__file__).resolve().parents[1]
out = root / 'test-artifacts/special-workflow-review/po-approval-reference-20260928'
patch = ''
for name in json.loads((out / 'runtime-files.json').read_text()):
    before = out / 'baseline' / name
    patch += ''.join(difflib.unified_diff(before.read_text().splitlines(True) if before.exists() else [],
        (root / name).read_text().splitlines(True), fromfile='a/server/' + name, tofile='b/server/' + name, n=0))
(out / 'runtime.diff').write_text(patch)
