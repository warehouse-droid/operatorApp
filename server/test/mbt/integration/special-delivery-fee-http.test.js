import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import crypto from 'node:crypto';
import {app} from '../../../src/server.js';
import {createOperator} from '../../../src/auth-repository.js';
import {performance} from 'node:perf_hooks';
import * as repDirectory from '../../../src/special-stock-sales-reps.js';
import {writeFileSync,mkdirSync} from 'node:fs';
import {query,closeDb} from '../../../src/db.js';
import * as repo from '../../../src/special-stock-request-repository.js';
import {pdfText} from '../../field-sales/pdf-text.js';

const run=crypto.randomUUID().replaceAll('-',''),users={},cases=[],originalFetch=globalThis.fetch;
const profile={name:'Mr Bin Building Supply LTD',address:'3445 Kennedy Road, Toronto',phone:'416-555-0100',taxBps:1300,validityDays:30};
let server,base,flag,settings,cache,remoteCalls=0;
const draft=()=>({storeLocationId:1,inquiryDate:'2099-01-01',expiresOn:'2099-03-01',salesRepId:123,customerName:'TEST Quote Customer',vendorName:'TEST Vendor',
 fulfillmentMethod:'mbt_delivery',deliveryAddress:'TEST Delivery Address',deliveryFeeRate:235,palletTotal:3,palletRate:40,lines:[{productName:'TEST Stone',quantity:2,uom:'PCS',rate:100,discountPercent:10,requiredDate:'2099-02-01'}]});
async function call(path,{body,role='sales',method=body?'POST':'GET'}={}){
 const response=await originalFetch(base+path,{method,headers:{...(users[role]?.token?{authorization:'Bearer '+users[role].token}:{}),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
 if(response.headers.get('content-type')?.includes('application/pdf'))return {status:response.status,headers:response.headers,buffer:Buffer.from(await response.arrayBuffer())};
 const payload=await response.json();if(path==='/api/sales/special-stock-requests'&&response.status===201)cases.push(payload.id);
 return {status:response.status,payload};
}
const create='/api/sales/special-stock-requests';
before(async()=>{
 assert.equal(process.env.MBT_TEST_ISOLATED,'1');assert.equal(process.env.NETSUITE_DIRECT_ACCESS_ENABLED,'false');assert.equal(new URL(process.env.DATABASE_URL).hostname,'mbbs-special-review-db');
 flag=(await query("SELECT enabled FROM mbt_feature_flags WHERE flag_key='special_stock_request_workflow'")).rows[0].enabled;
 await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'");
 settings=(await query('SELECT data FROM field_sales_settings WHERE singleton')).rows[0].data;
 await query('UPDATE field_sales_settings SET data=$1::jsonb WHERE singleton',[JSON.stringify({...settings,companies:{...settings.companies,MBBS:profile}})]);
 cache=(await query('SELECT * FROM special_stock_sales_rep_cache WHERE singleton')).rows[0];
 const cacheStore=repDirectory.specialSalesRepCache ?? {saveCache:async reps=>{await query(`INSERT INTO special_stock_sales_rep_cache(singleton,reps) VALUES(true,$1::jsonb) ON CONFLICT(singleton) DO UPDATE SET reps=EXCLUDED.reps`,[JSON.stringify(reps)]);}};
 await repDirectory.createSpecialSalesRepDirectory({...cacheStore,queryAll:async()=>[{id:123,name:'TEST Local rep'}]}).list();
 // Older captured source has no cache adapter; seed only the fixture so RED exercises submission itself.
 if(!repDirectory.specialSalesRepCache)await cacheStore.saveCache([{id:123,name:'TEST Local rep'}]);
 await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,raw,synced_at) VALUES(2055,'MBBS-Special Order','PC','{}',now()),(1784,'PALLET','EACH','{}',now()),(1987,'Delivery Charge',NULL,'{}',now()) ON CONFLICT DO NOTHING");
 await query("INSERT INTO netsuite_customers(netsuite_id,entity_number,legal_name,display_name,currency,active,source_modified_at,source_version,payload_hash) VALUES(8899397,'TEST-QUOTE-CUSTOMER','TEST Quote Customer','TEST Quote Customer','CAD',true,now(),'test',repeat('f',64)) ON CONFLICT DO NOTHING");
 server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base='http://127.0.0.1:'+server.address().port;
 for(const [name,role,yards] of [['sales','sales',[1]],['outside','sales',[28]],['scm','scm',[]]]){
  const username='quote-pallet-'+name+'-'+run,password=crypto.randomUUID();
  const user=await createOperator({username,displayName:'TEST '+name,password,role,roles:[role],yardLocationIds:yards});users[name]=user;
  const response=await originalFetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password})});assert.equal(response.status,200);user.token=(await response.json()).token;
 }
 globalThis.fetch=(url,options)=>{if(String(url).startsWith(base+'/'))return originalFetch(url,options);remoteCalls++;throw Error('Unexpected external call while testing local PALLET quotes');};
});
after(async()=>{
 try{globalThis.fetch=originalFetch;
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  await query('DELETE FROM sales_stock_requests WHERE id=ANY($1::bigint[])',[cases]);
  for(const user of Object.values(users)){await query('DELETE FROM delivery_audit_log WHERE actor_operator_id=$1',[user.id]);await query('DELETE FROM operators WHERE id=$1',[user.id]);}
  if(cache)await query('UPDATE special_stock_sales_rep_cache SET reps=$1::jsonb,refreshed_at=$2 WHERE singleton',[JSON.stringify(cache.reps),cache.refreshed_at]);else await query('DELETE FROM special_stock_sales_rep_cache');
  if(settings)await query('UPDATE field_sales_settings SET data=$1::jsonb WHERE singleton',[JSON.stringify(settings)]);
  if(flag!==undefined)await query("UPDATE mbt_feature_flags SET enabled=$1 WHERE flag_key='special_stock_request_workflow'",[flag]);
 }finally{await closeDb();}
});

