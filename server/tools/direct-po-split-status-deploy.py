"""Apply the verified SQL identity fix and recover only SN1401885's transport status."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / 'server'
STATE = SERVER / 'deployments/direct-po-split-status-20261015'
OUT = SERVER / 'test-artifacts/direct-po-split-status-20261015'
MIGRATION = '291_direct_po_materialized_split_status.sql'
APP = 'mbbs-operator-app-app-1'
FINGERPRINT = """SELECT md5(jsonb_build_object(
  'order',(SELECT to_jsonb(p) FROM purchase_orders p WHERE netsuite_id=-8673120731222),
  'lines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM purchase_order_lines l WHERE purchase_order_id=-8673120731222),
  'links',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM dispatch_so_po_allocations a WHERE po_order_id=-8673120731222),
  'group',(SELECT to_jsonb(g) FROM dispatch_global_order_groups g WHERE group_ref='GOA-9140S3-9143S3'),
  'proof',(SELECT jsonb_agg(to_jsonb(j) ORDER BY id) FROM driver_job_records j WHERE id IN (6294,6296)),
  'receipts',(SELECT jsonb_agg(to_jsonb(j) ORDER BY id) FROM dispatch_direct_po_ir_jobs j WHERE local_po_id=-8673120731222),
  'receiptContract',pg_get_functiondef('dispatch_linked_transport_receipt_ready(text,text)'::regprocedure)
)::text) AS fingerprint"""


def remote(program):
    result = subprocess.run(['sudo', '-n', 'docker', 'exec', '-i', '-w', '/app', APP,
                             'node', '--input-type=module'], input=program, text=True,
                            capture_output=True, check=True)
    return json.loads(result.stdout)


def save(path, data):
    path.write_text(json.dumps(data, indent=2) + '\n')
    path.chmod(0o600)


def capture():
    assert not (STATE / 'before.json').exists(), 'Preserve the original capture.'
    result = remote("""
      import {pool,query,closeDb} from './src/db.js';
      import {listScmSchedule} from './src/dispatch-repository.js';
      pool.options.options='-c default_transaction_read_only=on -c statement_timeout=30000 -c jit=off';
      try {
        const definition=(await query("SELECT pg_get_functiondef('dispatch_po_allocation_delivery_refs(bigint)'::regprocedure) AS sql")).rows[0].sql;
        const fingerprint=(await query(FINGERPRINT)).rows[0].fingerprint;
        const row=(await listScmSchedule({exactRefs:['SN1401885']}))[0];
        const jobs=(await query('SELECT id,status,completed_at FROM driver_job_records WHERE id IN (6294,6296) ORDER BY id')).rows;
        console.log(JSON.stringify({definition,fingerprint,status:row.calculatedStatus,jobs}));
      } finally {await closeDb();}
    """.replace('FINGERPRINT', json.dumps(FINGERPRINT)))
    save(STATE / 'before.json', result)
    (STATE / 'rollback-function.sql').write_text('BEGIN;\n' + result['definition'] + ';\nCOMMIT;\n')
    print(json.dumps({'captured': True, 'order': 'SN1401885', 'status': result['status']}))


def apply():
    report = json.loads((OUT / 'checks.json').read_text())
    assert report['passed'] and all(m['killed'] and m['propertyKilled'] for m in report['mutations'])
    for name, digest in report['sourceHashes'].items():
        assert hashlib.sha256((SERVER / name).read_bytes()).hexdigest() == digest, name
    before = json.loads((STATE / 'before.json').read_text())
    migration = (SERVER / 'migrations' / MIGRATION).read_text()
    helper = (SERVER / 'tools/direct-po-split-status-recovery.mjs').read_text().replace("'../src/db.js'", "'./src/db.js'")
    body = """
      import assert from 'node:assert/strict';
      import {pool,closeDb} from './src/db.js';
      import {listScmSchedule} from './src/dispatch-repository.js';
      pool.options.options='-c lock_timeout=3000 -c statement_timeout=30000 -c jit=off';
      try {
        const result=await withTransaction(async()=>{
          await query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
          const installed=(await query("SELECT pg_get_functiondef('dispatch_po_allocation_delivery_refs(bigint)'::regprocedure) AS sql")).rows[0].sql;
          assert.equal(installed,BEFORE.definition,'SQL function changed since capture');
          const before=(await query(FINGERPRINT)).rows[0].fingerprint;
          assert.equal(before,BEFORE.fingerprint,'Order or delivery proof changed since capture');
          assert.equal((await query('SELECT 1 FROM schema_migrations WHERE filename=$1',[MIGRATION_NAME])).rowCount,0);
          const proof=(await query("SELECT completed_at::text AS at,order_refs FROM driver_job_records WHERE id=6296 AND status='complete' AND stop_type='dropoff'")).rows[0];
          assert.ok(proof);
          assert.deepEqual([...proof.order_refs].sort(),['SOA09140-S3','SOA09143-S3']);
          assert.equal(proof.at,'2026-10-13 15:39:49.216144+00');
          await query(MIGRATION_SQL);
          assert.deepEqual((await query("SELECT id,dispatch_po_allocation_delivery_refs(id) AS refs FROM dispatch_so_po_allocations WHERE po_order_id=-8673120731222 AND status='active' ORDER BY id")).rows,
            [{id:'254',refs:['SOA09143-S3']},{id:'255',refs:['SOA09140-S3']}]);
          const recovered=await recoverDirectPoScheduleCompletion({poId:-8673120731222,poRef:'SN1401885',driverJobRecordId:6296});
          const repeated=await recoverDirectPoScheduleCompletion({poId:-8673120731222,poRef:'SN1401885',driverJobRecordId:6296});
          assert.equal(repeated.completionEventId,recovered.completionEventId);
          assert.equal((await query(FINGERPRINT)).rows[0].fingerprint,before,'Source data or receipt contract changed');
          const completion=(await query("SELECT dispatch_completed_at::text AS at,metadata FROM dispatch_order_completion_events WHERE id=$1",[recovered.completionEventId])).rows[0];
          assert.equal(completion.at,proof.at);
          assert.equal(completion.metadata.statusOnlyRecovery,true);
          assert.equal(completion.metadata.directShipCoverageVerified,false);
          const row=(await listScmSchedule({exactRefs:['SN1401885']}))[0];
          assert.equal(row.calculatedStatus,'Completed');
          await query('INSERT INTO schema_migrations(filename) VALUES($1)',[MIGRATION_NAME]);
          return {order:row.orderRef,status:row.calculatedStatus,completionAt:completion.at,
            ...recovered,sourceDataUnchanged:true,idempotenceVerified:true};
        });
        console.log(JSON.stringify(result));
      } finally {await closeDb();}
    """.replace('BEFORE', json.dumps(before)).replace('FINGERPRINT', json.dumps(FINGERPRINT))
    body = body.replace('MIGRATION_NAME', json.dumps(MIGRATION)).replace('MIGRATION_SQL', json.dumps(migration))
    result = remote(helper + '\n' + body)
    save(OUT / 'applied.json', result)
    print(json.dumps(result))


def verify():
    before = json.loads((STATE / 'before.json').read_text())
    applied = json.loads((OUT / 'applied.json').read_text())
    expected_body = (SERVER / 'migrations' / MIGRATION).read_text().split('AS $$', 1)[1].rsplit('$$;', 1)[0]
    result = remote("""
      import assert from 'node:assert/strict';
      import {pool,query,closeDb} from './src/db.js';
      import {listScmSchedule} from './src/dispatch-repository.js';
      pool.options.options='-c default_transaction_read_only=on -c statement_timeout=30000 -c jit=off';
      try {
        const row=(await listScmSchedule({exactRefs:['SN1401885']}))[0];
        assert.equal(row.calculatedStatus,'Completed');
        assert.equal((await query("SELECT prosrc AS body FROM pg_proc WHERE oid='dispatch_po_allocation_delivery_refs(bigint)'::regprocedure")).rows[0].body,EXPECTED_BODY);
        assert.equal((await query(FINGERPRINT)).rows[0].fingerprint,EXPECTED_FINGERPRINT);
        const event=(await query(`SELECT completion_event_id,dispatch_completed_at::text AS at,metadata
          FROM dispatch_order_completion_status WHERE order_kind='PO' AND order_ref='SN1401885'`)).rows[0];
        assert.equal(event.completion_event_id,EXPECTED_EVENT);
        assert.equal(event.at,'2026-10-13 15:39:49.216144+00');
        assert.equal(event.metadata.statusOnlyRecovery,true);
        assert.equal(event.metadata.directShipCoverageVerified,false);
        const health=[];
        for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
          const response=await fetch(base+'/health',{signal:AbortSignal.timeout(20000)});
          assert.equal(response.status,200);assert.equal((await response.json()).ok,true);
          health.push({base,status:response.status});
        }
        console.log(JSON.stringify({order:'SN1401885',status:row.calculatedStatus,event,
          sourceDataUnchanged:true,newReceiptJobs:0,installedSplitMatcherVerified:true,health}));
      } finally {await closeDb();}
    """.replace('EXPECTED_FINGERPRINT', json.dumps(before['fingerprint']))
       .replace('EXPECTED_EVENT', json.dumps(applied['completionEventId']))
       .replace('EXPECTED_BODY', json.dumps(expected_body))
       .replace('FINGERPRINT', json.dumps(FINGERPRINT)))
    result['containers'] = {}
    for label, args in [('running', ['ps']), ('all', ['ps', '-a'])]:
        raw = subprocess.check_output(['sudo', '-n', 'docker', *args, '--format',
                                       '{{.Names}} {{.Status}}'], text=True)
        result['containers'][label] = raw.strip().splitlines()
    save(OUT / 'verified.json', result)
    print(json.dumps(result))


def verify_range():
    expected_body = (SERVER / 'migrations' / MIGRATION).read_text().split('AS $$', 1)[1].rsplit('$$;', 1)[0]
    result = remote("""
      import assert from 'node:assert/strict';
      import {pool,query,closeDb} from './src/db.js';
      import {listScmSchedule} from './src/dispatch-repository.js';
      pool.options.options='-c default_transaction_read_only=on -c statement_timeout=30000 -c jit=off';
      try {
        assert.equal((await query("SELECT prosrc AS body FROM pg_proc WHERE oid='dispatch_po_allocation_delivery_refs(bigint)'::regprocedure")).rows[0].body,EXPECTED_BODY);
        const row=(await listScmSchedule({exactRefs:['SN1401885']}))[0];
        assert.equal(row.calculatedStatus,'Completed');
        assert.deepEqual((await query("SELECT id,dispatch_po_allocation_delivery_refs(id) AS refs FROM dispatch_so_po_allocations WHERE po_order_id=-8673120731222 AND status='active' ORDER BY id")).rows,
          [{id:'254',refs:['SOA09143-S3']},{id:'255',refs:['SOA09140-S3']}]);
        const completion=(await query(`SELECT completion_event_id,dispatch_completed_at::text AS at
          FROM dispatch_order_completion_status WHERE order_kind='PO' AND order_ref='SN1401885'`)).rows[0];
        assert.equal(completion.completion_event_id,'73841');
        assert.equal(completion.at,'2026-10-13 15:39:49.216144+00');
        assert.equal((await query("SELECT dispatch_linked_transport_delivery_ready('PO','SN1401885') AS ready")).rows[0].ready,true);
        assert.equal((await query('SELECT count(*)::int AS n FROM dispatch_direct_po_ir_jobs WHERE local_po_id=-8673120731222')).rows[0].n,0);
        const quantities=(await query(`SELECT item_id,quantity::numeric::text AS qty,unit,received_sales_qty::numeric::text AS received
          FROM purchase_order_lines WHERE purchase_order_id=-8673120731222 ORDER BY item_id`)).rows;
        assert.deepEqual(quantities.map(l=>({item:Number(l.item_id),qty:Number(l.qty),unit:l.unit,received:Number(l.received)})),
          [{item:1784,qty:32,unit:'EACH',received:0},{item:2055,qty:1984,unit:'SQFT',received:0}]);
        const health=await fetch('http://127.0.0.1:3000/health',{signal:AbortSignal.timeout(20000)});
        assert.equal(health.status,200);assert.equal((await health.json()).ok,true);
        console.log(JSON.stringify({order:'SN1401885',status:row.calculatedStatus,completion,
          installedSplitMatcherVerified:true,deliveryProofReady:true,quantitiesVerified:true,
          receiptJobs:0,health:200}));
      } finally {await closeDb();}
    """.replace('EXPECTED_BODY', json.dumps(expected_body)))
    result['containers'] = {}
    for label, args in [('running', ['ps']), ('all', ['ps', '-a'])]:
        result['containers'][label] = subprocess.check_output(
            ['sudo', '-n', 'docker', *args, '--format', '{{.Names}} {{.Status}}'], text=True).strip().splitlines()
    save(OUT / 'range-live.json', result)
    print(json.dumps(result))


if __name__ == '__main__':
    os.umask(0o077)
    {'capture': capture, 'apply': apply, 'verify': verify, 'verify-range': verify_range}[sys.argv[1]]()
