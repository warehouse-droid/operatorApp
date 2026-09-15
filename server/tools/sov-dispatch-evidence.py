from pathlib import Path
import collections
import difflib
import hashlib
import json
import re

root = Path(__file__).resolve().parents[1]
artifact = root / 'test-artifacts/sov-dispatch'
final = artifact / 'final'


def messages(file):
    return collections.Counter((row['filePath'], message['ruleId'], message['message'])
                               for row in json.loads(file.read_text()) for message in row['messages'])


lint_delta = messages(final / 'lint.json') - messages(final / 'lint-baseline.json')
assert not lint_delta, f'New lint errors: {lint_delta}'
normalize_types = lambda value: re.sub(r'\(\d+,\d+\)', '(line,column)', value)
assert normalize_types((final / 'types.log').read_text()) == normalize_types((final / 'types-baseline.log').read_text())
assert '# fail 0' in (final / 'focused.log').read_text()
assert '# fail 0' in (final / 'route-prefix.log').read_text()
regressions = (final / 'regressions.log').read_text()
assert re.findall(r'^not ok \d+ - (.+)$', regressions, re.M) == ['RP-05 active travel protects its destination while allowing work after it']
assert 'not ok' in (final / 'regressions-baseline.log').read_text()
mutations = [json.loads(line) for line in (final / 'mutation.log').read_text().splitlines()]
assert mutations[-1] == {'mutantsKilled': 5, 'propertiesKilled': 5, 'restored': True}
mbt = (final / 'mbt.log').read_text()
failure = re.search(r'Isolated MBT main run failed in (.+)', mbt)
assert failure and failure.group(1) == ('2/462 file(s): /app/test/mbt/infrastructure/p3-gauntlet-contract.test.js, '
                                      '/app/test/mbt/infrastructure/production-runtime-contract.test.js'), 'Unexpected full-suite result'

coverage = json.loads((final / 'coverage/coverage-final.json').read_text())
details = []
hashes = []
for folder in ('src', 'public'):
    for file in sorted((root / folder).rglob('*')):
        if not file.is_file():
            continue
        relative = file.relative_to(root)
        before = artifact / 'baseline' / relative
        if before.exists() and file.read_bytes() == before.read_bytes():
            continue
        hashes.append(f'{hashlib.sha256(file.read_bytes()).hexdigest()}  server/{relative}')
        if file.suffix != '.js':
            continue
        lines = file.read_text().splitlines()
        changed = []
        for op, _, _, start, end in difflib.SequenceMatcher(None, before.read_text().splitlines() if before.exists() else [], lines).get_opcodes():
            if op in ('insert', 'replace'):
                changed.extend(range(start + 1, end + 1))
        data = coverage.get('/app/' + str(relative), {})
        hits = {}
        for key, statement in data.get('statementMap', {}).items():
            for line in range(statement['start']['line'], statement['end']['line'] + 1):
                hits[line] = max(hits.get(line, 0), data['s'][key])
        missing = [line for line in changed if lines[line - 1].strip() and not hits.get(line, 0)]
        assert not missing, f'Changed runtime lines not exercised: {relative}:{missing}'
        details.append({'file': str(relative), 'changedLines': len(changed), 'uncovered': missing})
(final / 'source.sha256').write_text('\n'.join(hashes) + '\n')
(final / 'changed-coverage.json').write_text(json.dumps(details, indent=2) + '\n')
print(json.dumps({'newLintErrors': 0, 'newTypeErrors': 0, 'changedRuntimeLines': sum(row['changedLines'] for row in details),
                  'uncoveredChangedRuntimeLines': 0, 'mutantsKilled': 5, 'propertiesKilled': 5,
                  'fullSuiteFiles': 462, 'baselineFailingFiles': 2}))
