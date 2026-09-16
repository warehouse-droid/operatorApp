#!/usr/bin/env python3
"""Freeze the task source and verify reproducible, fresh gauntlet evidence."""
import collections
import difflib
import hashlib
import json
from pathlib import Path
import re
import sys

root = Path(__file__).resolve().parents[1]
artifact = root / 'test-artifacts/consolidation-load'
manifest = json.loads((root / 'test/consolidation-load-manifest.json').read_text())


def hashes():
    files = set(manifest['production'] + manifest['validation'])
    files.add('test/consolidation-load-manifest.json')
    files.update(str(p.relative_to(root)) for p in (root / 'tools').glob('consolidation-load-*') if p.is_file())
    return {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in sorted(files)}


if sys.argv[1:] == ['prepare']:
    changes, patches = {}, []
    for name in manifest['production'] + manifest['validation']:
        previous = artifact / 'baseline' / name
        old = previous.read_text().splitlines(keepends=True) if previous.exists() else []
        new = (root / name).read_text().splitlines(keepends=True)
        patches.extend(difflib.unified_diff(old, new, fromfile='a/' + name, tofile='b/' + name))
        if name not in manifest['production'] or not name.endswith(('.js', '.mjs')):
            continue
        lines = []
        for tag, _, _, start, end in difflib.SequenceMatcher(None, old, new, autojunk=False).get_opcodes():
            if tag in ('insert', 'replace'):
                lines.extend(range(start + 1, end + 1))
        if lines:
            changes[name] = lines
    (artifact / 'task.patch').write_text(''.join(patches))
    (artifact / 'changed-lines.json').write_text(json.dumps(changes, indent=2) + '\n')
    (artifact / 'source-hashes.json').write_text(json.dumps(hashes(), indent=2) + '\n')
    print('Source state and changed lines frozen.')
    sys.exit(0)

assert hashes() == json.loads((artifact / 'source-hashes.json').read_text()), 'Sources changed during gauntlet'


def diagnostics(kind, label):
    text = (artifact / f'{kind}-{label}.log').read_text()
    if kind == 'types':
        return collections.Counter(re.sub(r'\(\d+,\d+\)', '', line) for line in text.splitlines() if 'error TS' in line)
    return collections.Counter((Path(file['filePath']).name, row['ruleId'], row['message']) for file in json.loads(text) for row in file['messages'])


results = {'baselineCommit': manifest['baselineCommit'], 'static': {}}
for kind in ['types', 'lint']:
    before, after = diagnostics(kind, 'baseline'), diagnostics(kind, 'current')
    assert not after - before, f'New {kind} diagnostics: {after - before}'
    results['static'][kind] = {'baseline': sum(before.values()), 'current': sum(after.values()), 'new': 0}


def tap(name):
    text = (artifact / name).read_text()
    counts = {key: int(re.findall(rf'^# {key} (\d+)$', text, re.M)[-1]) for key in ['tests', 'pass', 'fail', 'skipped']}
    assert counts['fail'] == 0 and counts['skipped'] == 0, (name, counts)
    return counts


for label in ['focused', 'browser', 'browser-coverage']:
    results[label] = tap(label + '-final.log')


def full_result(name):
    text = (artifact / name).read_text()
    failures = {re.sub(r' \([\d.]+ms\)$', '', row) for row in re.findall(r'^✖ (.+)$', text, re.M) if row != 'failing tests:'}
    counts = {key: sum(int(n) for n in re.findall(rf'^ℹ {key} (\d+)$', text, re.M)) for key in ['tests', 'pass', 'fail', 'skipped']}
    assert counts['tests'] > 2300, (name, counts)
    assert re.search(r'run failed in 2/\d+ file\(s\)', text), 'Full randomized suite did not finish with the recorded baseline failures'
    return {**counts, 'failures': sorted(failures)}


results['baselineFull'] = full_result('baseline-full-final.log')
results['full'] = full_result('full-final.log')
assert results['baselineFull']['failures'] == results['full']['failures']
assert results['full']['fail'] == results['baselineFull']['fail'] == 2
assert results['full']['skipped'] == results['baselineFull']['skipped']
e2e = (artifact / 'e2e-final.log').read_text()
assert re.search(r'\b72 passed\b', e2e) and not re.search(r'\d+ failed', e2e), 'Operator browser regression failed'
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
