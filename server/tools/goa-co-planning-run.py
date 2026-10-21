"""Reproduce GOA CO checks with existing pinned Docker images; no live DB access.

Run: sudo -n python3 tools/goa-co-planning-run.py [--focused]
Evidence is written under test-artifacts/goa-co-planning-20261001.
"""
import difflib
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

SERVER = Path(__file__).resolve().parents[1]
OUT = SERVER / 'test-artifacts/goa-co-planning-20261001'
FILES = ['src/sor-rental-policy.js', 'src/yard-dependency-structure.js', 'public/dispatch.js', 'public/dispatch.html']


def run(name, args, baseline=None, allowed=(0,)):
    command = ['sudo', '-n', 'env']
    if baseline:
        command.append('GOA_CO_BASELINE=' + str(baseline))
    command.extend(['bash', 'tools/goa-co-planning-test.sh', *args])
    with (OUT / name).open('wb') as log:
        result = subprocess.run(command, cwd=SERVER, stdout=log, stderr=subprocess.STDOUT)
    assert result.returncode in allowed, name + ': inspect the verification log'


def main():
    assert sys.argv[1:] in ([], ['--focused'])
    OUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='goa-co-baseline-') as folder:
        baseline = Path(folder)
        for name in ['src', 'public']:
            shutil.copytree(SERVER / name, baseline / name)
        subprocess.run(['patch', '--batch', '--fuzz=0', '-p1', '-d', str(baseline), '-i',
                        str(SERVER / 'test/support/goa-co-planning-baseline.patch')], check=True)
        differences = {}
        for name in FILES:
            old, new = baseline / name, SERVER / name
            target = OUT / 'candidate-before' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(old, target)
            differences[name] = {'sourceHash': hashlib.sha256(new.read_bytes()).hexdigest(),
                                 'diff': ''.join(difflib.unified_diff(old.read_text().splitlines(True),
                                      new.read_text().splitlines(True), fromfile='a/' + name, tofile='b/' + name, n=0))}
        (OUT / 'candidate-diffs.json').write_text(json.dumps(differences, indent=2))
        checker = (SERVER / 'tools/goa-co-planning-check.mjs').read_text()
        declaration = re.search(r'const regressions = \[(.*?)\];', checker, re.S)
        assert declaration
        regressions = re.findall(r"'([^']+\.test\.js)'", declaration[1])
        assert len(regressions) == 13
        run('red.log', ['node', '--test', '--test-concurrency=1', 'test/dispatch/unit/goa-co-planning.test.js',
                        'test/dispatch/integration/goa-co-planning.test.js'], baseline, allowed=(1,))
        assert 'ERR_ASSERTION' in (OUT / 'red.log').read_text(), 'RED must fail a behavior assertion'
        run('regressions-baseline.log', ['node', '--test', '--test-concurrency=1', *regressions], baseline, allowed=(0, 1))
        run('driver-order-baseline.log', ['node', 'src/dispatch-driver-order-harness.js'], baseline, allowed=(1,))
        run('types-baseline.log', ['npm', 'run', 'typecheck:mbt'], baseline, allowed=(0, 1, 2))
        run('types-final.log', ['npm', 'run', 'typecheck:mbt'], allowed=(0, 1, 2))
        def diagnostics(name):
            return Counter(re.sub(r'\(\d+,\d+\)', '(LINE,COLUMN)', line)
                           for line in (OUT / name).read_text().splitlines() if ': error TS' in line)
        assert not diagnostics('types-final.log') - diagnostics('types-baseline.log'), 'Added type diagnostics'
        run('gauntlet.log', ['node', 'tools/goa-co-planning-check.mjs'])
        if '--focused' not in sys.argv:
            suite = ['node', '--experimental-loader=./test/support/goa-co-suite-timeout-loader.mjs',
                     'test/support/run-node-tests.mjs', 'infrastructure', 'unit', 'contracts',
                     'property', 'integration', 'adversarial', 'concurrency']
            run('full-baseline.log', suite, baseline, allowed=(0, 1))
            run('full-final.log', suite, allowed=(0, 1))
            subprocess.run([sys.executable, 'tools/goa-co-planning-evidence.py'], cwd=SERVER, check=True)


if __name__ == '__main__':
    main()
