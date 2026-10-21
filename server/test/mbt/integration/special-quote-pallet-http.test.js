import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import crypto from 'node:crypto';
import {app} from '../../../src/server.js';
import {createOperator} from '../../../src/auth-repository.js';
import {specialSalesReps} from '../../../src/special-stock-sales-reps.js';
import {query,closeDb} from '../../../src/db.js';
import * as repo from '../../../src/special-stock-request-repository.js';
import {pdfText} from '../../field-sales/pdf-text.js';

const run=crypto.randomUUID().replaceAll('-',''),users={},cases=[],originalFetch=globalThis.fetch,originalSelect=specialSalesReps.select;
const profile={name:'Mr Bin Building Supply LTD',address:'3445 Kennedy Road, Toronto',phone:'416-555-0100',taxBps:1300,validityDays:30};
let server,base,flag,settings,remoteCalls=0;
const draft=()=>({storeLocationId:1,inquiryDate:'2099-01-01',expiresOn:'2099-03-01',salesRepId:123,customerName:'TEST Quote Customer',vendorName:'TEST Vendor',
 fulfillmentMethod:'yard_pickup',palletTotal:3,palletRate:40,lines:[{productName:'TEST Stone',quantity:2,uom:'PCS',rate:100,discountPercent:10,requiredDate:'2099-02-01'}]});
