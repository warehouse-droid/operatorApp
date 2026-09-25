import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {writeFileSync,readFileSync} from 'node:fs';
import {chromium,expect} from '@playwright/test';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
assert.equal(new URL(process.env.DATABASE_URL).pathname,'/mbt_test');
// The original regression left this OFF. Exercise the production path explicitly.
process.env.DISPATCH_PLANNER_ORDER_POOL_MODE='on';
const {app,dispatchOrderCatalogTick}=await import('../src/server.js');
const {query,pool,closeDb}=await import('../src/db.js');
const {config}=await import('../src/config.js');
const {createOperator}=await import('../src/auth-repository.js');
const {DISPATCH_FLEET_PLANNING_LOCK}=await import('../src/dispatch-fleet-status.js');
assert.equal(config.dispatch.plannerOrderPoolMode,'on');
let cleaning=false;
pool.on('connect',client=>client.on('error',error=>{if(!cleaning)console.error('Isolated DB connection:',error.message);}));
async function cleanupFixture(){
 await query("UPDATE mbt_feature_flags SET enabled=false WHERE flag_key='sor_rental_workflow'");
 await query("DELETE FROM dispatch_custom_orders WHERE parent_order_ref='SOR998902'");
 await query('DELETE FROM sales_order_lines WHERE sales_order_id=998902');await query('DELETE FROM sales_orders WHERE netsuite_id=998902');
 await query('DELETE FROM sor_item_policies WHERE item_id=998902');
 await query("DELETE FROM sor_return_reconcile_queue WHERE source_ref='SOR998902'");
}
await cleanupFixture();
const username=`gate-browser-${randomUUID()}`,password=randomUUID();
await createOperator({username,password,displayName:'Isolated gate admin',role:'admin',roles:['admin']});
await query("UPDATE mbt_feature_flags SET enabled=false WHERE flag_key='sor_rental_workflow'");
await query("INSERT INTO sales_orders(netsuite_id,tranid,sales_order_type,netsuite_active,status_text,outbound_location,outbound_location_id,dispatch_address,customer,is_test_fixture) VALUES(998902,'SOR998902','Delivery',true,'Pending Fulfillment','Rental',50,'77 Test Road','Isolated rental',false)");
await query("INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,item_type,quantity,netsuite_active) VALUES(998902,1,998902,'Lift/Day','Service',2,true)");
await query("INSERT INTO sor_item_policies(item_id,item_name,full_name,item_type) VALUES(998902,'Lift/Day','05 MBR Equip : Lift/Day','Service')");
const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({args:['--no-sandbox']});
const errors=[];
let holder,worker,catalog;
async function until(fn,label){
 const start=Date.now();while(Date.now()-start<5000){if(await fn())return;await new Promise(r=>setTimeout(r,20));}
 throw new Error('Timed out: '+label);
}
try {
 const page=await browser.newPage({viewport:{width:1280,height:900},serviceWorkers:'block'});
 page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(()=>localStorage.setItem('mbbs.ui.language','en'));
 await page.goto(base+'/');
 await page.locator('[name=username]').fill(username);await page.locator('[name=password]').fill(password);
 await Promise.all([page.waitForURL(url=>url.pathname!=='/'),page.locator('button[type=submit]').click()]);
 await page.waitForFunction(()=>Boolean(localStorage.getItem('mbbs.staff.token')));
 const token=await page.evaluate(()=>localStorage.getItem('mbbs.staff.token'));
 await page.goto(base+'/admin/sor-auto-returns');
 await expect(page.locator('[data-sor-gate]')).toContainText('paused');
 await page.getByRole('link',{name:'Manage SOR feature gate'}).click();
 const button=page.locator('[data-gate-toggle="sor_rental_workflow"]');
 await expect(button).toHaveText('Turn on');
 await page.locator('#gateReason').fill('Isolated regression of SOR and catalog concurrency');
 await button.click();await expect(button).toHaveText('Turn off');

 // Force the exact production dependency: SOR owns fleet, while the catalog
 // executor already has a task waiting for fleet. No refresh callback is mocked.
 holder=await pool.connect();await holder.query('BEGIN');
 await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))',[DISPATCH_FLEET_PLANNING_LOCK]);
 const pid=(await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
 const revision=(await query('SELECT revision FROM sor_item_policies WHERE item_id=998902')).rows[0].revision;
 worker=fetch(base+'/api/admin/sor-auto-returns/items/998902',{method:'PUT',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({override:true,expectedRevision:Number(revision)}),signal:AbortSignal.timeout(10000)}).then(async r=>({status:r.status,body:await r.json()}));
 worker.catch(()=>{});
 const waiting=async()=>Number((await query('SELECT count(*) FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid])).rows[0].count);
 await until(async()=>await waiting()>=1,'SOR waiting at fleet lock');
 catalog=dispatchOrderCatalogTick();catalog.catch(()=>{});
 await until(async()=>await waiting()>=2,'real catalog executor waiting at fleet lock');
 await holder.query('COMMIT');holder.release();holder=null;
 const start=Date.now();
 const result=await Promise.race([Promise.all([worker,catalog]),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('SOR/catalog deadlock: production-mode workers did not finish')),5000);timer.unref();})]);
 assert.equal(result[0].status,200,JSON.stringify(result[0]));
 assert.ok(result[0].body.reconciliation.processed>=1);
 assert.equal(result[1].failed,0);
 const workerMs=Date.now()-start;
 assert.equal((await query("SELECT count(*)::int AS n FROM dispatch_custom_orders WHERE ref_number='SOR998902-Return'")).rows[0].n,1);
 assert.equal((await query("SELECT count(*)::int AS n FROM sor_return_reconcile_queue WHERE source_ref='SOR998902'")).rows[0].n,0);
 const probes=await Promise.all(Array.from({length:12},async()=>{
  const began=Date.now();const r=await fetch(base+'/api/auth/bootstrap-needed',{signal:AbortSignal.timeout(2000)});
  assert.equal(r.status,200);return Date.now()-began;
 }));
 const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password}),signal:AbortSignal.timeout(2000)});
 assert.equal(login.status,200);
 await button.click();await expect(button).toHaveText('Turn on');
 await page.goto(base+'/admin/sor-auto-returns');await expect(page.locator('[data-sor-gate]')).toContainText('paused');
 await page.screenshot({path:'test-artifacts/sor-rentals/gate-paused.png'});
 assert.deepEqual(errors,[]);
 const sourceHashes=Object.fromEntries(['src/sor-rental-service.js','src/sor-feature-gate.js','src/netsuite.js'].map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')]));
 const resultReport={passed:true,sourceHashes,catalogMode:config.dispatch.plannerOrderPoolMode,realWorkerOverlap:true,workerMs,login:200,bootstrapRequests:probes.length,maxBootstrapMs:Math.max(...probes),pageErrors:errors,gateOff:true};
 writeFileSync('test-artifacts/sor-rentals/gate-browser.json',JSON.stringify(resultReport,null,2));console.log(JSON.stringify(resultReport));
} catch(error) {console.error('REGRESSION ASSERTION:',error.message);throw error;} finally {
 if(holder){await holder.query('ROLLBACK');holder.release();}
 // A failed regression can leave the old code deadlocked. Only this explicitly
 // isolated database is eligible for cleanup; never connect this runner to live.
 cleaning=true;
 const cleanup=await pool.connect();
 await cleanup.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='idle in transaction'");cleanup.release();
 await Promise.allSettled([worker,catalog]);
 await browser.close();await new Promise(resolve=>server.close(resolve));
 await cleanupFixture();
 await closeDb();
}
