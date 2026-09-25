"""Compare durable posting latency, keeping outage/restart samples separate."""
import json
from pathlib import Path
import subprocess

sql = """
BEGIN READ ONLY;
SET LOCAL statement_timeout='15s';
WITH periods(label,from_time,to_time) AS (VALUES
 ('before_crash','2026-09-23 00:00Z'::timestamptz,'2026-09-24 11:24Z'::timestamptz),
 ('outage','2026-09-24 11:24Z','2026-09-24 12:36Z'),
 ('recovery_first_five_minutes','2026-09-24 12:36Z','2026-09-24 12:41Z'),
 ('after_recovery','2026-09-24 12:36Z',now()),
 ('after_first_five_minutes','2026-09-24 12:41Z',now()),
 ('after_lock_fix','2026-09-24 13:00Z',now())),
timings AS (
 SELECT 'operator_pickup'::text AS kind,created_at,completed_at,status,
 extract(epoch from completed_at-created_at)::double precision AS seconds
 FROM operator_netsuite_posting_commands WHERE function_key='customer_pickup'
 UNION ALL SELECT 'driver_fulfillment',created_at,completed_at,status,
 extract(epoch from completed_at-created_at)::double precision FROM dispatch_sales_order_if_candidates)
SELECT row_to_json(r) FROM (
 SELECT p.label AS period,p.from_time,p.to_time,t.kind AS metric,count(*) AS n,
 count(t.completed_at) AS completed, count(*) FILTER(WHERE status='uncertain') AS uncertain,
 count(*) FILTER(WHERE status='gate_disabled') AS gate_disabled,
 round(percentile_cont(.5) WITHIN GROUP(ORDER BY t.seconds)::numeric,3) AS median_seconds,
 round(percentile_cont(.95) WITHIN GROUP(ORDER BY t.seconds)::numeric,3) AS p95_seconds,
 round(max(t.seconds)::numeric,3) AS max_seconds
 FROM periods p JOIN timings t ON t.created_at>=p.from_time AND t.created_at<p.to_time
 GROUP BY p.label,p.from_time,p.to_time,t.kind ORDER BY p.from_time,t.kind) r;
COMMIT;
"""
result = subprocess.run(['sudo', '-n', 'docker', 'exec', '-i', 'mbbs-operator-app-db-1', 'psql', '-U', 'mbbs_app', '-d', 'mbbs_yard', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], input=sql, text=True, capture_output=True, check=True)
rows = [json.loads(line) for line in result.stdout.splitlines() if line.startswith('{')]
report = {'periods': rows, 'limitations': [
    'Server command creation to completion; excludes browser upload, admission before command creation, rendering and polling.',
    'Driver metric is asynchronous fulfillment after recorded dropoff; it is not Driver button response time.',
    'Prior Driver fulfillment candidates were gate_disabled: no comparable successful pre-crash posting baseline.',
    'No duration-bearing historical Driver HTTP logs or populated device/server action timestamps were found.',
    'Completed-only percentiles exclude the unresolved SOB120921-S1; uncertain counts are shown separately.',
    'Outage requests blocked before command admission cannot appear in command durations.'
]}
dest = Path(__file__).resolve().parents[1] / 'test-artifacts/operator-responsiveness/timing-comparison.json'
dest.parent.mkdir(parents=True, exist_ok=True)
dest.write_text(json.dumps(report, indent=2)+'\n')
print(json.dumps(report, indent=2))
