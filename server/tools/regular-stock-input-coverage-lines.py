"""Locate changed lines with histogram diff, keeping repeated route wrappers aligned."""
from pathlib import Path
import json
import re
import subprocess
import sys

server = Path(__file__).resolve().parents[1]
source, output = map(Path, sys.argv[1:3])
changed = {}
for name in json.loads((server / 'tools/regular-stock-input-files.json').read_text()):
    if not name.endswith('.js'):
        continue
    baseline, current = output / 'before' / name, source / name
    if baseline.exists():
        result = subprocess.run(['git', 'diff', '--no-index', '--histogram', '--unified=0', '--', str(baseline), str(current)], capture_output=True, text=True)
        assert result.returncode in [0, 1], result.stderr
        lines = []
        for start, count in re.findall(r'^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@', result.stdout, re.M):
            lines.extend(range(int(start), int(start) + int(count or 1)))
    else:
        lines = list(range(1, len(current.read_text().splitlines()) + 1))
    changed[name] = lines
(output / 'changed-lines.json').write_text(json.dumps({'algorithm': 'git histogram', 'files': changed}, indent=2) + '\n')
