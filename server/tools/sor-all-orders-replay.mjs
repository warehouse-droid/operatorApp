import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {existsSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {chromium,expect} from '@playwright/test';

assert.equal(process.env.MBT_TEST_ISOLATED,'1');
assert.equal(new URL(process.env.DATABASE_URL).pathname,'/mbt_test');
assert.equal(process.env.NETSUITE_DIRECT_ACCESS_ENABLED,'false');
process.env.DISPATCH_PLANNER_ORDER_POOL_MODE='on';
const {app,dispatchOrderCatalogTick}=await import('../src/server.js');
const {query,pool,closeDb}=await import('../src/db.js');
const {config}=await import('../src/config.js');
const {createOperator}=await import('../src/auth-repository.js');
const {DISPATCH_FLEET_PLANNING_LOCK}=await import('../src/dispatch-fleet-status.js');
assert.equal(config.dispatch.plannerOrderPoolMode,'on');
assert.equal(config.netsuite.directAccessEnabled,false);
const artifact='test-artifacts/sor-rentals';
const input=readFileSync(`${artifact}/all-orders-snapshot.json`);
const snapshot=JSON.parse(input);
const refs=[...new Set(snapshot.tables.sales_orders.map(row=>row.tranid.replace(/-S\d+$/u,'')))].sort();
assert.ok(refs.length>=137,'Replay must include all captured orders');
let cleaning=false;
pool.on('connect',client=>client.on('error',error=>{if(!cleaning)console.error(error.message);}));
// Fixture import alone bypasses foreign-key references to unrelated live users.
// Normal triggers/constraints are restored before any production code is run.
const seed=await pool.connect();
try {
 await seed.query('BEGIN');await seed.query('SET LOCAL session_replication_role=replica');
 for(const [table,rows] of Object.entries(snapshot.tables)) {
  assert.match(table,/^[a-z_]+$/u);
  await seed.query(`DELETE FROM ${table}`);
  if(!rows.length)continue;
  const columns=(await seed.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND is_generated='NEVER' ORDER BY ordinal_position",[table])).rows.map(row=>`"${row.column_name}"`).join(',');
  await seed.query(`INSERT INTO ${table}(${columns}) OVERRIDING SYSTEM VALUE SELECT ${columns} FROM jsonb_populate_recordset(null::${table},$1::jsonb)`,[JSON.stringify(rows)]);
  const sequences=(await seed.query("SELECT column_name,pg_get_serial_sequence($1,column_name) AS sequence FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",[table])).rows.filter(row=>row.sequence);
  for(const column of sequences)await seed.query(`SELECT setval($1,COALESCE((SELECT max("${column.column_name}") FROM ${table}),1),true)`,[column.sequence]);
 }
 await seed.query('COMMIT');
}catch(error){await seed.query('ROLLBACK');throw error;}finally{seed.release();}
await query('UPDATE mbt_feature_flags SET enabled=false');
await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='sor_rental_workflow'");
await query('UPDATE sor_signature_settings SET returns_enabled=true');
const repair='migrations/224_sor_return_definitions.sql';
if(existsSync(repair))await query(readFileSync(repair,'utf8'));
await query('DELETE FROM sor_return_reconcile_queue');
await query('INSERT INTO sor_return_reconcile_queue(source_ref) SELECT unnest($1::text[])',[refs]);
const username=`sor-replay-${randomUUID()}`,password=randomUUID();
await createOperator({username,password,displayName:'Isolated SOR replay admin',role:'admin',roles:['admin']});
const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({args:['--no-sandbox']});
let holder,worker,catalog,probing=false,probeLoop;
const errors=[],probes=[],rounds=[];
const returns=async()=> (await query("SELECT id,ref_number,status,pickup_location,dropoff_location,line_snapshot,sor_source_fingerprint,sor_review_reason FROM dispatch_custom_orders WHERE order_kind='sor_rental_return' ORDER BY ref_number")).rows;
const initialReturns=await returns();
async function until(fn,label){const start=Date.now();while(Date.now()-start<5000){if(await fn())return;await new Promise(r=>setTimeout(r,20));}throw new Error('Timed out: '+label);}
const deadline=(work)=>Promise.race([work,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('SOR/catalog deadlock: production-mode workers did not finish')),10000);timer.unref();})]);
try {
 const page=await browser.newPage({serviceWorkers:'block'});page.on('pageerror',error=>errors.push(error.message));
 await page.goto(base+'/');await page.locator('[name=username]').fill(username);await page.locator('[name=password]').fill(password);
 await Promise.all([page.waitForURL(url=>url.pathname!=='/'),page.locator('button[type=submit]').click()]);
 await page.waitForFunction(()=>Boolean(localStorage.getItem('mbbs.staff.token')));
 const token=await page.evaluate(()=>localStorage.getItem('mbbs.staff.token'));
 const policy=(await query('SELECT * FROM sor_item_policies ORDER BY item_id LIMIT 1')).rows[0];
 const tick=()=>fetch(base+`/api/admin/sor-auto-returns/items/${policy.item_id}`,{method:'PUT',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({override:policy.auto_return_override,expectedRevision:Number(policy.revision)}),signal:AbortSignal.timeout(15000)}).then(async response=>{const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));assert.equal(body.reconciliation.error,undefined);return body.reconciliation;});
 probing=true;
 probeLoop=(async()=>{while(probing){const start=Date.now();const response=await fetch(base+'/api/auth/bootstrap-needed',{signal:AbortSignal.timeout(2000)});assert.equal(response.status,200);probes.push(Date.now()-start);await new Promise(r=>setTimeout(r,100));}})();probeLoop.catch(()=>{});
 async function drain(label,force=false) {
  const start=Date.now();let processed=0,batches=0;
  if(force){
   holder=await pool.connect();await holder.query('BEGIN');await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))',[DISPATCH_FLEET_PLANNING_LOCK]);
   const pid=(await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
   const waiting=async()=>Number((await query('SELECT count(*) FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid])).rows[0].count);
   worker=tick();worker.catch(()=>{});await until(async()=>await waiting()>=1,'SOR waiting for fleet lock');
   catalog=dispatchOrderCatalogTick();catalog.catch(()=>{});await until(async()=>await waiting()>=2,'catalog waiting for fleet lock');
   await holder.query('COMMIT');holder.release();holder=null;
   const result=await deadline(Promise.all([worker,catalog]));assert.equal(result[1].failed,0);
   processed+=result[0].processed;batches++;
  }
  while(Number((await query('SELECT count(*) FROM sor_return_reconcile_queue')).rows[0].count)>0){
   assert.ok(batches<30,'Queue did not drain');
   const result=await deadline(Promise.all([tick(),dispatchOrderCatalogTick()]));
   assert.equal(result[1].failed,0);assert.ok(result[0].processed>0,'No progress');processed+=result[0].processed;batches++;
   assert.deepEqual((await query("SELECT source_ref,attempts,last_error FROM sor_return_reconcile_queue WHERE attempts>0 OR last_error<>''")).rows,[]);
  }
  assert.ok(processed>=refs.length);
  const health=(await query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND (wait_event_type='Lock' OR (state='idle in transaction' AND xact_start<now()-interval '5 seconds'))")).rows[0];assert.equal(health.n,0);
  const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password}),signal:AbortSignal.timeout(2000)});assert.equal(login.status,200);
  rounds.push({label,processed,batches,ms:Date.now()-start,lockWaitersAfter:health.n,login:login.status});
 }
 await drain('all captured orders with forced catalog contention',true);
 const firstReturns=await returns();
 if(existsSync(repair)) {
  for(const previous of initialReturns.filter(row=>row.status==='open')) {
   const retained=firstReturns.find(row=>row.ref_number===previous.ref_number);
   assert.equal(retained?.id,previous.id,'Existing return identity must survive replay');
   assert.equal(retained?.status,'open',previous.ref_number+' must not be cancelled by its own derived definition');
  }
  assert.deepEqual(firstReturns.filter(row=>row.sor_review_reason).map(row=>row.ref_number),[]);
 }
 // Reproduce the incident trigger: ordinary updates queue OLD orders.
 await query("UPDATE sales_orders SET sales_order_type=sales_order_type WHERE tranid ~ '^SOR[0-9]+(-S[0-9]+)?$'");
 await query('UPDATE sales_order_lines SET item_name=item_name');
 assert.equal(Number((await query('SELECT count(*) FROM sor_return_reconcile_queue')).rows[0].count),refs.length);
 await drain('same existing orders after header and line sync',true);
 assert.deepEqual(await returns(),firstReturns,'Replay must be idempotent');
 assert.equal(new Set(firstReturns.map(row=>row.ref_number)).size,firstReturns.length);
 await query("UPDATE mbt_feature_flags SET enabled=false WHERE flag_key='sor_rental_workflow'");
 await query('INSERT INTO sor_return_reconcile_queue(source_ref) SELECT unnest($1::text[])',[refs]);
 const paused=await tick();assert.equal(paused.disabled,true);assert.equal(paused.processed,0);
 assert.equal(Number((await query('SELECT count(*) FROM sor_return_reconcile_queue')).rows[0].count),refs.length);
 assert.deepEqual(await returns(),firstReturns);
 await page.goto(base+'/admin/sor-auto-returns');await expect(page.locator('[data-sor-gate]')).toContainText('paused');
 await page.screenshot({path:`${artifact}/all-orders-paused.png`});
 assert.deepEqual(errors,[]);
 probing=false;await probeLoop;
 const report={passed:true,capturedAt:snapshot.metadata.capturedAt,snapshotSha256:createHash('sha256').update(input).digest('hex'),sourceHashes:Object.fromEntries(['src/server.js','src/sor-rental-service.js','src/sor-rental-repository.js','src/sor-feature-gate.js','src/dispatch-delivery-group-repository.js'].map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')])),catalogMode:'on',orderCount:refs.length,lineCount:snapshot.tables.sales_order_lines.length,rounds,initialReturnCount:initialReturns.length,finalReturnCount:firstReturns.length,reviewRefs:firstReturns.filter(row=>row.sor_review_reason).map(row=>row.ref_number),bootstrapProbes:probes.length,maxBootstrapMs:Math.max(...probes),pageErrors:errors,pausedGateVerified:true,externalAccess:false,fixtureLimitations:'Unrelated users, non-SOR orders, unrelated plans, inventory and historical catalog workload are not copied. Original SOR header/line/policy/return/execution rows are retained.'};
 writeFileSync(`${artifact}/all-orders-replay.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
} catch(error) {
 const blocked=(await query("SELECT state,wait_event_type,wait_event,left(query,160) AS query,extract(epoch from now()-xact_start) AS transaction_seconds FROM pg_stat_activity WHERE datname=current_database() AND (wait_event_type='Lock' OR state='idle in transaction')")).rows;
 console.error(JSON.stringify({failed:true,error:error.message,blocked}));
 throw error;
} finally {
 probing=false;if(holder){await holder.query('ROLLBACK');holder.release();}
 cleaning=true;await query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='idle in transaction'");
 await Promise.allSettled([worker,catalog,probeLoop]);await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await closeDb();
}
