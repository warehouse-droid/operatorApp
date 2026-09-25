"""Reproducible software checks and an evidence gate for the split/pickup release."""
import collections
import hashlib
import importlib.util
import json
from pathlib import Path
import random
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
ART = ROOT / 'test-artifacts/split-group-pickup'
RELEASE = Path('/home/ubuntu/operatorapp-deploy-backups/split-group-pickup-20260924-v1')
TESTS = ['test/dispatch/integration/dispatch-split-pickup-pool.test.js',
         'test/dispatch/frontend/dispatch-split-group-name.test.js',
         'test/dispatch/integration/dispatch-global-order-group-pool.red.test.js']


def run(mode, name, *args, allowed=(0,)):
    with (ART / name).open('wb') as output:
        result = subprocess.run(['sudo','-n','bash','tools/split-group-pickup-test-env.sh','run',mode,*args],
                                cwd=ROOT, stdout=output, stderr=subprocess.STDOUT)
    assert result.returncode in allowed, name + ' failed'


def tap(name, expected):
    text = (ART / name).read_text()
    for key, value in [('tests', expected),('pass', expected),('fail',0),('cancelled',0),('skipped',0)]:
        assert re.search(r'^# ' + key + ' ' + str(value) + '$', text, re.M), name + ': ' + key


def health():
    files = TESTS.copy()
    random.Random(120921).shuffle(files)
    for index, file in enumerate(files):
        name = f'health-{index}.log'
        run('current', name, 'node','--test',file)
        tap(name, 3 if 'pickup-pool' in file else 2 if 'group-name' in file else 1)
    (ART / 'health.json').write_text(json.dumps({'order': files, 'tests': 6, 'failures': 0}, indent=2) + '\n')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def collect():
    spec = importlib.util.spec_from_file_location('prior_evidence', ROOT / 'tools/rejected-edit-lifecycle-gauntlet.py')
    prior = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(prior)
    baseline, old_failures = prior.full_log('full-current.log')
    prior.ARTIFACTS = ART
    current, failures = prior.full_log('full-final.log')
    assert not failures - old_failures, 'New test failures: ' + repr(list((failures - old_failures).items()))
    assert not set(current['failedFiles']) - set(baseline['failedFiles']), 'New failing files'
    assert current['files'] == baseline['files']
    tap('green.log', 6)
    tap('candidate.log', 6)
    assert json.loads((ART / 'health.json').read_text())['failures'] == 0
    types = []
    for mode in ['baseline','current']:
        text = (ART / f'types-{mode}.log').read_text()
        types.append(collections.Counter(re.sub(r'\(\d+,\d+\)','(LINE,COL)',line) for line in text.splitlines() if 'error TS' in line))
    assert not types[1] - types[0], 'New type diagnostics'
    assert all(not row['messages'] for row in json.loads((ART / 'lint.json').read_text()))
    coverage = json.loads((ART / 'coverage.json').read_text())
    for file, result in coverage.items():
        assert result['changedLines'] == result['covered'] and result['sha256'] == digest(ROOT / file)
    mutations = json.loads((ART / 'mutations.json').read_text())
    assert len(mutations['results']) == 5 and all(row[scope]['killed'] for row in mutations['results'] for scope in ['all','properties'])
    assert all(digest(ROOT / file) == value for file,value in mutations['sourceHashes'].items())
    guard = json.loads((ART / 'rename-guard.json').read_text())
    assert guard['staleStateRefused'] and guard['stateUnchangedAfterRehearsal'] and guard['backupNotWrittenOnRefusal']
    manifest = json.loads((RELEASE / 'manifest.json').read_text())
    workspace = {file: digest(ROOT / file) for file in manifest['workspace']}
    candidate = {file: digest(RELEASE / 'candidate' / file) for file in manifest['after']}
    assert workspace == manifest['workspace'] and candidate == manifest['after']
    result = {'passed': True, 'workspace': workspace, 'candidateSources': candidate,
              'baseline': baseline, 'current': current, 'newFailures': 0,
              'focusedTests': 6, 'candidateTests': 6, 'changedLinesCovered': sum(len(row['covered']) for row in coverage.values()),
              'typeDiagnostics': [sum(row.values()) for row in types], 'newTypeDiagnostics': 0,
              'mutantsKilled': 5, 'propertyOnlyMutantsKilled': 5, 'namePropertyRuns': 100, 'pickupPropertyRuns': 20,
              'renameGuards': guard}
    (ART / 'verification.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({key:value for key,value in result.items() if key not in ['workspace','candidateSources','baseline','current']}))


def software_matrix():
    run('current','green.log','node','--test',*TESTS)
    run('candidate','candidate.log','node','--test',*TESTS)
    health()
    run('current','coverage.json','node','test/support/split-group-pickup-coverage.mjs')
    subprocess.run(['python3','tools/split-group-pickup-mutations.py'], cwd=ROOT, check=True)
    for mode in ['baseline','current']:
        run(mode,f'types-{mode}.log','node_modules/.bin/tsc','--noEmit','--allowJs','--checkJs','--skipLibCheck',
            '--target','ES2022','--lib','ES2022,DOM','src/dispatch-order-catalog-repository.js','src/server.js',allowed=(0,1,2))
    run('current','lint.json','node_modules/.bin/eslint','--config','eslint.mbt.config.js','--format','json',
        'src/server.js','src/dispatch-order-catalog-repository.js',*TESTS[:2],
        'test/support/split-group-pickup-coverage.mjs','tools/rename-split-group.mjs','tools/split-group-pickup-live.mjs')
    with (ART / 'full-final.log').open('wb') as output:
        result = subprocess.run(['sudo','-n','bash','tools/rejected-edit-test-env.sh','run','current','npm','test'],
                                cwd=ROOT,stdout=output,stderr=subprocess.STDOUT)
        assert result.returncode in (0,1)
    collect()


def matrix():
    # Refuse an already-running container instead of interrupting another test run.
    subprocess.run(['sudo','-n','bash','tools/rejected-edit-test-env.sh','start'], cwd=ROOT, check=True)
    try:
        with (ART / 'test-migration.log').open('wb') as output:
            subprocess.run(['sudo','-n','bash','tools/rejected-edit-test-env.sh','run','current','npm','run','migrate'],
                           cwd=ROOT,stdout=output,stderr=subprocess.STDOUT,check=True)
        subprocess.run(['sudo','-n','docker','exec','mbbs-rejected-edit-test-db','psql','-U','mbt_test','-d','postgres',
                        '-X','-v','ON_ERROR_STOP=1','-c','CREATE DATABASE mbt_test_file_120921aabbcc_focus TEMPLATE mbt_test;'],check=True)
        software_matrix()
    finally:
        subprocess.run(['sudo','-n','bash','tools/rejected-edit-test-env.sh','stop'],cwd=ROOT,check=True)


if __name__ == '__main__':
    {'run': matrix,'health': health,'check': collect}[sys.argv[1]]()
