import assert from 'node:assert/strict';
import fs from 'node:fs';
import test,{before,after} from 'node:test';
import {chromium} from '@playwright/test';
import {fixture} from './mbt/helpers/backorder-already-ordered.js';
import {pool} from '../src/db.js';
import {createSpecialStockCase} from '../src/special-stock-request-repository.js';

const queryTimes=[];let f,browser;const specials=[],regular=[],timings=[],out='test-artifacts/request-browser/'+(process.env.REQUEST_LOADING_BROWSER_PHASE||'standalone');
before(async()=>{
  fs.mkdirSync(out,{recursive:true});f=await fixture({sku:88999602});
  for(let i=0;i<7;i++)regular.push(await f.create(2));
  for(let i=0;i<60;i++)specials.push(await createSpecialStockCase({storeLocationId:1,fulfillmentMethod:'yard_pickup',
    inquiryDate:'2098-02-01',customerName:'TEST request performance '+i,vendorName:'TEST vendor',
    lines:[{productName:'TEST material '+i,quantity:7,uom:'EACH',rate:100,requiredDate:'2098-02-10'}]},
    {operatorId:f.users.sales.id,authorizedStoreLocationIds:[1]}));
  await f.query("UPDATE sales_special_stock_cases SET sales_order_netsuite_id=88999603,sales_order_ref='TEST-LINKED-SO' WHERE request_id=$1",[specials.at(-1).id]);
  for(let i=0;i<30;i++) {
    const orders=Array.from({length:200},(_,n)=>({id:`TEST-HISTORY-${i}-${n}`,type:'SO',items:Array.from({length:12},(_,j)=>({itemId:j,description:'TEST material specification '.repeat(40)}))}));
    if(i===0)orders.push({id:'TEST-LINKED-SO',type:'SO'});
    const trucks=[{plate:'TEST',loads:[{name:'Load',stops:orders.map(order=>({type:'drop',orderId:order.id,timing:{arrival:600}}))}]}];
    const plan=(await f.query("INSERT INTO dispatch_plans(plan_date,status,revision) VALUES($1,'draft',1) RETURNING id",[`2098-03-${String(i+1).padStart(2,'0')}`])).rows[0];
    await f.query("INSERT INTO dispatch_plan_snapshots(plan_id,orders,trucks,summary) VALUES($1,$2,$3,'{}')",[plan.id,JSON.stringify(orders),JSON.stringify(trucks)]);
  }
  const job=(await f.query("INSERT INTO driver_job_records(job_id,driver_login,stop_type,status) VALUES('browser-perf-job','TEST','dropoff','pending') RETURNING id")).rows[0];
  await f.query(`INSERT INTO driver_job_corrections(correction_id,idempotency_id,action,driver_job_record_id,job_id,
    plan_date,driver_login,expected_state_hash,audit_note,corrected_by,before_state,after_state,result)
    SELECT gen_random_uuid(),gen_random_uuid(),'reopen',$1,'browser-old-'||g,'2098-01-01','TEST',repeat('0',64),'TEST','TEST','{}','{}',
    jsonb_build_object('physicalVisitJobIds',jsonb_build_array('browser-visit-'||g)) FROM generate_series(1,85) g`,[job.id]);
  await f.query(`INSERT INTO dispatch_order_completion_events(order_kind,order_ref,dispatch_completed_at,completion_evidence_type,completion_evidence_id)
    SELECT 'SO','SO-BROWSER-HISTORY-'||g,'2098-01-01','driver_job','browser-history-job-'||g FROM generate_series(1,28500) g`);
  await f.query('ANALYZE driver_job_corrections; ANALYZE dispatch_order_completion_events; ANALYZE dispatch_plan_snapshots');
  const plan=await f.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT plan_id FROM dispatch_plan_snapshots
    WHERE dispatch_snapshot_planning_refs(orders,trucks) && ARRAY['TEST-LINKED-SO','__MBBS_ANY_REFERENCE__']`);
  fs.writeFileSync(out+'/planning-index-explain.json',JSON.stringify(plan.rows[0]['QUERY PLAN'],null,2));
  const execute=pool.query.bind(pool);
  pool.query=async(sql,params)=>{const start=performance.now();try{return await execute(sql,params);}finally{
    queryTimes.push({ms:performance.now()-start,sql:String(sql).replace(/'(?:''|[^'])*'/g,"'?'").replace(/\s+/g,' ').slice(0,240)});
  }};
  browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
});
after(async()=>{
  fs.writeFileSync(out+'/query-profiles.json',JSON.stringify(queryTimes,null,2));
  fs.writeFileSync(out+'/timings.json',JSON.stringify(timings,null,2));
  await browser?.close();
  if(f){await f.query('DELETE FROM sales_stock_requests WHERE id=ANY($1::bigint[])',[specials.map(d=>d.id)]);await f.close();}
});
async function load(role,tab,sample){
 const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
 await context.addInitScript(token=>localStorage.setItem('mbbs.staff.token',token),f.users[role].token);
 const page=await context.newPage(),errors=[],api=[];page.on('pageerror',e=>errors.push(e.message));
 page.on('response',r=>{if(r.url().includes('/api/')&&r.status()>=400)api.push({path:new URL(r.url()).pathname,status:r.status()});});
 try{
  const start=performance.now();await page.goto(`${f.base}/${role}/stock-requests?tab=${tab}`,{waitUntil:'domcontentloaded'});
  if(tab==='regular')await page.locator('[data-backorder-detail]').waitFor({state:'visible',timeout:15000});
  else await page.locator(`[data-special-${role}-action="select"].selected`).waitFor({state:'visible',timeout:15000});
  await page.locator('.stock-request-detail').waitFor({state:'visible'});
  const ms=performance.now()-start;
  fs.writeFileSync(`${out}/${role}-${tab}-${sample}.resources.json`,JSON.stringify(await page.evaluate(()=>performance.getEntriesByType('resource').map(r=>({name:new URL(r.name).pathname,start:r.startTime,ms:r.duration,response:r.responseStart}))),null,2));
  const lines=await page.locator('.stock-request-detail').innerText();assert.ok(lines.includes('TEST'),lines.slice(0,300));
  assert.deepEqual(errors,[]);assert.deepEqual(api,[]);
  const row={role,tab,sample,ms:Math.round(ms)};timings.push(row);console.log(JSON.stringify({measurement:'browser-ready',...row}));
  await page.screenshot({path:`${out}/${role}-${tab}-${sample}.png`,fullPage:true});
  assert.ok(ms<=1500,`${role} ${tab} usable-page target exceeded: ${ms.toFixed(1)}ms`);
 }finally{await context.close();}
}
test('queue records preserve complete individual detail and Sales yard authorization',async()=>{
 const old=fs.readFileSync('tools/request-loading-20261008/original-stage-view.sql','utf8');
 const actual=(await f.query("SELECT pg_get_viewdef('special_stock_workflow_stages'::regclass,true) AS sql")).rows[0].sql.replace(/;\s*$/,'');
 const diff=await f.query(`WITH expected AS (${old}), actual AS (${actual}) SELECT count(*)::int AS n FROM (
   (SELECT * FROM expected EXCEPT ALL SELECT * FROM actual) UNION ALL (SELECT * FROM actual EXCEPT ALL SELECT * FROM expected)) difference`);
 assert.equal(diff.rows[0].n,0);
 for(const role of ['sales','scm']) {
  const result=await f.http(role,`/api/${role}/stock-requests?${role==='sales'?'bucket=pending':'queue=request'}`);
  assert.equal(result.status,200);assert.equal(result.body.requests.length,7);
  for(const row of result.body.requests)assert.deepEqual(row,(await f.http(role,`/api/${role}/stock-requests/${row.id}`)).body);
 }
 const foreign=await f.http('foreign','/api/sales/stock-requests?bucket=pending');
 assert.equal(foreign.status,200);assert.deepEqual(foreign.body.requests,[]);
 assert.equal((await f.http('foreign',`/api/sales/stock-requests/${regular[0].id}`)).status,403);
});
for(const role of ['sales','scm'])for(const tab of ['special','regular'])test(`${role} ${tab}: cold browser is usable within 1.5 seconds with historical data`,async()=>{
 for(let i=1;i<=3;i++)await load(role,tab,i);
});
test('concurrent Sales/SCM special/regular page reads retain the same target',async()=>{
 const outcomes=await Promise.allSettled(['sales','scm'].flatMap(role=>['special','regular'].map(tab=>load(role,tab,'concurrent'))));
 for(const outcome of outcomes)if(outcome.status==='rejected')throw outcome.reason;
});
