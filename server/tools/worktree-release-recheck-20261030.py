"""Reproduce the two observed browser flakes on production source before release.

Assertions, timeouts, and resource limits stay unchanged. A passing retry alone
does not clear a failure: the same failure must occur with production source.
"""
import concurrent.futures
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import tarfile

os.environ['MBBS_RELEASE_TEST_SHARDS'] = '1'
HERE = Path(__file__).resolve().parent


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


checks = module('checks', 'worktree-release-checks-20261030.py')
release = module('release', 'worktree-release-20261030.py')
SIGNATURES = {
    'test/mbt/integration/backorder-po-routing.test.js': 'Retry PO routing',
    'test/mbt/integration/stock-check-lines-browser.test.js':
        'response.json: Target page, context or browser has been closed'
}
REPORT = checks.SERVER / 'test/whole-worktree-deployment-20261030-rechecks.json'


def failed(summary):
    return {row['file']: set(row['failures']) for row in summary['failedFiles']}


def unresolved(wanted, known):
    return [{'file': file, 'failures': sorted(names - known.get(file, set()))}
            for file, names in wanted.items() if names - known.get(file, set())]


def main():
    signal.signal(signal.SIGTERM, checks.interrupt)
    signal.signal(signal.SIGINT, checks.interrupt)
    original = json.loads(checks.REPORT.read_text())
    if original['passed']:
        checks.emit({'recheckRequired': False})
        return
    assert original['candidate']['fileCount'] == 1253
    assert original['newFailures'] and all(row['file'] in SIGNATURES for row in original['newFailures']), 'Unclassified regression requires investigation'
    release.unchanged()
    before = checks.hashes()
    digest = hashlib.sha256(json.dumps(before, sort_keys=True).encode()).hexdigest()
    assert digest == original['sourceTreeHash'], 'Full-run source changed before replay'
    result = {'passed': False, 'sourceTreeHash': digest, 'originalNewFailures': original['newFailures'],
              'rule': 'Same failure reproduced on production source; passing retries alone are insufficient', 'rounds': []}
    wanted, known = failed(original['candidate']), failed(original['baseline'])
    candidate = checks.config(checks.SERVER, 'candidate')
    checks.ARTIFACT.chmod(0o777)
    watchdog = subprocess.Popen(['python3', str(HERE / 'worktree-test-watchdog-20261030.py'), checks.PROJECT], cwd=checks.ROOT)
    try:
        baseline = checks.ARTIFACT / 'live-source'
        baseline.mkdir()
        data = checks.run('docker', 'exec', 'mbbs-operator-app-app-1', 'tar', '-C', '/app', '-cf', '-',
            'src', 'public', 'migrations', 'package.json', 'package-lock.json',
            'netsuite-field-sales-restlet.js', 'netsuite-smart-scm-picking-ticket-restlet.js')
        with tarfile.open(fileobj=io.BytesIO(data)) as archive:
            archive.extractall(baseline, filter='data')
        for path in baseline.rglob('*'):
            path.chmod(0o755 if path.is_dir() else 0o644)
        baseline.chmod(0o755)
        prior = checks.config(baseline, 'baseline')
        checks.run('python3', 'docker/verify-memory-limits.py')
        for args, name, timeout in [(['up', '-d', '--wait', 'db'], 'database', 120),
                                    (['run', '--rm', '--no-deps', '-T', 'migrate'], 'migrate', 600)]:
            code, output = checks.logged(candidate + args, name, timeout)
            if code:
                raise RuntimeError(output[-3000:])
        for attempt in range(1, 4):
            pending = unresolved(wanted, known)
            if not pending:
                break
            files = [row['file'] for row in pending]
            assert all(file in SIGNATURES for file in files), 'A new unexpected replay failure requires investigation'
            pool = concurrent.futures.ThreadPoolExecutor(max_workers=2)
            try:
                futures = {mode: pool.submit(checks.test_group, command, mode + '-recheck-' + str(attempt), files)
                           for mode, command in [('candidate', candidate), ('baseline', prior)]}
                outputs = {mode: future.result() for mode, future in futures.items()}
            except BaseException:
                checks.STOP.set()
                raise
            finally:
                pool.shutdown(wait=True, cancel_futures=True)
            round_result = {'attempt': attempt}
            for mode, (code, output) in outputs.items():
                summary = checks.summary(output)
                assert summary['fileCount'] == len(files), 'Incomplete browser replay'
                round_result[mode] = {'exitCode': code, **summary}
                for file, names in failed(summary).items():
                    if mode == 'candidate':
                        wanted.setdefault(file, set()).update(names)
                    elif SIGNATURES.get(file, '') in output:
                        known.setdefault(file, set()).update(names)
            round_result['unresolved'] = unresolved(wanted, known)
            result['rounds'].append(round_result)
            checks.emit({'recheckRound': attempt, 'unresolved': round_result['unresolved']})
        release.unchanged()
        assert checks.hashes() == before
        result['unresolved'] = unresolved(wanted, known)
        result['passed'] = not result['unresolved']
    except BaseException as error:
        result['error'] = str(error)
        raise
    finally:
        cleanup = subprocess.run(candidate + ['down', '--volumes', '--remove-orphans'], cwd=checks.ROOT, capture_output=True)
        leftovers = {}
        for kind in ['container', 'volume', 'network']:
            args = ['docker', kind, 'ls', '-q'] + (['-a'] if kind == 'container' else [])
            leftovers[kind] = checks.run(*args, '--filter', 'label=com.docker.compose.project=' + checks.PROJECT).decode().split()
        watchdog.terminate()
        watchdog.wait(timeout=15)
        result['cleanup'] = {'exitCode': cleanup.returncode, 'leftovers': leftovers}
        result['passed'] = result['passed'] and cleanup.returncode == 0 and not any(leftovers.values())
        REPORT.write_text(json.dumps(result, indent=2) + '\n')
        for args in [['docker', 'ps'], ['docker', 'ps', '-a']]:
            print(checks.run(*args, '--format', '{{.Names}} {{.Status}}').decode(), flush=True)
        release.health()
    if not result['passed']:
        raise SystemExit('Browser failures remain unclassified; deployment remains blocked')
    original['newFailuresBeforeRechecks'] = original['newFailures']
    original['newFailures'] = []
    original['recheckReport'] = str(REPORT.relative_to(checks.SERVER))
    original['passed'] = True
    checks.REPORT.write_text(json.dumps(original, indent=2) + '\n')
    checks.emit({'passed': True, 'browserFailuresReproducedOnProductionSource': True})


if __name__ == '__main__':
    main()
