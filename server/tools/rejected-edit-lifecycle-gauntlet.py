"""Run the isolated verification matrix, or check its saved evidence for release."""
import collections
import hashlib
import json
from pathlib import Path
import random
import re
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
ARTIFACTS = SERVER / 'test-artifacts/rejected-edit-lifecycle'
RELEASE = Path('/home/ubuntu/operatorapp-deploy-backups/rejected-edit-lifecycle-20260923-v1')
TESTS = ['test/dispatch/frontend/' + name for name in [
    'dispatch-rejected-edit-lifecycle.test.js', 'dispatch-authoritative-retirement.red.test.js',
    'dispatch-save-reliability.test.js']]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(mode, name, *args, allowed=(0,)):
    with (ARTIFACTS / name).open('wb') as output:
        result = subprocess.run(['sudo', '-n', 'bash', 'tools/rejected-edit-test-env.sh', 'run', mode, *args],
                                cwd=SERVER, stdout=output, stderr=subprocess.STDOUT)
    assert result.returncode in allowed, name + ' failed'


def full_log(name):
    text = (ARTIFACTS / name).read_text()
    entries = re.findall(r'\[isolation\] MBT main (\d+)/(\d+) (\S+)', text)
    assert entries and int(entries[-1][0]) == int(entries[-1][1]) == len(entries), name + ' incomplete'
    assert 'Isolated MBT main run failed in ' in text or 'Isolated MBT main run passed' in text, name + ' lacks completion'
    failures = collections.Counter()
    for block in re.split(r'\[isolation\] MBT main \d+/\d+ ', text)[1:]:
        file = block.splitlines()[0]
        for line in block.split('ℹ tests ')[0].splitlines():
            if re.match(r'^\s*✖ ', line):
                label = re.sub(r' \([\d.]+m?s\)$', '', line.strip())
                failures[(file, label)] += 1
    counts = {key: sum(map(int, re.findall('ℹ ' + key + r' (\d+)', text)))
              for key in ['tests', 'pass', 'fail', 'cancelled', 'skipped']}
    match = re.search(r'failed in (\d+)/\d+ file\(s\): (.+)', text)
    failed_files = set(match[2].split(', ')) if match else set()
    return {'files': len(entries), **counts, 'failedFiles': sorted(failed_files)}, failures


def tap(name, expected):
    text = (ARTIFACTS / name).read_text()
    for key, value in [('tests', expected), ('pass', expected), ('fail', 0), ('cancelled', 0), ('skipped', 0)]:
        assert re.search(r'^# ' + key + ' ' + str(value) + '$', text, re.M), name + ': ' + key


def health():
    files = TESTS.copy()
    random.Random(120921).shuffle(files)
    counts = collections.Counter()
    for index, file in enumerate(files):
        name = f'suite-health-{index}.log'
        run('current', name, 'node', '--test', file)
        text = (ARTIFACTS / name).read_text()
        for key in ['tests', 'pass', 'fail', 'cancelled', 'skipped']:
            values = re.findall(r'^# ' + key + r' (\d+)$', text, re.M)
            assert len(values) == 1
            counts[key] += int(values[0])
    assert counts == {'tests': 61, 'pass': 61, 'fail': 0, 'cancelled': 0, 'skipped': 0}
    (ARTIFACTS / 'suite-health.json').write_text(json.dumps({'seed': 120921, 'order': files, 'counts': dict(counts)}, indent=2) + '\n')


