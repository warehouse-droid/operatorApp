#!/usr/bin/env python3
"""Capture a baseline or compare completed isolated Node test runs by test name."""
import json
import re
import sys
from pathlib import Path


def parse_log(filename):
    text = Path(filename).read_text()
    if not re.search(r'Isolated MBT main run (?:failed in|passed:)', text):
        raise RuntimeError('The full test run has not completed.')
    failures = {}
    current = None
    total_files = 0
    for line in text.splitlines():
        match = re.match(r'\[isolation\] MBT main \d+/(\d+) /app/(.+)', line)
        if match:
            total_files = int(match[1])
            current = match[2]
        match = re.match(r'\s*✖ (.+?) \([\d.]+ms\)', line)
        if match and current:
            failures.setdefault(current, set()).add(match[1].replace('/app/', ''))
    summary = re.search(r'run failed in \d+/\d+ file\(s\): (.+)', text)
    if summary:
        for filename in summary[1].split(', '):
            failures.setdefault(filename.removeprefix('/app/'), {'<file-level failure>'})
    return {
        'files': total_files,
        'tests': sum(map(int, re.findall(r'^ℹ tests (\d+)$', text, re.M))),
        'passes': sum(map(int, re.findall(r'^ℹ pass (\d+)$', text, re.M))),
        'failures': {name: sorted(tests) for name, tests in sorted(failures.items())},
    }


if sys.argv[1] == 'capture':
    result = parse_log(sys.argv[2])
else:
    baseline = json.loads(Path(sys.argv[2]).read_text())
    final = parse_log(sys.argv[3])
    before = {(name, test) for name, tests in baseline['failures'].items() for test in tests}
    after = {(name, test) for name, tests in final['failures'].items() for test in tests}
    result = {'baseline': baseline, 'final': final, 'newFailures': sorted(after - before), 'resolvedFailures': sorted(before - after)}
output = sys.argv[-1]
Path(output).write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({key: result[key] for key in ['files', 'tests', 'passes', 'newFailures', 'resolvedFailures'] if key in result}, indent=2))
if result.get('newFailures'):
    sys.exit(1)
