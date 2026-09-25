"""Freeze only this task's changes, run all layers, and compare immutable sources."""
import collections
import concurrent.futures
import difflib
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
ART = ROOT / 'test-artifacts/netsuite-priority-queue'
BASE = ART / 'baseline'
RUNTIME = ['src/netsuite.js', 'src/server.js', 'src/operator-netsuite-request-pool.js',
           'src/operator-netsuite-priority-middleware.js', 'src/netsuite-request-queue-store.js',
           'src/netsuite-request-scheduler.js', 'src/return-customer-directory.js']


def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def owned():
    files = RUNTIME + ['migrations/227_netsuite_request_priority.sql', 'test/mbt/unit/smart-scm-created-po-service.test.js']
    for folder in ['tools', 'test', 'test/support', 'test/mbt/integration']:
        files += [str(file.relative_to(ROOT)) for file in (ROOT / folder).glob('netsuite-priority-queue*') if file.is_file()]
    return sorted(set(files))


def freeze(name):
    candidate = ART / name
    assert not candidate.exists(), 'Choose a fresh candidate name; prior evidence is immutable.'
    shutil.copytree(BASE, candidate, ignore=shutil.ignore_patterns('node_modules'))
    for file in owned():
        shutil.copy2(ROOT / file, candidate / file)
    hashes = {str(file.relative_to(candidate)): digest(file)
              for file in candidate.rglob('*') if file.is_file()}
    (ART / f'{name}-hashes.json').write_text(json.dumps(hashes, indent=2) + '\n')
    patch = ''
    for file in RUNTIME + ['migrations/227_netsuite_request_priority.sql']:
        before = (BASE / file).read_text().splitlines(keepends=True) if (BASE / file).exists() else []
        after = (candidate / file).read_text().splitlines(keepends=True)
        patch += ''.join(difflib.unified_diff(before, after, fromfile='a/' + file, tofile='b/' + file))
    (ART / f'{name}-runtime.patch').write_text(patch)
    return candidate


def run(label, args, source):
    command = ['sudo', '-n', 'env', 'NETSUITE_PRIORITY_SOURCE_ROOT=' + str(source),
               'bash', 'tools/netsuite-priority-queue-test.sh', *args]
    log = ART / (label + '.log')
    for attempt in range(24):
        with log.open('w') as output:
            result = subprocess.run(command, cwd=ROOT, stdout=output, stderr=subprocess.STDOUT)
        if 'all predefined address pools have been fully subnetted' not in log.read_text():
            break
        shutil.copy2(log, ART / f'{label}-network-attempt-{attempt}.log')
        time.sleep(5)
    assert result.returncode in ([0, 1] if '-full-' in label else [0]), label


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


def coverage(candidate):
    data = json.loads((ART / 'checks/coverage/coverage-final.json').read_text())
    result = {}
    for file in RUNTIME:
        before = (BASE / file).read_text().splitlines() if (BASE / file).exists() else []
        after = (candidate / file).read_text().splitlines()
        changed = set()
        for op, _, _, start, end in difflib.SequenceMatcher(None, before, after).get_opcodes():
            if op in ['insert', 'replace']:
                changed.update(range(start + 1, end + 1))
        cov = data['/app/' + file]
        measured, missing = [], []
        for line in sorted(changed):
            spans = [key for key, span in cov['statementMap'].items() if span['start']['line'] <= line <= span['end']['line']]
            if not spans:
                continue
            measured.append(line)
            if not any(cov['s'][key] > 0 for key in spans):
                missing.append(line)
        branches = [hit for key, span in cov['branchMap'].items() if span['line'] in changed for hit in cov['b'][key]]
        result[file] = {'covered': len(measured) - len(missing), 'measured': len(measured), 'missing': missing,
                        'coveredBranches': sum(hit > 0 for hit in branches), 'measuredBranches': len(branches)}
    (ART / 'coverage.json').write_text(json.dumps(result, indent=2) + '\n')
    assert not any(row['missing'] for row in result.values()), result
    return result


