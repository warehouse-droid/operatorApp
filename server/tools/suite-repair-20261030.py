"""Run selected or complete repair suites with bounded, unconditional cleanup.

python3 docker/retention/retention.py run -- python3 server/tools/suite-repair-20261030.py --full --label final
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('checks', HERE / 'worktree-release-checks-20261030.py')
checks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checks)
ROOT, SERVER, ARTIFACT = checks.ROOT, checks.SERVER, checks.ARTIFACT
BASELINE_COMMIT = '859dbc987d88fdd41b475f3738cefe9704aae3ea'


def selected_files(args):
    if args.full:
        return None
    if args.failed:
        prior = json.loads((SERVER / args.failed).read_text())
        section = prior.get('candidate', prior.get('result', prior))
        return [row['file'] for row in section['failedFiles']]
    return args.files


def source_hash(server=SERVER):
    captured = set(checks.run('git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard').decode().split('\0'))
    paths = [p for folder in ['src', 'public', 'migrations', 'test/mbt', 'test/support', 'tools']
             for p in (server / folder).rglob('*') if p.is_file() and '__pycache__' not in p.parts]
    paths += [p for p in server.iterdir() if p.is_file() and p.suffix in ['.js', '.mjs', '.json']]
    paths += [server.parent / 'docker-compose.mbt-test.yml', server / 'package.json', server / 'package-lock.json']
    hashes = {str(p.relative_to(server.parent)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(paths)
              if str(p.relative_to(server.parent)) in captured}
    return hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest()


def capture_source():
    """Freeze source so later repairs cannot change the code under a running test."""
    snapshot = ARTIFACT / 'source'
    snapshot.mkdir()
    paths = checks.run('git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard').decode().split('\0')
    for name in set(paths):
        relative = Path(name)
        parts = relative.parts
        selected = name.startswith('.github/workflows/') or name in ['docker-compose.yml', 'docker-compose.mbt-test.yml']
        if len(parts) >= 2 and parts[0] == 'server':
            selected = parts[1] in ['src', 'public', 'migrations', 'test', 'tools', 'contracts'] or (
                len(parts) == 2 and relative.suffix in ['.js', '.mjs', '.json'])
        source = ROOT / relative
        if selected and source.is_file():
            target = snapshot / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
            target.chmod(0o644)
    return snapshot / 'server'


def diagnosis(body, result):
    chunks, current = {}, None
    for line in body.splitlines():
        if line.startswith('[isolation] ') and ' /app/' in line:
            current = line.split(' /app/', 1)[1]
            chunks[current] = []
        elif current:
            chunks[current].append(line)
    for row in result['failedFiles']:
        lines = chunks.get(row['file'], [])
        start = next((i for i, line in enumerate(lines) if line.startswith('✖ ') and line != '✖ failing tests:'), None)
        # Preserve a concise failure explanation, never the raw log/browser data.
        row['firstFailureEvidence'] = [line[:500] for line in lines[start:start + 24]] if start is not None else []
        if start is not None and lines[start].startswith('✖ /app/'):
            row['startupEvidence'] = [line[:500] for line in lines[:min(start, 24)]]
        details, seen = [], set()
        for index, line in enumerate(lines):
            if not line.startswith('✖ ') or line == '✖ failing tests:':
                continue
            name = re.sub(r' \([0-9.]+ms\)$', '', line[2:])
            if name in seen:
                continue
            seen.add(name)
            excerpt = lines[index + 1:index + 9]
            location = next((entry.strip() for entry in lines[index + 1:index + 80]
                             if 'at TestContext.' in entry), None)
            details.append({'test': name, 'message': [entry[:500] for entry in excerpt], 'location': location})
        row['failureDetails'] = details


def main():
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--full', action='store_true')
    group.add_argument('--failed', help='Prior concise report, relative to server')
    group.add_argument('--files', nargs='+')
    parser.add_argument('--label', required=True)
    parser.add_argument('--static', action='store_true', help='Check TypeScript and lint changed JavaScript')
    parser.add_argument('--fix-lint', action='store_true', help='Apply only new, safe ESLint fixes; requires another verification run')
    parser.add_argument('--shuffle', type=int, help='Deterministically reorder files in the complete suite')
    parser.add_argument('--coverage', action='store_true', help='Collect disposable native V8 coverage')
    parser.add_argument('--mutations', action='store_true', help='Verify five temporary application faults are detected')
    args = parser.parse_args()
    assert re.fullmatch(r'[a-z0-9-]+', args.label), 'Unsafe report label'
    files = selected_files(args)
    assert files is None or files, 'No selected tests'
    ARTIFACT.chmod(0o777)
    command = checks.config(SERVER, 'repair')
    report_path = SERVER / ('test/suite-repair-20261030-' + args.label + '.json')
    result = {'passed': False, 'label': args.label, 'specApproval': 'not obtained (autonomous run)',
              'selection': files if files is not None else 'full'}
    signal.signal(signal.SIGTERM, checks.interrupt)
    signal.signal(signal.SIGINT, checks.interrupt)
    watchdog = None
    try:
        checks.run('python3', 'docker/verify-memory-limits.py')
        before = source_hash()
        runtime = capture_source()
        assert source_hash(runtime) == before, 'Source changed during capture'
        checks.emit({'stage': 'source-captured', 'hash': before})
        checks.SERVER = runtime
        command = checks.config(runtime, 'repair')
        overlay_path = Path(command[-1])
        overlay = json.loads(overlay_path.read_text())
        if args.shuffle is not None:
            overlay['services']['test']['environment']['MBBS_TEST_SHUFFLE_SEED'] = str(args.shuffle)
            result['shuffleSeed'] = args.shuffle
        if args.coverage:
            overlay['services']['test']['environment']['NODE_V8_COVERAGE'] = '/app/test-artifacts/node-coverage'
            changes, current, line = {}, None, 0
            diff = checks.run('git', 'diff', '--unified=0', BASELINE_COMMIT, '--', 'server/src', 'server/public').decode()
            for text in diff.splitlines():
                if text.startswith('+++ b/server/'):
                    current = text.removeprefix('+++ b/server/')
                elif text.startswith('@@'):
                    line = int(re.search(r'\+(\d+)', text)[1])
                elif text.startswith('+') and current and current.endswith(('.js', '.mjs')):
                    if 'suiteRepair=20261030-v1' not in text:
                        changes.setdefault(current, []).append(line)
                    line += 1
            (ARTIFACT / 'repair-changed-lines.json').write_text(json.dumps(changes))
        for service in ['test', 'migrate']:
            overlay['services'][service]['volumes'] += [
                {'type': 'bind', 'source': str(runtime.parent / name),
                 'target': '/workspace/' + name, 'read_only': True}
                for name in ['.github/workflows', 'docker-compose.yml', 'docker-compose.mbt-test.yml']]
        overlay_path.write_text(json.dumps(overlay))
        # Reuse the existing process guard while keeping historical reports frozen.
        guard = (HERE / 'worktree-test-watchdog-20261030.py').read_text().replace(
            "'server/test/whole-worktree-deployment-20261030-timeouts.json'",
            "'server/test/suite-repair-20261030-" + args.label + "-timeouts.json'")
        # -c has no __file__; supply the original script path for its root lookup.
        guard = "__file__ = " + repr(str(HERE / 'worktree-test-watchdog-20261030.py')) + '\n' + guard
        watchdog = subprocess.Popen(['python3', '-c', guard, checks.PROJECT], cwd=ROOT)
        for name, arguments, timeout in [
            ('database', ['up', '-d', '--wait', 'db'], 120),
            ('migrate', ['run', '--rm', '--no-deps', '-T', 'migrate'], 600)]:
            code, body = checks.logged(command + arguments, name, timeout)
            if code:
                raise RuntimeError(body[-5000:])
        code, body = checks.test_group(command, 'repair', files)
        result['result'] = checks.summary(body)
        diagnosis(body, result['result'])
        result['exitCode'] = code
        result['sourceTreeHash'] = before
        assert source_hash(runtime) == before, 'Captured source changed during this run'
        if files is not None:
            assert result['result']['fileCount'] == len(files), 'Incomplete selection'
        result['passed'] = code == 0 and not result['result']['failedFiles']
        if args.static:
            names = checks.run('git', 'diff', '--name-only', BASELINE_COMMIT, '--', 'server').decode().splitlines()
            names += checks.run('git', 'ls-files', '--others', '--exclude-standard', '--', 'server').decode().splitlines()
            changed = sorted({str(Path(name).relative_to('server')) for name in names
                              if Path(name).suffix in ['.js', '.mjs'] and (ROOT / name).is_file()})
            module_spec = importlib.util.spec_from_file_location('repair_static', HERE / 'suite-repair-static-20261030.py')
            static = importlib.util.module_from_spec(module_spec)
            module_spec.loader.exec_module(static)
            result['static'] = static.compare(checks, command, runtime, changed, args.fix_lint, BASELINE_COMMIT)
            result['passed'] = result['passed'] and result['static']['passed']
        if args.coverage:
            coverage_code, coverage_output = checks.logged(command + ['run', '--rm', '--no-deps', '-T', 'test',
                'node', 'tools/suite-repair-coverage-20261030.mjs'], 'coverage-summary', 600)
            assert coverage_code == 0, coverage_output[-4000:]
            result['coverage'] = json.loads((ARTIFACT / 'repair-coverage-summary.json').read_text())
        if args.mutations:
            mutation_spec = importlib.util.spec_from_file_location('repair_mutations', HERE / 'suite-repair-mutations-20261030.py')
            mutations = importlib.util.module_from_spec(mutation_spec)
            mutation_spec.loader.exec_module(mutations)
            result['mutations'] = mutations.run(checks, command, runtime, source_hash)
            result['passed'] = result['passed'] and result['mutations']['passed']
    except BaseException as error:
        result['error'] = str(error)
        raise
    finally:
        checks.STOP.set()
        cleanup = subprocess.run(command + ['down', '--volumes', '--remove-orphans'], cwd=ROOT, capture_output=True)
        leftovers = {}
        for kind in ['container', 'volume', 'network']:
            flags = ['-a'] if kind == 'container' else []
            leftovers[kind] = checks.run('docker', kind, 'ls', '-q', *flags,
                '--filter', 'label=com.docker.compose.project=' + checks.PROJECT).decode().split()
        if watchdog is not None:
            watchdog.terminate()
            watchdog.wait(timeout=15)
        result['cleanup'] = {'exitCode': cleanup.returncode, 'leftovers': leftovers}
        result['passed'] = result['passed'] and cleanup.returncode == 0 and not any(leftovers.values())
        report_path.write_text(json.dumps(result, indent=2) + '\n')
        report_path.chmod(0o644)
        for args in [['docker', 'ps'], ['docker', 'ps', '-a']]:
            print(checks.run(*args, '--format', '{{.Names}} {{.Status}}').decode(), flush=True)
        checks.run('curl', '-fsS', '-o', '/dev/null', 'http://127.0.0.1:3000/health')
        checks.emit({'passed': result['passed'], 'report': str(report_path),
            'counts': {k: v for k, v in result.get('result', {}).items() if k != 'failedFiles'}})
    if not result['passed']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
