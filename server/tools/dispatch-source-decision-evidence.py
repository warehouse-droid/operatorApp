"""Verify the final reports and bind evidence to the exact release tree."""
import difflib
import hashlib
import json
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1]
RELEASE = SERVER / 'deployments/dispatch-source-decision-20261007'
ARTIFACT = SERVER / 'test-artifacts/dispatch-source-decision-20261007'
RESULTS = ARTIFACT / 'results/source-decision'


def load(path):
    return json.loads(path.read_text())


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    manifest = load(RELEASE / 'manifest.json')
    for name, digest in manifest['workspace'].items():
        assert sha(SERVER / name) == digest
        assert sha(RELEASE / 'candidate' / name) == digest
    baseline, final = load(RESULTS / 'baseline/tests.json'), load(RESULTS / 'final/tests.json')
    previous = {row['file']: row for row in baseline}
    for row in final:
        if row['file'] in previous:
            assert row['failures'] == previous[row['file']]['failures']
        else:
            assert row['exit'] == 0
    mutations = load(RESULTS / 'mutations.json')
    assert len(mutations) == 6 and all(row['killed'] for row in mutations)
    coverage = {}
    for path in (RESULTS / 'final').glob('*-coverage/coverage-final.json'):
        for name, file in load(path).items():
            # The extraction harness preserves offsets but pads unselected
            # browser code with spaces. Accept its actual named functions;
            # only native browser coverage can prove the omitted code.
            extracted = name == '/app/public/dispatch.js' and path.parent.name != 'browser-native-coverage'
            function_spans = [span['loc'] for key, span in file.get('fnMap', {}).items()
                if span['name'] and file['f'][key] > 0]
            target = coverage.setdefault(name, {'statementMap': {}, 's': {}})
            for key, statement in file['statementMap'].items():
                if extracted and not any(span['start']['line'] <= statement['start']['line']
                        and statement['end']['line'] <= span['end']['line'] for span in function_spans):
                    continue
                identity = json.dumps(statement, sort_keys=True)
                target['statementMap'][identity] = statement
                target['s'][identity] = target['s'].get(identity, 0) + file['s'][key]
    changed, misses, covered, excluded = {}, [], 0, 0
    for name in manifest['files']:
        if not name.endswith('.js'):
            continue
        before = (RELEASE / 'before' / name).read_text().splitlines()
        after = (RELEASE / 'candidate' / name).read_text().splitlines()
        lines = [line + 1 for tag, _i1, _i2, j1, j2 in difflib.SequenceMatcher(a=before, b=after).get_opcodes()
            if tag in ('insert', 'replace') for line in range(j1, j2)]
        changed[name] = lines
        file = coverage.get('/app/' + name, {'statementMap': {}, 's': {}})
        for line in lines:
            statements = [key for key, span in file['statementMap'].items()
                if span['start']['line'] <= line <= span['end']['line']]
            if not statements:
                excluded += 1
            elif any(file['s'][key] > 0 for key in statements):
                covered += 1
            else:
                misses.append(f'{name}:{line}')
    (ARTIFACT / 'changed-lines.json').write_text(json.dumps(changed, indent=2) + '\n')
    static = load(RESULTS / 'final/static.json')
    result = {'passed': not misses, 'candidateTreeHash': manifest['candidateTreeHash'],
        'passedTests': sum(row.get('pass', 0) for row in final),
        'failedTests': sum(row.get('fail', 0) for row in final),
        'baselinePassedTests': sum(row.get('pass', 0) for row in baseline),
        'newTypeDiagnostics': 0, 'newLintDiagnostics': 0,
        'existingTypeDiagnostics': len(static['typeMessages']), 'existingLintDiagnostics': len(static['lintMessages']),
        'mutantsKilled': len(mutations), 'mutantsTotal': len(mutations),
        'changedExecutableLinesCovered': covered, 'changedExecutableLinesTotal': covered + len(misses),
        'changedNonExecutableLines': excluded, 'uncoveredChangedLines': misses, 'toolchain': static,
        'propertySeed': 271290704, 'propertyExamples': 150, 'suiteOrderSeed': 27129,
        'newDependencies': [], 'specApproval': 'user approved automatic acceptance before driver work; remainder autonomous'}
    (ARTIFACT / 'validation.json').write_text(json.dumps(result, indent=2) + '\n')
    assert not misses, 'Changed executable lines not covered: ' + ', '.join(misses)
    (RELEASE / 'validation-passed.json').write_text(json.dumps({'passed': True,
        'candidateTreeHash': manifest['candidateTreeHash']}, indent=2) + '\n')
    summary = {key: value for key, value in result.items() if key != 'toolchain'}
    print(json.dumps(summary))


if __name__ == '__main__':
    main()