def report(name):
    candidate = ART / name
    checks = json.loads((ART / 'checks.json').read_text())
    assert checks['passed']
    for file, sha in checks['sourceHashes'].items():
        assert digest(candidate / file) == sha == digest(ROOT / file), 'Stale or changed runtime: ' + file
    hashes = json.loads((ART / f'{name}-hashes.json').read_text())
    assert all(digest(candidate / file) == sha for file, sha in hashes.items()), 'Candidate changed during checks'
    assert all(digest(BASE / file) == sha for file, sha in json.loads((ART / 'baseline-hashes.json').read_text()).items()), 'Baseline changed'
    logs = {}
    for kind in ['baseline', 'candidate']:
        logs[kind] = ''
        for lane in range(3):
            text = (ART / f'{name}-{kind}-full-{lane}.log').read_text()
            assert re.search(r'Isolated MBT main run (?:failed|passed)', text), 'Incomplete suite lane'
            logs[kind] += text + '\n'
    before, after = logs['baseline'], logs['candidate']
    new_failures = failures(after) - failures(before)
    new_files = failed_files(after) - failed_files(before)
    result = {'candidate': name, 'baseline': counts(before), 'candidateCounts': counts(after),
              'baselineFailures': sorted(failures(before)), 'candidateFailures': sorted(failures(after)),
              'newFailures': list(new_failures), 'newFailedFiles': sorted(new_files),
              'changedCoverage': coverage(candidate), 'checks': checks,
              'sourceTreeHash': hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest(),
              'deployed': False}
    (ART / 'regression.json').write_text(json.dumps(result, indent=2) + '\n')
    assert not new_failures and not new_files, (new_failures, new_files)
    assert counts(after)['fail'] <= counts(before)['fail']
    assert counts(after)['cancelled'] <= counts(before)['cancelled']
    print(json.dumps({key: result[key] for key in ['candidate', 'baseline', 'candidateCounts', 'newFailures', 'newFailedFiles', 'sourceTreeHash', 'deployed']}))


def reuse_baseline(name, previous):
    # The baseline source is immutable; a routing correction requires rerunning
    # the candidate, not rebuilding an identical baseline for a third time.
    deadline = time.monotonic() + 1200
    for lane in range(3):
        source = ART / f'{previous}-baseline-full-{lane}.log'
        while not source.exists() or not re.search(r'Isolated MBT main run (?:failed|passed)', source.read_text()):
            assert time.monotonic() < deadline, 'Previous baseline suite is incomplete'
            time.sleep(5)
        shutil.copy2(source, ART / f'{name}-baseline-full-{lane}.log')
    (ART / f'{name}-baseline-provenance.json').write_text(json.dumps({
        'source': previous, 'reason': 'Identical immutable baseline; rerun candidate after route inventory correction',
        'hashes': {str(file.name): digest(file) for file in ART.glob(f'{name}-baseline-full-*.log')}
    }, indent=2) + '\n')


def main(name, baseline_from=None):
    candidate = freeze(name)
    run(name + '-checks', ['node', 'tools/netsuite-priority-queue-checks.mjs'], candidate)
    coverage(candidate)
    if baseline_from:
        reuse_baseline(name, baseline_from)
    sources = [('candidate', candidate)] if baseline_from else [('baseline', BASE), ('candidate', candidate)]
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
        jobs = [executor.submit(run, f'{name}-{kind}-full-{lane}', ['node', 'tools/operator-suiteql-full.mjs', str(lane), '3'], source)
                for lane in range(3) for kind, source in sources]
        for job in jobs:
            job.result()
    report(name)


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == 'report':
        report(sys.argv[2])
    else:
        main(sys.argv[1] if len(sys.argv) > 1 else 'candidate-v1',
             sys.argv[3] if len(sys.argv) == 4 and sys.argv[2] == '--baseline-from' else None)
