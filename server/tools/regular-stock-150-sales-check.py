"""Reproduce the checks with disposable data and no external integration access."""
import difflib
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1]
OUT = SERVER / 'test-artifacts/regular-stock-150-sales'
FILES = json.loads((SERVER / 'tools/regular-stock-150-sales-files.json').read_text())
MODE = sys.argv[1] if len(sys.argv) > 1 else 'all'
OUT.mkdir(parents=True, exist_ok=True)
for check_file in SERVER.glob('tools/regular-stock-150-sales-*.py'):
    compile(check_file.read_text(), str(check_file), 'exec')
ENV = {
    'NODE_ENV': 'test', 'MBT_TEST_ISOLATED': '1', 'MBBS_ENV_FILE': '/nonexistent',
    'DATABASE_URL': 'postgres://mbt_test:mbt_test_password@mbbs-special-review-db:5432/mbt_test',
    'NETSUITE_DIRECT_ACCESS_ENABLED': 'false', 'NETSUITE_MIRROR_ROLE': 'disabled',
    'NETSUITE_ACCOUNT_ID': '', 'NETSUITE_CLIENT_ID': '', 'NETSUITE_CLIENT_SECRET': '',
    'NETSUITE_M2M_STORAGE_SECRET': '', 'NETSUITE_WEBHOOK_SECRET': 'isolated_delivery_access_test',
    'SMART_SCM_LIVE_EXECUTION_ENABLED': 'false', 'SAMSARA_WRITES_ENABLED': 'false',
    'SAMSARA_API_TOKEN': '', 'GOOGLE_MAPS_API_KEY': '', 'SALES_PUBLIC_ACCESS_ENABLED': 'false',
    'OLLAMA_BASE_URL': 'http://127.0.0.1:9', 'PHOTO_UPLOAD_PROVIDER': 'local_data_url',
    'MBT_ENABLED': 'true', 'MBT_NETSUITE_WRITES_ENABLED': 'false',
    'PLAYWRIGHT_BROWSERS_PATH': '/ms-playwright', 'XDG_CONFIG_HOME': '/tmp/xdg-config', 'XDG_CACHE_HOME': '/tmp/xdg-cache'
}
for feature in ['CUSTOMER_SYNC', 'MASTER_DATA', 'ASSET_MANAGEMENT', 'FRONTDESK_OPERATIONS',
                'BIN_DISPATCH', 'DRIVER_EXECUTION', 'BILLING_OPERATIONS']:
    ENV['MBT_' + feature + '_ENABLED'] = 'false'

def docker(*args):
    return subprocess.check_output(['sudo', '-n', 'docker', *args], text=True).strip()

if MODE == 'baseline' and not (OUT / 'baseline-source.json').exists():
    for file in FILES:
        source = SERVER / file
        if source.exists():
            target = OUT / 'before' / file
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
    (OUT / 'baseline-source.json').write_text(json.dumps({
        'files': {f: hashlib.sha256((SERVER / f).read_bytes()).hexdigest() for f in FILES if (SERVER / f).exists()},
        'packageSha256': hashlib.sha256((SERVER / 'package.json').read_bytes()).hexdigest()
    }, indent=2))
if MODE == 'all':
    for name in ['checks.json', 'browser.json', 'all-results.json']:
        (OUT / name).unlink(missing_ok=True)
    shutil.rmtree(OUT / 'coverage', ignore_errors=True)
    changed = {}
    for file in FILES:
        old = (OUT / 'before' / file).read_text().splitlines(True) if (OUT / 'before' / file).exists() else []
        new = (SERVER / file).read_text().splitlines(True)
        changed[file] = [i + 1 for tag, _, _, start, end in difflib.SequenceMatcher(None, old, new).get_opcodes()
                         if tag in ('insert', 'replace') for i in range(start, end)]
    (OUT / 'changed-source-lines.json').write_text(json.dumps(changed, indent=2))

