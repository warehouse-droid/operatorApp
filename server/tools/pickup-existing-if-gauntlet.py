"""Reproduce pickup IF validation; only disposable test databases are written."""
import collections
import difflib
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

SERVER = Path(__file__).resolve().parents[1]
ARTIFACT = SERVER / 'test-artifacts/pickup-existing-if'
BASELINE = ARTIFACT / 'baseline'
FINAL = ARTIFACT / 'final'
RUNTIME = ['src/operator-netsuite-posting-' + name + '.js' for name in ['targets', 'domain', 'finalizer', 'service']]
RUNTIME += ['src/operator-pickup-existing-if-domain.js', 'src/operator-pickup-existing-if-source.js']


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def state():
    names = sorted(set(RUNTIME + ['test/mbt/infrastructure/p3-gauntlet-contract.test.js'] + [str(p.relative_to(SERVER)) for folder in ['test', 'tools']
        for p in (SERVER / folder).rglob('*pickup-existing-if*') if p.is_file()]))
    hashes = {name: sha(SERVER / name) for name in names}
    changed = {}
    for name in RUNTIME:
        old = (BASELINE / name).read_text().splitlines() if (BASELINE / name).exists() else []
        new = (SERVER / name).read_text().splitlines()
        changed[name] = [n for tag, _, _, begin, end in difflib.SequenceMatcher(None, old, new).get_opcodes()
                         if tag in ('replace', 'insert') for n in range(begin + 1, end + 1)]
    for name in ['package.json', 'package-lock.json']:
        assert sha(BASELINE / name) == sha(SERVER / name), 'Dependencies changed'
    for name in RUNTIME:
        text = '\n'.join((SERVER / name).read_text().splitlines()[n - 1] for n in changed[name])
        assert not re.search(r'-----BEGIN .*PRIVATE KEY-----|(?:AKIA|ASIA)[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}', text), name
    return {'files': hashes, 'runtime': {name: hashes[name] for name in RUNTIME}, 'changedLines': changed,
            'sourceHash': hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest()}


def run(name, args, accepted=(0,)):
    with (FINAL / name).open('w') as output:
        result = subprocess.run(['sudo', '-n', 'bash', str(SERVER / 'tools/pickup-existing-if-test.sh'), *args],
                                cwd=SERVER, stdout=output, stderr=subprocess.STDOUT)
    assert result.returncode in accepted, f'{name} failed; inspect {FINAL / name}'


def failures(text):
    return collections.Counter(re.findall(r'^✖ (.+?) \([0-9.]+ms\)$', text, re.M))


def failed_files(text):
    match = re.search(r'Isolated MBT main run failed in \d+/\d+ file\(s\): (.+)', text)
    return set(match[1].split(', ')) if match else set()


def main():
    os.umask(0o077)
    assert (ARTIFACT / 'baseline-full.log').exists(), 'Saved pre-change full baseline is required'
    if FINAL.exists():
        shutil.rmtree(FINAL)
    FINAL.mkdir()
    source = state()
    (FINAL / 'source.json').write_text(json.dumps(source, indent=2) + '\n')
    run('checks.log', ['node', 'tools/pickup-existing-if-checks.mjs'])
    print('Focused tests, changed-line coverage, static comparison, independent mutations and shuffled tests passed.', flush=True)
    run('full.log', ['npm', 'test'], accepted=(0, 1))
    before = (ARTIFACT / 'baseline-full.log').read_text()
    after = (FINAL / 'full.log').read_text()
    new_failures = failures(after) - failures(before)
    assert not new_failures, f'New full-suite failures: {dict(new_failures)}'
    assert not failed_files(after) - failed_files(before), 'New failed test files'
    assert '[isolation]' in after and 'Isolated MBT main run' in after, 'Full suite did not finish'
    assert source == state(), 'Source changed during final verification'
    report = {'sourceHash': source['sourceHash'], 'newFullSuiteFailures': list(new_failures),
              'baselineFailedTests': sum(failures(before).values()) // 2,
              'currentFailedTests': sum(failures(after).values()) // 2,
              'baselineFailedFiles': len(failed_files(before)), 'currentFailedFiles': len(failed_files(after)),
              'passed': sum(map(int, re.findall(r'^ℹ pass (\d+)$', after, re.M))),
              'skipped': sum(map(int, re.findall(r'^ℹ skipped (\d+)$', after, re.M))),
              'newDependencies': 0, 'changedSourceSecretScan': 'pass'}
    (FINAL / 'regression.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report), flush=True)


if __name__ == '__main__':
    main()
