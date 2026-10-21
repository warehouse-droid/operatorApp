"""Install only the measured Dispatch lookup indexes; never edit order data."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
MIGRATION = SERVER / 'migrations/234_dispatch_identity_lookup_indexes.sql'
SQL = MIGRATION.read_text()
STATEMENTS = [s.strip() for s in re.sub(r'--[^\n]*', '', SQL).split(';') if s.strip()]
EXPECTED = {
    'idx_sales_orders_dispatch_ref_lower': ('sales_orders', 'lower(btrim(tranid))'),
    'idx_sales_orders_dispatch_id_text': ('sales_orders', '(netsuite_id)::text'),
    'idx_purchase_orders_dispatch_tranid_lower': ('purchase_orders', 'lower(btrim(tranid))'),
    'idx_purchase_orders_dispatch_ref_lower': ('purchase_orders', 'lower(btrim(dispatch_ref))'),
    'idx_purchase_orders_dispatch_id_text': ('purchase_orders', '(netsuite_id)::text'),
}
assert len(STATEMENTS) == len(EXPECTED)
for statement, name in zip(STATEMENTS, EXPECTED):
    assert statement.startswith('CREATE INDEX IF NOT EXISTS ' + name + '\n')


def execute(container, user, database, sql):
    result = subprocess.run(['sudo', '-n', 'docker', 'exec', '-i', container, 'psql',
        '-U', user, '-d', database, '-XAt', '-v', 'ON_ERROR_STOP=1'], input=sql,
        text=True, capture_output=True, check=True)
    return result.stdout.strip()


def verify(run):
    names = ','.join("'" + name + "'" for name in EXPECTED)
    rows = run(f"""SELECT json_build_object('name',idx.relname,'table',t.relname,
      'valid',i.indisvalid,'ready',i.indisready,'unique',i.indisunique,
      'expression',pg_get_expr(i.indexprs,i.indrelid),'method',am.amname)
      FROM pg_index i JOIN pg_class idx ON idx.oid=i.indexrelid
      JOIN pg_class t ON t.oid=i.indrelid JOIN pg_am am ON am.oid=idx.relam
      WHERE idx.relname IN ({names}) AND idx.relnamespace='public'::regnamespace""")
    actual = {row['name']: row for row in map(json.loads, rows.splitlines())}
    for name, (table, expression) in EXPECTED.items():
        assert actual.get(name) == dict(name=name, table=table, valid=True, ready=True,
            unique=False, expression=expression, method='btree'), (name, actual.get(name))
    return actual


def main(mode):
    assert mode in ('rehearse', 'apply', 'verify')
    live = mode != 'rehearse'
    container, user, database = ('mbbs-operator-app-db-1', 'mbbs_app', 'mbbs_yard') if live else (
        'mbbs-special-review-db', 'mbt_test', 'mbt_verify')
    run = lambda sql: execute(container, user, database, sql)
    if mode == 'rehearse':
        # Only this task's additive indexes are removed, and only in the isolated database.
        drops = ''.join('DROP INDEX IF EXISTS ' + name + ';' for name in EXPECTED)
        run(drops)
        run('BEGIN;' + SQL + 'ROLLBACK;')
        for name in EXPECTED:
            assert run("SELECT to_regclass('" + name + "') IS NULL") == 't'
        run(SQL)
        run(SQL)
    elif mode == 'apply':
        for statement in STATEMENTS:
            # A normal migration transaction is suitable for fresh installations.
            # Existing live tables must remain writable throughout index builds.
            run("SET lock_timeout='2s'; SET statement_timeout='30s';" +
                statement.replace('CREATE INDEX IF NOT EXISTS', 'CREATE INDEX CONCURRENTLY IF NOT EXISTS') + ';')
        verify(run)
        run("SET lock_timeout='2s'; SET statement_timeout='30s'; ANALYZE sales_orders; ANALYZE purchase_orders;")
        run("INSERT INTO schema_migrations(filename) VALUES ('" + MIGRATION.name + "') ON CONFLICT DO NOTHING;")
    result = dict(mode=mode, indexes=verify(run), migrationSha256=hashlib.sha256(SQL.encode()).hexdigest(),
        businessWrites=0, applicationRestart=False)
    output = SERVER / 'test-artifacts/dispatch-contention'
    output.mkdir(parents=True, exist_ok=True)
    (output / (mode + '.json')).write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(dict(mode=mode, validIndexes=len(result['indexes']), businessWrites=0)))


if __name__ == '__main__':
    main(sys.argv[1])
