"""Apply only the verified method-change migration and guarded SOA10368 repair."""
import datetime
import hashlib
import json
from pathlib import Path
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
MIGRATION = '306_delivery_pickup_packing_release.sql'
FILES = {
    'migrations/' + MIGRATION: 'a7389af2f2b9049619904fb6ca4f8862b6733ba4187f368597e5ccc018e05145',
    'tools/soa10368-pickup-repair.sql': 'a211c0d06a1baa2331317f243306157606713a2827d75757dfc7f8be3b7446ab',
}


def main():
    sources = {}
    for name, expected in FILES.items():
        value = (SERVER / name).read_bytes()
        assert hashlib.sha256(value).hexdigest() == expected, 'Source changed since validation: ' + name
        sources[name] = value.decode()
    mode = sys.argv[1] if len(sys.argv) == 2 else ''
    if mode not in ('--apply', '--repair-only', '--install-rule'):
        print(json.dumps({'migration': MIGRATION, 'repairOrder': 'SOA10368', 'hashes': FILES, 'apply': False}))
        return
    subprocess.run(['curl', '-fsS', '-o', '/dev/null', 'http://127.0.0.1:3000/health'], check=True)
    record_dir = SERVER / 'deployments/delivery-pickup-release-20261022'
    record_dir.mkdir(exist_ok=True)
    record_name = {'--apply': 'applied.json', '--repair-only': 'repaired.json', '--install-rule': 'rule-installed.json'}[mode]
    assert not (record_dir / record_name).exists(), 'Already applied; inspect the audit before repeating.'
    sql = "BEGIN; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='15s';\n"
    if mode != '--repair-only':
        sql += "DO $$ BEGIN IF to_regprocedure('release_delivery_packing_on_pickup()') IS NOT NULL THEN RAISE EXCEPTION 'Release function already exists'; END IF; END $$;\n"
        sql += sources['migrations/' + MIGRATION]
        sql += "\nINSERT INTO schema_migrations(filename) VALUES ('" + MIGRATION + "');\n"
    if mode != '--install-rule':
        sql += sources['tools/soa10368-pickup-repair.sql']
    sql += "\nCOMMIT;\n"
    sql += """SELECT json_build_object('order',s.tranid,'method',s.sales_order_type,'status',s.operator_status,
      'packingWarnings',(SELECT count(*) FROM sales_order_lines WHERE sales_order_id=s.netsuite_id AND sync_exception IS NOT NULL),
      'automaticReleaseActive',EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='sales_orders'::regclass AND tgname='release_delivery_packing_on_pickup' AND tgenabled='O'),
      'repairAuditId',(SELECT max(id) FROM delivery_audit_log WHERE order_id=s.netsuite_id AND action='delivery.pickup.stale_packing.repair'))
      FROM sales_orders s WHERE s.netsuite_id=1064528;"""
    result = subprocess.run(['docker', 'exec', '-i', 'mbbs-operator-app-db-1', 'sh', '-c',
                             'psql -X -qAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'],
                            input=sql, text=True, capture_output=True, check=True)
    observed = json.loads(result.stdout.strip())
    record = {'appliedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'mode': mode, 'hashes': FILES,
              'result': observed, 'databaseOnly': True, 'beforeState': 'delivery_audit_log details on repairAuditId'}
    (record_dir / record_name).write_text(json.dumps(record, indent=2) + '\n')
    if mode != '--install-rule':
        assert observed['status'] == 'open' and observed['packingWarnings'] == 0
    if mode != '--repair-only':
        assert observed['automaticReleaseActive']
    subprocess.run(['curl', '-fsS', '-o', '/dev/null', 'http://127.0.0.1:3000/health'], check=True)
    print(json.dumps(record))


if __name__ == '__main__':
    try:
        main()
    except subprocess.CalledProcessError as error:
        if error.stderr:
            print(error.stderr, file=sys.stderr)
        raise
