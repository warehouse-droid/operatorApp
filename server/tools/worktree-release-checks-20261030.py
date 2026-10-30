"""Full-suite candidate/baseline comparison in the standard disposable budget.

Run from the repository root through docker/retention/retention.py run.
Raw logs and the captured production source live only in MBBS_TEST_ARTIFACT_DIR.
"""
import collections
import concurrent.futures
import hashlib
import io
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tarfile
import threading
import time

ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / 'server'
ARTIFACT = Path(os.environ['MBBS_TEST_ARTIFACT_DIR'])
PROJECT = 'mbbs-worktree-check-' + str(os.getpid())
REPORT = SERVER / 'test/whole-worktree-deployment-20261030-checks.json'
COMPOSE = ['docker', 'compose', '-p', PROJECT, '-f', str(ROOT / 'docker-compose.mbt-test.yml')]
ROOT_FILES = [p.name for p in SERVER.glob('*.js')] + ['package.json', 'package-lock.json']
SHARDS = int(os.environ.get('MBBS_RELEASE_TEST_SHARDS', '2'))
assert SHARDS in [1, 2], 'Only one or two bounded test shards are supported'
STOP = threading.Event()


def run(*args, **options):
    return subprocess.run(args, cwd=ROOT, check=True, capture_output=True, **options).stdout


def emit(value):
    print(json.dumps(value), flush=True)


def hashes():
    paths = [p for name in ['src', 'public', 'migrations'] for p in (SERVER / name).rglob('*') if p.is_file() and p.suffix not in ['.orig', '.rej']]
    paths += [SERVER / n for n in ROOT_FILES]
    return {str(p.relative_to(SERVER)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(paths)}


def config(runtime, name):
    mounts = []
    for folder in ['src', 'public', 'migrations', 'test', 'tools', 'contracts']:
        source = runtime / folder if folder in ['src', 'public'] else SERVER / folder
        mounts.append({'type': 'bind', 'source': str(source), 'target': '/app/' + folder, 'read_only': True})
    for file in ROOT_FILES:
        source = runtime / file if (runtime / file).exists() else SERVER / file
        mounts.append({'type': 'bind', 'source': str(source), 'target': '/app/' + file, 'read_only': True})
    mounts.append({'type': 'bind', 'source': str(ARTIFACT), 'target': '/app/test-artifacts'})
    for file in ['eslint.mbt.config.js', 'tsconfig.mbt.json']:
        if file not in ROOT_FILES:
            mounts.append({'type': 'bind', 'source': str(SERVER / file), 'target': '/app/' + file, 'read_only': True})
    service = {'image': 'mbbs-dispatch-source-test:latest', 'volumes': mounts,
               'mem_limit': '1536m', 'memswap_limit': '1536m', 'cpus': '1.0',
               'labels': {'com.mbbs.lifecycle': 'disposable-test'},
               'environment': {'PLAYWRIGHT_BROWSERS_PATH': '/ms-playwright',
                               'MBBS_TEST_FILE_TIMEOUT_MS': '180000'}}
    target = ARTIFACT / (name + '.compose.json')
    target.write_text(json.dumps({'services': {'test': service, 'migrate': service,
        'db': {'labels': {'com.mbbs.lifecycle': 'disposable-test'}}}}))
    return COMPOSE + ['-f', str(target)]


def logged(command, name, timeout=10800):
    path = ARTIFACT / (name + '.log')
    started = time.monotonic()
    with path.open('wb') as output:
        child = subprocess.Popen(command, cwd=ROOT, stdout=output, stderr=subprocess.STDOUT)
        try:
            while child.poll() is None:
                if STOP.is_set():
                    raise InterruptedError('Release check interrupted')
                if time.monotonic() - started > timeout:
                    raise TimeoutError(name + ' exceeded its time budget')
                time.sleep(5)
                if int(time.monotonic() - started) % 30 < 5:
                    body = path.read_text(errors='replace')
                    progress = re.findall(r'^\[isolation\].*$', body, re.M)
                    emit({'stage': name, 'elapsedSeconds': round(time.monotonic() - started),
                          'progress': progress[-1] if progress else 'running'})
        finally:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
    return child.returncode, path.read_text(errors='replace')


def test_group(command, name, files=None):
    def shard(index):
        output = ARTIFACT / (name + '-artifacts-' + str(index))
        output.mkdir(mode=0o777)
        output.chmod(0o777)
        override = ARTIFACT / (name + '-shard-' + str(index) + '.compose.json')
        override.write_text(json.dumps({'services': {'test': {'volumes': [{
            'type': 'bind', 'source': str(output), 'target': '/app/test-artifacts'}]}}}))
        arguments = ['node', 'tools/worktree-test-shard-20261030.mjs', str(index), str(SHARDS)]
        if files is not None:
            arguments.append(json.dumps(files))
        return logged(command + ['-f', str(override), 'run', '--rm', '--no-deps', '-T', 'test'] + arguments,
                      name + '-shard-' + str(index))
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=SHARDS)
    try:
        results = list(pool.map(shard, range(SHARDS)))
    except BaseException:
        STOP.set()
        raise
    finally:
        pool.shutdown(wait=True, cancel_futures=True)
    output = '\n'.join(result[1] for result in results)
    (ARTIFACT / (name + '.log')).write_text(output)
    started = re.findall(r'^\[isolation\].*? (/app/.*)$', output, re.M)
    assert len(started) == len(set(started)), 'Test shards overlapped'
    return max(result[0] for result in results), output