test('local HTTP submission retains the Sales fee, produces a quote and prepares a customer-only SO charge',async()=>{
 const response=await call(create,{body:{...draft(),netsuiteSalesRep:{id:666,name:'Forged name'}}});assert.equal(response.status,201,JSON.stringify(response.payload));let detail=response.payload;
 assert.equal(detail.deliveryFeeRate,235);assert.equal(detail.netsuiteSalesRepName,'TEST Local rep');
 const document=await call(`/api/sales/special-stock-requests/${detail.id}/quote.pdf`);assert.equal(document.status,200);assert.match(pdfText(document.buffer),/Delivery Charge/);assert.match(pdfText(document.buffer),/Total CAD\$604\.55/);
 const context={operatorId:users.sales.id,authorizedStoreLocationIds:[1]};
 detail=await repo.respondSpecialStockLine(detail.id,detail.lines[0].id,{expectedRevision:detail.revision,supplyStatus:'in_stock',availabilityMode:'no_projection',vendorId:331,vendorName:'TEST Vendor',vendorYard:'TEST Yard'},context);
 detail=await repo.decideSpecialStockLine(detail.id,detail.lines[0].id,{expectedRevision:detail.revision,decision:'accepted'},context);
 const input={expectedRevision:detail.revision,customerId:8899397,operationalYardLocationId:1,fulfillmentMethod:'mbt_delivery',deliveryAddress:'TEST Address',deliveryFeeRate:235,palletTotal:3,palletRate:40,
 materialLines:[{caseLineId:detail.lines[0].id,itemId:2055,description:'TEST Stone',quantity:2,packageQuantity:2,conversionToPc:1,uom:'PC',rate:100,discountPercent:10}]};
 detail=await repo.saveSpecialSalesOrderDraft(detail.id,input,context);
 const fees=detail.salesOrderLines.filter(l=>l.itemId===1987);assert.equal(fees.length,1);assert.equal(fees[0].ancillary,true);assert.equal(fees[0].rate,235);assert.equal(fees[0].quantity,1);assert.equal(fees[0].uom,null);
 assert.equal(detail.purchaseOrderLines.filter(l=>l.itemId===1987).length,0);assert.equal(detail.lines.length,1);
 detail=await repo.saveSpecialSalesOrderDraft(detail.id,{...input,expectedRevision:detail.revision,deliveryFeeRate:0},context);assert.equal(detail.deliveryFeeRate,0);assert.deepEqual(detail.salesOrderLines.filter(l=>l.itemId===1987),[]);
 detail=await repo.saveSpecialSalesOrderDraft(detail.id,{...input,expectedRevision:detail.revision,fulfillmentMethod:'yard_pickup'},context);assert.equal(detail.deliveryFeeRate,null);assert.equal(detail.salesOrderLines.filter(l=>l.itemId===1987).length,0);assert.equal(remoteCalls,0);
});
test('invalid rates, forged rep IDs and unauthorized users cannot partially save',async()=>{
 const count=(await query('SELECT count(*) FROM sales_stock_requests')).rows[0].count;
 for(const patch of [{deliveryFeeRate:-1},{deliveryFeeRate:''},{deliveryFeeRate:.1234567},{salesRepId:987654}])assert.equal((await call(create,{body:{...draft(),...patch}})).status,400);
 for(const [role,status] of [['none',401],['outside',403],['scm',403]])assert.equal((await call(create,{role,body:draft()})).status,status);
 assert.equal((await query('SELECT count(*) FROM sales_stock_requests')).rows[0].count,count);assert.equal(remoteCalls,0);
});
test('new local requests with 1, 10 and 100 lines complete within one second without network access',async()=>{
 const timings=[];
 for(const count of [1,10,100])for(let repeat=0;repeat<3;repeat++){
  const input=draft();input.lines=Array.from({length:count},(_,i)=>({...input.lines[0],productName:'TEST Stone '+i}));
  const start=performance.now(),response=await call(create,{body:input}),ms=performance.now()-start;
  assert.equal(response.status,201,JSON.stringify(response.payload));assert.equal(response.payload.lines.length,count);assert.ok(ms<1000,`${count} lines took ${ms.toFixed(1)} ms`);timings.push({lines:count,ms});
 }
 assert.equal(remoteCalls,0);mkdirSync('test-artifacts/special-delivery-fee-20261001',{recursive:true});writeFileSync('test-artifacts/special-delivery-fee-20261001/timings.json',JSON.stringify(timings,null,2));console.log('submission timings '+JSON.stringify(timings));
});