network = 'mbbs-sales150-test-' + str(os.getpid())
db = network + '-db'
layers = []
try:
    docker('network', 'create', '--internal', network)
    docker('run', '-d', '--name', db, '--network', network, '--network-alias', 'mbbs-special-review-db',
           '--tmpfs', '/var/lib/postgresql', '-e', 'POSTGRES_DB=mbt_test', '-e', 'POSTGRES_USER=mbt_test',
           '-e', 'POSTGRES_PASSWORD=mbt_test_password', '-e', 'PGDATA=/var/lib/postgresql/data', 'postgres:18-alpine')
    for _attempt in range(60):
        if subprocess.run(['sudo', '-n', 'docker', 'exec', db, 'pg_isready', '-U', 'mbt_test'], capture_output=True).returncode == 0:
            break
        time.sleep(.5)
    else:
        raise RuntimeError('Isolated PostgreSQL did not start')
    args = ['sudo', '-n', 'docker', 'run', '--network', network, '--read-only',
            '--tmpfs', '/tmp:uid=1000,gid=1000,mode=1777', '--tmpfs', '/app/data:uid=1000,gid=1000,mode=0700']
    for key, value in ENV.items():
        args += ['-e', key + '=' + value]
    for folder in ['src', 'public', 'test', 'tools', 'migrations', 'package.json']:
        args += ['-v', str(SERVER / folder) + ':/app/' + folder + ':ro']
    if MODE in ['baseline', 'resolution-baseline', 'browser-red']:
        for file in FILES:
            saved = OUT / 'before' / file
            if saved.exists() and (MODE in ['baseline', 'resolution-baseline'] or file == 'public/sales-stock-requests.js'):
                args += ['-v', str(saved) + ':/app/' + file + ':ro']
    args += ['-v', str(OUT) + ':/app/test-artifacts']
    commands = [('migrations', ['node', 'src/migrate.js'])]
    if MODE == 'baseline':
        commands += [('regressions', ['node', 'tools/regular-stock-150-sales-tests.mjs', '--baseline'])]
    elif MODE in ['red', 'focus']:
        commands += [('focused', ['node', '--test', '--test-concurrency=1',
            'test/mbt/unit/regular-stock-150-sales.test.js', 'test/mbt/integration/regular-stock-150-sales.test.js'])]
    elif MODE in ['browser', 'browser-red']:
        commands += [('browser', ['node', 'tools/regular-stock-150-sales-browser.mjs'])]
    elif MODE in ['resolution-health', 'resolution-baseline']:
        commands += [('browser', ['node', '--test', 'test/mbt/integration/regular-stock-resolution-browser.test.js'])]
    elif MODE == 'constraints':
        commands += [('constraints', ['node', 'tools/regular-stock-150-sales-constraints.mjs'])]
    elif MODE == 'all':
        commands += [('regressions', ['node', 'node_modules/c8/bin/c8.js', '--all=false', '--check-coverage=false',
            *['--include=' + f for f in FILES if f.endswith('.js')], '--reporter=json', '--reporter=text-summary',
            '--reports-dir=test-artifacts/coverage', '--temp-directory=/tmp/sales150-coverage',
            'node', 'tools/regular-stock-150-sales-tests.mjs']),
            ('browser', ['node', 'tools/regular-stock-150-sales-browser.mjs']),
            ('constraints', ['node', 'tools/regular-stock-150-sales-constraints.mjs'])]
    else:
        raise ValueError('Unknown mode: ' + MODE)
    for name, command in commands:
        started = time.monotonic()
        log_path = OUT / (MODE + '-' + name + '.log')
        with log_path.open('wb') as log:
            container = network + '-' + name
            result = subprocess.run(args + ['--name', container, 'mbbs-regular-v2:e2e' if name in ['browser', 'regressions'] else 'mbbs-regular-v2:test'] + command,
                cwd=SERVER, stdout=log, stderr=subprocess.STDOUT)
        state = json.loads(docker('inspect', '--format', '{{json .State}}', container))
        docker('rm', container)
        record = {'layer': name, 'exitCode': result.returncode, 'seconds': round(time.monotonic() - started, 2),
                  'oomKilled': state['OOMKilled'], 'error': state['Error']}
        layers.append(record)
        (OUT / (MODE + '-results.json')).write_text(json.dumps(layers, indent=2))
        print(json.dumps(record), flush=True)
        if result.returncode:
            print(log_path.read_text()[-10000:], flush=True)
            sys.exit(result.returncode)
finally:
    subprocess.run(['sudo', '-n', 'docker', 'rm', '-f', db], capture_output=True)
    subprocess.run(['sudo', '-n', 'docker', 'network', 'rm', network], capture_output=True)
