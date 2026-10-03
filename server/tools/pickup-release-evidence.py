"""Bind pickup release checks and changed-line coverage to the built candidate."""
import difflib
import hashlib
import json
from pathlib import Path

server = Path(__file__).resolve().parents[1]
release = server / 'deployments/dispatch-pickup-address-20261003'
artifact = server / 'test-artifacts/dispatch-pickup-release-20261003'
checks = artifact / 'runtime/pickup-override'
log = (artifact / 'runtime/pickup-release/pickup.log').read_text()
assert '26 test(s)' in log and 'Pickup override mutations killed: 5/5' in log
static = next(json.loads(line) for line in log.splitlines() if line.startswith('{"static":'))
assert static['static'] == 'no new diagnostics'
suites = json.loads((checks / 'suites.json').read_text())
assert suites['current'] == suites['baseline']
manifest = json.loads((release / 'manifest.json').read_text())
hashes = json.loads((checks / 'source-hashes.json').read_text())
for name, value in hashes.items():
    path = release / 'candidate-app' / name if name in manifest['services']['app']['tree'] else server / name
    assert hashlib.sha256(path.read_bytes()).hexdigest() == value, name
coverage = json.loads((checks / 'coverage/coverage-final.json').read_text())
coverage.update(json.loads((checks / 'browser-istanbul.json').read_text()))
changed = []
for name in json.loads((server / 'tools/pickup-release-files.json').read_text()):
    old = (release / 'before-app' / name).read_text()
    current = (release / 'candidate-app' / name).read_text()
    if name.endswith('.html'):
        assert '/dispatch.js?v=20261003-pickup-address-1' in current
        continue
    added = {line + 1 for tag, _a, _b, start, end in difflib.SequenceMatcher(a=old.splitlines(), b=current.splitlines()).get_opcodes()
             if tag in ('insert', 'replace') for line in range(start, end)}
    data = coverage['/app/' + name]
    executable = {line for item in data['statementMap'].values() for line in range(item['start']['line'], item['end']['line'] + 1)}
    hit = {line for key, item in data['statementMap'].items() if data['s'][key] > 0
           for line in range(item['start']['line'], item['end']['line'] + 1)}
    relevant = added & executable
    assert relevant and relevant <= hit, (name, sorted(relevant - hit))
    changed.append({'file': name, 'covered': len(relevant & hit), 'total': len(relevant)})
results = json.loads((artifact / 'gauntlet-results.json').read_text())
assert len(results) == 3 and all(row['status'] == 0 for row in results)
for name, count in [('boss-regression', 140), ('pickup-shuffled', 27)]:
    text = (artifact / ('runtime/pickup-release/' + name + '.log')).read_text()
    assert '# pass ' + str(count) + '\n' in text and '# fail 0\n' in text
result = {'passed': True, 'imageId': manifest['services']['app']['candidateImageId'],
          'focusedTests': 26, 'bossRegressionTests': 140, 'shuffledTests': 27,
          'mutationsKilled': 5, 'suites': suites, 'static': static,
          'changedLineCoverage': changed, 'sourceHashes': hashes,
          'verificationToolHashes': {name: hashlib.sha256((server / 'tools' / name).read_bytes()).hexdigest()
              for name in ['pickup-release-check.mjs', 'pickup-release-gauntlet.mjs', 'pickup-release-evidence.py']}}
(release / 'validation.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
