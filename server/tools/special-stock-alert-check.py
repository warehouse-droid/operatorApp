"""Run focused checks for Special alerts, quote requester attribution and transfer ETAs."""
import json
from pathlib import Path
import re
import subprocess

SERVER = Path(__file__).resolve().parents[1]
OUT = SERVER / 'test-artifacts/special-workflow-review/special-alert-20260928'
OUT.mkdir(parents=True, exist_ok=True)
RUNNER = ['sudo', '-n', 'docker', 'exec', '-e', 'MBT_TEST_ISOLATED=1',
          '-e', 'DATABASE_URL=postgres://mbt_test:special_review_only@mbbs-special-review-db:5432/mbt_verify',
          '-e', 'PLAYWRIGHT_BROWSERS_PATH=/browsers', '-w', '/app', 'mbbs-special-review-runner']
RUNTIME = ['public/scm-special-alert.js', 'public/app-sidebar.js', 'public/scm-special-stock-requests.js',
           'public/sales-special-stock-requests.js', 'src/special-stock-alerts.js', 'src/special-stock-documents.js',
           'src/special-stock-request-domain.js', 'src/special-stock-request-repository.js']
TESTS = ['test/mbt/unit/special-quote-requester.test.js', 'test/mbt/unit/special-stock-transfer.test.js',
         'test/mbt/unit/special-workflow-documents.test.js', 'test/mbt/integration/special-stock-alert-counts.test.js',
         'test/mbt/integration/special-stock-alert-http.test.js', 'test/mbt/integration/special-stock-transfer.test.js',
         'test/mbt/integration/special-stock-alert-browser.test.js']

def check(label, args):
    result = subprocess.run(RUNNER + args, capture_output=True, text=True)
    output = result.stdout + result.stderr
    (OUT / (label + '.log')).write_text(output)
    if result.returncode:
        raise RuntimeError(label + ': ' + output[-5000:])
    print(label + ': passed', flush=True)
    return output

for file in RUNTIME + ['src/server.js']:
    check('syntax-' + Path(file).name, ['node', '--check', file])
check('lint', ['node', 'node_modules/eslint/bin/eslint.js', '--config', 'tools/stock-request-layout-eslint.config.mjs', '--max-warnings=0', *RUNTIME, *TESTS])
output = check('focused-tests', ['node', '--test', '--test-concurrency=1', *TESTS])
summary = {key: int(re.search(r'^# ' + key + r' (\d+)$', output, re.M).group(1)) for key in ['tests','pass','fail']}
summary.update({'syntax': True, 'lint': True, 'fullRegressionRun': False, 'backupsRun': False})
(OUT / 'checks.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary))
