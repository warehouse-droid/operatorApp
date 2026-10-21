#!/usr/bin/env python3
"""Compare actual baseline diagnostics and changed-line coverage for this task."""
import collections
import difflib
import hashlib
import json
import pathlib
import re
import sys

server = pathlib.Path(__file__).resolve().parents[1]
artifact = server / 'test-artifacts/operator-to-yard-flow'
names = ['transfer-order-posting-domain.js', 'transfer-order-posting-repository.js',
         'transfer-order-posting-service.js', 'receiving-repository.js',
         'delivery-repository.js', 'server.js', 'order-sync-repository.js', 'netsuite.js']

def hashes():
    return {f'src/{name}': hashlib.sha256((server / 'src' / name).read_bytes()).hexdigest() for name in names}

def coverage():
    data = json.loads((artifact / 'coverage/coverage-final.json').read_text())
    covered, changed, misses = 0, 0, []
    branch_covered, branch_changed, branch_misses = 0, 0, []
    for name in names:
        reference = artifact / 'coverage-baseline/src' / name
        if not reference.exists():
            reference = artifact / 'baseline/src' / name
        before = reference.read_text().splitlines()
        after = (server / 'src' / name).read_text().splitlines()
        entries = data.get(f'/app/src/{name}', {})
        executed = set()
        for key, location in entries.get('statementMap', {}).items():
            if entries['s'][key] > 0:
                executed.update(range(location['start']['line'], location['end']['line'] + 1))
        changed_lines = set()
        for tag, _, _, start, end in difflib.SequenceMatcher(None, before, after).get_opcodes():
            if tag not in ('replace', 'insert'):
                continue
            for index in range(start, end):
                text = after[index].strip()
                if not text or text.startswith(('//', '/*', '*')):
                    continue
                changed += 1
                changed_lines.add(index + 1)
                if index + 1 in executed:
                    covered += 1
                else:
                    misses.append(f'src/{name}:{index + 1}')
        for key, branch in entries.get('branchMap', {}).items():
            line = branch['loc']['start']['line']
            if line not in changed_lines:
                continue
            for count in entries['b'][key]:
                branch_changed += 1
                branch_covered += count > 0
                if count == 0:
                    branch_misses.append(f'src/{name}:{line}')
    return {'covered': covered, 'changed': changed, 'uncovered': misses,
            'branches': {'covered': branch_covered, 'changed': branch_changed, 'uncovered': branch_misses}}

def diagnostics(path):
    # Line shifts do not turn an existing compiler diagnostic into a new error.
    return collections.Counter(re.sub(r'\(\d+,\d+\):', ':', line) for line in path.read_text().splitlines() if 'error TS' in line)

def type_comparison():
    old = diagnostics(artifact / 'types-baseline.log')
    new = diagnostics(artifact / 'types-final.log')
    return {'baseline': sum(old.values()), 'final': sum(new.values()), 'new': list((new - old).elements())}

def expected_files(mode):
    match = re.search(rf'\[isolation\] full-{mode} 1/(\d+) ', (artifact / f'full-{mode}.log').read_text())
    assert match, f'No complete test discovery recorded for {mode}'
    return int(match.group(1))

def source_comparison():
    started = json.loads((artifact / 'full-final-source-hashes.json').read_text())
    current = hashes()
    focused = json.loads((artifact / 'source-hashes.json').read_text())
    assert all(focused[name] == digest for name, digest in current.items()), 'Focused suite source changed after its run'
    changed = [name for name in current if started[name] != current[name]]
    if not changed:
        return {'fullSuiteStart': started, 'focusedFinal': current, 'concurrentChange': None}
    # Preserve the full run's original result and hashes. Only the exact, recorded
    # concurrent edit is accepted, with a fresh replay on the final snapshot.
    event = json.loads((artifact / 'concurrent-change.json').read_text())
    assert changed == [event['file']], 'Unrecorded source changes during the full suite'
    name = event['file']
    original = (artifact / event['originalSource']).read_bytes()
    assert hashlib.sha256(original).hexdigest() == event['beforeHash'] == started[name]
    assert current[name] == event['afterHash']
    actual_patch = ''.join(difflib.unified_diff(original.decode().splitlines(True),
        (server / name).read_text().splitlines(True), fromfile=f'a/{name}', tofile=f'b/{name}'))
    assert actual_patch == (artifact / event['patch']).read_text(), 'Concurrent edit differs from the recorded patch'
    replay = event['replay']
    output = (artifact / replay['log']).read_text()
    for label, expected in [('tests', replay['pass']), ('pass', replay['pass']), ('fail', 0)]:
        matches = re.findall(rf'^# {label} (\d+)$', output, re.M)
        assert matches and int(matches[-1]) == expected, 'Concurrent-edit replay did not pass'
    return {'fullSuiteStart': started, 'focusedFinal': current, 'concurrentChange': event}

if len(sys.argv) > 1 and sys.argv[1] == 'hash':
    (artifact / 'final-source-hashes.json').write_text(json.dumps(hashes(), indent=2) + '\n')
    sys.exit(0)
if len(sys.argv) > 1 and sys.argv[1] == 'coverage':
    print(json.dumps(coverage(), indent=2))
    sys.exit(0)
if len(sys.argv) > 1 and sys.argv[1] == 'types':
    result = type_comparison()
    print(json.dumps(result, indent=2))
    assert not result['new'], 'New TypeScript errors remain'
    sys.exit(0)
baseline = json.loads((artifact / 'full-baseline-results.json').read_text())
final = json.loads((artifact / 'full-final-results.json').read_text())
source = source_comparison()
base_by_file = {result['file']: result for result in baseline}
new_failures = []
resolved_failures = []
for result in final:
    if result['exitCode'] == 0:
        continue
    old = base_by_file.get(result['file'])
    if not old or old['exitCode'] == 0:
        event = source['concurrentChange']
        if event and result['file'] == event['replay']['file']:
            assert old and old['tests'] == event['replay']['pass']
            resolved_failures.append({'original': result, 'replay': event['replay'], 'reason': event['description']})
        else:
            new_failures.append(result)
    elif set(result['failures']) - set(old['failures']):
        new_failures.append(result)
assert len(baseline) == expected_files('baseline') and len(final) == expected_files('final'), 'A full suite did not finish'
types = type_comparison()
summary = {'sourceHashes': hashes(), 'sourceComparison': source,
           'fullBaseline': {'files': len(baseline), 'failedFiles': sum(r['exitCode'] != 0 for r in baseline), 'tests': sum(r['tests'] for r in baseline)},
           'fullFinal': {'files': len(final), 'failedFiles': sum(r['exitCode'] != 0 for r in final), 'tests': sum(r['tests'] for r in final)},
           'newFailures': new_failures, 'resolvedFailures': resolved_failures, 'types': types,
           'coverage': coverage()}
(artifact / 'results.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary, indent=2))
assert not new_failures, 'New regression failures remain'
assert not types['new'], 'New TypeScript errors remain'
assert not summary['coverage']['uncovered'], 'Changed executable lines were not exercised'
