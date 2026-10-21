import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {app} from '../../../src/server.js';
import {createOperator} from '../../../src/auth-repository.js';
import {query,withTransaction,closeDb} from '../../../src/db.js';
import * as repo from '../../../src/special-stock-request-repository.js';

const run=crypto.randomUUID().replaceAll('-',''),users={},cases=[];
let server,base,flag;
const item=(name='New paver')=>({productName:name,color:'Grey',size:'16',detailSpec:'Smooth',quantity:3,uom:'PCS',rate:12.25,
 discountPercent:10,palletQty:1,layerQty:2,sectionQty:3,pieceQty:4,requiredDate:'2099-02-01',customerNote:'New note'});
async function call(id,body,{role='sales'}={}){
 const response=await fetch(base+'/api/sales/special-stock-requests/'+id+'/items',{method:'POST',headers:{'content-type':'application/json',
 ...(users[role]?.token?{authorization:'Bearer '+users[role].token}:{})},body:JSON.stringify(body)});
 return {status:response.status,payload:await response.json()};
}
async function newCase(count=1){
 const detail=await repo.createSpecialStockCase({storeLocationId:1,inquiryDate:'2099-01-01',customerName:'TEST Original',vendorId:331,vendorName:'TEST Vendor',
 fulfillmentMethod:'yard_pickup',expiresOn:'2099-03-01',lines:Array.from({length:count},(_,i)=>item('Old item '+i))},
 {operatorId:users.sales.id,authorizedStoreLocationIds:[1]});cases.push(detail.id);return detail;
}
async function reviewedCase(){
 let detail=await newCase();
 await query(`UPDATE sales_special_stock_lines SET supply_status='in_stock',sales_decision='accepted',availability_mode='dated',available_date='2099-02-01',
 response_vendor_id=331,response_vendor_name='TEST Vendor',vendor_yard='West yard',sales_visible_note='Ready',scm_internal_note='Private',
 unit_purchase_cost=8,purchase_currency='CAD',response_revision=3,decision_revision=3,stock_checked_at=now(),responded_at=now(),
 resolved_item_id=2055,resolved_item_name='MBBS-Special Order',resolved_description='Old item 0 Grey 16 Smooth',sales_uom='PC',purchase_uom='PC',
 sales_quantity=3,purchase_quantity=3 WHERE request_id=$1`,[detail.id]);
 await query(`INSERT INTO sales_special_stock_order_lines(request_id,case_line_id,order_kind,item_id,item_name,description,quantity,uom,unit_rate,native_discount_percent)
 VALUES($1,$2,'sales_order',2055,'MBBS-Special Order','Old item 0 Grey 16 Smooth',3,'PC',12.25,10)`,[detail.id,detail.lines[0].id]);
 detail=await repo.getSpecialStockCase(detail.id,{audience:'sales',authorizedStoreLocationIds:[1]});return detail;
}
const rows=async id=>(await query('SELECT * FROM sales_special_stock_lines WHERE request_id=$1 ORDER BY line_number',[id])).rows;
const events=async id=>(await query("SELECT * FROM sales_special_stock_events WHERE request_id=$1 AND event_type='special_items_added'",[id])).rows;
before(async()=>{
 assert.equal(process.env.MBT_TEST_ISOLATED,'1');assert.equal(new URL(process.env.DATABASE_URL).hostname,'mbbs-special-review-db');
 flag=(await query("SELECT enabled FROM mbt_feature_flags WHERE flag_key='special_stock_request_workflow'")).rows[0].enabled;
 await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'");
 server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base='http://127.0.0.1:'+server.address().port;
 for(const [name,role,yards] of [['sales','sales',[1]],['outside','sales',[28]],['scm','scm',[]]]){
  const username='items-copy-'+name+'-'+run,password=crypto.randomUUID();
  const user=await createOperator({username,displayName:'TEST '+name,password,role,roles:[role],yardLocationIds:yards});users[name]=user;
  const response=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password})});
  assert.equal(response.status,200);user.token=(await response.json()).token;
 }
});
after(async()=>{
 try{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 await query('DELETE FROM sales_stock_requests WHERE id=ANY($1::bigint[])',[cases]);
 for(const user of Object.values(users)){await query('DELETE FROM delivery_audit_log WHERE actor_operator_id=$1',[user.id]);await query('DELETE FROM operators WHERE id=$1',[user.id]);}
 if(flag!==undefined)await query("UPDATE mbt_feature_flags SET enabled=$1 WHERE flag_key='special_stock_request_workflow'",[flag]);
 }finally{await closeDb();}
});
test('HTTP add items resets New enquiry, preserves every old SQL column and invalidates the unsent SO draft',async()=>{
 const detail=await reviewedCase(),before=await rows(detail.id);assert.equal(detail.stage,'confirmed');
 const response=await call(detail.id,{expectedRevision:detail.revision,lines:[item(),item('Second new item')]});
 assert.equal(response.status,200,JSON.stringify(response.payload));assert.equal(response.payload.id,detail.id);assert.equal(response.payload.stage,'new_enquiry');
 assert.equal(response.payload.revision,detail.revision+1);assert.deepEqual((await rows(detail.id)).slice(0,1),before);
 assert.deepEqual(response.payload.lines.map(line=>line.lineNumber),[1,2,3]);assert.equal(response.payload.lines[1].supplyStatus,null);assert.equal(response.payload.lines[1].salesDecision,'pending');
 assert.equal(response.payload.salesOrderLines.length,0);assert.equal((await events(detail.id)).length,1);
 const listed=await repo.listSpecialStockCases({audience:'scm',stages:['new_enquiry']});assert.ok(listed.some(row=>row.id===detail.id));
 await assert.rejects(repo.claimSpecialOrderOperation(detail.id,{expectedRevision:response.payload.revision,orderKind:'sales_order',operationId:crypto.randomUUID()}),{code:'SPECIAL_SO_DRAFT_REQUIRED'});
});
test('HTTP appends require Sales role, yard access and enabled workflow; anonymous and outside-yard edits change nothing',async()=>{
 const detail=await newCase(),before=await rows(detail.id),body={expectedRevision:detail.revision,lines:[item()]};
 assert.equal((await call(detail.id,body,{role:'none'})).status,401);assert.equal((await call(detail.id,body,{role:'scm'})).status,403);
 assert.equal((await call(detail.id,body,{role:'outside'})).status,403);
 try{await query("UPDATE mbt_feature_flags SET enabled=false WHERE flag_key='special_stock_request_workflow'");assert.equal((await call(detail.id,body)).status,404);}
 finally{await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'");}
 assert.deepEqual(await rows(detail.id),before);assert.equal((await events(detail.id)).length,0);
});
test('HTTP revision conflict and hostile batch validation leave old items, draft, revision and events unchanged',async()=>{
 const detail=await reviewedCase(),before=await rows(detail.id);
 const stale=await call(detail.id,{expectedRevision:detail.revision+1,lines:[item()]});assert.equal(stale.status,409);assert.equal(stale.payload.code,'SPECIAL_REVISION_CONFLICT');
 for(const lines of [[],null,[item(),{...item(),quantity:0}],[{...item(),rate:-1}],[{...item(),uom:'BOGUS'}],[{...item(),productName:'x'.repeat(501)}],[{...item(),requiredDate:'2000-01-01'}]]){
  const response=await call(detail.id,{expectedRevision:detail.revision,lines});assert.equal(response.status,400,JSON.stringify(response.payload));
 }
 assert.deepEqual(await rows(detail.id),before);assert.equal((await events(detail.id)).length,0);
 const current=await repo.getSpecialStockCase(detail.id,{audience:'sales',authorizedStoreLocationIds:[1]});assert.equal(current.revision,detail.revision);assert.equal(current.salesOrderLines.length,1);
});
test('HTTP rejects additions after orders, closure, remote submission, uncertain operations and pending reviews',async()=>{
 for(const assignment of ["close_status='closed'","close_status='closure_pending'","operationally_complete=true","sales_order_netsuite_id=123456789,sales_order_ref='TEST-SOB123456789'", "purchase_order_netsuite_id=123456789,purchase_order_ref='TEST-POB123456789'",'sales_order_skipped=true','sales_order_skipped=true,purchase_order_skipped=true',
 "sales_order_operation_status='creating'","sales_order_operation_status='attention'","purchase_order_operation_status='creating'","sales_order_submission_started_at=now()","purchase_order_submission_started_at=now()",
 "quantity_review='{\"id\":\"test\",\"status\":\"pending\"}'::jsonb","fulfillment_change='{\"id\":\"test\",\"status\":\"pending\"}'::jsonb",'attention=true']){
  const detail=await newCase();await query('UPDATE sales_special_stock_cases SET '+assignment+' WHERE request_id=$1',[detail.id]);const before=await rows(detail.id);
  const response=await call(detail.id,{expectedRevision:detail.revision,lines:[item()]});assert.equal(response.status,409,assignment+': '+JSON.stringify(response.payload));
  assert.deepEqual(await rows(detail.id),before);assert.equal((await events(detail.id)).length,0);
 }
});
test('HTTP combined count accepts exactly 100 items and rejects 101 without inserting anything',async()=>{
 const detail=await newCase(99),response=await call(detail.id,{expectedRevision:detail.revision,lines:[item()]});
 assert.equal(response.status,200,JSON.stringify(response.payload));assert.equal(response.payload.lines.length,100);
 const before=await rows(detail.id),overflow=await call(detail.id,{expectedRevision:response.payload.revision,lines:[item()]});
 assert.equal(overflow.status,400);assert.equal(overflow.payload.code,'SPECIAL_CASE_LINES_INVALID');assert.deepEqual(await rows(detail.id),before);
});
test('database failure on the second insert rolls back the first, SO draft deletion, revision bump and event',async()=>{
 assert.equal(typeof repo.addSpecialStockItems,'function');const detail=await reviewedCase(),before=await rows(detail.id);
 await withTransaction(async()=>{
  await query(`CREATE FUNCTION item_fault_${run}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.request_id=${detail.id} AND NEW.product_name='reject fixture' THEN RAISE EXCEPTION 'injected item failure'; END IF; RETURN NEW; END $$`);
  await query(`CREATE TRIGGER item_fault_${run} BEFORE INSERT ON sales_special_stock_lines FOR EACH ROW EXECUTE FUNCTION item_fault_${run}()`);
  await assert.rejects(repo.addSpecialStockItems(detail.id,{expectedRevision:detail.revision,lines:[item(),item('reject fixture')]},{operatorId:users.sales.id,authorizedStoreLocationIds:[1]}),/injected item failure/);
  assert.deepEqual(await rows(detail.id),before);assert.equal((await events(detail.id)).length,0);
  const current=await repo.getSpecialStockCase(detail.id,{audience:'sales',authorizedStoreLocationIds:[1]});assert.equal(current.revision,detail.revision);assert.equal(current.salesOrderLines.length,1);
 },{rollback:true});
});
test('concurrent appends commit once per revision; rejected duplicate submission adds no duplicate lines',async()=>{
 const detail=await newCase(),body={expectedRevision:detail.revision,lines:[item()]};
 const responses=await Promise.all([call(detail.id,body),call(detail.id,body)]);assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
 assert.equal((await rows(detail.id)).length,2);assert.equal((await events(detail.id)).length,1);
});
test('order claim and append serialize on the same row and never leave a claimed SO with an unreviewed new item',async()=>{
 assert.equal(typeof repo.addSpecialStockItems,'function');
 for(let iteration=0;iteration<6;iteration++){
  const detail=await reviewedCase(),context={operatorId:users.sales.id,authorizedStoreLocationIds:[1]};
  const add=()=>repo.addSpecialStockItems(detail.id,{expectedRevision:detail.revision,lines:[item()]},context);
  const claim=()=>repo.claimSpecialOrderOperation(detail.id,{expectedRevision:detail.revision,orderKind:'sales_order',operationId:crypto.randomUUID()},context);
  const results=await Promise.allSettled(iteration%2?[claim(),add()]:[add(),claim()]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const current=await repo.getSpecialStockCase(detail.id,{audience:'sales',authorizedStoreLocationIds:[1]});
  if(current.salesOrderOperationStatus==='creating'){assert.equal(current.lines.length,1);assert.equal(current.salesOrderLines.length,1);}
  else{assert.equal(current.lines.length,2);assert.equal(current.salesOrderLines.length,0);assert.equal(current.stage,'new_enquiry');}
 }
});
test('direct item update rejects a missing actor and preserves the request',async()=>{
 const detail=await newCase(),before=await rows(detail.id);
 await assert.rejects(repo.addSpecialStockItems(detail.id,{expectedRevision:detail.revision,lines:[item()]},{authorizedStoreLocationIds:[1]}),{status:401,code:'SPECIAL_ACTOR_REQUIRED'});
 assert.deepEqual(await rows(detail.id),before);assert.equal((await events(detail.id)).length,0);
});
test('hostile item fields cannot mark new items reviewed, alter prices or replace the existing vendor and header',async()=>{
 const detail=await newCase(),before=await rows(detail.id);
 const response=await call(detail.id,{expectedRevision:detail.revision,vendorId:999,storeLocationId:28,salesOrderId:42,closeStatus:'closed',
 lines:[{...item(),id:detail.lines[0].id,brand:'Injected vendor',supplyStatus:'in_stock',salesDecision:'accepted',originalRate:9999,unitPurchaseCost:0,itemResolution:{itemId:999}}]});
 assert.equal(response.status,200,JSON.stringify(response.payload));assert.deepEqual((await rows(detail.id)).slice(0,1),before);
 assert.equal(response.payload.vendorId,331);assert.equal(response.payload.storeLocationId,1);assert.equal(response.payload.closeStatus,'active');assert.equal(response.payload.salesOrderId,null);
 const added=response.payload.lines[1];assert.equal(added.brand,'TEST Vendor');assert.equal(added.originalRate,12.25);assert.equal(added.supplyStatus,null);assert.equal(added.salesDecision,'pending');assert.equal(Object.hasOwn(added,'unitPurchaseCost'),false);assert.equal(added.itemResolution,null);
 const stored=(await rows(detail.id))[1];assert.equal(stored.unit_purchase_cost,null);assert.equal(stored.resolved_item_id,null);
});
