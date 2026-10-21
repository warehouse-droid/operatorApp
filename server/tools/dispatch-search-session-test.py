"""Reproduce the Dispatch session regression using repo sources and isolated tests.

Run with ``python3 tools/dispatch-search-session-test.py``. Each run keeps its
baseline, validation results and HTTP logs in a fresh test-artifacts directory.
The only release helper invoked is offline(); no production state is inspected.
"""
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

SERVER = Path(__file__).resolve().parents[1]
ASSETS = ('public/dispatch.js', 'public/dispatch.html')


def hashes(root):
    return {asset: hashlib.sha256((root / asset).read_bytes()).hexdigest() for asset in ASSETS}


def main():
    os.umask(0o077)
    artifacts = SERVER / 'test-artifacts'
    artifacts.mkdir(exist_ok=True)
    out = Path(tempfile.mkdtemp(prefix='dispatch-search-session-reproduction-', dir=artifacts))
    result = {
        'passed': False,
        'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'artifacts': str(out),
        'sourceHashes': hashes(SERVER),
        'checks': {},
    }
    print(json.dumps({'artifacts': str(out)}), flush=True)
    try:
        # Loading the helper must not create bytecode alongside existing tools.
        sys.dont_write_bytecode = True
        spec = importlib.util.spec_from_file_location('dispatch_search_release',
            SERVER / 'tools/dispatch-search-session-release.py')
        release = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(release)
        release.OUT = out

        baseline = out / 'production-before'
        baseline.mkdir()
        shutil.copytree(SERVER / 'public', baseline / 'public')
        for folder in ('src', 'migrations'):
            (baseline / folder).symlink_to(SERVER / folder, target_is_directory=True)
        patch = (SERVER / 'test/dispatch-search-session.changes.patch').read_text()
        reversed_patch = subprocess.run([
            'patch', '--batch', '--fuzz=0', '--no-backup-if-mismatch', '-R', '-p1', '-d', str(baseline)
        ], input=patch, text=True, capture_output=True)
        (out / 'reverse-patch.log').write_text(reversed_patch.stdout + reversed_patch.stderr)
        result['checks']['reversePatch'] = {'exitCode': reversed_patch.returncode}
        reversed_patch.check_returncode()
        result['baselineHashes'] = hashes(baseline)

        for source, phase in ((baseline, 'baseline'), (SERVER, 'current')):
            release.offline(source, phase)
            result['checks'][phase] = json.loads((out / f'{phase}-results.json').read_text())
            print(json.dumps({'phase': phase, **result['checks'][phase]}), flush=True)
        validation = json.loads((out / 'validation.json').read_text())
        assert validation['passed'] and validation['sourceHashes'] == result['sourceHashes']
        result['validation'] = validation

        http_artifacts = out / 'http'
        # The existing runner appends this value to its checks directory. Resolve
        # the path back into this run's artifacts without changing that runner.
        check_name = os.path.relpath(http_artifacts, artifacts / 'mbt-bin-planning/checks')
        env = dict(os.environ, BIN_PLANNING_SOURCE_ROOT=str(SERVER), BIN_PLANNING_CHECK=check_name)
        with (out / 'http.log').open('wb') as log:
            http = subprocess.run([
                'bash', str(SERVER / 'tools/bin-planning-test.sh'), 'node', '--test', '--test-concurrency=1',
                'test/dispatch/integration/dispatch-search-session.test.js'
            ], cwd=SERVER, env=env, stdout=log, stderr=subprocess.STDOUT)
        result['checks']['http'] = {'exitCode': http.returncode, 'log': str(out / 'http.log')}
        http.check_returncode()
        http_output = (out / 'http.log').read_text()
        counts = {name: int(re.search(rf'^# {name} (\d+)$', http_output, re.MULTILINE).group(1))
            for name in ('tests', 'pass', 'fail', 'skipped')}
        result['checks']['http'].update(counts)
        assert counts == {'tests': 6, 'pass': 6, 'fail': 0, 'skipped': 0}, 'Unexpected HTTP test results'
        assert hashes(SERVER) == result['sourceHashes'], 'Repo assets changed during reproduction'
        result['passed'] = True
    except Exception as error:
        result['error'] = f'{type(error).__name__}: {error}'
        raise
    finally:
        result['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        (out / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result), flush=True)


if __name__ == '__main__':
    main()
