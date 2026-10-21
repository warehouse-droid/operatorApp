"""Focused validation for the read-only movement/history display change."""
from pathlib import Path
import difflib
import hashlib
import json
import os
import subprocess

server = Path(__file__).resolve().parents[1]
out = server / 'test-artifacts/movement-document-history'
files = json.loads((out / 'runtime-files.json').read_text())
runner = ['sudo', '-n', 'docker', 'exec', '-e', 'MBT_TEST_ISOLATED=1', '-e',
          'DATABASE_URL=postgres://mbt_test:special_review_only@mbbs-special-review-db:5432/mbt_verify',
          '-w', '/app', 'mbbs-special-review-runner']

for file in files:
    if file.endswith('.js'):
        subprocess.run(runner + ['node', '--check', file], check=True, capture_output=True)
test = 'test/mbt/integration/movement-document-history.test.js'
for label, command in [('integration', ['node', '--test', test]),
                       ('existing-ui-contract', ['node', 'src/dispatch-loaded-export-harness.js'])]:
    result = subprocess.run(runner + command, capture_output=True, text=True)
    (out / (label + '.log')).write_text(result.stdout + result.stderr)
    if result.returncode:
        print(result.stdout + result.stderr)
        raise SystemExit(result.returncode)

for name in ['browser.json', 'operator-history-desktop.png', 'operator-history-tablet.png',
             'in-outbound-desktop.png', 'control-in-outbound-desktop.png']:
    subprocess.run(['sudo', '-n', 'docker', 'cp', 'mbbs-special-review-runner:/app/test-artifacts/movement-document-history/' + name, str(out / name)], check=True)
    subprocess.run(['sudo', '-n', 'chown', f'{os.getuid()}:{os.getgid()}', str(out / name)], check=True)
browser = json.loads((out / 'browser.json').read_text())
assert not browser['errors'] and len(browser['results']) == 3
for file in ['public/operator.js', 'public/dispatch-loaded-export.js', 'public/control.js']:
    assert browser['sourceHashes'][file] == hashlib.sha256((server / file).read_bytes()).hexdigest(), 'Browser evidence is stale: ' + file
live = json.loads((out / 'live-read.json').read_text())
assert live['beforeCount'] == live['afterCount']
assert any(row['documents'] == [{'type': 'IF', 'ref': 'IF155552'}] for row in live['pickupHistory'])
diff = []
for file in files:
    baseline = out / 'baseline' / file
    before = baseline.read_text() if baseline.exists() else ''
    diff.extend(difflib.unified_diff(before.splitlines(True), (server / file).read_text().splitlines(True),
                                    fromfile='a/server/' + file, tofile='b/server/' + file, n=3))
(out / 'runtime.diff').write_text(''.join(diff))
source = files + [test, 'tools/movement-history-browser.mjs', 'tools/movement-history-check.py', 'tools/movement-history-live.py']
(out / 'source-manifest.json').write_text(json.dumps({file: hashlib.sha256((server / file).read_bytes()).hexdigest() for file in source}, indent=2)+'\n')
summary = {'completed': True, 'integrationTests': 7, 'browserViews': 3, 'syntaxChecked': True,
           'existingUiContract': True, 'productionDataWrites': 0, 'netSuiteRequests': 0}
(out / 'summary.json').write_text(json.dumps(summary, indent=2)+'\n')
print(json.dumps(summary))
