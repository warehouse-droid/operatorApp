"""Reproduce the Sales map checks using the installed isolated test environment."""
import json
from pathlib import Path
import re
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
ARTIFACTS = SERVER / 'test-artifacts/sales-monitor-map'
ENV = SERVER / 'tools/aggregate-test-env.sh'


def execute(log, *command, name='mbbs-aggregate-requests'):
    with (ARTIFACTS / log).open('wb') as output:
        result = subprocess.run(['sudo', '-n', 'env', 'AGGREGATE_TEST_NAME=' + name, 'bash', str(ENV), 'exec', *command],
                                stdout=output, stderr=subprocess.STDOUT)
    print(json.dumps({'check': log, 'exit': result.returncode}), flush=True)
    return result.returncode


def start(name):
    for action in ['stop', 'start', 'runner']:
        subprocess.run(['sudo', '-n', 'env', 'AGGREGATE_TEST_NAME=' + name, 'bash', str(ENV), action], check=True, stdout=subprocess.DEVNULL)


def export():
    with (ARTIFACTS / 'isolated-artifacts.tar').open('wb') as output:
        subprocess.run(['sudo', '-n', 'docker', 'exec', 'mbbs-aggregate-requests-runner', 'tar', '-C', '/app/test-artifacts', '-cf', '-', '.'], stdout=output, check=True)
    subprocess.run(['tar', '--no-same-owner', '--no-same-permissions', '--no-overwrite-dir', '-xf', str(ARTIFACTS / 'isolated-artifacts.tar'), '-C', str(ARTIFACTS)], check=True)


if __name__ == '__main__':
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    if '--full-only' not in sys.argv:
        start('mbbs-aggregate-requests')
        commands = {
            'migration.log': ['node', 'src/migrate.js'],
            'static.log': ['node', 'tools/sales-monitor-map-checks.mjs', 'static'],
            'tests.log': ['node', 'node_modules/c8/bin/c8.js', '--include=src/server.js', '--check-coverage=false', '--temp-directory=/tmp/sales-monitor-map-coverage',
                          '--report-dir=test-artifacts/sales-monitor-map-coverage', '--reporter=json', 'node', '--test', 'test/mbt/integration/sales-monitor-map.test.js'],
            'coverage.log': ['node', 'tools/sales-monitor-map-checks.mjs', 'coverage'],
            'neighbors.log': ['npm', 'run', 'test:google-maps-usage'],
            'suite-health.log': ['node', 'tools/sales-monitor-map-checks.mjs', 'shuffle'],
            'mutations.log': ['node', 'tools/sales-monitor-map-checks.mjs', 'mutations'],
            'versions.log': ['node', '--input-type=module', '-e', "import fs from 'node:fs'; console.log(JSON.stringify({node:process.version,...Object.fromEntries(['@playwright/test','fast-check','c8','eslint','typescript'].map(p=>[p,JSON.parse(fs.readFileSync('node_modules/'+p+'/package.json')).version]))}))"]
        }
        for log, command in commands.items():
            code = execute(log, *command)
            if log == 'neighbors.log':
                baseline = json.loads((SERVER / 'test/sales-monitor-map-neighbor-baseline.json').read_text())
                failures = re.findall(r'^not ok \d+ - (.+)$', (ARTIFACTS / log).read_text(), re.M)
                assert code == 1 and failures == baseline['knownFailures'], failures
            elif code:
                export()
                raise SystemExit('Check failed: ' + log)
        export()
    if '--focused' not in sys.argv:
        start('mbbs-aggregate-regression')
        if execute('full-migration.log', 'node', 'src/migrate.js', name='mbbs-aggregate-regression'):
            raise SystemExit('Full regression database migration failed')
        execute('full.log', 'npm', 'test', name='mbbs-aggregate-regression')
        subprocess.run(['python3', str(SERVER / 'tools/aggregate-regression.py'), 'compare',
                        str(SERVER / 'test/aggregate-access-existing-baseline.json'), str(ARTIFACTS / 'full.log'), str(ARTIFACTS / 'full-regression.json')], check=True)
    print('Sales monitor map checks complete.', flush=True)
