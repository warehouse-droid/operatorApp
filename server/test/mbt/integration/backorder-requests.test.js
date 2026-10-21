import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, {before, after} from 'node:test';
import {app} from '../../../src/server.js';
import {createOperator} from '../../../src/auth-repository.js';
import {query,closeDb,withTransaction} from '../../../src/db.js';
import * as special from '../../../src/special-stock-request-repository.js';
import {buildSpecialQuote} from '../../../src/special-stock-documents.js';

const run=crypto.randomUUID(), users={}, requests=[],plans=[],extraPurchaseIds=[];
const sku=88999001, bag=88999002, so=88999101, po=88999102;
const nativeFetch=globalThis.fetch;
let server, base, outbound=0;
before(async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');
  assert.equal(new URL(process.env.DATABASE_URL).hostname,'db');
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'");
  await query("INSERT INTO inventory_items(item_id,item_name,display_name,item_description,stock_unit,vendor,raw,synced_at) VALUES($1,'TEST-BO-EA','Regular each material','Regular description','EA','TEST BO Vendor','{}',now()),($2,'TEST-BO-BAG','Regular bag material','Bag description','BAG','TEST BO Vendor','{}',now()) ON CONFLICT DO NOTHING",[sku,bag]);
  await query("INSERT INTO inventory_items(item_id,item_name,display_name,stock_unit,vendor,to_plt) VALUES(88999003,'TEST-BO-NATIVE','Native regular material','889','TEST BO Vendor',NULL),(88999004,'TEST-BO-CONVERTED','Converted regular material','Ton','TEST BO Vendor',2.5)");
  await query("INSERT INTO sales_orders(netsuite_id,tranid,customer_id,order_location_id,status_text,netsuite_active) VALUES($1,'TEST-BO-SO',18,28,'Closed',false) ON CONFLICT DO NOTHING",[so]);
  await query("INSERT INTO purchase_orders(netsuite_id,tranid,vendor_id,destination_location_id,status_text,netsuite_active) VALUES($1,'TEST-BO-PO',19,28,'Pending Approval',false) ON CONFLICT DO NOTHING",[po]);
  server=app.listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r));
  base='http://127.0.0.1:'+server.address().port;
  for(const role of ['sales','scm','foreign']){
    const username='backorder-'+role+'-'+run,password=crypto.randomUUID(), actual=role==='foreign'?'sales':role;
    users[role]=await createOperator({username,password,displayName:'TEST '+role,role:actual,roles:[actual],yardLocationIds:actual==='sales'?[role==='foreign'?28:1]:[]});
    const r=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password})});
    assert.equal(r.status,200);users[role].token=(await r.json()).token;
  }
  globalThis.fetch=async()=>{outbound++;throw Error('Backorder must not call external services');};
});
after(async()=>{
  globalThis.fetch=nativeFetch;
  if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
  await query('DELETE FROM sales_stock_requests WHERE id=ANY($1::bigint[])',[requests]);
  await query('DELETE FROM dispatch_plans WHERE id=ANY($1::bigint[])',[plans]);
  await query('DELETE FROM purchase_orders WHERE netsuite_id=ANY($1::bigint[])',[[po,...extraPurchaseIds]]);
  await query('DELETE FROM sales_orders WHERE netsuite_id IN ($1,$2)',[so,so+20]);
  for(const user of Object.values(users)){
    await query('DELETE FROM delivery_audit_log WHERE actor_operator_id=$1',[user.id]);
    await query('DELETE FROM operators WHERE id=$1',[user.id]);
  }
  await closeDb();assert.equal(outbound,0);
});
async function http(role,path,method='GET',body){
  const r=await nativeFetch(base+path,{method,headers:{authorization:'Bearer '+users[role].token,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:r.status,body:await r.json()};
}
const regular='/api/sales/stock-requests';
async function create(extra={}){
  const r=await http('sales',regular,'POST',{deliveryMethod:'backorder',workflowVersion:2,destinationLocationId:1,customerName:'',vendorId:331,vendorName:'TEST BO Vendor',inquiryDate:'2099-01-01',fulfillmentMethod:'vendor_pickup',
    lines:[{itemId:sku,salesQty:7,quantityMode:'direct',rate:10,discountPercent:5,requiredDate:'2099-02-01'},{itemId:bag,salesQty:9,quantityMode:'direct',rate:12,requiredDate:'2099-02-01'}],...extra});
  assert.equal(r.status,201,JSON.stringify(r.body));requests.push(r.body.id);return r.body;
}
const path=(d,role,action)=>`/api/${role}/stock-requests/${d.id}/backorder/${action}`;
async function action(d,role,name,input={},method='POST'){
  const r=await http(role,path(d,role,name),method,{expectedRevision:d.revision,...input});
  assert.equal(r.status,200,JSON.stringify(r.body));return r.body;
}
async function reviewed(d){
  for(const line of d.lines)d=await action(d,'scm',`lines/${line.id}/response`,{supplyStatus:'in_stock',availabilityMode:'no_projection',vendorId:331,vendorName:'TEST BO Vendor',vendorYard:'Vendor yard',scmInternalNote:'Private purchasing note'});
  for(const line of d.lines)d=await action(d,'sales',`lines/${line.id}/decision`,{decision:'accepted'});
  return d;
}
async function poLinked(d,ref='TEST-BO-PO'){return action(d,'scm','purchase-order/link',{purchaseOrderRef:ref});}
async function planPo(ref='TEST-BO-PO',status='draft',assigned=true){
  const plan={orders:[{id:ref,type:'PO'}],trucks:[{plate:'TEST BO TRUCK',loads:[{name:'TEST load',stops:assigned?[{type:'pickup',orderId:ref}]:[]}]}]};
  const {assertSpecialStockHandoffPlanning}=await import('../../../src/dispatch-plan-repository.js');
  return withTransaction(async()=>{await assertSpecialStockHandoffPlanning(plan);const id=(await query("INSERT INTO dispatch_plans(plan_date,status) VALUES('2099-04-10'::date+$2::integer,$1) RETURNING id",[status,plans.length])).rows[0].id;plans.push(id);await query("INSERT INTO dispatch_plan_snapshots(plan_id,orders,trucks,summary) VALUES($1,$2,$3,'{}')",[id,JSON.stringify(plan.orders),JSON.stringify(plan.trucks)]);return id;});
}
async function linked(d){d=await poLinked(d);await planPo();return action(d,'sales','sales-order/link',{salesOrderRef:'test-bo-so'});}
async function uniquePo(){const id=po+100+extraPurchaseIds.length,ref='TEST-BO-PO-'+id;extraPurchaseIds.push(id);await query("INSERT INTO purchase_orders(netsuite_id,tranid,vendor_id,destination_location_id,netsuite_active,status_text) VALUES($1,$2,19,28,false,'Closed')",[id,ref]);return {id,ref};}

test('PO recheck allows SCM reference linking after SO and repeated stock updates',async()=>{
  let d=await reviewed(await create());
  d=await action(d,'sales','sales-order/link',{salesOrderRef:'TEST-BO-SO'});
  const originalSo=d.salesOrderId;
  for(const response of [
    {supplyStatus:'production',availabilityMode:'dated',availableDate:'2099-03-02'},
    {supplyStatus:'in_stock',availabilityMode:'no_projection'}
  ]) d=await action(d,'scm',`lines/${d.lines[0].id}/response`,{...response,vendorId:331,vendorName:'TEST BO Vendor',vendorYard:'Vendor yard'});
  assert.equal(d.stage,'confirmed');assert.equal(d.lines[0].salesDecision,'pending');assert.equal(d.purchaseOrderId,null);
  const lines=d.lines,revision=d.revision;
  const ordersBefore=(await query('SELECT to_jsonb(s) AS so,to_jsonb(p) AS po FROM sales_orders s,purchase_orders p WHERE s.netsuite_id=$1 AND p.netsuite_id=$2',[so,po])).rows;
  assert.equal((await http('scm',path(d,'scm','purchase-order/link'),'POST',{expectedRevision:revision-1,purchaseOrderRef:'TEST-BO-PO'})).status,409);
  assert.equal((await http('sales',path(d,'scm','purchase-order/link'),'POST',{expectedRevision:revision,purchaseOrderRef:'TEST-BO-PO'})).status,403);
  d=await poLinked(d);
  assert.equal(d.purchaseOrderId,po);assert.equal(d.purchaseOrderRef,'TEST-BO-PO');assert.equal(d.salesOrderId,originalSo);
  assert.equal(d.revision,revision+1);assert.deepEqual(d.lines,lines);
  assert.equal(d.events.filter(event=>event.eventType==='special_purchase_order_linked').length,1);
  assert.deepEqual((await query('SELECT to_jsonb(s) AS so,to_jsonb(p) AS po FROM sales_orders s,purchase_orders p WHERE s.netsuite_id=$1 AND p.netsuite_id=$2',[so,po])).rows,ordersBefore);
});
test('PO recheck keeps missing review and explicit Sales update guards on an SO-linked case',async()=>{
  let pending=await create();
  for(const line of pending.lines) pending=await action(pending,'scm',`lines/${line.id}/response`,{supplyStatus:'in_stock',availabilityMode:'no_projection',vendorId:331,vendorName:'TEST BO Vendor',vendorYard:'Vendor yard'});
  const forged=await http('scm',path(pending,'scm','purchase-order/link'),'POST',{expectedRevision:pending.revision,purchaseOrderRef:'TEST-BO-PO',salesOrderId:so,salesOrderRef:'TEST-BO-SO'});
  assert.equal(forged.status,409);assert.equal(forged.body.code,'BACKORDER_SALES_ACCEPTANCE_REQUIRED');
  let d=await action(await reviewed(await create()),'sales','sales-order/link',{salesOrderRef:'TEST-BO-SO'});
  const lineId=d.lines[0].id;
  d=await action(d,'sales',`lines/${lineId}/edit`,{quantity:8});
  const blocked=async()=>{
    const r=await http('scm',path(d,'scm','purchase-order/link'),'POST',{expectedRevision:d.revision,purchaseOrderRef:'TEST-BO-PO',salesOrderId:so,stockCheckedAt:'2099-01-01',salesDecision:'accepted'});
    assert.equal(r.status,409);assert.equal(r.body.code,'BACKORDER_SALES_ACCEPTANCE_REQUIRED');
    assert.equal((await http('scm','/api/scm/stock-requests/'+d.id)).body.purchaseOrderId,null);
  };
  await blocked();
  d=await action(d,'scm',`lines/${lineId}/response`,{supplyStatus:'in_stock',availabilityMode:'no_projection',vendorId:331,vendorName:'TEST BO Vendor',vendorYard:'Vendor yard'});
  d=await action(d,'sales',`lines/${lineId}/decision`,{decision:'request_update',reason:'Please check the revised material'});
  await blocked();
});

test('Backorder NetSuite quotation number is editable throughout every stage without changing workflow or native orders',async()=>{
  const orderBefore=(await query('SELECT * FROM sales_orders WHERE netsuite_id=$1',[so])).rows[0];
  let d=await create();
  const attach=async()=>{
    const previous=(await http('sales',regular+'/'+d.id)).body,number='QUOT-'+d.id+'-'+d.revision;
    const materialRows=(await query('SELECT * FROM sales_special_stock_lines WHERE request_id=$1 ORDER BY id',[d.id])).rows;
    d=await action(d,'sales','quotation/link',{quotationNumber:'  '+number+'  ',remarks:'Ignore this unrelated field',salesOrderRef:'UNKNOWN'});
    assert.equal(d.estimateNumber,number);assert.equal(d.revision,previous.revision+1);assert.equal(d.stage,previous.stage);
    assert.equal(d.closeStatus,previous.closeStatus);assert.equal(d.remarks,previous.remarks);
    assert.equal(d.salesOrderId,previous.salesOrderId);assert.equal(d.purchaseOrderId,previous.purchaseOrderId);
    assert.deepEqual(d.lines,previous.lines);assert.ok(d.events.some(event=>event.eventType==='backorder_quotation_linked'));
    assert.deepEqual((await query('SELECT * FROM sales_special_stock_lines WHERE request_id=$1 ORDER BY id',[d.id])).rows,materialRows);
    assert.equal((await http('sales',regular+'/'+d.id)).body.estimateNumber,number);
  };
  await attach();d=await reviewed(d);await attach();d=await poLinked(d);await attach();
  await planPo();d=await action(d,'sales','sales-order/link',{salesOrderRef:'TEST-BO-SO'});assert.equal(d.stage,'confirmed');await attach();
  d=await action(await create(),'sales','close',{reason:'Quotation can be added later'});assert.equal(d.stage,'closed');await attach();
  assert.deepEqual((await query('SELECT * FROM sales_orders WHERE netsuite_id=$1',[so])).rows[0],orderBefore);
});
test('Backorder quotation attachments enforce Sales access, input bounds and atomic revision conflicts',async()=>{
  const d=await create(),before=(await http('sales',regular+'/'+d.id)).body;
  for(const number of ['',null,123,{},'x'.repeat(101)]){
    const r=await http('sales',path(d,'sales','quotation/link'),'POST',{expectedRevision:d.revision,quotationNumber:number});assert.equal(r.status,400);
  }
  assert.equal((await http('foreign',path(d,'sales','quotation/link'),'POST',{expectedRevision:d.revision,quotationNumber:'QUOT-FOREIGN'})).status,403);
  assert.equal((await http('scm',path(d,'scm','quotation/link'),'POST',{expectedRevision:d.revision,quotationNumber:'QUOT-SCM'})).status,409);
  assert.deepEqual((await http('sales',regular+'/'+d.id)).body,before);
  const saves=await Promise.all(['QUOT-ONE','QUOT-TWO'].map(quotationNumber=>http('sales',path(d,'sales','quotation/link'),'POST',{expectedRevision:d.revision,quotationNumber})));
  assert.deepEqual(saves.map(r=>r.status).sort(),[200,409]);
  const current=(await http('sales',regular+'/'+d.id)).body;assert.equal(current.revision,d.revision+1);assert.equal(current.events.filter(e=>e.eventType==='backorder_quotation_linked').length,1);
  assert.equal((await http('sales',path(current,'sales','quotation/link'),'POST',{quotationNumber:'QUOT-NO-REVISION'})).status,409);
  assert.equal((await http('sales',path(current,'sales','quotation/link'),'POST',{expectedRevision:d.revision,quotationNumber:'QUOT-STALE'})).status,409);
  assert.equal((await http('sales',path({id:999999999},'sales','quotation/link'),'POST',{expectedRevision:1,quotationNumber:'QUOT-MISSING'})).status,404);
});
test('Backorder PO linkage notifies Sales with the PO number once and quotation changes do not repeat it',async()=>{
  let d=await reviewed(await create());
  assert.ok(!(await http('sales',regular+'/alerts')).body.requests.some(row=>row.id===d.id));
  d=await poLinked(d);const linkedRevision=d.revision;
  const alert=(await http('sales',regular+'/alerts')).body.requests.find(row=>row.id===d.id);
  assert.ok(alert);assert.equal(alert.purchaseOrderRef,'TEST-BO-PO');assert.match(alert.message,/PO linked/);assert.equal(alert.eventId,linkedRevision);
  assert.ok(!(await http('foreign',regular+'/alerts')).body.requests.some(row=>row.id===d.id));
  d=await action(d,'sales','quotation/link',{quotationNumber:'QUOT-BEFORE-READ'});
  assert.equal((await http('sales',regular+'/alerts')).body.requests.find(row=>row.id===d.id).eventId,linkedRevision);
  assert.equal((await http('sales',regular+'/'+d.id+'/decisions/read','POST',{eventId:alert.eventId})).status,200);
  d=await action(d,'sales','quotation/link',{quotationNumber:'QUOT-AFTER-READ'});
  assert.ok(!(await http('sales',regular+'/alerts')).body.requests.some(row=>row.id===d.id));
  await query("UPDATE sales_special_stock_events SET details=details-'requestRevision' WHERE request_id=$1 AND event_type='special_purchase_order_linked'",[d.id]);
  d=await action(d,'sales','quotation/link',{quotationNumber:'QUOT-LEGACY-EVENT'});
  assert.ok(!(await http('sales',regular+'/alerts')).body.requests.some(row=>row.id===d.id));
  d=await action(d,'scm',`lines/${d.lines[0].id}/response`,{supplyStatus:'production',availabilityMode:'dated',availableDate:'2099-03-01',vendorId:331,vendorName:'TEST BO Vendor',vendorYard:'Vendor yard'});
  assert.equal((await http('sales',regular+'/alerts')).body.requests.find(row=>row.id===d.id).eventId,d.revision);
});
test('Backorder persisted pending information after PO linkage gets a fresh alert without repeating the PO notice',async()=>{
  let d=await poLinked(await reviewed(await create()));
  const linked=(await http('sales',regular+'/alerts')).body.requests.find(row=>row.id===d.id);assert.ok(linked);
  assert.equal((await http('sales',regular+'/'+d.id+'/decisions/read','POST',{eventId:linked.eventId})).status,200);
  // Exercise persisted information state; new information actions intentionally
  // remain restricted to enquiries before order linkage.
  await query('UPDATE sales_special_stock_cases SET information_request=$2::jsonb WHERE request_id=$1',
    [d.id,JSON.stringify({status:'pending',question:'Legacy information request'})]);
  await query('UPDATE sales_stock_requests SET revision=revision+1 WHERE id=$1',[d.id]);
  d=(await http('sales',regular+'/'+d.id)).body;
  assert.equal(d.stage,'pending_update');
  const information=(await http('sales',regular+'/alerts')).body.requests.find(row=>row.id===d.id);
  assert.ok(information);assert.equal(information.eventId,d.revision);assert.match(information.message,/pending update/);
  assert.equal((await http('sales',regular+'/'+d.id+'/decisions/read','POST',{eventId:information.eventId})).status,200);
  await query("UPDATE sales_special_stock_cases SET information_request='{}'::jsonb WHERE request_id=$1",[d.id]);
  await query('UPDATE sales_stock_requests SET revision=revision+1 WHERE id=$1',[d.id]);
  d=(await http('sales',regular+'/'+d.id)).body;assert.equal(d.stage,'confirmed');
  assert.ok(!(await http('sales',regular+'/alerts')).body.requests.some(row=>row.id===d.id));
});
test('Backorder Confirmed and PO-linked cases keep due SCM ETA reminders after SO linkage',async()=>{
  let d=await create();
  for(const line of d.lines)d=await action(d,'scm',`lines/${line.id}/response`,{supplyStatus:'production',availabilityMode:'dated',availableDate:'2099-03-01',vendorId:331,vendorName:'TEST BO Vendor',vendorYard:'Vendor yard'});
  for(const line of d.lines)d=await action(d,'sales',`lines/${line.id}/decision`,{decision:'accepted'});
  assert.equal(d.stage,'confirmed');
  const before=(await http('scm','/api/scm/stock-requests/alerts')).body.manualReview;
  await query("UPDATE sales_special_stock_lines SET reminder_due_date=(now() AT TIME ZONE 'America/Toronto')::date-1 WHERE request_id=$1",[d.id]);
  assert.equal((await http('scm','/api/scm/stock-requests/alerts')).body.manualReview,before+1);
  d=await poLinked(d);assert.equal(d.stage,'confirmed');
  assert.equal((await http('scm','/api/scm/stock-requests/alerts')).body.manualReview,before+1);
  await planPo();d=await action(d,'sales','sales-order/link',{salesOrderRef:'TEST-BO-SO'});assert.equal(d.stage,'confirmed');
  assert.equal((await http('scm','/api/scm/stock-requests/alerts')).body.manualReview,before+1);
});

test('Backorder creates an optional-customer Regular STREQ with regular SKU/UOM identity despite shortages',async()=>{
  const d=await create();assert.equal(d.requestType,'regular');assert.equal(d.workflowVersion,2);assert.match(d.requestRef,/^STREQ-\d{6}$/);assert.equal(d.regular.deliveryMethod,'backorder');assert.equal(d.workflowKind,'backorder');assert.equal(d.customerName,'');assert.equal(d.stage,'new_enquiry');
  assert.deepEqual(d.lines.map(l=>[l.itemId,l.uom,l.quantity]),[[sku,'EA',7],[bag,'BAG',9]]);assert.equal(d.operationallyComplete,false);assert.deepEqual(d.transfers,[]);
  const row=(await query('SELECT request_type,workflow_version,regular_details FROM sales_stock_requests WHERE id=$1',[d.id])).rows[0];assert.equal(row.request_type,'regular');assert.equal(row.workflow_version,2);assert.equal(row.regular_details.deliveryMethod,'backorder');
});
test('Backorder is Pending/Request with no transfer lines, searchable, and excluded from Special and completed queues',async()=>{
  const d=await create();
  for(const [role,url] of [['sales',regular+'?bucket=pending&search=TEST-BO-BAG'],['scm','/api/scm/stock-requests?queue=request&search='+d.requestRef]]){
    const r=await http(role,url);assert.equal(r.status,200);assert.ok(r.body.requests.some(x=>x.id===d.id));
  }
  for(const url of [regular+'?bucket=completed','/api/sales/special-stock-requests']){const r=await http('sales',url);assert.equal(r.status,200);assert.ok(!r.body.requests.some(x=>x.id===d.id));}
  const foreign=await http('foreign',regular+'/'+d.id);assert.equal(foreign.status,403);
});
test('Backorder reuses per-material review, Sales confirmation, ETA/reminders and private projection before and after manual links',async()=>{
  let d=await reviewed(await create());assert.equal(d.lines[0].salesDecision,'accepted');
  const sales=await http('sales',regular+'/'+d.id);assert.equal(sales.status,200);assert.ok(!JSON.stringify(sales.body).includes('Private purchasing note'));assert.ok(!Object.hasOwn(sales.body.lines[0],'unitPurchaseCost'));
  d=await poLinked(d);d=await action(d,'scm',`lines/${d.lines[0].id}/readiness`,{ready:false,eta:'2099-02-05'});assert.equal(d.lines[0].availableDate,'2099-02-05');assert.ok(d.lines[0].reminderDueDate);
  d=await action(d,'scm',`lines/${d.lines[0].id}/response`,{supplyStatus:'production',availabilityMode:'dated',availableDate:'2099-02-08',vendorId:331,vendorName:'TEST BO Vendor',vendorYard:'Vendor yard'});assert.equal(d.lines[0].salesDecision,'pending');assert.equal(d.lines[1].salesDecision,'accepted');
});
test('Backorder reviewed manual references ignore all business comparisons, link PO before the planned SO, and can be shared',async()=>{
  const a=await linked(await reviewed(await create()));const b=await linked(await reviewed(await create()));
  assert.equal(a.salesOrderId,b.salesOrderId);assert.equal(a.purchaseOrderId,b.purchaseOrderId);assert.equal(a.salesOrderId,so);assert.equal(a.purchaseOrderId,po);assert.deepEqual(a.salesOrderLines,[]);assert.deepEqual(a.purchaseOrderLines,[]);
  assert.equal((await query('SELECT count(*)::int AS n FROM dispatch_so_po_allocations WHERE po_order_id=$1',[po])).rows[0].n,0);
});
test('Backorder links retain reference identity, revision, auth and foreign-line checks',async()=>{
  let d=await poLinked(await reviewed(await create()));await planPo();const revision=d.revision;
  assert.equal((await http('sales',path(d,'sales','sales-order/link'),'POST',{expectedRevision:revision,salesOrderRef:'UNKNOWN'})).status,404);
  await query("INSERT INTO sales_orders(netsuite_id,tranid,status_text,netsuite_active) VALUES($1,'TEST-BO-SO','Closed',false)",[so+20]);
  try{assert.equal((await http('sales',path(d,'sales','sales-order/link'),'POST',{expectedRevision:revision,salesOrderRef:'TEST-BO-SO'})).status,409);}finally{await query('DELETE FROM sales_orders WHERE netsuite_id=$1',[so+20]);}
  assert.equal((await http('sales',path(d,'sales','sales-order/link'),'POST',{expectedRevision:revision,salesOrderRef:'TEST-BO-SO',salesOrderId:po})).status,409);
  assert.equal((await http('foreign',path(d,'sales','sales-order/link'),'POST',{expectedRevision:revision,salesOrderRef:'TEST-BO-SO'})).status,403);
  d=await action(d,'sales','sales-order/link',{salesOrderRef:'TEST-BO-SO'});
  assert.equal((await http('sales',path(d,'sales','sales-order/link'),'POST',{expectedRevision:revision,salesOrderRef:'TEST-BO-SO'})).status,409);
  const another=await create();assert.equal((await http('scm',path(d,'scm',`lines/${another.lines[0].id}/readiness`),'POST',{expectedRevision:d.revision,ready:true})).status,409);
  assert.equal((await http('sales',path(d,'scm','purchase-order/link'),'POST',{expectedRevision:d.revision,purchaseOrderRef:'TEST-BO-PO'})).status,403);
});
test('Backorder stays Confirmed after the planned PO and SO links and never edits native orders',async()=>{
  let d=await poLinked(await reviewed(await create()));assert.equal(d.operationallyComplete,false);assert.equal(d.stage,'confirmed');
  const soBefore=(await query('SELECT * FROM sales_orders WHERE netsuite_id=$1',[so])).rows[0],poBefore=(await query('SELECT * FROM purchase_orders WHERE netsuite_id=$1',[po])).rows[0];
  await planPo();d=await action(d,'sales','sales-order/link',{salesOrderRef:'TEST-BO-SO'});assert.equal(d.stage,'confirmed');assert.equal(d.operationallyComplete,false);
  assert.ok(!(await http('sales',regular+'?bucket=completed&search='+d.requestRef)).body.requests.some(x=>x.id===d.id));
  assert.ok((await http('sales',regular+'?bucket=pending&search='+d.requestRef)).body.requests.some(x=>x.id===d.id));
  d=await action(d,'sales','header',{remarks:'Local edit after links'});assert.equal(d.remarks,'Local edit after links');
  let closed=await poLinked(await reviewed(await create()));closed=await action(closed,'sales','close',{reason:'Cancelled locally'});assert.equal(closed.stage,'closed');
  assert.deepEqual((await query('SELECT * FROM sales_orders WHERE netsuite_id=$1',[so])).rows[0],soBefore);assert.deepEqual((await query('SELECT * FROM purchase_orders WHERE netsuite_id=$1',[po])).rows[0],poBefore);
});
test('Backorder blocks handcrafted generation, skip, transfer and Special route bypasses using persisted profile',async()=>{
  const d=await linked(await reviewed(await create()));
  for(const [role,url] of [['sales',`/api/sales/special-stock-requests/${d.id}/sales-order/create`],['scm',`/api/scm/special-stock-requests/${d.id}/purchase-order/create`],['sales',path(d,'sales','sales-order/create')],['scm',path(d,'scm','purchase-order/create')],['sales',path(d,'sales','sales-order/skip')],['sales',regular+'/'+d.id+'/sales-order'],['scm',`/api/scm/stock-requests/${d.id}/purchase-proposals`]]){
    const r=await http(role,url,'POST',{expectedRevision:d.revision,operationId:crypto.randomUUID(),salesOrderRef:'TEST-BO-SO',lineIds:d.lines.map(x=>x.id)});assert.ok([400,403,404,409].includes(r.status),url+' '+r.status);
  }
  assert.equal((await query('SELECT count(*)::int AS n FROM sales_stock_transfers WHERE request_id=$1',[d.id])).rows[0].n,0);
  assert.equal((await query('SELECT sales_order_operation_status,purchase_order_operation_status FROM sales_special_stock_cases WHERE request_id=$1',[d.id])).rows[0].sales_order_operation_status,'linked');
});
test('Backorder quote uses optional customer, regular SKU descriptions and prices, without ancillary rows',async()=>{
  const d=await create();const quote=buildSpecialQuote(d,{name:'TEST MBBS',taxBps:1300});assert.equal(quote.snapshot.customerName,'');assert.equal(quote.snapshot.lines.length,2);assert.ok(!JSON.stringify(quote).includes('MBBS-Special'));assert.ok(!JSON.stringify(quote).includes('PALLET'));assert.ok(!JSON.stringify(quote).includes('Delivery Charge'));
  assert.equal(quote.snapshot.lines[0].unit,'EA');assert.equal(quote.snapshot.lines[0].unitRate,'10');
});
test('Backorder rejects unknown stock SKU and ancillary inputs without partially creating a request',async()=>{
  const before=(await query("SELECT count(*)::int AS n FROM sales_stock_requests WHERE regular_details->>'deliveryMethod'='backorder'")).rows[0].n;
  for(const extra of [{lines:[{itemId:999999998,salesQty:1}]},{palletTotal:1},{deliveryFeeRate:10}]){
    const r=await http('sales',regular,'POST',{deliveryMethod:'backorder',destinationLocationId:1,inquiryDate:'2099-01-01',customerName:'',vendorName:'TEST BO Vendor',fulfillmentMethod:'vendor_pickup',lines:[{itemId:sku,salesQty:1}],...extra});assert.ok([400,404,409].includes(r.status));
  }
  assert.equal((await query("SELECT count(*)::int AS n FROM sales_stock_requests WHERE regular_details->>'deliveryMethod'='backorder'")).rows[0].n,before);
});
test('Backorder header/material changes remain local after linking, preserve SKU and prices, and require fresh confirmations',async()=>{
  let d=await poLinked(await reviewed(await create()));const before=(await query('SELECT * FROM sales_orders WHERE netsuite_id=$1',[so])).rows[0];
  d=await action(d,'sales','header',{customerName:'',remarks:'Updated local request',salesInternalRemark:'Private Sales text',fulfillmentMethod:'yard_pickup'});
  assert.equal(d.customerName,'');assert.equal(d.fulfillmentMethod,'yard_pickup');assert.equal(d.remarks,'Updated local request');
  const r=await http('scm','/api/scm/stock-requests/'+d.id);assert.ok(!JSON.stringify(r.body).includes('Private Sales text'));
  d=await action(d,'sales',`lines/${d.lines[0].id}/edit`,{quantity:19,productName:'Changed locally',customerNote:'Request note'});
  assert.equal(d.lines[0].quantity,19);assert.equal(d.lines[0].itemId,sku);assert.equal(d.lines[0].originalRate,10);assert.equal(d.lines[0].salesDecision,'pending');assert.equal(d.lines[1].salesDecision,'accepted');
  assert.deepEqual((await query('SELECT * FROM sales_orders WHERE netsuite_id=$1',[so])).rows[0],before);
  for(const body of [{quantity:-1},{quantity:1e10},{productName:''},{palletTotal:0}])assert.equal((await http('sales',path(d,'sales',`lines/${d.lines[0].id}/edit`),'POST',{expectedRevision:d.revision,...body})).status,400);
});
test('Backorder information replies, Regular alerts and acknowledgements use the authorized request profile',async()=>{
  let d=await create();d=await action(d,'scm','information/request',{question:'Please confirm the specifications'});assert.equal(d.stage,'pending_update');
  const alert=await http('sales',regular+'/alerts');assert.ok(alert.body.requests.some(r=>r.id===d.id && r.action==='backorder'));
  assert.equal((await http('foreign',regular+'/'+d.id+'/decisions/read','POST',{eventId:d.revision})).status,403);
  assert.equal((await http('sales',regular+'/'+d.id+'/decisions/read','POST',{eventId:d.revision})).status,200);
  assert.ok(!(await http('sales',regular+'/alerts')).body.requests.some(r=>r.id===d.id));
  d=await action(d,'sales','information/submit',{reply:'Specifications confirmed'});assert.equal(d.informationRequest.status,'answered');
  const scm=await http('scm','/api/scm/stock-requests/alerts');assert.ok(scm.body.manualReview>0);
});
test('Backorder reference linking serializes concurrent revisions and Special cases can share its SO',async()=>{
  const d=await poLinked(await reviewed(await create()));await planPo();const url=path(d,'sales','sales-order/link'),body={expectedRevision:d.revision,salesOrderRef:'TEST-BO-SO'};
  const results=await Promise.all([http('sales',url,'POST',body),http('sales',url,'POST',body)]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  const context={operatorId:users.sales.id,authorizedStoreLocationIds:[1]};
  const draft={storeLocationId:1,inquiryDate:'2099-01-01',customerName:'TEST Special',vendorName:'TEST BO Vendor',fulfillmentMethod:'vendor_pickup',lines:[{productName:'Enquiry material',quantity:1,uom:'PCS',rate:10,requiredDate:'2099-02-01'}]};
  const a=await special.createSpecialStockCase(draft,context),b=await special.createSpecialStockCase(draft,context);requests.push(a.id,b.id);
  await special.linkSpecialSalesOrder(a.id,{expectedRevision:a.revision,salesOrderRef:'TEST-BO-SO'},context);
  const linked=await special.linkSpecialSalesOrder(b.id,{expectedRevision:b.revision,salesOrderRef:'TEST-BO-SO'},context);
  assert.equal(linked.salesOrderId,so);assert.equal((await special.getSpecialStockCase(a.id)).salesOrderId,so);
  await assert.rejects(special.getSpecialStockCase(d.id),{code:'SPECIAL_CASE_NOT_FOUND'});
});
test('Backorder schema rejects profile/SKU substitution and incomplete successful completion',async()=>{
  const d=await create();
  for(const [sql,args] of [["UPDATE sales_special_stock_cases SET workflow_kind='special' WHERE request_id=$1",[d.id]],['UPDATE sales_special_stock_cases SET operationally_complete=true WHERE request_id=$1',[d.id]],['UPDATE sales_special_stock_lines SET regular_item_id=$2 WHERE request_id=$1',[d.id,bag]]])await assert.rejects(query(sql,args),{code:'23514'});
  const old=await special.createSpecialStockCase({storeLocationId:1,inquiryDate:'2099-01-01',customerName:'TEST schema',vendorName:'TEST BO Vendor',fulfillmentMethod:'vendor_pickup',lines:[{productName:'Special material',quantity:1,uom:'PCS',rate:10,requiredDate:'2099-02-01'}]},{operatorId:users.sales.id,authorizedStoreLocationIds:[1]});requests.push(old.id);
  await assert.rejects(query('UPDATE sales_special_stock_lines SET request_id=$2,line_number=42 WHERE id=$1',[d.lines[0].id,old.id]),{code:'23514'});
  const r=await http('sales',regular+'/'+d.id);assert.equal(r.body.workflowKind,'backorder');assert.equal(r.body.lines[0].itemId,sku);
});
test('Backorder SO linkage keeps Pickup and Delivery Confirmed with SQL/detail/queue stage agreement',async()=>{
  for(const fulfillmentMethod of ['yard_pickup','mbt_delivery']){
    let d=await poLinked(await reviewed(await create({fulfillmentMethod,...(fulfillmentMethod==='mbt_delivery'?{deliveryAddress:'TEST delivery address'}:{})})));
    assert.notEqual((await query('SELECT stage FROM special_stock_workflow_stages WHERE request_id=$1',[d.id])).rows[0].stage,'completed');
    await planPo();d=await action(d,'sales','sales-order/link',{salesOrderRef:'TEST-BO-SO'});assert.equal(d.stage,'confirmed');assert.equal(d.operationallyComplete,false);
    assert.equal((await query('SELECT stage FROM special_stock_workflow_stages WHERE request_id=$1',[d.id])).rows[0].stage,'confirmed');
    const closed=await http('scm','/api/scm/stock-requests?type=backorder&queue=closed&stage=completed');assert.ok(!closed.body.requests.some(x=>x.id===d.id));
    const pending=await http('scm','/api/scm/stock-requests?type=backorder&queue=request&search='+d.requestRef);assert.ok(pending.body.requests.some(x=>x.id===d.id));
    const alerts=await http('sales',regular+'/alerts');assert.ok(alerts.body.requests.some(x=>x.id===d.id));
  }
});
test('Backorder native order previews preserve audience rules without requiring material mappings',async()=>{
  const {getBackorderRequest}=await import('../../../src/backorder-request-service.js');
  const {createSpecialOrderDocumentService}=await import('../../../src/special-stock-documents.js');
  const d=await linked(await reviewed(await create()));let fetches=0;
  const service=createSpecialOrderDocumentService({getCase:getBackorderRequest,fetchPdf:async(kind,id)=>{fetches++;assert.equal(kind,'purchase_order');assert.equal(id,po);return {buffer:Buffer.from('%PDF-1.4\nTEST'),filename:'TEST-native.pdf'};}});
  const document=await service.preview(d.id,'purchase_order',{audience:'scm'});assert.equal(document.buffer.toString(),'%PDF-1.4\nTEST');
  assert.equal((await service.preview(d.id,'purchase_order',{audience:'scm'})).cached,true);assert.equal(fetches,1);
  await assert.rejects(service.preview(d.id,'purchase_order',{audience:'sales',authorizedStoreLocationIds:[1]}),{status:403});
  const response=await nativeFetch(base+path(d,'scm','purchase-order/document.pdf'),{headers:{authorization:'Bearer '+users.scm.token}});assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/application\/pdf/);assert.equal(Buffer.from(await response.arrayBuffer()).subarray(0,5).toString(),'%PDF-');
  assert.equal((await http('sales',path(d,'sales','purchase-order/document.pdf'))).status,403);assert.equal(fetches,1);
});

test('Order webhooks leave linked Backorders unchanged in both the app and the packaged worker',async()=>{
  const {spawnSync}=await import('node:child_process');
  const {resolve}=await import('node:path');
  const {mkdtempSync,cpSync,symlinkSync,writeFileSync,readFileSync,rmSync,existsSync}=await import('node:fs');
  const soId=so+21,poId=po+21;
  await query("INSERT INTO sales_orders(netsuite_id,tranid,status_text,netsuite_active) VALUES($1,'TEST-BO-WORKER-SO','Closed',false)",[soId]);
  await query("INSERT INTO purchase_orders(netsuite_id,tranid,status_text,netsuite_active) VALUES($1,'TEST-BO-WORKER-PO','Closed',false)",[poId]);
  const root=mkdtempSync('/tmp/mbbs-backorder-worker-');
  try{
    let d=await poLinked(await reviewed(await create()),'TEST-BO-WORKER-PO');await planPo('TEST-BO-WORKER-PO');d=await action(d,'sales','sales-order/link',{salesOrderRef:'TEST-BO-WORKER-SO'});
    const before=(await query('SELECT to_jsonb(special) AS value FROM sales_special_stock_cases special WHERE request_id=$1',[d.id])).rows[0].value;
    for(const [orderKind,orderId] of [['sales_order',soId],['purchase_order',poId]])assert.deepEqual(await special.reconcileSpecialOrderWebhook({orderKind,orderId}),{matched:false});
    for(const folder of ['src','public'])cpSync(resolve('tools/backorder-requests-20261006/baseline-worker/'+folder),root+'/'+folder,{recursive:true});
    symlinkSync(resolve('node_modules'),root+'/node_modules');cpSync('package.json',root+'/package.json');
    const patch='tools/backorder-requests-20261006/worker-candidate/src/special-stock-request-repository.js';
    if(existsSync(patch))writeFileSync(root+'/src/special-stock-request-repository.js',readFileSync(patch));
    const script=`import assert from 'node:assert/strict';import {reconcileSpecialOrderWebhook} from './src/special-stock-request-repository.js';import {closeDb} from './src/db.js';globalThis.fetch=()=>{throw Error('Backorder worker must not use external services');};try{for(const [orderKind,orderId] of ${JSON.stringify([['sales_order',soId],['purchase_order',poId]])})assert.deepEqual(await reconcileSpecialOrderWebhook({orderKind,orderId}),{matched:false});console.log('Worker ignores Backorder references');}finally{await closeDb();}`;
    const coverage=Boolean(process.env.NODE_V8_COVERAGE),report=resolve('test-artifacts/backorder-requests-20261006/worker-coverage');
    const args=coverage?[resolve('node_modules/c8/bin/c8.js'),'--all=false','--check-coverage=false','--include=src/special-stock-request-repository.js','--temp-directory='+root+'/coverage-raw','--report-dir='+report,'--reporter=json',process.execPath,'--input-type=module','-e',script]:['--input-type=module','-e',script];
    const child=spawnSync(process.execPath,args,{cwd:root,env:process.env,encoding:'utf8',timeout:30000});
    if(coverage)writeFileSync(report+'/source.json',JSON.stringify({root,sha256:crypto.createHash('sha256').update(readFileSync(root+'/src/special-stock-request-repository.js')).digest('hex')}));assert.equal(child.status,0,child.stderr);assert.match(child.stdout,/Worker ignores Backorder/);
    assert.deepEqual((await query('SELECT to_jsonb(special) AS value FROM sales_special_stock_cases special WHERE request_id=$1',[d.id])).rows[0].value,before);
  }finally{rmSync(root,{recursive:true,force:true});await query('DELETE FROM sales_orders WHERE netsuite_id=$1',[soId]);await query('DELETE FROM purchase_orders WHERE netsuite_id=$1',[poId]);}
});

test('Backorder quote price and discount edits stay local and validate money bounds',async()=>{
  let d=await poLinked(await reviewed(await create()));
  const before=(await query('SELECT to_jsonb(so) AS value FROM sales_orders so WHERE netsuite_id=$1',[so])).rows[0].value;
  d=await action(d,'sales',`lines/${d.lines[0].id}/edit`,{rate:25,discountPercent:12.5});
  assert.equal(d.lines[0].originalRate,25);assert.equal(d.lines[0].quotedDiscountPercent,12.5);assert.equal(d.lines[0].salesDecision,'pending');assert.equal(d.lines[1].originalRate,12);
  const quote=buildSpecialQuote(d,{name:'TEST MBBS',taxBps:1300});assert.equal(quote.snapshot.lines[0].unitRate,'25');
  for(const fields of [{rate:-1},{rate:1e15},{discountPercent:101},{discountPercent:-1}])assert.equal((await http('sales',path(d,'sales',`lines/${d.lines[0].id}/edit`),'POST',{expectedRevision:d.revision,...fields})).status,400);
  assert.deepEqual((await query('SELECT to_jsonb(so) AS value FROM sales_orders so WHERE netsuite_id=$1',[so])).rows[0].value,before);
});

test('Manual Backorder links keep incomplete material reviews in SCM notifications',async()=>{
  const before=await http('scm','/api/scm/stock-requests/alerts');
  const d=await poLinked(await reviewed(await create()));
  await action(d,'sales',`lines/${d.lines[0].id}/edit`,{quantity:8});
  const after=await http('scm','/api/scm/stock-requests/alerts');assert.equal(after.body.manualReview,before.body.manualReview+1);
});
test('Manual Backorder links keep revised material confirmations in Sales notifications',async()=>{
  let d=await poLinked(await reviewed(await create()));d=await action(d,'scm',`lines/${d.lines[0].id}/response`,{supplyStatus:'in_stock',availabilityMode:'no_projection',vendorId:331,vendorName:'TEST BO Vendor',vendorYard:'Vendor yard'});
  const alerts=await http('sales',regular+'/alerts');assert.ok(alerts.body.requests.some(row=>row.id===d.id && row.action==='backorder'));
});


test('Backorder persisted profile rejects generic edits and cancellation without changing local records',async()=>{
  const d=await create(),before=(await query('SELECT to_jsonb(r) AS value FROM sales_stock_requests r WHERE id=$1',[d.id])).rows[0].value;
  for(const [role,url,method,fields] of [['sales',regular+'/'+d.id,'PATCH',{deliveryMethod:'stocking',remarks:'Hostile edit'}],['sales',regular+'/'+d.id+'/cancel','POST',{}],['scm',`/api/scm/stock-requests/${d.id}/line-decisions`,'POST',{decision:'reject',reason:'Hostile rejection',lineIds:d.lines.map(line=>line.id)}]]){
    const r=await http(role,url,method,{expectedRevision:d.revision,...fields});assert.equal(r.status,409);assert.equal(r.body.code,'BACKORDER_WORKFLOW_ONLY');
  }
  const {cancelSalesStockRequest}=await import('../../../src/stock-request-repository.js');
  await assert.rejects(cancelSalesStockRequest(d.id,{expectedRevision:d.revision},{operatorId:users.sales.id,authorizedDestinationLocationIds:[1]}),{code:'BACKORDER_WORKFLOW_ONLY'});
  assert.equal((await http('foreign',path(d,'sales','header'),'POST',{expectedRevision:d.revision,remarks:'Foreign edit'})).status,403);
  assert.deepEqual((await query('SELECT to_jsonb(r) AS value FROM sales_stock_requests r WHERE id=$1',[d.id])).rows[0].value,before);
});
test('Backorder directory, vendor and reference filters preserve the Regular scope and Special alert counts',async()=>{
  const {getSpecialStockAlertCounts,getSpecialSalesAlertCounts}=await import('../../../src/special-stock-alerts.js');
  const context={operatorId:users.sales.id,authorizedStoreLocationIds:[1]},before=await getSpecialStockAlertCounts(),salesBefore=await getSpecialSalesAlertCounts(context);
  let d=await create();assert.deepEqual(await getSpecialStockAlertCounts(),before);d=await reviewed(d);assert.deepEqual(await getSpecialSalesAlertCounts(context),salesBefore);d=await linked(d);
  for(const [kind,ref,id] of [['sales_order','TEST-BO-SO',so],['purchase_order','TEST-BO-PO',po]]){
    const r=await http('scm',`/api/scm/stock-requests/backorder/order-links?kind=${kind}&search=${ref}`);assert.equal(r.status,200);assert.ok(r.body.orders.some(row=>row.id===id));assert.ok(r.body.orders.every(row=>!Object.hasOwn(row,'unitPurchaseCost')));
  }
  assert.equal((await http('sales','/api/sales/stock-requests/backorder/order-links?kind=invalid')).status,400);
  for(const [role,url] of [['sales',regular+'?type=backorder&bucket=pending&vendor=TEST%20BO%20Vendor&search=TEST-BO-PO'],['scm','/api/scm/stock-requests?type=backorder&queue=request&vendor=TEST%20BO%20Vendor&search=TEST-BO-SO']]){
    const r=await http(role,url);assert.equal(r.status,200);assert.ok(r.body.requests.some(row=>row.id===d.id));
  }
  assert.ok(!(await http('foreign',regular+'?type=backorder&vendor=TEST%20BO%20Vendor')).body.requests.some(row=>row.id===d.id));
  assert.ok(!(await http('scm','/api/scm/stock-requests?type=backorder&vendor=DIFFERENT')).body.requests.some(row=>row.id===d.id));
});


test('Backorder accepts the Regular catalog native UOM without imposing the Special UOM format',async()=>{
  const d=await create({lines:[{itemId:88999003,salesQty:3,rate:10}]});assert.equal(d.lines[0].uom,'889');assert.equal(d.lines[0].quantity,3);
});
test('Backorder keeps the Regular converted quantity and exact native UOM label',async()=>{
  const d=await create({lines:[{itemId:88999004,pallets:3,rate:10}]});assert.equal(d.lines[0].uom,'Ton');assert.equal(d.lines[0].quantity,7.5);assert.equal(d.lines[0].palletQty,3);
  const rejected=await http('sales',regular,'POST',{deliveryMethod:'backorder',destinationLocationId:1,vendorId:331,vendorName:'TEST BO Vendor',lines:[{itemId:88999004,salesQty:7.5,rate:10}]});assert.equal(rejected.status,400);
});

// Confirmed releases SO and PO linkage independently after review and acceptance.
async function reviewStock(d,line=d.lines[0]) {
  return action(d,'scm',`lines/${line.id}/response`,{supplyStatus:'in_stock',availabilityMode:'no_projection',vendorId:331,vendorName:'TEST BO Vendor',vendorYard:'Vendor dock'});
}
async function rejectedLink(d,role,kind,code,fields={}) {
  const before=(await query('SELECT * FROM sales_special_stock_cases WHERE request_id=$1',[d.id])).rows[0];
  const events=(await query('SELECT count(*)::int AS n FROM sales_special_stock_events WHERE request_id=$1',[d.id])).rows[0].n;
  const r=await http(role,path(d,role,kind+'-order/link'),'POST',{expectedRevision:d.revision,[kind+'OrderRef']:kind==='sales'?'TEST-BO-SO':'TEST-BO-PO',...fields});
  assert.equal(r.status,409,JSON.stringify(r.body));assert.equal(r.body.code,code);
  assert.deepEqual((await query('SELECT * FROM sales_special_stock_cases WHERE request_id=$1',[d.id])).rows[0],before);
  assert.equal((await query('SELECT revision FROM sales_stock_requests WHERE id=$1',[d.id])).rows[0].revision,d.revision);
  assert.equal((await query('SELECT count(*)::int AS n FROM sales_special_stock_events WHERE request_id=$1',[d.id])).rows[0].n,events);
}
test('Backorder PO linking requires reviewed stock and Sales acceptance for every open material',async()=>{
  let d=await create();await rejectedLink(d,'scm','purchase','BACKORDER_SALES_ACCEPTANCE_REQUIRED');
  for(const line of d.lines)d=await reviewStock(d,line);
  assert.ok(d.lines.every(l=>l.unitPurchaseCost===null));assert.ok(d.lines.every(l=>l.stockCheckedAt));
  await rejectedLink(d,'scm','purchase','BACKORDER_SALES_ACCEPTANCE_REQUIRED');
  d=await action(d,'sales',`lines/${d.lines[0].id}/decision`,{decision:'accepted'});await rejectedLink(d,'scm','purchase','BACKORDER_SALES_ACCEPTANCE_REQUIRED');
  d=await action(d,'sales',`lines/${d.lines[1].id}/decision`,{decision:'declined',reason:'Not needed'});
  d=await poLinked(d);assert.equal(d.purchaseOrderId,po);assert.equal(d.salesOrderId,null);assert.equal(d.stage,'confirmed');
});
test('Confirmed Backorder lets Sales link SO first and SCM link PO afterwards without planning',async()=>{
  let d=await reviewed(await create());assert.equal(d.stage,'confirmed');assert.equal(d.purchaseOrderId,null);
  d=await action(d,'sales','sales-order/link',{salesOrderRef:'TEST-BO-SO'});
  assert.equal(d.salesOrderId,so);assert.equal(d.purchaseOrderId,null);assert.equal(d.stage,'confirmed');
  assert.ok(d.events.some(e=>e.eventType==='special_sales_order_linked'));
  const order=await uniquePo();d=await poLinked(d,order.ref);
  assert.equal(d.salesOrderId,so);assert.equal(d.purchaseOrderId,order.id);assert.equal(d.stage,'confirmed');
  assert.equal((await query('SELECT stage FROM special_stock_workflow_stages WHERE request_id=$1',[d.id])).rows[0].stage,'confirmed');
});
test('Confirmed Backorder lets Sales link SO after PO with any planning state',async()=>{
  for(const plan of ['missing','unassigned','cancelled','assigned']){
    const order=await uniquePo();let d=await poLinked(await reviewed(await create()),order.ref);
    if(plan!=='missing')await planPo(order.ref,plan==='cancelled'?'cancelled':'draft',plan!=='unassigned');
    d=await action(d,'sales','sales-order/link',{salesOrderRef:'TEST-BO-SO'});
    assert.equal(d.salesOrderId,so,plan);assert.equal(d.purchaseOrderId,order.id,plan);assert.equal(d.stage,'confirmed',plan);
  }
});
test('SO linking rejects unfinished material review and ignores forged confirmation and planning flags',async()=>{
  let d=await create();
  const forged={stage:'confirmed',lines:d.lines.map(line=>({...line,salesDecision:'accepted',supplyStatus:'in_stock',stockCheckedAt:'2099-01-01'})),purchaseOrderId:po,dispatchPlanning:{purchaseOrder:{planned:true}}};
  await rejectedLink(d,'sales','sales','BACKORDER_SALES_ACCEPTANCE_REQUIRED',forged);
  for(const line of d.lines)d=await reviewStock(d,line);
  await rejectedLink(d,'sales','sales','BACKORDER_SALES_ACCEPTANCE_REQUIRED');
  d=await action(d,'sales',`lines/${d.lines[0].id}/decision`,{decision:'accepted'});
  await rejectedLink(d,'sales','sales','BACKORDER_SALES_ACCEPTANCE_REQUIRED');
  d=await action(d,'sales',`lines/${d.lines[1].id}/decision`,{decision:'declined',reason:'Not needed'});
  d=await action(d,'sales','sales-order/link',{salesOrderRef:'TEST-BO-SO'});assert.equal(d.salesOrderId,so);
});
test('Concurrent Confirmed SO and PO links preserve revision checks and both links after retry',async()=>{
  let d=await reviewed(await create());const initial=d.revision,order=await uniquePo();
  const operations=[['sales','sales-order/link',{salesOrderRef:'TEST-BO-SO'}],['scm','purchase-order/link',{purchaseOrderRef:order.ref}]];
  const results=await Promise.all(operations.map(([role,name,input])=>http(role,path(d,role,name),'POST',{expectedRevision:initial,...input})));
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  d=(await http('sales',regular+'/'+d.id)).body;assert.equal(d.revision,initial+1);
  assert.equal(d.events.filter(e=>['special_sales_order_linked','special_purchase_order_linked'].includes(e.eventType)).length,1);
  const [role,name,input]=operations[results.findIndex(r=>r.status===409)];
  d=await action(d,role,name,input);assert.equal(d.revision,initial+2);assert.equal(d.salesOrderId,so);assert.equal(d.purchaseOrderId,order.id);
  assert.equal(d.events.filter(e=>['special_sales_order_linked','special_purchase_order_linked'].includes(e.eventType)).length,2);
});
test('Backorder material changes revoke review and Sales acceptance before SCM can link a PO',async()=>{
  let d=await reviewed(await create());d=await action(d,'sales',`lines/${d.lines[0].id}/edit`,{quantity:8});
  assert.equal(d.lines[0].supplyStatus,null);assert.ok(d.lines[1].stockCheckedAt);
  await rejectedLink(d,'sales','sales','BACKORDER_SALES_ACCEPTANCE_REQUIRED');
  await rejectedLink(d,'scm','purchase','BACKORDER_SALES_ACCEPTANCE_REQUIRED');
  d=await reviewStock(d);await rejectedLink(d,'scm','purchase','BACKORDER_SALES_ACCEPTANCE_REQUIRED');
  d=await action(d,'sales',`lines/${d.lines[0].id}/decision`,{decision:'accepted'});d=await poLinked(d);assert.equal(d.purchaseOrderId,po);
});
test('Backorder with every material declined closes and cannot link a PO',async()=>{
  let d=await reviewed(await create());for(const line of d.lines)d=await action(d,'sales',`lines/${line.id}/decision`,{decision:'declined',reason:'Not needed'});
  assert.equal(d.stage,'closed');assert.equal(d.closeStatus,'closed');await rejectedLink(d,'scm','purchase','BACKORDER_CLOSED');
  await rejectedLink(d,'sales','sales','BACKORDER_CLOSED');
});

test('Combined SCM queues return the union without duplicates and retain common vendor filters',async()=>{
  await create();await linked(await reviewed(await create()));
  const read=async queue=>{const r=await http('scm','/api/scm/stock-requests?limit=100&queue='+encodeURIComponent(queue)+'&vendor=TEST%20BO%20Vendor');assert.equal(r.status,200,JSON.stringify(r.body));return r.body.requests.map(row=>row.id).sort((a,b)=>a-b);};
  const pending=await read('request'),closed=await read('closed'),combined=await read('request,closed');assert.deepEqual(combined,[...new Set([...pending,...closed])].sort((a,b)=>a-b));assert.equal(combined.length,new Set(combined).size);
  const all=await read('');assert.ok(combined.every(id=>all.includes(id)));
  assert.equal((await http('scm','/api/scm/stock-requests?queue=request,mystery')).status,400);
});

test('Backorder Sales replies become Confirmed only after every line replies and PO linkage becomes Dispatch Arrangement',async()=>{
  let d=await create();for(const line of d.lines)d=await reviewStock(d,line);assert.equal(d.stage,'await_customer_confirmation');
  d=await action(d,'sales',`lines/${d.lines[0].id}/decision`,{decision:'accepted'});assert.equal(d.stage,'await_customer_confirmation');
  d=await action(d,'sales',`lines/${d.lines[1].id}/decision`,{decision:'declined',reason:'Not needed'});assert.equal(d.stage,'confirmed');
  assert.equal((await query('SELECT stage FROM special_stock_workflow_stages WHERE request_id=$1',[d.id])).rows[0].stage,'confirmed');
  d=await poLinked(d);assert.equal(d.stage,'confirmed');assert.equal((await query('SELECT stage FROM special_stock_workflow_stages WHERE request_id=$1',[d.id])).rows[0].stage,'confirmed');
});
test('Backorder all rejected replies close it and freeze later local edits without changing neighboring requests',async()=>{
  let d=await create();const other=await create();for(const line of d.lines)d=await reviewStock(d,line);
  d=await action(d,'sales',`lines/${d.lines[0].id}/decision`,{decision:'declined',reason:'Not needed'});assert.equal(d.stage,'await_customer_confirmation');
  d=await action(d,'sales',`lines/${d.lines[1].id}/decision`,{decision:'declined',reason:'Not needed'});assert.equal(d.stage,'closed');assert.equal(d.closeStatus,'closed');
  assert.equal((await query('SELECT stage FROM special_stock_workflow_stages WHERE request_id=$1',[d.id])).rows[0].stage,'closed');
  const late=await http('sales',path(d,'sales',`lines/${d.lines[0].id}/edit`),'POST',{expectedRevision:d.revision,quantity:10});assert.equal(late.status,409);assert.equal(late.body.code,'BACKORDER_CLOSED');
  assert.equal((await http('sales',regular+'/'+other.id)).body.stage,'new_enquiry');
});
