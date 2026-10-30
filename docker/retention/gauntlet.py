"""Reproduce retention checks and deliberate mutation failures in disposable /tmp."""
import ast
import hashlib
import importlib
import json
from pathlib import Path
import random
import shutil
import subprocess
import sys
import tempfile
import trace
import unittest


def main():
    source = Path(__file__).resolve().parent
    with tempfile.TemporaryDirectory(prefix='retention-gauntlet-') as directory:
        work = Path(directory)
        for path in source.glob('*.py'):
            ast.parse(path.read_text(), filename=path.name)
            shutil.copy2(path, work / path.name)
        original = (work / 'retention.py').read_text()
        mutants = {
            'retain_four_instead_of_five': ('[:count]]', '[:max(0, count - 1)]]'),
            'ignore_protected_files': ('str(path) in protected or info.st_dev', 'False or info.st_dev'),
            'allow_symlink_roots': ('if path.resolve(strict=True) != path or path.is_symlink():', 'if False:'),
            'ignore_changed_tree': ("if signature != action['fingerprint']:", 'if False:'),
            'leave_test_artifacts': ('shutil.rmtree(artifact.name, dir_fd=descriptor)', 'pass'),
        }
        outcomes = {}
        for name, (before, after) in mutants.items():
            if original.count(before) != 1:
                raise RuntimeError(f'Ambiguous mutation: {name}')
            (work / 'retention.py').write_text(original.replace(before, after))
            result = subprocess.run([sys.executable, '-B', '-m', 'unittest', 'test_retention'],
                                    cwd=work, capture_output=True, text=True, timeout=30)
            outcomes[name] = result.returncode != 0
            if not outcomes[name]:
                raise RuntimeError(f'Mutation survived: {name}')
        (work / 'retention.py').write_text(original)
        # The ordering mutant must also be killed by the property test alone.
        before, after = mutants['retain_four_instead_of_five']
        (work / 'retention.py').write_text(original.replace(before, after))
        property_result = subprocess.run([sys.executable, '-B', '-m', 'unittest',
            'test_retention.RetentionTests.test_latest_five_properties'], cwd=work,
            capture_output=True, timeout=30)
        if property_result.returncode == 0:
            raise RuntimeError('Retention property failed to detect under-retention')
        (work / 'retention.py').write_text(original)
        sys.path.insert(0, str(work))
        tracer = trace.Trace(count=True, trace=False)

        def fresh_suite():
            module = importlib.import_module('test_retention')
            tests = list(unittest.defaultTestLoader.loadTestsFromTestCase(module.RetentionTests))
            random.Random(20261021).shuffle(tests)
            suite = unittest.TestSuite(tests)
            return unittest.TextTestRunner(verbosity=2).run(suite)

        result = tracer.runfunc(fresh_suite)
        counts = tracer.results().counts
        coverage = {}
        for name in ('retention.py', 'host_retention.py'):
            path = work / name
            executable = set(trace._find_executable_linenos(str(path)))
            hit = {line for (filename, line), count in counts.items() if filename == str(path) and count}
            coverage[name] = {'executed': len(executable & hit), 'executable': len(executable),
                              'uncovered': sorted(executable - hit)}
        print(json.dumps({'tests': result.testsRun, 'successful': result.wasSuccessful(),
                          'mutantsKilled': sum(outcomes.values()), 'mutants': outcomes,
                          'orderingPropertyKilledMutant': True, 'coverage': coverage,
                          'suiteOrderSeed': 20261021,
                          'sourceHashes': {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                                           for p in source.glob('*.py') if p.name != 'gauntlet.py'},
                          'python': sys.version.split()[0]}), flush=True)
        if not result.wasSuccessful():
            raise SystemExit(1)


if __name__ == '__main__':
    main()
