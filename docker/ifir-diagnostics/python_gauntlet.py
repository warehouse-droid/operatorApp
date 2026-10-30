"""Stdlib-only collector contracts, mutation checks, and executable line evidence."""
import ast
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import trace
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def run_tests(directory, pattern=None):
    command = [sys.executable, '-B', '-m', 'unittest', '-v']
    command.append('test_timings.TimingTests.test_interval_property_order_duplicates_and_bounds'
                   if pattern else 'test_timings')
    return subprocess.run(command, cwd=directory, capture_output=True, text=True, timeout=30)


def main():
    source = (ROOT / 'timings.py').read_text()
    ast.parse(source)
    suite = unittest.defaultTestLoader.discover(str(ROOT), pattern='test_timings.py')
    tracer = trace.Trace(count=True, trace=False, ignoredirs=[sys.prefix, sys.exec_prefix])
    result = tracer.runfunc(unittest.TextTestRunner(verbosity=2).run, suite)
    if not result.wasSuccessful():
        raise SystemExit(1)
    report = {'python': sys.version.split()[0], 'tests': result.testsRun,
              'sourceSha256': hashlib.sha256(source.encode()).hexdigest(), 'mutations': []}
    counts = tracer.results().counts
    report['executedLinesInProcess'] = len({line for (file, line), hits in counts.items()
                                           if Path(file).resolve() == ROOT / 'timings.py' and hits})
    repeat = run_tests(ROOT)
    assert repeat.returncode == 0, repeat.stderr
    mutants = [
        ('interval-double-count', 'total += max(0, stop - max(start, end))', 'total += stop - start'),
        ('secrets-retained', "result = {key: data[key] for key in ('event', 'commandId', 'at', 'operation', 'durationMs')}",
         'result = dict(data)'),
        ('replay-duplicates', "f'{container}\\n{stamp}\\n{encoded}'", "f'{container}\\n{stamp}\\n{encoded}\\n{time.monotonic()}'"),
        ('unbounded-log-buffer', 'if len(buffer) > MAX_LINE:', 'if False:')
    ]
    with tempfile.TemporaryDirectory() as directory:
        temporary = Path(directory)
        (temporary / 'test_timings.py').write_bytes((ROOT / 'test_timings.py').read_bytes())
        for name, before, after in mutants:
            assert source.count(before) == 1, name
            (temporary / 'timings.py').write_text(source.replace(before, after))
            result = run_tests(temporary)
            assert result.returncode == 1 and ('FAIL' in result.stderr or 'ERROR' in result.stderr), name
            prop = run_tests(temporary, pattern=True)
            report['mutations'].append({'name': name, 'killed': True, 'propertyOnlyKilled': prop.returncode == 1})
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
