"""Capture a read-only, private SOR replay fixture; never copy live credentials."""
import hashlib
import json
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[1]
tables = {
    'sales_orders': "SELECT * FROM sales_orders WHERE tranid ~ '^SOR[0-9]+(-S[0-9]+)?$'",
    'sales_order_lines': "SELECT l.* FROM sales_order_lines l JOIN sales_orders o ON o.netsuite_id=l.sales_order_id WHERE o.tranid ~ '^SOR[0-9]+(-S[0-9]+)?$'",
    'sor_item_policies': 'SELECT * FROM sor_item_policies',
    'sor_signature_settings': 'SELECT * FROM sor_signature_settings',
    'dispatch_custom_orders': "SELECT * FROM dispatch_custom_orders WHERE order_kind='sor_rental_return'",
    'dispatch_global_order_splits': "SELECT * FROM dispatch_global_order_splits WHERE parent_order_ref ~ '^SOR[0-9]+'",
    'dispatch_global_order_groups': "SELECT * FROM dispatch_global_order_groups WHERE group_ref IN (SELECT group_ref FROM dispatch_global_order_group_members WHERE member_order_ref ~ '^SOR[0-9]+')",
    'dispatch_global_order_group_members': "SELECT * FROM dispatch_global_order_group_members WHERE group_ref IN (SELECT group_ref FROM dispatch_global_order_group_members WHERE member_order_ref ~ '^SOR[0-9]+')",
    'dispatch_delivery_groups': "SELECT * FROM dispatch_delivery_groups WHERE group_ref IN (SELECT group_ref FROM dispatch_delivery_group_members WHERE member_order_ref ~ '^SOR[0-9]+')",
    'dispatch_delivery_group_members': "SELECT * FROM dispatch_delivery_group_members WHERE group_ref IN (SELECT group_ref FROM dispatch_delivery_group_members WHERE member_order_ref ~ '^SOR[0-9]+')",
    'dispatch_plan_order_assignments': "SELECT * FROM dispatch_plan_order_assignments WHERE order_ref ~ '^SOR[0-9]+'",
    'dispatch_plans': "SELECT * FROM dispatch_plans WHERE id IN (SELECT plan_id FROM dispatch_plan_order_assignments WHERE order_ref ~ '^SOR[0-9]+')",
    'driver_job_records': "SELECT * FROM driver_job_records WHERE EXISTS(SELECT 1 FROM jsonb_array_elements_text(order_refs) r WHERE r ~ '^SOR[0-9]+')",
    'sor_return_reconcile_queue': 'SELECT * FROM sor_return_reconcile_queue',
}
sql = "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout='15s';\n"
sql += "SELECT json_build_object('capturedAt',now(),'sorEnabled',(SELECT enabled FROM mbt_feature_flags WHERE flag_key='sor_rental_workflow'));\n"
for table, select in tables.items():
    sql += f"SELECT jsonb_build_object('table','{table}','rows',coalesce(jsonb_agg(t),'[]'::jsonb)) FROM ({select}) t;\n"
sql += 'COMMIT;'
result = subprocess.run(['sudo', '-n', 'docker', 'exec', '-i', 'mbbs-operator-app-db-1', 'psql', '-U', 'mbbs_app', '-d', 'mbbs_yard', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], input=sql, text=True, capture_output=True, check=True)
data = [json.loads(line) for line in result.stdout.splitlines() if line.startswith('{')]
assert data[0]['sorEnabled'] is False
snapshot = {'metadata': data[0], 'tables': {entry['table']: entry['rows'] for entry in data[1:]}}
dest = root / 'test-artifacts/sor-rentals/all-orders-snapshot.json'
dest.touch(mode=0o600)
dest.write_text(json.dumps(snapshot))
print(json.dumps({'snapshotSha256': hashlib.sha256(dest.read_bytes()).hexdigest(), **data[0], 'counts': {table: len(rows) for table, rows in snapshot['tables'].items()}}))
