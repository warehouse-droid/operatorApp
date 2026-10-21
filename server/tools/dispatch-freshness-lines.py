"""Identify this task's changed lines against its captured dirty-worktree baseline."""
import difflib
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
artifact = root / 'test-artifacts/dispatch-freshness-20261019'
files = ['public/dispatch.js', 'src/server.js', 'src/dispatch-planner-optimization.js',
         'src/dispatch-order-catalog-repository.js', 'src/dispatch-sales-resplit-repository.js', 'src/sor-rental-policy.js']
result = []
for file in files:
    before = (artifact / 'before' / file).read_text().splitlines()
    after = (root / file).read_text().splitlines()
    lines = []
    for action, _a, _b, start, end in difflib.SequenceMatcher(None, before, after, autojunk=False).get_opcodes():
        if action in ('insert', 'replace'):
            lines.extend(range(start + 1, end + 1))
    result.append({'file': file, 'lines': lines, 'sha256': hashlib.sha256((root / file).read_bytes()).hexdigest()})
(artifact / 'results').mkdir(parents=True, exist_ok=True)
(artifact / 'results/changed-lines.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'files': len(result), 'changedLines': sum(len(row['lines']) for row in result)}))
