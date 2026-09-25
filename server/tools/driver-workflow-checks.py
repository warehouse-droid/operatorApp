"""Focused checks against the same base image used by the browser fixture."""
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
ART = ROOT / 'test-artifacts/driver-workflow'
IMAGE = 'mbbs-operator-app:sor-rentals-20260924-v1'


def run(name, arguments):
    result = subprocess.run(['docker', 'run', '--rm', '--network', 'none', '--read-only',
                             *arguments], capture_output=True, text=True)
    output = result.stdout + result.stderr
    (ART / (name + '.log')).write_text(output)
    return result.returncode, output


def tests(name, driver_path=None):
    mounts = ['-v', str(ROOT/'test')+':/app/test:ro',
              '-v', str(ROOT/'public')+':/app/public:ro']
    if driver_path:
        mounts += ['-v', str(driver_path)+':/app/public/driver.js:ro']
    files = ['test/mbt/unit/driver-instruction-route-comparison.test.js']
    if not driver_path:
        files += ['test/mbt/unit/driver-pwa-recovery-assets.test.js']
    return run(name, [*mounts, '--entrypoint', 'node', IMAGE, '--test', *files])


code, output = tests('focused')
assert code == 0 and '# pass 9' in output and '# fail 0' in output, output
code, output = run('static', [
    '-v', str(ROOT/'public')+':/app/public:ro',
    '-v', str(ROOT/'tools')+':/app/tools:ro',
    '-v', str(ART)+':/app/test-artifacts/driver-workflow',
    '-v', str(ROOT/'test-artifacts/sor-rentals/node_modules')+':/app/node_modules:ro',
    '-w', '/app', '--entrypoint', 'node', 'mbbs-return-batch-browser-test:20260918',
    'tools/driver-workflow-static.mjs'])
assert code == 0, output

source = (ROOT/'public/driver.js').read_text()
mutations = [
    ('translation', 'key !== "localized"', 'key !== "missed-localized"'),
    ('location-identity', '!authoritativeJobChanged(previousJob, { job: nextJob })',
     'authoritativeJobChanged(previousJob, { job: nextJob })'),
    ('completion-race', 'if (beforeAction && routeReconciliation === DRIVER_ROUTE_RECONCILIATION.serverExecutionChanged)',
     'if (false && routeReconciliation === DRIVER_ROUTE_RECONCILIATION.serverExecutionChanged)'),
    ('start-ordering', 'return (manifest?.jobs || []).some((previousJob) =>',
     'return false && (manifest?.jobs || []).some((previousJob) =>'),
    ('offline-overlay', '|| browserOfflineObserved\n    || !token',
     '|| false\n    || !token'),
]


def mutant(entry):
    name, old, new = entry
    assert source.count(old) == 1
    path = ART / ('mutant-' + name + '.js')
    path.write_text(source.replace(old, new))
    code, output = tests('mutant-' + name, path)
    assert code != 0 and 'failureType: \'testCodeFailure\'' in output, output
    path.unlink()
    return {'mutation': name, 'killed': True}


with ThreadPoolExecutor(max_workers=3) as pool:
    result = list(pool.map(mutant, mutations))
assert (ROOT/'public/driver.js').read_text() == source
(ART/'mutations.json').write_text(json.dumps({'passed': True, 'results': result}, indent=2))
print(json.dumps({'passed': True, 'focusedTests': 9, 'newLintDiagnostics': 0,
                  'mutantsKilled': len(result)}))
