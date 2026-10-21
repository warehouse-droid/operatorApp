"""Compare every completed isolated test file, including spec-reporter output."""
from collections import Counter
import json
from pathlib import Path
import re

OUT = Path(__file__).resolve().parents[2] / 'test-artifacts/sor-return-date-conflict-20261014'


def report(path):
    text = path.read_text()
    stages = re.findall(r'^\[isolation\] (.+?) (\d+)/(\d+) (.+)$', text, re.M)
    assert stages and int(stages[-1][1]) == int(stages[-1][2]), 'Incomplete suite: ' + str(path)
    assert re.search(r'^Isolated .+ run (?:passed|failed)', text, re.M), 'Missing completion: ' + str(path)
    files = []
    chunks = re.split(r'^\[isolation\] .+? \d+/\d+ ', text, flags=re.M)[1:]
    for chunk in chunks:
        name, _, body = chunk.partition('\n')
        name = name[name.index('/test/') + 1:]
        counts = {key: sum(map(int, re.findall(r'^(?:ℹ|#) ' + key + r' (\d+)$', body, re.M)))
                  for key in ['tests', 'pass', 'fail', 'skipped', 'cancelled']}
        failures = Counter(re.findall(r'^[ \t]*✖ (.+?) \([0-9.]+ms\)$', body, re.M))
        failures.update(re.findall(r'^not ok \d+ - (.+)$', body, re.M))
        normalize = lambda value: re.sub(r'/tmp/(?:dispatch-source-notices|sor-return-date-conflict)-[^/]+/|/app/', '<source>/', value)
        failures = Counter({normalize(key): value for key, value in failures.items()})
        timed_out = bool(re.search(r'Isolated test file .+ exited on signal SIGKILL\.', body))
        if timed_out:
            failures['unverified: file deadline exceeded'] += 1
        files.append({'file': name, **counts, 'timedOut': timed_out, 'failureNames': dict(failures)})
    assert len(files) == int(stages[-1][2]), 'Missing test files'
    return {'files': files, **{key: sum(row[key] for row in files) for key in ['tests', 'pass', 'fail', 'skipped', 'cancelled']}}


results = []
for label in ['dispatch']:
    before = report(OUT / ('full-baseline-' + label + '.log'))
    after = report(OUT / ('full-final-' + label + '.log'))
    old = {row['file']: row for row in before['files']}
    assert set(old) == {row['file'] for row in after['files']}, 'Suite ownership changed'
    new_failures = []
    for row in after['files']:
        previous = old[row['file']]
        delta = Counter(row['failureNames']) - Counter(previous['failureNames'])
        if delta or row['fail'] > previous['fail'] or row['cancelled'] > previous['cancelled']:
            new_failures.append({'file': row['file'], 'names': dict(delta), 'baselineFail': previous['fail'], 'currentFail': row['fail']})
        assert row['tests'] >= previous['tests'], 'A test file ran fewer tests: ' + row['file']
    results.append({'label': label, 'before': before, 'after': after, 'newFailures': new_failures})
    (OUT / 'full-suite.json').write_text(json.dumps(results, indent=2) + '\n')
    print(json.dumps({'suite': label, 'baseline': {key: before[key] for key in ['tests', 'pass', 'fail']},
                      'current': {key: after[key] for key in ['tests', 'pass', 'fail']}, 'newFailures': new_failures}), flush=True)
    assert not new_failures, 'New full-suite failures require investigation'
