from pathlib import Path
import difflib
import hashlib
import json
import re
import sys

root = Path(__file__).resolve().parents[1]
artifact = root / 'test-artifacts/dispatch-so-fulfilled-planning'
files = [
    'src/dispatch-fulfilled-so-policy.js', 'src/dispatch-fulfilled-so-repository.js',
    'src/dispatch-repository.js', 'src/dispatch-plan-repository.js',
    'src/dispatch-planner-v2-repository.js', 'src/dispatch-order-catalog-repository.js',
    'src/sales-order-reconciliation.js', 'src/server.js', 'public/dispatch.js', 'public/dispatch.html',
]
changed = {}
patches = []
hashes = {}
for file in files:
    source = (root / file).read_text()
    baseline = artifact / 'baseline' / file
    before = baseline.read_text() if baseline.exists() else ''
    hashes[file] = hashlib.sha256(source.encode()).hexdigest()
    old, new = before.splitlines(keepends=True), source.splitlines(keepends=True)
    patches.extend(difflib.unified_diff(old, new, fromfile='a/' + file, tofile='b/' + file))
    if file.endswith('.js'):
        changed[file] = [line + 1 for tag, _, _, first, last in difflib.SequenceMatcher(a=old, b=new).get_opcodes()
                         if tag in ('insert', 'replace') for line in range(first, last)]
(artifact / 'changed-lines.json').write_text(json.dumps(changed, indent=2) + '\n')
(artifact / 'task.patch').write_text(''.join(patches))
(artifact / 'source-hashes.json').write_text(json.dumps(hashes, indent=2) + '\n')
if 'prepare' in sys.argv:
    sys.exit(0)

def suite(name):
    text = (artifact / name).read_text()
    totals = {key: sum(map(int, re.findall(r'(?:ℹ |# )' + key + r' (\d+)', text)))
              for key in ('tests', 'pass', 'fail', 'skipped')}
    failed = re.findall(r'(?:✖ |not ok \d+ - )([^\n]+)', text)
    totals['failed'] = sorted(set(re.sub(r' \([\d.]+ms\)$', '', item) for item in failed))
    return totals

results = {name: suite(name) for name in ['baseline-full-final.log', 'full-final.log',
    'baseline-dispatch-full-final.log', 'dispatch-full-final.log', 'focused-final.log', 'browser-final.log']}

def lint(label):
    return sorted((row['filePath'].replace('/app/', ''), m['ruleId'], m['message'])
                  for row in json.loads((artifact / f'lint-{label}.log').read_text()) for m in row['messages'])

def types(label):
    return sorted(re.sub(r'\(\d+,\d+\)', '(LINE)', line) for line in
                  (artifact / f'types-{label}.log').read_text().splitlines() if 'error TS' in line)

from collections import Counter
results['static'] = {
    'lintBaseline': len(lint('baseline')), 'lintCurrent': len(lint('current')),
    'newLint': list((Counter(lint('current')) - Counter(lint('baseline'))).elements()),
    'typeBaseline': len(types('baseline')), 'typeCurrent': len(types('current')),
    'newTypes': list((Counter(types('current')) - Counter(types('baseline'))).elements()),
}
for baseline, current in [('baseline-full-final.log', 'full-final.log'),
                          ('baseline-dispatch-full-final.log', 'dispatch-full-final.log')]:
    results[current]['newFailures'] = sorted(set(results[current]['failed']) - set(results[baseline]['failed']))
(artifact / 'summary.json').write_text(json.dumps(results, indent=2) + '\n')
print(json.dumps(results, indent=2))
assert not results['full-final.log']['newFailures'], 'New full-suite failures'
assert not results['dispatch-full-final.log']['newFailures'], 'New Dispatch failures'
assert not results['static']['newLint'], 'New lint diagnostics'
assert not results['static']['newTypes'], 'New type diagnostics'
assert results['focused-final.log']['fail'] == 0, 'Focused suite failed'
assert results['browser-final.log']['fail'] == 0, 'Browser suite failed'
