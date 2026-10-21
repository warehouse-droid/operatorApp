"""Report browser V8 coverage for changed executable lines; no inferred coverage."""
from pathlib import Path
import difflib
import hashlib
import json

root = Path(__file__).resolve().parents[1]
baseline = root / 'test-artifacts/bin-planner-readonly-release-20260927/baseline'
artifact = root / 'test-artifacts/mbt-bin-planning/checks/readonly-final-feature'
records = []
for file in artifact.glob('readonly-coverage-*.json'):
    records.extend(json.loads(file.read_text()))
assert records, 'Run the browser suite with coverage first'
report = []
for name in ['dispatch.js', 'mbt-planning.js']:
    file = 'public/' + name
    source = (root / file).read_text()
    old = (baseline / file).read_text().splitlines(keepends=True)
    lines = source.splitlines(keepends=True)
    changed = set()
    for tag, _, _, start, end in difflib.SequenceMatcher(a=old, b=lines, autojunk=False).get_opcodes():
        if tag in ['insert', 'replace']:
            changed.update(range(start, end))
    executions = []
    for record in records:
        if record['url'].split('/')[-1].split('?')[0] != name:
            continue
        assert record['source'] == source, 'Browser source differs: ' + file
        executions.append([r for f in record['functions'] for r in f['ranges']])
    assert executions, name
    offsets = []; offset = 0
    for line in lines:
        offsets.append(offset + len(line[:len(line)-len(line.lstrip())].encode('utf-16-le')) // 2)
        offset += len(line.encode('utf-16-le')) // 2
    eligible = [i for i in sorted(changed) if lines[i].strip() and not lines[i].lstrip().startswith(('//', '/*', '*'))
                and lines[i].strip() not in ['}', '};', ');', '});']]
    covered = []; missed = []
    for i in eligible:
        hit = False
        for ranges in executions:
            matches = [r for r in ranges if r['startOffset'] <= offsets[i] < r['endOffset']]
            if matches and min(matches, key=lambda r: r['endOffset']-r['startOffset'])['count'] > 0:
                hit = True
        (covered if hit else missed).append(i + 1)
    report.append({'file': file, 'sha256': hashlib.sha256(source.encode()).hexdigest(),
                   'changed_lines_measured': len(eligible), 'browser_covered': len(covered), 'uncovered_lines': missed})
out = root / 'test-artifacts/bin-planner-readonly/final/browser-changed-line-coverage.json'
out.write_text(json.dumps(report, indent=2))
print(json.dumps(report, indent=2))
