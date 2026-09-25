"""Collect final verification, source identity and known scope without credentials."""
import hashlib
import json
from pathlib import Path
import re

server = Path(__file__).resolve().parents[1]
folder = server / 'test-artifacts/field-sales/recent'
browser = json.loads((folder / 'recent-browser-results.json').read_text())
assert browser['passed'] == 3 and not browser['errors']
for name, count in [('map-browser-results.json', 7), ('browser-results.json', 5)]:
    checked = json.loads((folder / name).read_text())
    assert checked['passed'] == count and not checked['errors']
for name in ['focused.log', 'coverage.log']:
    log = (folder / name).read_text()
    assert '# tests 80' in log and '# fail 0' in log and '# skipped 0' in log
for name in ['lint.log', 'types.log']:
    assert not (folder / name).read_text().strip()
mutations = json.loads((folder / 'mutations.log').read_text())
assert mutations['killed'] == 5 and all(row['killed'] for row in mutations['results'])
health = json.loads((folder / 'health.log').read_text())
assert health['passed']
source, sha = {}, hashlib.sha256()
secret = re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:sk-proj-|ghp_)[A-Za-z0-9_-]{20,}')
for name, expected in sorted(browser['source'].items()):
    content = (server / name).read_bytes()
    assert hashlib.sha256(content).hexdigest() == expected, name
    assert not secret.search(content), 'Secret-like content in ' + name
    source[name] = expected
    sha.update((name + '\0').encode())
    sha.update(content)
verification = ['test/field-sales/spec.md', *[str(p.relative_to(server)) for pattern in
                ['test/field-sales/recent*.js', 'tools/field-sales-recent-*'] for p in server.glob(pattern) if p.is_file()]]
coverage = json.loads((folder / 'coverage/coverage-summary.json').read_text())
report = {'passed': True, 'specApproval': 'User: Implement the plan', 'tier': 2,
          'runtimeSha256': sha.hexdigest(), 'source': source,
          'verificationFiles': {name: hashlib.sha256((server / name).read_bytes()).hexdigest() for name in verification},
          'focusedTests': 80, 'browserScenarios': 15, 'mutationKills': mutations['killed'],
          'coverage': coverage, 'suiteHealth': health, 'runtimeSecretScan': 'passed',
          'scope': 'Field Sales suite; broader unrelated repository baseline not rerun; browser branch coverage not claimed',
          'artifacts': {str(p.relative_to(folder)): hashlib.sha256(p.read_bytes()).hexdigest()
                        for p in folder.rglob('*') if p.is_file() and p.name != 'evidence.json' and 'v8' not in p.parts}}
(folder / 'evidence.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({key: report[key] for key in ['passed', 'runtimeSha256', 'focusedTests', 'browserScenarios', 'mutationKills']}))
