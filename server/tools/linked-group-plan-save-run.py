"""Reproduce the saved-group fix with pinned, disposable Docker services.

Run sudo -n python3 tools/linked-group-plan-save-run.py. --focused omits the
full MBT comparison; --full-baseline/--full-final run that comparison's halves.
"""
from collections import Counter
import difflib
import hashlib
import json
from pathlib import Path
import random
import re
import shutil
import subprocess
import sys
import tempfile

SERVER = Path(__file__).resolve().parents[1]
OUT = SERVER / 'test-artifacts/linked-group-plan-save-20261001'
OWN = ['test/mbt/integration/linked-group-plan-save.test.js',
       'test/mbt/property/linked-group-plan-save.property.test.js']
REGRESSIONS = ['test/mbt/unit/link-to-group.test.js', 'test/mbt/integration/link-to-group.test.js',
               'test/mbt/integration/link-to-group-http.test.js',
               'test/dispatch/unit/goa-co-planning.test.js', 'test/dispatch/integration/goa-co-planning.test.js',
               'test/dispatch/integration/co-direct-to.test.js', 'test/dispatch/integration/co-supply-reference.test.js',
               'test/dispatch/integration/dispatch-retired-confirm.test.js']


def run(name, args, baseline=None, allowed=(0,)):
    command = ['sudo', '-n', 'env']
    if baseline:
        command.append('LINKED_GROUP_BASELINE=' + str(baseline))
    command.extend(['bash', 'tools/linked-group-plan-save-test.sh', *args])
    with (OUT / name).open('wb') as log:
        result = subprocess.run(command, cwd=SERVER, stdout=log, stderr=subprocess.STDOUT)
    assert result.returncode in allowed, name + ': inspect verification log'


def diagnostics(name):
    return Counter(re.sub(r'\(\d+,\d+\)', '(LINE,COLUMN)', line)
                   for line in (OUT / name).read_text().splitlines() if ': error TS' in line)


def suite_health():
    files = [*OWN, *REGRESSIONS]
    random.Random(96119612).shuffle(files)
    command = ['node', 'tools/linked-group-plan-save-order.mjs', *files]
    (OUT / 'random-order.json').write_text(json.dumps({'seed': 96119612, 'command': command}, indent=2) + '\n')
    run('focused-random.log', command)


def main():
    assert sys.argv[1:] in ([], ['--focused'], ['--full-baseline'], ['--full-final'], ['--suite-health'])
    mode = sys.argv[1] if len(sys.argv) > 1 else 'all'
    OUT.mkdir(parents=True, exist_ok=True)
    if mode == '--suite-health':
        suite_health()
        return
    with tempfile.TemporaryDirectory(prefix='linked-group-baseline-') as directory:
        baseline = Path(directory)
        for folder in ['src', 'public']:
            shutil.copytree(SERVER / folder, baseline / folder)
        subprocess.run(['patch', '--batch', '--fuzz=0', '-p1', '-d', str(baseline), '-i',
                        str(SERVER / 'test/support/linked-group-plan-save-baseline.patch')], check=True)
        suite = ['node', '--experimental-loader=./test/support/goa-co-suite-timeout-loader.mjs',
                 'tools/linked-group-plan-save-full.mjs']
        if mode in ('--full-baseline', '--full-final'):
            run('full-baseline.log' if mode == '--full-baseline' else 'full-final.log',
                suite + ['baseline' if mode == '--full-baseline' else 'final'],
                baseline if mode == '--full-baseline' else None, allowed=(0, 1))
            return
        old = baseline / 'src/server.js'
        new = SERVER / 'src/server.js'
        shutil.copy2(old, OUT / 'before/src/server.js')
        comparison = {'src/server.js': {'sourceHash': hashlib.sha256(new.read_bytes()).hexdigest(),
            'diff': ''.join(difflib.unified_diff(old.read_text().splitlines(True), new.read_text().splitlines(True),
                                               fromfile='a/src/server.js', tofile='b/src/server.js', n=0))}}
        (OUT / 'candidate-diffs.json').write_text(json.dumps(comparison, indent=2) + '\n')
        run('red-final.log', ['node', '--test', '--test-concurrency=1', *OWN], baseline, allowed=(1,))
        assert '202 !== 200' in (OUT / 'red-final.log').read_text()
        assert 'Property failed' in (OUT / 'red-final.log').read_text()
        run('regressions-baseline.log', ['node', 'tools/linked-group-plan-save-order.mjs', *REGRESSIONS], baseline, allowed=(0, 1))
        for name, source in [('types-baseline.log', baseline), ('types-final.log', None)]:
            run(name, ['npm', 'run', 'typecheck:mbt'], source, allowed=(0, 1, 2))
        assert not diagnostics('types-final.log') - diagnostics('types-baseline.log'), 'New type diagnostics'
        run('gauntlet.log', ['node', 'tools/linked-group-plan-save-check.mjs'])
        suite_health()
        if mode == 'all':
            run('full-baseline.log', suite + ['baseline'], baseline, allowed=(0, 1))
            run('full-final.log', suite + ['final'], allowed=(0, 1))
            subprocess.run([sys.executable, 'tools/linked-group-plan-save-evidence.py'], cwd=SERVER, check=True)


if __name__ == '__main__':
    main()
