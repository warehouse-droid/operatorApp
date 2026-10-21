import hashlib
import json
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[1]
out = root / 'test-artifacts/special-workflow-review/line-decline-20261003'
files = json.loads((root / 'tools/special-line-decline-files.json').read_text())
report = {}
for name in files:
    source = root / name
    before = out / 'before' / name
    result = subprocess.run(['git', 'diff', '--no-index', '--histogram', '--unified=0', str(before) if before.exists() else '/dev/null', str(source)], capture_output=True, text=True)
    if result.returncode not in (0, 1):
        raise RuntimeError(result.stderr)
    report[name] = {'sourceHash': hashlib.sha256(source.read_bytes()).hexdigest(),
                    'baselineHash': hashlib.sha256(before.read_bytes()).hexdigest() if before.exists() else None,
                    'diff': result.stdout}
(out / 'changed-diffs.json').write_text(json.dumps(report, indent=2) + '\n')
