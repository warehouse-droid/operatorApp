import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';

assert.equal(process.env.MBT_TEST_ISOLATED,'1');
assert.equal(new URL(process.env.DATABASE_URL).pathname,'/mbt_test_driver');
assert.equal(process.env.NETSUITE_DIRECT_ACCESS_ENABLED,'false');
process.env.DISPATCH_PLANNER_ORDER_POOL_MODE='on';
const {app,dispatchOrderCatalogTick}=await import('../src/server.js');
const {query,closeDb}=await import('../src/db.js');
const {createOperator}=await import('../src/auth-repository.js');
const prior=JSON.parse(readFileSync('test-artifacts/sor-rentals/all-orders-driver.json','utf8'));
assert.equal(prior.passed,true);
assert.equal(prior.planOnly,undefined);
const returns=async()=>(await query("SELECT to_jsonb(c) AS row FROM dispatch_custom_orders c WHERE order_kind='sor_rental_return' ORDER BY ref_number")).rows.map(row=>row.row);
const before=await returns();
assert.equal(before.length,21);
assert.ok(before.every(row=>row.status==='completed'));
const report={passed:false,externalAccess:false,completedReturnCount:before.length};
const server=app.listen(0,'127.0.0.1');
await new Promise(resolve=>server.once('listening',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
try {
 await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='sor_rental_workflow'");
 const username='sor-completed-replay-'+randomUUID(),password=randomUUID();
 await createOperator({username,password,displayName:'Isolated completed-return replay',role:'admin',roles:['admin']});
 const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password}),signal:AbortSignal.timeout(5000)});
 assert.equal(login.status,200);
 const body=await login.json();
 const token=body.token;
 assert.ok(token);
 const policy=(await query('SELECT * FROM sor_item_policies ORDER BY item_id LIMIT 1')).rows[0];
 const tick=async()=>{
  const response=await fetch(base+`/api/admin/sor-auto-returns/items/${policy.item_id}`,{method:'PUT',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({override:policy.auto_return_override,expectedRevision:Number(policy.revision)}),signal:AbortSignal.timeout(15000)});
  const payload=await response.json();
  assert.equal(response.status,200,JSON.stringify(payload));
  assert.equal(payload.reconciliation.error,undefined);
  return payload.reconciliation;
 };
 await query("UPDATE sales_orders SET sales_order_type=sales_order_type WHERE tranid ~ '^SOR[0-9]+(-S[0-9]+)?$'");
 await query('UPDATE sales_order_lines SET item_name=item_name');
 const queued=Number((await query('SELECT count(*) FROM sor_return_reconcile_queue')).rows[0].count);
 assert.equal(queued,137);
 const began=Date.now();let batches=0,processed=0;
 while(Number((await query('SELECT count(*) FROM sor_return_reconcile_queue')).rows[0].count)){
  assert.ok(batches<20,'Replay did not drain');
  const [worker,catalog]=await Promise.all([tick(),dispatchOrderCatalogTick()]);
  assert.equal(catalog.failed,0);assert.ok(worker.processed>0);
  processed+=worker.processed;batches++;
  assert.deepEqual((await query("SELECT source_ref,attempts,last_error FROM sor_return_reconcile_queue WHERE attempts>0 OR last_error<>''")).rows,[]);
 }
 assert.equal(processed,137);
 assert.deepEqual(await returns(),before,'Completed return rows must survive later source sync unchanged');
 const locks=Number((await query("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND (wait_event_type='Lock' OR (state='idle in transaction' AND xact_start<now()-interval '5 seconds'))")).rows[0].count);
 assert.equal(locks,0);
 await query("UPDATE mbt_feature_flags SET enabled=false WHERE flag_key='sor_rental_workflow'");
 await query('UPDATE sor_signature_settings SET returns_enabled=false');
 const paused=await tick();assert.equal(paused.disabled,true);assert.equal(paused.processed,0);
 Object.assign(report,{passed:true,processed,batches,ms:Date.now()-began,lockWaitersAfter:locks,allCompletedRowsUnchanged:true,pausedGateVerified:true});
 console.log(JSON.stringify(report));
} catch(error) {report.error=error.stack;throw error;}
finally {
 report.finishedAt=new Date().toISOString();
 report.sourceHashes=Object.fromEntries(['src/server.js','src/sor-rental-service.js','src/sor-rental-repository.js','src/dispatch-delivery-group-repository.js'].map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')]));
 writeFileSync('test-artifacts/sor-rentals/completed-returns-replay.json',JSON.stringify(report,null,2));
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await closeDb();
}
