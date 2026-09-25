"""Record the checked source and final planner follow-up results without secrets."""
import hashlib
import json
from pathlib import Path

server = Path(__file__).resolve().parents[1]
folder = server / 'test-artifacts/field-sales/map-followup'
browser = json.loads((folder / 'map-browser-results.json').read_text())
existing = json.loads((folder / 'browser-results.json').read_text())
mutations = json.loads((folder / 'mutations.log').read_text())
coverage = json.loads((folder / 'coverage/coverage-summary.json').read_text())['total']
assert browser['passed'] == 7 and browser['failed'] == 0 and not browser['errors']
assert existing['passed'] == 5 and not existing['errors']
assert mutations['killed'] == 3
assert not (folder / 'lint.log').read_text().strip()
focused = (folder / 'focused.log').read_text()
assert '# tests 69' in focused and '# fail 0' in focused and '# skipped 0' in focused
source = {}
sha = hashlib.sha256()
for name, expected in sorted(browser['source'].items()):
    relative = 'public/field-sales/' + name
    content = (server / relative).read_bytes()
    assert hashlib.sha256(content).hexdigest() == expected
    source[relative] = expected
    sha.update((relative + '\0').encode())
    sha.update(content)
verification = ['test/field-sales/planner.test.js', 'test/field-sales/spec.md',
                'tools/field-sales-map-browser.mjs', 'tools/field-sales-map-mutations.mjs',
                'tools/field-sales-map-test.sh', 'tools/field-sales-map-deploy.py',
                'tools/field-sales-map-evidence.py']
report = {'passed': True, 'runtimeSha256': sha.hexdigest(), 'source': source,
          'verificationFiles': {name: hashlib.sha256((server / name).read_bytes()).hexdigest() for name in verification},
          'focusedTests': 69, 'newBrowserScenarios': 7, 'existingBrowserScenarios': 5,
          'mutationKills': mutations['killed'], 'helperCoverage': coverage,
          'artifacts': {str(path.relative_to(folder)): hashlib.sha256(path.read_bytes()).hexdigest()
                        for path in folder.rglob('*') if path.is_file() and path.name != 'evidence.json'}}
(folder / 'evidence.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({key: report[key] for key in ['passed', 'runtimeSha256', 'focusedTests', 'newBrowserScenarios', 'existingBrowserScenarios', 'mutationKills', 'helperCoverage']}))
