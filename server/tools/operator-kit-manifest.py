"""Refresh the scoped patch/changed-line manifest against the preserved pre-task worktree."""
from pathlib import Path
import difflib
import hashlib
import json
import re

ROOT = Path(__file__).resolve().parents[1]
BASE = Path('/home/ubuntu/operator-kit-baseline-20260918')
catalog = (ROOT / 'tools/operator-kit-files.mjs').read_text()
files = re.findall(r"'([^']+)'", catalog.split('export const added')[0])
manifest, patches = [], []
for name in files:
    before = (BASE / name).read_text() if (BASE / name).exists() else ''
    after = (ROOT / name).read_text()
    lines, current = [], after.splitlines()
    for kind, _, _, start, end in difflib.SequenceMatcher(None, before.splitlines(), current, autojunk=False).get_opcodes():
        if kind in ('insert', 'replace'):
            lines.extend(i + 1 for i in range(start, end) if current[i].strip()
                         and not current[i].lstrip().startswith(('//', '/*', '*'))
                         and not re.fullmatch(r'[\s{}();,]+', current[i]))
    manifest.append({'file': name, 'sha256': hashlib.sha256(after.encode()).hexdigest(), 'lines': lines})
    patches.extend(difflib.unified_diff(before.splitlines(True), after.splitlines(True), fromfile='a/' + name, tofile='b/' + name))
(ROOT / 'test/support/operator-kit-changes.json').write_text(json.dumps(manifest, indent=2) + '\n')
(ROOT / 'test/support/operator-kit-changes.patch').write_text(''.join(patches))
print(json.dumps({'changedExecutableLines': sum(len(row['lines']) for row in manifest), 'files': len(files)}))