async function call(path,{body,role='sales',method=body?'POST':'GET'}={}){
 const response=await originalFetch(base+path,{method,headers:{...(users[role]?.token?{authorization:'Bearer '+users[role].token}:{}),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
 if(response.headers.get('content-type')?.includes('application/pdf'))return {status:response.status,headers:response.headers,buffer:Buffer.from(await response.arrayBuffer())};
 const payload=await response.json();if(path==='/api/sales/special-stock-requests'&&response.status===201)cases.push(payload.id);
 return {status:response.status,payload};
}
const preview='/api/sales/special-stock-requests/quote-preview',create='/api/sales/special-stock-requests';
before(async()=>{
 assert.equal(process.env.MBT_TEST_ISOLATED,'1');assert.equal(process.env.NETSUITE_DIRECT_ACCESS_ENABLED,'false');assert.equal(new URL(process.env.DATABASE_URL).hostname,'mbbs-special-review-db');
 flag=(await query("SELECT enabled FROM mbt_feature_flags WHERE flag_key='special_stock_request_workflow'")).rows[0].enabled;
 await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'");
 settings=(await query('SELECT data FROM field_sales_settings WHERE singleton')).rows[0].data;
 await query('UPDATE field_sales_settings SET data=$1::jsonb WHERE singleton',[JSON.stringify({...settings,companies:{...settings.companies,MBBS:profile}})]);
 specialSalesReps.select=async id=>{assert.equal(Number(id),123);return {id:123,name:'TEST Quote rep'};};
 await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,raw,synced_at) VALUES(2055,'MBBS-Special Order','PC','{}',now()),(1784,'PALLET','EACH','{}',now()) ON CONFLICT DO NOTHING");
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
 try{globalThis.fetch=originalFetch;specialSalesReps.select=originalSelect;
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  await query('DELETE FROM sales_stock_requests WHERE id=ANY($1::bigint[])',[cases]);
  for(const user of Object.values(users)){await query('DELETE FROM delivery_audit_log WHERE actor_operator_id=$1',[user.id]);await query('DELETE FROM operators WHERE id=$1',[user.id]);}
  if(settings)await query('UPDATE field_sales_settings SET data=$1::jsonb WHERE singleton',[JSON.stringify(settings)]);
  if(flag!==undefined)await query("UPDATE mbt_feature_flags SET enabled=$1 WHERE flag_key='special_stock_request_workflow'",[flag]);
 }finally{await closeDb();}
});
test('authenticated initial quote PDFs add positive PALLET and omit zero without creating any request or calling NetSuite',async()=>{
 const count=(await query('SELECT count(*) FROM sales_stock_requests')).rows[0].count;
 for(const total of [3,0]){
  const response=await call(preview,{body:{...draft(),palletTotal:total}});assert.equal(response.status,200);
  assert.equal(response.headers.get('content-type'),'application/pdf');assert.match(response.headers.get('cache-control'),/no-store/);
  const text=pdfText(response.buffer);if(total){assert.equal(text.split('PALLET').length,2);assert.match(text,/HST \(13%\)\$39\.00Total CAD\$339\.00/);}else{assert.doesNotMatch(text,/PALLET/);assert.match(text,/Total CAD\$203\.40/);}
 }
 assert.equal((await query('SELECT count(*) FROM sales_stock_requests')).rows[0].count,count);assert.equal(remoteCalls,0);
});
test('Submit to SCM persists quoted PALLET values for the saved PDF and subsequent SO draft',async()=>{
 const response=await call(create,{body:draft()});assert.equal(response.status,201,JSON.stringify(response.payload));let detail=response.payload;
 assert.equal(detail.palletTotal,3);assert.equal(detail.palletRate,40);assert.equal(detail.salesOrderId,null);assert.equal(detail.purchaseOrderId,null);
 const stored=(await query('SELECT pallet_total,pallet_rate FROM sales_special_stock_cases WHERE request_id=$1',[detail.id])).rows[0];assert.equal(Number(stored.pallet_total),3);assert.equal(Number(stored.pallet_rate),40);
 let document=await call(`/api/sales/special-stock-requests/${detail.id}/quote.pdf`);assert.equal(document.status,200);assert.equal(pdfText(document.buffer).split('PALLET').length,2);
 const context={operatorId:users.sales.id,authorizedStoreLocationIds:[1]};
 detail=await repo.respondSpecialStockLine(detail.id,detail.lines[0].id,{expectedRevision:detail.revision,supplyStatus:'in_stock',availabilityMode:'no_projection',vendorId:331,vendorName:'TEST Vendor',vendorYard:'TEST Yard'},context);
 detail=await repo.decideSpecialStockLine(detail.id,detail.lines[0].id,{expectedRevision:detail.revision,decision:'accepted'},context);
 detail=await repo.saveSpecialSalesOrderDraft(detail.id,{expectedRevision:detail.revision,customerId:8899397,operationalYardLocationId:1,fulfillmentMethod:'yard_pickup',palletTotal:detail.palletTotal,palletRate:detail.palletRate,
  materialLines:[{caseLineId:detail.lines[0].id,itemId:2055,description:'TEST Stone',quantity:2,packageQuantity:2,conversionToPc:1,uom:'PC',rate:100,discountPercent:10}]},context);
 const pallets=detail.salesOrderLines.filter(line=>line.itemId===1784);assert.equal(pallets.length,1);assert.equal(pallets[0].quantity,3);assert.equal(pallets[0].rate,40);
 document=await call(`/api/sales/special-stock-requests/${detail.id}/quote.pdf`);assert.equal(document.status,200);assert.equal(pdfText(document.buffer).split('PALLET').length,2);assert.match(pdfText(document.buffer),/Total CAD\$339\.00/);assert.equal(remoteCalls,0);
});
test('invalid PALLET inputs, anonymous viewers and other yards cannot create partial records or disclose quote PDFs',async()=>{
 const count=(await query('SELECT count(*) FROM sales_stock_requests')).rows[0].count;
 for(const path of [preview,create]){
  assert.equal((await call(path,{role:'none',body:draft()})).status,401);assert.equal((await call(path,{role:'outside',body:draft()})).status,403);assert.equal((await call(path,{role:'scm',body:draft()})).status,403);
  for(const patch of [{palletTotal:-1},{palletTotal:1.5},{palletRate:-1},{palletRate:null},{palletRate:.1234567},{palletTotal:1000000000,palletRate:1000000000}])assert.equal((await call(path,{body:{...draft(),...patch}})).status,400);
 }
 assert.equal((await query('SELECT count(*) FROM sales_stock_requests')).rows[0].count,count);assert.equal(remoteCalls,0);
});
