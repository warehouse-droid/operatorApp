"""Reproduce verification in a clean disposable database, preserving review data."""
import importlib.util
import json
from pathlib import Path
import subprocess

SERVER = Path(__file__).resolve().parents[1]
ART = SERVER / 'test-artifacts/dispatch-contention'
spec = importlib.util.spec_from_file_location('indexes', Path(__file__).with_name('dispatch-contention-indexes.py'))
indexes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(indexes)
DB = 'dispatch_contention_verify'
PREFIX = ['sudo', '-n', 'docker']
RUNNER = 'mbbs-special-review-runner'
ENV = ['-e', 'MBT_TEST_ISOLATED=1', '-e', 'PLAYWRIGHT_BROWSERS_PATH=/browsers', '-e',
    f'DATABASE_URL=postgres://mbt_test:special_review_only@mbbs-special-review-db:5432/{DB}']


def command(*args, **options):
    return subprocess.run([*PREFIX, *args], check=True, capture_output=True, **options)


def mutate_indexes():
    run = lambda sql: indexes.execute('mbbs-special-review-db', 'mbt_test', DB, sql)
    results = []
    for name in ['idx_sales_orders_dispatch_ref_lower', 'idx_purchase_orders_dispatch_tranid_lower',
                 'idx_purchase_orders_dispatch_id_text']:
        try:
            run('DROP INDEX ' + name)
            result = subprocess.run([*PREFIX, 'exec', *ENV, '-w', '/app', RUNNER, 'node', '--test',
                'test/dispatch/integration/dispatch-identity-indexes.test.js'], capture_output=True, text=True)
            (ART / ('index-mutation-' + name + '.txt')).write_text(result.stdout + result.stderr)
            assert result.returncode != 0 and name + ' is missing' in result.stdout
            results.append(dict(index=name, killed=True))
        finally:
            run(indexes.SQL)
    (ART / 'index-mutations.json').write_text(json.dumps(results, indent=2))


def main():
    ART.mkdir(parents=True, exist_ok=True)
    schema = command('exec', 'mbbs-special-review-db', 'pg_dump', '-U', 'mbt_test', '-d', 'mbt_verify',
        '--schema-only', '--no-owner', '--no-privileges').stdout
    # Only this tool's disposable database is replaced, never the review or live databases.
    indexes.execute('mbbs-special-review-db', 'mbt_test', 'postgres', f'DROP DATABASE IF EXISTS {DB} WITH (FORCE);')
    indexes.execute('mbbs-special-review-db', 'mbt_test', 'postgres', f'CREATE DATABASE {DB};')
    command('exec', '-i', 'mbbs-special-review-db', 'psql', '-U', 'mbt_test', '-d', DB,
        '-v', 'ON_ERROR_STOP=1', input=schema)
    indexes.execute('mbbs-special-review-db', 'mbt_test', DB, indexes.SQL)
    command('cp', str(ART / 'baseline') + '/.', f'{RUNNER}:/app/test-artifacts/dispatch-contention/baseline')
    command('cp', str(ART / 'preexisting-po-test.txt'), f'{RUNNER}:/app/test-artifacts/dispatch-contention/preexisting-po-test.txt')
    mutate_indexes()
    result = subprocess.run([*PREFIX, 'exec', *ENV, '-w', '/app', RUNNER, 'node', 'tools/dispatch-contention-check.mjs'],
        text=True, capture_output=True)
    command('cp', f'{RUNNER}:/app/test-artifacts/dispatch-contention/.', str(ART))
    print(result.stdout + result.stderr)
    assert result.returncode == 0


if __name__ == '__main__':
    main()
