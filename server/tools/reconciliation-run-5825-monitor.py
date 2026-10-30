"""Read-only monitoring for the requested recovery; exit on completion/restart."""
import json
import subprocess
import time

APP = 'mbbs-operator-app-app-1'
SQL = """BEGIN READ ONLY; SET LOCAL statement_timeout='10s';
SELECT json_build_object('checkedAt',now(),'id',r.id,'status',r.status,
 'heartbeatAt',r.heartbeat_at,'phase',r.checkpoint->>'phase',
 'processed',r.checkpoint->>'processed','total',r.checkpoint->>'total',
 'review',r.summary->>'reviewOrders','failed',r.summary->>'failedOrders',
 'error',r.error,'targets',(SELECT json_object_agg(status,n) FROM
 (SELECT status,count(*) n FROM scm_reconciliation_run_targets
 WHERE run_id=r.id GROUP BY status) counts))
FROM scm_reconciliation_runs r WHERE r.id=5825; COMMIT;"""


def app():
    record = json.loads(subprocess.check_output(['docker', 'inspect', APP], text=True))[0]
    return {'id': record['Id'], 'restarts': record['RestartCount'],
            'healthy': record['State'].get('Health', {}).get('Status') == 'healthy'}


original = app()
while True:
    output = subprocess.check_output(['docker', 'exec', '-i', 'mbbs-operator-app-db-1', 'sh', '-c',
        'exec psql -X -qAt -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1'], input=SQL, text=True, timeout=20)
    row = json.loads(output.strip())
    current = app()
    row.update({'appHealthy': current['healthy'], 'appRestarts': current['restarts']})
    print(json.dumps(row), flush=True)
    if row['status'] not in ('queued', 'running') or current['id'] != original['id'] or current['restarts'] != original['restarts']:
        break
    time.sleep(45)
