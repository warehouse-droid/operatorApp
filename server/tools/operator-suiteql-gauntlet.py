"""Reproduce and compare the isolated SuiteQL regression checks."""
import collections
import concurrent.futures
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
ART = ROOT / 'test-artifacts/operator-suiteql'
BASE = ART / 'baseline'
CANDIDATE = ART / 'scoped-candidate'
PREFIX = 'export async function suiteql(q, params = [], options = {}) {\n  const run = () => runSuiteql(q, params, options);\n'
BRANCH = '  if (isOperatorNetSuiteRequest()) {return run();}\n'


def source_hash():
    return hashlib.sha256((ROOT / 'src/netsuite.js').read_bytes()).hexdigest()


def scoped_candidate():
    assert not CANDIDATE.exists(), 'Use the retained immutable candidate or a new artifact directory'
    CANDIDATE.mkdir()
    for folder in ['src', 'public', 'test', 'migrations', 'tools', 'contracts']:
        shutil.copytree(BASE / folder, CANDIDATE / folder, symlinks=True)
    for file in BASE.iterdir():
        if file.is_file():
            shutil.copy2(file, CANDIDATE / file.name)
    source = (BASE / 'src/netsuite.js').read_text()
    assert source.count(PREFIX) == 1
    expected = source.replace(PREFIX, PREFIX + BRANCH)
    assert (ROOT / 'src/netsuite.js').read_text() == expected
    (CANDIDATE / 'src/netsuite.js').write_text(expected)
    owned = ['test/mbt/integration/operator-suiteql-priority.test.js',
             'test/support/operator-suiteql-fixture.mjs', 'test/support/operator-suiteql-mutation-loader.mjs']
    owned += [str(file.relative_to(ROOT)) for file in (ROOT / 'tools').glob('operator-suiteql-*') if file.is_file()]
    for file in owned:
        shutil.copy2(ROOT / file, CANDIDATE / file)
    hashes = {str(file.relative_to(CANDIDATE)): hashlib.sha256(file.read_bytes()).hexdigest()
              for folder in ['src', 'public', 'migrations', 'test', 'tools']
              for file in (CANDIDATE / folder).rglob('*') if file.is_file()}
    (ART / 'scoped-source-hashes.json').write_text(json.dumps(hashes, indent=2) + '\n')


def capture():
    if BASE.exists():
        return
    BASE.mkdir(parents=True)
    for folder in ['src', 'public', 'test', 'migrations', 'tools', 'contracts']:
        shutil.copytree(ROOT / folder, BASE / folder)
    for pattern in ['*.json', '*.js', 'Dockerfile*']:
        for file in ROOT.glob(pattern):
            if file.is_file():
                shutil.copy2(file, BASE / file.name)
    source = (BASE / 'src/netsuite.js').read_text()
    assert source.count(PREFIX + BRANCH) == 1
    (BASE / 'src/netsuite.js').write_text(source.replace(PREFIX + BRANCH, PREFIX))
    (BASE / 'test/mbt/integration/operator-suiteql-priority.test.js').unlink()


def run(label, args, baseline=False, source=None):
    command = ['sudo', '-n']
    if baseline or source:
        command += ['env', 'OPERATOR_SUITEQL_SOURCE_ROOT=' + str(BASE if baseline else source)]
    command += ['bash', 'tools/operator-suiteql-test.sh', *args]
    with (ART / (label + '.log')).open('w') as output:
        result = subprocess.run(command, cwd=ROOT, stdout=output, stderr=subprocess.STDOUT)
    assert result.returncode in ([0, 1] if label.endswith('full') or label.startswith('current-lane-') else [0]), label


def failures(text):
    result = collections.Counter()
    blocks = re.split(r'^\[isolation\] MBT main \d+/\d+ (.+)\n', text, flags=re.M)
    for index in range(1, len(blocks), 2):
        for name in re.findall(r'^✖ (.+?) \([0-9.]+ms\)$', blocks[index + 1], re.M):
            result[blocks[index] + ' :: ' + name] += 1
    return result


def failed_files(text):
    return {file for match in re.finditer(r'Isolated MBT main run failed in \d+/\d+ file\(s\): (.+)', text)
            for file in match[1].split(', ')}


def counts(text):
    return {name: sum(map(int, re.findall(r'^ℹ ' + name + r' (\d+)$', text, re.M)))
            for name in ['tests', 'pass', 'fail', 'skipped', 'cancelled']}


def report():
    before = (ART / 'baseline-full.log').read_text()
    after = (ART / 'current-full.log').read_text()
    assert all(re.search(r'Isolated MBT main run (?:failed|passed)', text) for text in [before, after]), 'Full suites have not finished'
    assert not failures(after) - failures(before), 'New failing tests: ' + str(failures(after) - failures(before))
    assert not failed_files(after) - failed_files(before), 'New failing test files'
    assert counts(after)['fail'] <= counts(before)['fail'], 'New failed-test count'
    assert counts(after)['cancelled'] <= counts(before)['cancelled'], 'New cancellations'
    checks = json.loads((ART / 'checks.json').read_text())
    assert checks['passed'] and checks['sourceHash'] == source_hash(), 'Checks are stale'
    result = {'passed': True, 'sourceHash': source_hash(), 'baseline': counts(before), 'current': counts(after),
              'baselineFailedTests': sorted(failures(before)), 'baselineFailedFiles': sorted(failed_files(before)),
              'currentFailedFiles': sorted(failed_files(after)), 'newFailures': [], 'newFailedFiles': []}
    (ART / 'regression.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({key: value for key, value in result.items() if not key.endswith(('Files', 'Tests'))}))


def main():
    ART.mkdir(parents=True, exist_ok=True)
    capture()
    run('baseline-full', ['npm', 'test'], True)
    scoped()


def scoped():
    if not CANDIDATE.exists():
        scoped_candidate()
    start = source_hash()
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
        tasks = [executor.submit(run, f'current-lane-{lane}', ['node', 'tools/operator-suiteql-full.mjs', str(lane), '3'], source=CANDIDATE)
                 for lane in range(3)]
        for task in tasks:
            task.result()
    combined = ''
    for lane in range(3):
        text = (ART / f'current-lane-{lane}.log').read_text()
        assert re.search(r'Isolated MBT main run (?:failed|passed)', text), 'Incomplete lane'
        combined += text + '\n'
    (ART / 'current-full.log').write_text(combined)
    run('checks-run', ['node', 'tools/operator-suiteql-checks.mjs'], source=CANDIDATE)
    hashes = json.loads((ART / 'scoped-source-hashes.json').read_text())
    assert all(hashlib.sha256((CANDIDATE / file).read_bytes()).hexdigest() == value for file, value in hashes.items()), 'Candidate changed during testing'
    assert start == source_hash(), 'Source changed during validation'
    report()


if __name__ == '__main__':
    {'report': report, 'scoped': scoped}.get(sys.argv[1] if len(sys.argv) > 1 else '', main)()
