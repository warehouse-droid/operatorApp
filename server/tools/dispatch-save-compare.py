"""Gate new failures without suppressing the repository's recorded baseline."""
import argparse
from collections import Counter
import json
from pathlib import Path
import re


def test_failures(path):
    data = Path(path).read_text()
    assert re.search(r'Isolated .+ run (?:passed|failed in) ', data), f'Incomplete suite: {path}'
    return Counter(re.findall(r'^✖ (?!failing tests:)(.+?) \([\d.]+ms\)$', data, re.M))


def static_diagnostics(path):
    data = json.loads(Path(path).read_text())
    lint = Counter()
    for entry in data['lint']:
        for issue in entry['messages']:
            # A moved declaration changes no-shadow's embedded line reference.
            message = re.sub(r'on line \d+', 'on line <n>', issue['message'])
            lint[(entry['filePath'].removeprefix('/app/'), issue.get('ruleId'), issue['severity'], message)] += 1
    types = Counter(re.sub(r'\(\d+,\d+\)', '(line,column)', line)
                    for line in data['types'].splitlines() if 'error TS' in line)
    assert data['typesExit'] in [0, 1, 2] and (data['typesExit'] == 0 or types), 'Type checker did not complete'
    return lint, types


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['suite', 'static'])
    parser.add_argument('baseline')
    parser.add_argument('candidate')
    parser.add_argument('--output')
    args = parser.parse_args()
    if args.mode == 'suite':
        before, after = map(test_failures, [args.baseline, args.candidate])
        new = after - before
        report = {'baselineFailures': dict(before), 'candidateFailures': dict(after), 'newFailures': dict(new)}
    else:
        before, after = map(static_diagnostics, [args.baseline, args.candidate])
        new_lint, new_types = after[0] - before[0], after[1] - before[1]
        report = {'baselineLint': sum(before[0].values()), 'candidateLint': sum(after[0].values()),
                  'baselineTypes': sum(before[1].values()), 'candidateTypes': sum(after[1].values()),
                  'newLint': [list(key) + [count] for key, count in new_lint.items()], 'newTypes': dict(new_types)}
        new = new_lint or new_types
    if args.output:
        Path(args.output).write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))
    assert not new, 'New diagnostics; inspect the comparison report'