def summary(body):
    files = []
    current = None
    for line in body.splitlines():
        match = re.match(r'\[isolation\] .*? (\d+)/(\d+) (/app/.*)', line)
        if match:
            current = {'file': match[3].removeprefix('/app/'), 'failures': []}
            files.append(current)
        if current is None:
            continue
        counts = re.match(r'ℹ (tests|pass|fail|cancelled|skipped) (\d+)', line)
        if counts:
            current[counts[1]] = int(counts[2])
        if line.startswith('✖ ') and line != '✖ failing tests:':
            failure = re.sub(r' \([0-9.]+ms\)$', '', line[2:])
            failure = re.sub(r' \(/app/[^)]*\)$', '', failure)
            if failure not in current['failures']:
                current['failures'].append(failure)
    totals = {key: sum(f.get(key, 0) for f in files) for key in ['tests', 'pass', 'fail', 'cancelled', 'skipped']}
    failed = [f for f in files if f.get('fail', 0) or f.get('cancelled', 0) or f['failures']]
    return {'fileCount': len(files), **totals, 'failedFiles': failed}


def interrupt(number, _frame):
    raise KeyboardInterrupt('Interrupted by signal ' + str(number))


def main():
    ARTIFACT.chmod(0o777)
    candidate = config(SERVER, 'candidate')
    result = {'specApproval': 'not obtained (autonomous run)', 'newFailures': [], 'passed': False,
              'testShards': SHARDS, 'perTestContainerMemory': '1536m', 'sharedSliceMemory': '4g', 'sharedSliceCpu': 2}
    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGINT, interrupt)
    watchdog = subprocess.Popen(['python3', str(SERVER / 'tools/worktree-test-watchdog-20261030.py'), PROJECT], cwd=ROOT)
    # Teardown is registered before source capture or the first test container.
    try:
        run('python3', 'docker/verify-memory-limits.py')
        before = hashes()
        source_digest = hashlib.sha256(json.dumps(before, sort_keys=True).encode()).hexdigest()
        baseline = ARTIFACT / 'live-source'
        baseline.mkdir()
        tar_paths = ['src', 'public', 'migrations', 'package.json', 'package-lock.json',
            'netsuite-field-sales-restlet.js', 'netsuite-smart-scm-picking-ticket-restlet.js']
        captured = run('docker', 'exec', 'mbbs-operator-app-app-1', 'tar', '-C', '/app', '-cf', '-', *tar_paths)
        with tarfile.open(fileobj=io.BytesIO(captured)) as archive:
            archive.extractall(baseline, filter='data')
        for p in baseline.rglob('*'):
            p.chmod(0o755 if p.is_dir() else 0o644)
        baseline.chmod(0o755)
        prior = config(baseline, 'baseline')
        code, output = logged(candidate + ['up', '-d', '--wait', 'db'], 'database', 120)
        if code:
            raise RuntimeError(output[-6000:])
        code, output = logged(candidate + ['run', '--rm', '--no-deps', '-T', 'migrate'], 'migrate', 600)
        if code:
            raise RuntimeError(output[-6000:])
        code, output = test_group(candidate, 'full-candidate')
        result['candidate'] = summary(output)
        result['candidateExitCode'] = code
        assert result['candidate']['fileCount'] == 1253, 'The complete release suite did not finish'
        emit({'candidate': {k: v for k, v in result['candidate'].items() if k != 'failedFiles'},
              'failedFileCount': len(result['candidate']['failedFiles'])})
        failed = [f['file'] for f in result['candidate']['failedFiles']]
        if code and not failed:
            raise RuntimeError('Candidate stopped without a parseable result: ' + output[-6000:])
        if failed:
            baseline_code, baseline_output = test_group(prior, 'failed-file-baseline', failed)
            result['baseline'] = summary(baseline_output)
            result['baselineExitCode'] = baseline_code
            assert result['baseline']['fileCount'] == len(failed), 'Production-source replay did not finish'
            baseline_failures = {f['file']: set(f['failures']) for f in result['baseline']['failedFiles']}
            # A failure already reproduced with identical application and test
            # source remains baseline evidence if its intermittent hook passes
            # in this replay. Never accept a passing retry as such evidence.
            replay_path = SERVER / 'test/whole-worktree-deployment-20261030-rechecks.json'
            if replay_path.exists():
                replay = json.loads(replay_path.read_text())
                clean = replay.get('cleanup', {}).get('exitCode') == 0 and not any(replay.get('cleanup', {}).get('leftovers', {}).values())
                for proof in replay.get('productionReproductions', []) if clean else []:
                    path = SERVER / proof['file']
                    if proof['sourceTreeHash'] == source_digest and hashlib.sha256(path.read_bytes()).hexdigest() == proof['testFileHash']:
                        baseline_failures.setdefault(proof['file'], set()).update(proof['failures'])
                        result.setdefault('priorProductionReproductions', []).append(proof)
            for file in result['candidate']['failedFiles']:
                new = set(file['failures']) - baseline_failures.get(file['file'], set())
                if file['file'] not in baseline_failures or new:
                    result['newFailures'].append({'file': file['file'], 'failures': sorted(new) or file['failures']})
        assert hashes() == before, 'Application source changed during the test run'
        result['sourceTreeHash'] = source_digest
        result['sourceHashes'] = before
        result['passed'] = not result['newFailures']
    except BaseException as error:
        result['error'] = str(error)
        raise
    finally:
        cleanup = subprocess.run(candidate + ['down', '--volumes', '--remove-orphans'], cwd=ROOT, capture_output=True, text=True)
        leftovers = {}
        for kind in ['container', 'volume', 'network']:
            args = ['docker', kind, 'ls', '-q']
            if kind == 'container': args.append('-a')
            args += ['--filter', 'label=com.docker.compose.project=' + PROJECT]
            leftovers[kind] = run(*args).decode().split()
        result['cleanup'] = {'exitCode': cleanup.returncode, 'leftovers': leftovers}
        watchdog.terminate()
        watchdog.wait(timeout=15)
        if cleanup.returncode or any(leftovers.values()):
            result['passed'] = False
        # Full hashes are operational source provenance, not generated test logs.
        manifest = SERVER / 'deployments/whole-worktree-20261030'
        manifest.mkdir(exist_ok=True)
        if 'sourceHashes' in result:
            (manifest / 'tested-source-hashes.json').write_text(json.dumps(result.pop('sourceHashes'), indent=2) + '\n')
        REPORT.write_text(json.dumps(result, indent=2) + '\n')
        for command in [['docker', 'ps'], ['docker', 'ps', '-a']]:
            print(run(*command, '--format', '{{.Names}} {{.Status}}').decode(), flush=True)
        run('curl', '-fsS', '-o', '/dev/null', 'http://127.0.0.1:3000/health')
        emit({'passed': result['passed'], 'newFailures': result['newFailures'], 'report': str(REPORT)})
    if not result['passed']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
