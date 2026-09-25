"""Reproduce receiving split balance verification using isolated existing tools."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
ARTIFACTS = SERVER / 'test-artifacts/receiving-split-balance'
ENV = SERVER / 'tools/aggregate-test-env.sh'
RUNTIME = ['src/receiving-po-split-progress.js', 'src/receiving-repository.js',
           'public/operator.js', 'public/operator.html', 'public/service-worker.js']


def execute(log, *command, name='mbbs-aggregate-requests'):
    with (ARTIFACTS / log).open('wb') as output:
        result = subprocess.run(['sudo', '-n', 'env', 'AGGREGATE_TEST_NAME=' + name, 'bash', str(ENV), 'exec', *command], stdout=output, stderr=subprocess.STDOUT)
    print(json.dumps({'check': log, 'exit': result.returncode}), flush=True)
    return result.returncode


def start(name):
    for action in ['stop', 'start', 'runner']:
        subprocess.run(['sudo', '-n', 'env', 'AGGREGATE_TEST_NAME=' + name, 'bash', str(ENV), action], check=True, stdout=subprocess.DEVNULL)


def export():
    with (ARTIFACTS / 'isolated-artifacts.tar').open('wb') as output:
        subprocess.run(['sudo', '-n', 'docker', 'exec', 'mbbs-aggregate-requests-runner', 'tar', '-C', '/app/test-artifacts/receiving-split-balance', '-cf', '-', '.'], stdout=output, check=True)
    subprocess.run(['tar', '--no-same-owner', '--no-same-permissions', '--no-overwrite-dir', '-xf', str(ARTIFACTS / 'isolated-artifacts.tar'), '-C', str(ARTIFACTS)], check=True)


if __name__ == '__main__':
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    initial = {name: hashlib.sha256((SERVER / name).read_bytes()).hexdigest() for name in RUNTIME}
    if '--full-only' not in sys.argv and '--compare-only' not in sys.argv:
        start('mbbs-aggregate-requests')
        commands = {
            'migration.log': ['node', 'src/migrate.js'],
            'static.log': ['node', 'tools/receiving-split-balance-checks.mjs', 'static'],
            'tests.log': ['node', 'node_modules/c8/bin/c8.js', '--check-coverage=false', '--temp-directory=/tmp/receiving-split-coverage',
                          '--report-dir=test-artifacts/receiving-split-balance/coverage', '--reporter=json',
                          '--include=src/receiving-repository.js', '--include=src/receiving-po-split-progress.js', '--include=public/operator.js',
                          'node', 'tools/receiving-split-balance-checks.mjs', 'suite'],
            'coverage.log': ['node', 'tools/receiving-split-balance-checks.mjs', 'coverage'],
            'browser.log': ['node', 'tools/receiving-split-balance-browser.mjs'],
            'suite-health.log': ['node', 'tools/receiving-split-balance-checks.mjs', 'shuffle'],
            'mutations.log': ['node', 'tools/receiving-split-balance-checks.mjs', 'mutations'],
            'versions.log': ['node', '--input-type=module', '-e', "import fs from 'node:fs'; console.log(JSON.stringify({node:process.version,...Object.fromEntries(['@playwright/test','fast-check','c8','eslint','typescript'].map(p=>[p,JSON.parse(fs.readFileSync('node_modules/'+p+'/package.json')).version]))}))"]
        }
        for log, command in commands.items():
            if execute(log, *command):
                export()
                raise SystemExit('Check failed: ' + log)
        export()
        (ARTIFACTS / 'focused-source.json').write_text(json.dumps(initial, indent=2) + '\n')
    if '--focused' not in sys.argv:
        if '--compare-only' in sys.argv:
            assert initial == json.loads((ARTIFACTS / 'focused-source.json').read_text())
            assert all((SERVER / name).stat().st_mtime < (ARTIFACTS / 'full-migration.log').stat().st_mtime for name in RUNTIME), 'Source modified after the full run started'
        else:
            start('mbbs-aggregate-regression')
            if execute('full-migration.log', 'node', 'src/migrate.js', name='mbbs-aggregate-regression'):
                raise SystemExit('Full database migration failed')
            execute('full.log', 'npm', 'test', name='mbbs-aggregate-regression')
        subprocess.run(['python3', str(SERVER / 'tools/aggregate-regression.py'), 'compare', str(SERVER / 'test/receiving-split-balance-existing-baseline.json'),
                        str(ARTIFACTS / 'full.log'), str(ARTIFACTS / 'full-regression.json')], check=True)
        (ARTIFACTS / 'full-source.json').write_text(json.dumps(initial, indent=2) + '\n')
    assert initial == {name: hashlib.sha256((SERVER / name).read_bytes()).hexdigest() for name in RUNTIME}, 'Runtime sources changed during verification'
    print('Receiving split balance checks complete.', flush=True)
