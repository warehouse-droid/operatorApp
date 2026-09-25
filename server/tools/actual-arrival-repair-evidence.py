"""Compare actual recorded checks and identify the source tree they verify."""
import collections
import difflib
import hashlib
import json
from pathlib import Path
import re

SERVER = Path(__file__).resolve().parents[1]
ARTIFACT = SERVER / 'test-artifacts/actual-arrival-repair'
manifest = json.loads((SERVER / 'tools/actual-arrival-repair-files.json').read_text())


def lint(label):
    rows = json.loads((ARTIFACT / f'lint-{label}.log').read_text())
    return collections.Counter((row['filePath'], m['ruleId'], re.sub(r'line \d+', 'line N', m['message']))
                               for row in rows for m in row['messages'])


def types(label):
    return collections.Counter(re.sub(r'\(\d+,\d+\)', '(N,N)', line)
                               for line in (ARTIFACT / f'types-{label}.log').read_text().splitlines() if ': error ' in line)


def suite(label):
    log = (ARTIFACT / f'{label}.log').read_text()
    counts = dict(re.findall(r'^# (tests|pass|fail|cancelled|skipped) (\d+)$', log, re.M))
    assert int(counts['tests']) > 0 and counts['fail'] == counts['cancelled'] == counts['skipped'] == '0', label
    return {name: int(value) for name, value in counts.items()}


def adjacent(label):
    lines = (ARTIFACT / f'adjacent-{label}.log').read_text().splitlines()
    assert any('62/62' in line for line in lines), f'Incomplete {label} adjacent run'
    return lines[-1].split('file(s): ', 1)[1].split(', ')


coverage = json.loads((ARTIFACT / 'coverage/coverage-final.json').read_text())
changed_coverage = {}
for name in manifest['production']:
    current = (SERVER / name).read_text().splitlines()
    old = ARTIFACT / 'baseline' / name
    prior = old.read_text().splitlines() if old.exists() else []
    changed = {i + 1 for tag, a, b, c, d in difflib.SequenceMatcher(None, prior, current).get_opcodes()
               if tag in ['insert', 'replace'] for i in range(c, d)}
    # CLI smoke copies the identical production sources into its isolated data
    # directory. Merge those executions into their original source path.
    matches = [data for key, data in coverage.items() if key == '/app/' + name
               or (key.startswith('/tmp/arrival-cli-') and key.endswith('/' + name))]
    if not matches:
        changed_coverage[name] = {'measured': False, 'reason': 'HTML asset or frontend functions executed via VM extraction; no reliable source-line mapping'}
        continue
    lines = {}
    for data in matches:
        for sid, loc in data['statementMap'].items():
            for line in range(loc['start']['line'], loc['end']['line'] + 1):
                lines[line] = max(lines.get(line, 0), data['s'][sid])
    measured = changed & lines.keys()
    missed = sorted(line for line in measured if not lines[line])
    changed_coverage[name] = {'measured': True, 'covered': len(measured) - len(missed), 'total': len(measured), 'uncoveredLines': missed}

new_lint, new_types = lint('current') - lint('baseline'), types('current') - types('baseline')
mutations = json.loads((ARTIFACT / 'mutations.json').read_text())
current_failures, baseline_failures = adjacent('current'), adjacent('baseline')
report = {'specApproval': 'not obtained (autonomous run)',
          'sourceHashes': {name: hashlib.sha256((SERVER / name).read_bytes()).hexdigest() for name in manifest['production'] + manifest['tests']},
          'focused': suite('focused-final'), 'randomized': suite('random-final'),
          'newLint': list(new_lint.items()), 'newTypes': list(new_types.items()),
          'adjacent': {'files': 62, 'currentFailures': current_failures, 'baselineFailures': baseline_failures},
          'mutationsKilled': sum(item['killed'] for item in mutations), 'mutationsTotal': len(mutations),
          'propertyOnlyMutationsKilled': sum(item['killed'] for item in mutations if item['layer'] == 'property alone'),
          'changedCoverage': changed_coverage,
          'limits': ['Repository-wide npm test not run; dispatch suite and five related harnesses were run.',
                     'Frontend behavior is tested in VM-extracted real renderers; full browser end-to-end coverage is not claimed.',
                     'Backfill heartbeat timing is not accelerated in tests; live leases and immutable evidence are verified operationally.']}
assert not new_lint and not new_types, (new_lint, new_types)
assert current_failures == baseline_failures, 'New adjacent failures'
assert all(item['killed'] for item in mutations), 'Surviving selected mutation'
for name in ['dispatch-forecast', 'dispatch-stop-visit', 'dispatch-statistics-v2', 'driver-gps-gate', 'driver-location-reliability']:
    assert (ARTIFACT / f'{name}-final.log').stat().st_size > 0
(ARTIFACT / 'evidence.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({key: report[key] for key in ['focused', 'randomized', 'newLint', 'newTypes', 'mutationsKilled', 'mutationsTotal']}))
