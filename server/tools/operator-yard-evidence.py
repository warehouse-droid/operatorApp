#!/usr/bin/env python3
"""Freeze the task source and verify fresh, reproducible gauntlet results."""
import collections
import difflib
import hashlib
import json
from pathlib import Path
import re
import sys

root = Path(__file__).resolve().parents[1]
artifact = root / 'test-artifacts/operator-yard-access'
manifest = json.loads((root / 'test/support/operator-yard-manifest.json').read_text())


def hashes():
    files = manifest['production'] + manifest['validation']
    files += [str(p.relative_to(root)) for p in sorted((root / 'tools').glob('operator-yard-*'))]
    return {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in files}


if sys.argv[1:] == ['prepare']:
    changes = {}
    for name in manifest['production']:
        if not name.endswith('.js'):
            continue
        before = artifact / 'baseline' / name
        old = before.read_text().splitlines() if before.exists() else []
        new = (root / name).read_text().splitlines()
        lines = []
        for tag, _, _, start, end in difflib.SequenceMatcher(None, old, new, autojunk=False).get_opcodes():
            if tag in ('insert', 'replace'):
                lines += list(range(start + 1, end + 1))
        if lines:
            changes[name] = lines
    (artifact / 'changed-lines.json').write_text(json.dumps(changes, indent=2) + '\n')
    (artifact / 'source-hashes.json').write_text(json.dumps(hashes(), indent=2) + '\n')
    print('Source and changed-line inventory frozen.')
    sys.exit(0)

assert hashes() == json.loads((artifact / 'source-hashes.json').read_text()), 'Sources changed during the final gauntlet'


def diagnostics(kind, label):
    text = (artifact / f'{kind}-{label}.log').read_text()
    if kind == 'types':
        return collections.Counter(re.sub(r'\(\d+,\d+\)', '', line) for line in text.splitlines() if 'error TS' in line)
    return collections.Counter((file['filePath'], row['ruleId'], row['message']) for file in json.loads(text) for row in file['messages'])


static = {}
for kind in ['types', 'lint']:
    before, after = diagnostics(kind, 'baseline'), diagnostics(kind, 'current')
    assert not after - before, f'New {kind} diagnostics: {after - before}'
    static[kind] = {'baseline': sum(before.values()), 'current': sum(after.values()), 'new': 0}


def tap(name):
    text = (artifact / name).read_text()
    counts = {key: int(re.findall(rf'^# {key} (\d+)$', text, re.M)[-1]) for key in ['tests', 'pass', 'fail', 'skipped']}
    assert counts['fail'] == 0 and counts['skipped'] == 0, (name, counts)
    return counts


results = {'focused': tap('focused-final.log'), 'browser': tap('browser-final.log'), 'browserCoverage': tap('browser-coverage-final.log'), 'static': static}
expected = {'P3.12: browser specs share one worker-owned database-pool lifecycle', 'quality non-regression: the gauntlet builds and validates the omit-dev runtime'}
full = (artifact / 'full-final.log').read_text()
failures = {re.sub(r' \([\d.]+ms\)$', '', row) for row in re.findall(r'^✖ (.+)$', full, re.M) if row != 'failing tests:'}
assert failures == expected, failures
baseline = (artifact / 'baseline-final.log').read_text()
baseline_failures = set(re.findall(r'^not ok \d+ - (.+)$', baseline, re.M))
assert baseline_failures == expected, baseline_failures
results['full'] = {key: sum(int(n) for n in re.findall(rf'^ℹ {key} (\d+)$', full, re.M)) for key in ['tests', 'pass', 'fail', 'skipped']}
results['full']['baselineFailures'] = sorted(expected)
assert results['full']['fail'] == 2
e2e = (artifact / 'e2e-final.log').read_text()
assert re.search(r'\b72 passed\b', e2e) and not re.search(r'\d+ failed', e2e), 'Operator E2E regression failed'
results['operatorE2E'] = 72
coverage = json.loads((artifact / 'changed-coverage.json').read_text())
assert all(not row['missed'] for row in coverage), 'Changed executable lines are untested'
results['coverage'] = {'covered': sum(row['covered'] for row in coverage), 'executable': sum(row['executable'] for row in coverage)}
mutants = json.loads((artifact / 'mutations.json').read_text())
assert len(mutants) == 5 and all(stage['killed'] for row in mutants for stage in row['stages'])
results['mutations'] = {'focused': 5, 'propertiesOnly': 5}
assert 'Secret scan passed:' in (artifact / 'secrets-final.log').read_text()
results['sourceTreeSha256'] = hashlib.sha256(json.dumps(hashes(), sort_keys=True).encode()).hexdigest()
(artifact / 'final-results.json').write_text(json.dumps(results, indent=2) + '\n')
print(json.dumps(results, indent=2))
