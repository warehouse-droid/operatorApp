"""Verify the exact UI release, mutations and existing planner regressions."""
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import json
import os
import re
import subprocess

root = Path(__file__).resolve().parents[1]
out = root / 'test-artifacts/bin-planner-readonly/final'
out.mkdir(parents=True, exist_ok=True)
release = root / 'test-artifacts/bin-planner-readonly-release-20260927'
files = json.loads((root / 'tools/bin-planner-readonly-files.json').read_text())
hashes = lambda: {file: hashlib.sha256((root / file).read_bytes()).hexdigest() for file in files}
initial = hashes()
checks = {
    'feature': ['node', 'tools/bin-planning-suites.mjs', 'feature'],
    'dispatch': ['node', 'tools/bin-planning-suites.mjs', 'dispatch'],
    'frontend': ['node', '--test', 'test/dispatch/frontend/dispatch-map-preview-persistence.test.js',
                 'test/dispatch/frontend/dispatch-google-map-redraw.red.test.js', 'test/dispatch/frontend/dispatch-required-pickups.test.js',
                 'test/mbt/unit/dispatch-bin-disabled-ui.test.js'],
    'repeat': ['node', 'tools/bin-planning-suites.mjs', 'selected', 'test/mbt/unit/bin-planning-readonly-ui.test.js',
               'test/mbt/integration/bin-planning-readonly-browser.test.js', 'test/mbt/integration/bin-planning-browser.test.js'],
    'static': ['node', 'tools/bin-planner-readonly-static.mjs'],
}
def run(name, args):
    environment = dict(os.environ, BIN_PLANNING_CHECK='readonly-final-' + name)
    if name != 'static':
        environment['BIN_PLANNING_SOURCE_ROOT'] = str(release / 'candidate')
    with (out / (name + '.log')).open('w') as output:
        result = subprocess.run(['bash', str(root / 'tools/bin-planning-test.sh'), *args], env=environment,
                                stdout=output, stderr=subprocess.STDOUT, timeout=900)
    print(f'{name}: {result.returncode}', flush=True)
    return name, result.returncode

started = datetime.now(timezone.utc).isoformat()
results = {}
with ThreadPoolExecutor(max_workers=2) as executor:
    for future in as_completed([executor.submit(run, name, args) for name, args in checks.items()]):
        name, code = future.result()
        results[name] = code
with (out / 'mutations.log').open('w') as output:
    result = subprocess.run(['python3', str(root / 'tools/bin-planner-readonly-mutations.py')], stdout=output,
                            stderr=subprocess.STDOUT, timeout=600)
results['mutations'] = result.returncode
expected = sorted(['DP-11 and DP-12: targeted CO and atomic split commands return only affected records and exact retries',
                  'DP-13 and DP-16: checkpoint list is metadata-only and compact reads/commands record bounded timings',
                  'DP-33 frontend: active CO projection retains every current relationship pickup',
                  'history search reveals reconciliation-complete PO/SO orders but never Driver PWA-completed orders'])
log = (out / 'dispatch.log').read_text()
actual = sorted(set(re.findall(r'^✖ (.+?) \([\d.]+ms\)$', log, re.M)))
unexpected = {name: code for name, code in results.items() if code and name != 'dispatch'}
if actual != expected or results['dispatch'] != 1 or sum(map(int, re.findall(r'^ℹ fail (\d+)$', log, re.M))) != 4:
    unexpected['dispatch'] = actual
if hashes() != initial:
    unexpected['source_changed'] = True
report = {'checks': results, 'unexpected_failures': unexpected, 'unchanged_dispatch_failures': actual,
          'files': initial, 'source_tree_sha256': hashlib.sha256(json.dumps(initial, sort_keys=True).encode()).hexdigest(),
          'started_at': started, 'finished_at': datetime.now(timezone.utc).isoformat()}
(out / 'result.json').write_text(json.dumps(report, indent=2))
(release / 'release-checks.json').write_text(json.dumps({'passed': not unexpected, 'checks': results}, indent=2))
print(json.dumps({key: value for key, value in report.items() if key != 'files'}, indent=2))
raise SystemExit(1 if unexpected else 0)
