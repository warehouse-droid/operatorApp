"""Compare the bounded full suites and type diagnostics against their baselines."""
from collections import Counter
import json
from pathlib import Path
import re

SERVER = Path(__file__).resolve().parents[1]
OUT = SERVER / 'test-artifacts/goa-co-planning-20261001'


def suite(name):
    log = (OUT / name).read_text()
    summary = re.search(r'^Isolated MBT main run (?:failed in (\d+)/(\d+) file\(s\): ([^\n]+)|passed: (\d+) file\(s\), (\d+) test\(s\)\.)$', log, re.M)
    assert summary, name + ': full suite did not finish'
    failed = sorted(summary[3].split(', ')) if summary[1] is not None else []
    total = int(summary[2] or summary[4])
    assert total == len(re.findall(r'^\[isolation\] MBT main ', log, re.M))
    failures = set()
    for segment in re.split(r'\n\[isolation\] MBT main \d+/\d+ ', log)[1:]:
        file = segment.splitlines()[0]
        for match in re.finditer(r'^✖ (.+) \([\d.]+ms\)$', segment, re.M):
            failures.add(file + ': ' + match[1])
    return {'files': total, 'tests': sum(map(int, re.findall(r'^ℹ tests (\d+)$', log, re.M))),
            'pass': sum(map(int, re.findall(r'^ℹ pass (\d+)$', log, re.M))),
            'fail': sum(map(int, re.findall(r'^ℹ fail (\d+)$', log, re.M))),
            'failedFiles': failed, 'failureNames': sorted(failures),
            'timeouts': sorted(re.findall(r'Isolated test file (.+) exited on signal SIGTERM', log))}


def types(name):
    return Counter(re.sub(r'\(\d+,\d+\)', '(LINE,COLUMN)', line)
                   for line in (OUT / name).read_text().splitlines() if ': error TS' in line)


def main():
    before, after = suite('full-baseline.log'), suite('full-final.log')
    new_files = sorted(set(after['failedFiles']) - set(before['failedFiles']))
    new_tests = sorted(set(after['failureNames']) - set(before['failureNames']))
    old_types, new_types = types('types-baseline.log'), types('types-final.log')
    added_types = sorted((new_types - old_types).elements())
    checks = json.loads((OUT / 'checks.json').read_text())
    report = {'passed': checks['passed'] and not new_files and not new_tests and not added_types,
              'baseline': before, 'final': after, 'newFailedFiles': new_files,
              'newFailedTests': new_tests, 'types': {'baseline': old_types.total(),
                  'final': new_types.total(), 'newDiagnostics': added_types}}
    (OUT / 'regression-comparison.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({key: report[key] for key in ['passed', 'newFailedFiles', 'newFailedTests', 'types']}))
    assert report['passed'], 'Inspect regression-comparison.json before publishing'


if __name__ == '__main__':
    main()