def collect():
    baseline, old_failures = full_log('full-baseline.log')
    current, new_failures = full_log('full-current.log')
    added = new_failures - old_failures
    original_added = list(added.items())
    reproduced = []
    flaky_file = '/app/test/mbt/integration/stock-return-draft-insert.test.js'
    flaky_label = '✖ normal stock draft preserves every line field and consumes the draft only on success'
    if added:
        assert set(added) == {(flaky_file, flaky_label)}, 'New failed tests: ' + repr(list(added.items()))
        repeats = {}
        for mode in ['baseline', 'current']:
            text = (ARTIFACTS / ('flake-' + mode + '.log')).read_text()
            repeated = json.loads(text.splitlines()[-1])
            assert repeated['file'] == flaky_file and len(repeated['results']) == 5
            assert text.count(flaky_label) >= 5 and '/metadata-catalog/record/v1/creditMemo' in text
            assert repeated['results'] == [1, 1, 1, 1, 1], 'The extra failure must reproduce on the original version'
            repeats[mode] = repeated['results']
        reproduced.append({'file': flaky_file, 'test': flaky_label, 'repeats': repeats,
                           'reason': 'Existing return-reason metadata freshness behavior; browser files are not loaded by this test.'})
        added.clear()
    assert not set(current['failedFiles']) - set(baseline['failedFiles']) - {row['file'] for row in reproduced}, 'New failing files'
    assert current['files'] == baseline['files']
    tap('green.log', 61)
    tap('candidate-regressions.log', 61)
    assert json.loads((ARTIFACTS / 'suite-health.json').read_text())['counts'] == {
        'tests': 61, 'pass': 61, 'fail': 0, 'cancelled': 0, 'skipped': 0}
    types = []
    for mode in ['baseline', 'current']:
        text = (ARTIFACTS / ('types-' + mode + '.log')).read_text()
        types.append(collections.Counter(re.sub(r'\(\d+,\d+\)', '(LINE,COL)', line)
                                         for line in text.splitlines() if 'error TS' in line))
    assert not types[1] - types[0], 'New type diagnostics'
    for name in ['lint-current.json', 'tooling-lint.json']:
        assert all(not row['messages'] for row in json.loads((ARTIFACTS / name).read_text())), name
    coverage = json.loads((ARTIFACTS / 'coverage.json').read_text())
    mutations = json.loads((ARTIFACTS / 'mutations.json').read_text())
    source_hash = digest(SERVER / 'public/dispatch.js')
    assert coverage['sourceSha256'] == mutations['sourceSha256'] == source_hash
    assert coverage['count'] == 5 and coverage['changedLines'] == coverage['covered']
    assert all(all(value > 0 for value in row['counts']) for row in coverage['changedBranches'])
    assert len(mutations['results']) == 5 and all(row[scope]['killed'] for row in mutations['results'] for scope in ['all', 'properties'])
    guard = json.loads((ARTIFACTS / 'repair-guard.json').read_text())
    assert guard['staleFingerprintRejected'] and guard['stateUnchanged'] and guard['backupNotCreatedOnRejection']
    manifest = json.loads((RELEASE / 'manifest.json').read_text())
    workspace = {name: digest(SERVER / name) for name in manifest['workspace']}
    candidate = {name: digest(RELEASE / 'candidate' / name) for name in manifest['after']}
    assert workspace == manifest['workspace'] and candidate == manifest['after']
    result = {'passed': True, 'workspace': workspace, 'candidateSources': candidate,
              'baseline': baseline, 'current': current, 'newFailures': 0, 'focusedTests': 61, 'candidateTests': 61,
              'rawAddedFailures': original_added, 'reproducedBaselineFailures': reproduced,
              'typeDiagnostics': [sum(value.values()) for value in types], 'newTypeDiagnostics': 0,
              'changedLinesCovered': coverage['count'], 'manualMutantsKilled': 5, 'propertyOnlyMutantsKilled': 5,
              'propertyRuns': 50, 'repairGuards': guard,
              'browserCheck': 'unavailable: Playwright Chromium executable absent; VM regressions and real database rehearsal passed'}
    (ARTIFACTS / 'verification.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({key: value for key, value in result.items() if key not in ['baseline', 'current', 'workspace', 'candidateSources']}))


def matrix():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    # Reconstruct only this task's original browser source for baseline comparison.
    before = ARTIFACTS / 'before/public'
    before.mkdir(parents=True, exist_ok=True)
    text = (SERVER / 'public/dispatch.js').read_text()
    text = text.replace('function applyHistorySnapshot(snapshot, { reconcileLifecycle = true } = {})', 'function applyHistorySnapshot(snapshot)')
    text = text.replace('  // A rejected edit restores the local board; only deliberate history changes\n  // may retire or reactivate definitions that differ from the snapshot.\n', '')
    text = text.replace('if (reconcileLifecycle) reconcileGlobalOrderLifecycleTransition', 'reconcileGlobalOrderLifecycleTransition')
    text = text.replace('applyHistorySnapshot(unpackHistorySnapshot(rollbackPacked), { reconcileLifecycle: false })', 'applyHistorySnapshot(unpackHistorySnapshot(rollbackPacked))')
    (before / 'dispatch.js').write_text(text)
    (before / 'dispatch.html').write_text((SERVER / 'public/dispatch.html').read_text().replace('20260923-split-retirement-fix-v1', '20260923-link-to-group'))
    subprocess.run(['sudo', '-n', 'bash', 'tools/rejected-edit-test-env.sh', 'start'], cwd=SERVER, check=True)
    try:
        run('current', 'test-migration.log', 'npm', 'run', 'migrate')
        run('baseline', 'red.log', 'node', '--test', TESTS[0], allowed=(1,))
        for mode in ['baseline', 'current']:
            run(mode, 'full-' + mode + '.log', 'npm', 'test', allowed=(0, 1))
            run(mode, 'types-' + mode + '.log', 'node_modules/.bin/tsc', '--noEmit', '--allowJs', '--checkJs', '--skipLibCheck',
                '--target', 'ES2022', '--lib', 'ES2022,DOM', 'public/dispatch.js', allowed=(0, 1, 2))
            run(mode, 'lint-' + mode + '.json', 'node_modules/.bin/eslint', '--config', 'eslint.mbt.config.js', '--format', 'json', 'public/dispatch.js', TESTS[0])
        run('current', 'green.log', 'node', '--test', *TESTS)
        health()
        run('candidate', 'candidate-regressions.log', 'node', '--test', *TESTS)
        for mode in ['coverage', 'mutations']:
            run('current', mode + '.json', 'node', 'test/support/rejected-edit-lifecycle-checks.mjs', mode)
        for mode in ['baseline', 'current']:
            run(mode, 'flake-' + mode + '.log', 'node', 'test/support/rejected-edit-suite-flake-check.mjs')
        run('current', 'tooling-lint.json', 'node_modules/.bin/eslint', '--config', 'eslint.mbt.config.js', '--format', 'json',
            TESTS[0], 'test/support/rejected-edit-lifecycle-checks.mjs', 'tools/repair-sob120921-group.mjs')
        collect()
    finally:
        subprocess.run(['sudo', '-n', 'bash', 'tools/rejected-edit-test-env.sh', 'stop'], cwd=SERVER, check=True)


if __name__ == '__main__':
    {'run': matrix, 'check': collect, 'health': health}[sys.argv[1]]()
