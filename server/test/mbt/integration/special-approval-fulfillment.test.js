/* global structuredClone */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { beginRollbackContext, closeDb, query } from '../../../src/db.js';
import * as repository from '../../../src/special-stock-request-repository.js';

after(closeDb);
const referenceUpdate = (...args) => { assert.equal(typeof repository.updateSpecialPurchaseReference, 'function'); return repository.updateSpecialPurchaseReference(...args); };
const deliveryClaim = (...args) => { assert.equal(typeof repository.claimSpecialFulfillmentChange, 'function'); return repository.claimSpecialFulfillmentChange(...args); };
const context = { operatorId: 'special-review-test', authorizedStoreLocationIds: [1] };
const input = { storeLocationId: 1, inquiryDate: '2099-01-01', customerId: 8899100,
  customerName: 'TEST Review', vendorId: 8899200, vendorName: 'TEST Vendor', fulfillmentMethod: 'yard_pickup',
  lines: [{ productName: 'TEST product', quantity: 2, uom: 'PLT', rate: 144, requiredDate: '2099-02-01' }] };
async function fixture(run) {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,yard_location_ids) VALUES('special-review-test','special-review-test','TEST','hash','salt','admin',ARRAY['admin'],ARRAY[1]) ON CONFLICT DO NOTHING");
      await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,raw,synced_at) VALUES(2055,'MBBS-Special Order','SQFT','{}',now()),(1784,'PALLET','EACH','{}',now()) ON CONFLICT DO NOTHING");
      await query("INSERT INTO netsuite_customers(netsuite_id,entity_number,legal_name,display_name,currency,active,source_modified_at,source_version,payload_hash) VALUES(8899100,'TEST','TEST Review','TEST Review','CAD',true,now(),'test',repeat('d',64)) ON CONFLICT DO NOTHING");
      await run();
    });
  } finally { await rollback.rollback(); }
}

async function linked({status='A',statusText='Purchase Order : Pending Approval',method='yard_pickup'}={}) {
 const d=await repository.createSpecialStockCase({...input,fulfillmentMethod:method},context);
 await query("INSERT INTO sales_orders(netsuite_id,tranid,status,status_text,netsuite_active,customer_id,order_location_id,delivery_method_id,sales_order_type) VALUES(8899911,'TEST-APPROVAL-SO','B','Pending Fulfillment',true,8899100,1,1,'Pickup')");
 await query("INSERT INTO purchase_orders(netsuite_id,tranid,status,status_text,netsuite_active) VALUES(8899912,'TEST-APPROVAL-PO',$1,$2,true)",[status,statusText]);
 await query("UPDATE sales_special_stock_cases SET sales_order_netsuite_id=8899911,sales_order_ref='TEST-APPROVAL-SO',sales_order_approved=true,purchase_order_netsuite_id=8899912,purchase_order_ref='TEST-APPROVAL-PO',purchase_order_status='Pending Receipt' WHERE request_id=$1",[d.id]);
 await query("UPDATE sales_special_stock_lines SET supply_status='production',sales_decision='accepted',available_date='2099-02-01' WHERE request_id=$1",[d.id]);
 return repository.getSpecialStockCase(d.id);
}
test('pending PO stays Confirmed in detail, SQL filter and SCM alerts ahead of production',()=>fixture(async()=>{
 const {getSpecialStockAlertCounts}=await import('../../../src/special-stock-alerts.js');
 const before=await getSpecialStockAlertCounts(); const d=await linked();
 assert.equal(d.stage,'confirmed');assert.equal(d.purchaseOrderApproved,false);assert.equal(d.purchaseOrderPendingApproval,true);
 assert.equal((await query('SELECT stage FROM special_stock_workflow_stages WHERE request_id=$1',[d.id])).rows[0].stage,'confirmed');
 assert.ok((await repository.listSpecialStockCases({stages:['confirmed']})).some(r=>r.id===d.id));
 assert.equal((await getSpecialStockAlertCounts()).confirmedOrders,before.confirmedOrders+1);
 await query("UPDATE purchase_orders SET status='B',status_text='Pending Receipt' WHERE netsuite_id=8899912");
 const approved=await repository.getSpecialStockCase(d.id);assert.equal(approved.purchaseOrderApproved,true);assert.equal(approved.stage,'confirmed');
}));
test('unapproved PO blocks handoff release and customer vendor collection',()=>fixture(async()=>{
 const d=await linked({method:'vendor_pickup'});
 await assert.rejects(()=>repository.chooseSpecialHandoffRoute(d.id,{expectedRevision:d.revision,requestedRoute:'direct'},context),{code:'SPECIAL_PO_APPROVAL_REQUIRED'});
 await assert.rejects(()=>repository.completeSpecialVendorPickup(d.id,{expectedRevision:d.revision,pickupDate:'2099-02-01',pickupReference:'TEST'},context),{code:'SPECIAL_PO_APPROVAL_REQUIRED'});
}));
test('shared PO reference waits for approval, updates the existing schedule and rejects stale reference',()=>fixture(async()=>{
 let d=await linked();const save=(reference,previousReference='')=>referenceUpdate(d.id,{expectedRevision:d.revision,reference,previousReference},context);
 await assert.rejects(()=>save('VENDOR-REF'),{code:'SPECIAL_PO_APPROVAL_REQUIRED'});
 await query("UPDATE purchase_orders SET status='B',status_text='Pending Receipt' WHERE netsuite_id=8899912");
 await query("INSERT INTO scm_transport_schedule(order_kind,order_ref,source_id,status) VALUES('PO','TEST-APPROVAL-PO',8899912,'Hold')");
 d=await save('VENDOR-REF');assert.equal(d.purchaseOrderReference,'VENDOR-REF');assert.equal(d.purchaseOrderRef,'TEST-APPROVAL-PO');
 assert.deepEqual((await query("SELECT order_ref,packing_slip_ref FROM scm_transport_schedule WHERE source_id=8899912")).rows[0],{order_ref:'VENDOR-REF',packing_slip_ref:'VENDOR-REF'});
 await assert.rejects(()=>save('OTHER',''),{code:'SPECIAL_PO_REFERENCE_CONFLICT'});
 d=await save('', 'VENDOR-REF');assert.equal(d.purchaseOrderReference,'');
}));
test('Sales can claim delivery edits after both orders exist, with revision and yard protections',()=>fixture(async()=>{
 const d=await linked();const change={expectedRevision:d.revision,fulfillmentMethod:'mbt_delivery',deliveryAddress:'TEST new site',deliveryDate:'2099-02-01'};
 await assert.rejects(()=>deliveryClaim(d.id,change,{...context,authorizedStoreLocationIds:[28]}),{code:'SPECIAL_CASE_STORE_FORBIDDEN'});
 await assert.rejects(()=>deliveryClaim(d.id,{...change,expectedRevision:999},context),{code:'SPECIAL_REVISION_CONFLICT'});
 const claimed=await deliveryClaim(d.id,change,context);assert.equal(claimed.fulfillmentChange.status,'applying');assert.equal(claimed.fulfillmentChange.target.fulfillmentMethod,'mbt_delivery');
 assert.equal(claimed.fulfillmentMethod,'yard_pickup');assert.equal(claimed.attention,true);
}));
test('planned SO blocks a delivery edit before journal or remote work',()=>fixture(async()=>{
 const d=await linked();await query('UPDATE sales_orders SET dispatch_planned=true WHERE netsuite_id=8899911');
 await assert.rejects(()=>deliveryClaim(d.id,{expectedRevision:d.revision,fulfillmentMethod:'vendor_pickup'},context),{code:'SPECIAL_FULFILLMENT_PLANNED'});
}));

test('delivery service preserves its saved target after remote failure, permits planning, and updates both audiences on retry',()=>fixture(async()=>{
 const {createSpecialFulfillmentService}=await import('../../../src/special-stock-fulfillment.js');
 const {prepareSpecialFulfillmentPlan,applySpecialFulfillmentPlan}=await import('../../../src/special-stock-fulfillment-adapter.js');
 const {assertSpecialStockHandoffPlanning}=await import('../../../src/dispatch-plan-repository.js');
 let d=await linked({status:'B',statusText:'Pending Receipt'});
 const record={id:'8899911',entity:{id:'8899100'},location:{id:'1'},custbody3:{id:'1'},item:{items:[{line:1,item:{id:'2055'},quantity:2,units:'1',rate:10,description:'TEST product',location:{id:'1'}}]}};
 let patches=0,fail=true;
 const boundary={config:{pickupMethodId:1,deliveryMethodId:2},queryAll:async()=>[{uniquekey:101,rest_line_id:1,item:2055,status:'B',execution_quantity:0,billed_quantity:0,line_closed:'F'}],
 rest:async(_path,options={})=>{if(options.method==='PATCH'){patches++;Object.assign(record,options.body);if(fail){fail=false;throw Error('Lost acknowledgement');}}return{data:structuredClone(record)};}};
 const service=createSpecialFulfillmentService({prepare:input=>prepareSpecialFulfillmentPlan(input,boundary),apply:plan=>applySpecialFulfillmentPlan(plan,boundary)});
 await assert.rejects(()=>service(d.id,{expectedRevision:d.revision,fulfillmentMethod:'mbt_delivery',deliveryAddress:'TEST new site',deliveryDate:'2099-02-01',deliveryInstructions:'Use side gate'},context),/Lost acknowledgement/);
 d=await repository.getSpecialStockCase(d.id);assert.equal(d.fulfillmentMethod,'yard_pickup');assert.equal(d.fulfillmentChange.status,'attention');
 await assert.doesNotReject(()=>assertSpecialStockHandoffPlanning({trucks:[{loads:[{stops:[{type:'pickup',orderId:'TEST-APPROVAL-PO'}]}]}]}));
 const changeId=d.fulfillmentChange.id;
 d=await service(d.id,{expectedRevision:d.revision,changeId,fulfillmentMethod:'vendor_pickup'},context);
 assert.equal(d.fulfillmentMethod,'mbt_delivery');assert.equal(d.deliveryAddress,'TEST new site');assert.equal(d.attention,false);assert.equal(patches,1);assert.equal(d.fulfillmentChangePlan,undefined);
 const so=(await query('SELECT delivery_method_id,sales_order_type,dispatch_address,dispatch_instructions FROM sales_orders WHERE netsuite_id=8899911')).rows[0];
 assert.equal(Number(so.delivery_method_id),2);assert.equal(so.sales_order_type,'Delivery');assert.equal(so.dispatch_address,'TEST new site');assert.equal(so.dispatch_instructions,'Use side gate');
 assert.equal((await repository.getSpecialStockCase(d.id,{audience:'scm'})).fulfillmentMethod,'mbt_delivery');
 const completed=await service(d.id,{expectedRevision:d.revision,changeId},context);assert.equal(completed.fulfillmentMethod,'mbt_delivery');assert.equal(patches,1);
 d=await service(d.id,{expectedRevision:d.revision,fulfillmentMethod:'yard_pickup'},context);
 assert.equal(d.fulfillmentMethod,'yard_pickup');assert.equal(d.deliveryAddress,'');assert.equal(patches,2);
 assert.equal((await query('SELECT dispatch_address FROM sales_orders WHERE netsuite_id=8899911')).rows[0].dispatch_address,null);
}));
test('pre-SO delivery save uses no remote call and leaves enquiry prices unchanged',()=>fixture(async()=>{
 const {createSpecialFulfillmentService}=await import('../../../src/special-stock-fulfillment.js');
 let d=await repository.createSpecialStockCase(input,context);const before=d.lines;
 const update=createSpecialFulfillmentService({prepare:()=>assert.fail('No SO exists'),apply:()=>assert.fail('No SO exists')});
 d=await update(d.id,{expectedRevision:d.revision,fulfillmentMethod:'vendor_pickup'},context);
 assert.equal(d.fulfillmentMethod,'vendor_pickup');assert.deepEqual(d.lines,before);assert.equal(d.fulfillmentChange.status,'complete');
}));
test('approval classifier ignores stale cached text and rejects unknown, inactive and rejected POs',()=>fixture(async()=>{
 const d=await linked();
 for(const [code,label,active,approved,pending] of [
 ['A','Pending Receipt',true,false,true],['','Purchase Order : Pending Supervisor Approval',true,false,true],
 ['C','Rejected by Supervisor',true,false,false],['H','Closed',true,false,false],['','Unrecognized',true,false,false],
 ['B','Pending Receipt',false,false,false],['B','Pending Receipt',true,true,false],['','Purchase Order : Pending Receipt',true,true,false]
 ]){
 await query('UPDATE purchase_orders SET status=$1,status_text=$2,netsuite_active=$3 WHERE netsuite_id=8899912',[code,label,active]);
 const detail=await repository.getSpecialStockCase(d.id);assert.equal(detail.purchaseOrderApproved,approved,code+label);assert.equal(detail.purchaseOrderPendingApproval,pending);
 const stage=(await query('SELECT stage FROM special_stock_workflow_stages WHERE request_id=$1',[d.id])).rows[0].stage;assert.equal(stage,detail.stage);
 }
}));
test('PO reference rejects hostile values, duplicate refs and closed cases atomically',()=>fixture(async()=>{
 const d=await linked({status:'B',statusText:'Pending Receipt'});
 const save=(reference,previousReference='')=>referenceUpdate(d.id,{expectedRevision:d.revision,reference,previousReference},context);
 for(const value of [null,{},'x'.repeat(121),'bad\nref']) await assert.rejects(()=>save(value),{code:'SPECIAL_PO_REFERENCE_INVALID'});
 await query("INSERT INTO purchase_orders(netsuite_id,tranid,netsuite_active) VALUES(8899913,'DUPLICATE',true)");
 await assert.rejects(()=>save('DUPLICATE'),/already exists/);assert.equal((await repository.getSpecialStockCase(d.id)).revision,d.revision);
 await query("UPDATE sales_special_stock_cases SET close_status='closed' WHERE request_id=$1",[d.id]);
 await assert.rejects(()=>save('CLOSED'),{code:'SPECIAL_CASE_CLOSED'});
}));
test('pending PO handoffs stay hidden from Dispatch and become visible after approval',()=>fixture(async()=>{
 const d=await linked();
 await query("INSERT INTO sales_special_stock_handoffs(request_id,route,status,sales_order_netsuite_id,purchase_order_netsuite_id,pickup_address,destination_address,operational_yard_location_id) VALUES($1,'direct','ready',8899911,8899912,'TEST vendor','TEST yard',1)",[d.id]);
 assert.equal((await repository.listSpecialDispatchHandoffs()).some(r=>r.id===d.id),false);
 await query("UPDATE purchase_orders SET status='B',status_text='Pending Receipt' WHERE netsuite_id=8899912");
 assert.equal((await repository.listSpecialDispatchHandoffs()).some(r=>r.id===d.id),true);
}));
test('closed, stale-journal and unverified delivery completions reject without changing the saved method',()=>fixture(async()=>{
 let d=await linked();
 await query("UPDATE sales_special_stock_cases SET close_status='closed' WHERE request_id=$1",[d.id]);
 await assert.rejects(()=>deliveryClaim(d.id,{expectedRevision:d.revision,fulfillmentMethod:'vendor_pickup'},context),{code:'SPECIAL_FULFILLMENT_CLOSED'});
 await query("UPDATE sales_special_stock_cases SET close_status='active' WHERE request_id=$1",[d.id]);
 d=await deliveryClaim(d.id,{expectedRevision:d.revision,fulfillmentMethod:'mbt_delivery',deliveryAddress:'TEST site'},context);
 await assert.rejects(()=>repository.finishSpecialFulfillmentChange(d.id,'wrong-id',{},context),{code:'SPECIAL_FULFILLMENT_STALE'});
 await assert.rejects(()=>repository.finishSpecialFulfillmentChange(d.id,d.fulfillmentChange.id,{deliveryMethodId:1},context),{code:'SPECIAL_FULFILLMENT_UNVERIFIED'});
 assert.equal((await repository.getSpecialStockCase(d.id)).fulfillmentMethod,'yard_pickup');
}));

test('pickup location changes after SO/PO stay local and preserve canonical orders and notes',()=>fixture(async()=>{
 const {createSpecialFulfillmentService}=await import('../../../src/special-stock-fulfillment.js');
 let d=await linked({status:'B',statusText:'Pending Receipt'});
 await query("UPDATE sales_special_stock_lines SET supply_status='in_stock' WHERE request_id=$1",[d.id]);
 await query("UPDATE sales_orders SET expected_delivery_date='2099-03-01',dispatch_address='Existing unused address',dispatch_instructions='Keep existing notes' WHERE netsuite_id=8899911");
 await query("INSERT INTO sales_order_delivery_instructions(sales_order_id,additional_text,revision) VALUES(8899911,'Existing pickup notes',3)");
 const canonical=async()=>({so:(await query('SELECT * FROM sales_orders WHERE netsuite_id=8899911')).rows,
   po:(await query('SELECT * FROM purchase_orders WHERE netsuite_id=8899912')).rows,
   notes:(await query('SELECT * FROM sales_order_delivery_instructions WHERE sales_order_id=8899911')).rows});
 const before=await canonical(),lines=d.lines;
 const update=createSpecialFulfillmentService({prepare:()=>assert.fail('Pickup changes must not read NetSuite'),apply:()=>assert.fail('Pickup changes must not write NetSuite')});
 for(const method of ['vendor_pickup','yard_pickup']) {
  d=await update(d.id,{expectedRevision:d.revision,fulfillmentMethod:method},context);
  assert.equal(d.fulfillmentMethod,method);assert.equal(d.fulfillmentChange.status,'complete');assert.equal(d.attention,false);
  assert.deepEqual(await canonical(),before);assert.deepEqual(d.lines.map(l=>[l.id,l.originalRate,l.subtotal,l.quantity]),lines.map(l=>[l.id,l.originalRate,l.subtotal,l.quantity]));
  assert.equal((await repository.getSpecialStockCase(d.id,{audience:'scm'})).fulfillmentMethod,method);
  const handoff=(await query('SELECT status FROM sales_special_stock_handoffs WHERE request_id=$1',[d.id])).rows;
  assert.deepEqual(handoff,method==='vendor_pickup'?[]:[{status:'waiting_route'}]);
 }
 assert.equal((await query("SELECT count(*)::integer AS n FROM sales_special_stock_events WHERE request_id=$1 AND event_type='special_delivery_method_updated'",[d.id])).rows[0].n,2);
}));

test('failed legacy pickup update retries locally using its saved target and completes idempotently',()=>fixture(async()=>{
 const {createSpecialFulfillmentService}=await import('../../../src/special-stock-fulfillment.js');
 let d=await linked();d=await deliveryClaim(d.id,{expectedRevision:d.revision,fulfillmentMethod:'vendor_pickup'},context);
 const changeId=d.fulfillmentChange.id;
 await repository.failSpecialFulfillmentChange(d.id,changeId,'The exact NetSuite order and line identities are required.',context);
 d=await repository.getSpecialStockCase(d.id);assert.equal(d.attention,false);assert.equal(d.fulfillmentChange.status,'failed');
 const update=createSpecialFulfillmentService({prepare:()=>assert.fail('Pickup recovery is local'),apply:()=>assert.fail('Pickup recovery is local')});
 d=await update(d.id,{expectedRevision:d.revision,changeId,fulfillmentMethod:'mbt_delivery',deliveryAddress:'Ignored retry target'},context);
 assert.equal(d.fulfillmentMethod,'vendor_pickup');assert.equal(d.fulfillmentChange.target.fulfillmentMethod,'vendor_pickup');
 assert.equal(d.fulfillmentChange.error,null);assert.equal(d.attention,false);assert.equal(d.fulfillmentChange.status,'complete');
 const revision=d.revision;
 d=await update(d.id,{expectedRevision:revision,changeId},context);assert.equal(d.revision,revision);
 assert.equal(Number((await query('SELECT delivery_method_id FROM sales_orders WHERE netsuite_id=8899911')).rows[0].delivery_method_id),1);
}));

test('a legacy pickup journal with a saved remote plan must still be verified',()=>fixture(async()=>{
 const {createSpecialFulfillmentService}=await import('../../../src/special-stock-fulfillment.js');
 let d=await linked();d=await deliveryClaim(d.id,{expectedRevision:d.revision,fulfillmentMethod:'vendor_pickup'},context);
 const changeId=d.fulfillmentChange.id,plan={version:1,id:8899911,target:{methodId:1}};
 await repository.saveSpecialFulfillmentPlan(d.id,changeId,plan);
 await assert.rejects(()=>repository.finishSpecialFulfillmentChange(d.id,changeId,{},context),{code:'SPECIAL_FULFILLMENT_UNVERIFIED'});
 let verified=0;
 const update=createSpecialFulfillmentService({prepare:()=>assert.fail('Use the saved plan'),apply:async saved=>{assert.deepEqual(saved,plan);verified++;return{deliveryMethodId:1};}});
 d=await update(d.id,{expectedRevision:d.revision,changeId},context);assert.equal(verified,1);assert.equal(d.fulfillmentMethod,'vendor_pickup');
}));

test('pickup completion rechecks planning after claim and respects scope and revisions',()=>fixture(async()=>{
 let d=await linked();const input={expectedRevision:d.revision,fulfillmentMethod:'vendor_pickup'};
 await assert.rejects(()=>deliveryClaim(d.id,input,{...context,authorizedStoreLocationIds:[28]}),{code:'SPECIAL_CASE_STORE_FORBIDDEN'});
 await assert.rejects(()=>deliveryClaim(d.id,{...input,expectedRevision:d.revision+1},context),{code:'SPECIAL_REVISION_CONFLICT'});
 d=await deliveryClaim(d.id,input,context);
 await query('UPDATE sales_orders SET dispatch_planned=true WHERE netsuite_id=8899911');
 await assert.rejects(()=>repository.finishSpecialFulfillmentChange(d.id,d.fulfillmentChange.id,{},context),{code:'SPECIAL_FULFILLMENT_PLANNED'});
 assert.equal((await repository.getSpecialStockCase(d.id)).fulfillmentMethod,'yard_pickup');
}));
test('delivery preparation failure releases editing and Sales can replace the failed target',()=>fixture(async()=>{
 const {createSpecialFulfillmentService}=await import('../../../src/special-stock-fulfillment.js');
 let d=await linked();
 const update=createSpecialFulfillmentService({prepare:async()=>{throw Error('Preparation unavailable');},apply:()=>assert.fail('No prepared plan')});
 await assert.rejects(()=>update(d.id,{expectedRevision:d.revision,fulfillmentMethod:'mbt_delivery',deliveryAddress:'Failed site'},context),/Preparation unavailable/);
 d=await repository.getSpecialStockCase(d.id);
 assert.equal(d.fulfillmentChange.status,'failed');assert.equal(d.attention,false);assert.equal(d.fulfillmentChange.hasPlan,false);
 const old=d.fulfillmentChange.id;
 await query("UPDATE sales_special_stock_cases SET attention=true,attention_reason='Historic material mismatch' WHERE request_id=$1",[d.id]);
 d=await update(d.id,{expectedRevision:d.revision,replaceChangeId:old,fulfillmentMethod:'vendor_pickup'},context);
 assert.equal(d.fulfillmentMethod,'vendor_pickup');assert.equal(d.fulfillmentChange.status,'complete');assert.notEqual(d.fulfillmentChange.id,old);
 assert.equal(d.events.filter(e=>e.eventType==='special_delivery_change_replaced').length,1);
 assert.equal((await query('SELECT attention_reason FROM sales_special_stock_cases WHERE request_id=$1',[d.id])).rows[0].attention_reason,'Historic material mismatch');
}));
test('discarding an unapplied delivery attempt releases a stale lock without remote calls and preserves history',()=>fixture(async()=>{
 const {createSpecialFulfillmentService}=await import('../../../src/special-stock-fulfillment.js');
 let d=await linked();d=await deliveryClaim(d.id,{expectedRevision:d.revision,fulfillmentMethod:'mbt_delivery',deliveryAddress:'Unsent site'},context);
 const changeId=d.fulfillmentChange.id,revision=d.revision;
 const update=createSpecialFulfillmentService({prepare:()=>assert.fail('Discard must be local'),apply:()=>assert.fail('Discard must be local')});
 const cancel={action:'discard',changeId,expectedRevision:revision};
 await assert.rejects(()=>update(d.id,cancel,{...context,authorizedStoreLocationIds:[28]}),{code:'SPECIAL_CASE_STORE_FORBIDDEN'});
 await assert.rejects(()=>update(d.id,{...cancel,expectedRevision:revision+1},context),{code:'SPECIAL_REVISION_CONFLICT'});
 await assert.rejects(()=>update(d.id,{...cancel,changeId:'foreign'},context),{code:'SPECIAL_FULFILLMENT_STALE'});
 d=await update(d.id,cancel,context);
 assert.equal(d.fulfillmentChange.status,'cancelled');assert.equal(d.fulfillmentMethod,'yard_pickup');assert.equal(d.attention,false);
 assert.equal(d.events.filter(e=>e.eventType==='special_delivery_change_cancelled').length,1);
 const again=await update(d.id,{...cancel,expectedRevision:d.revision},context);assert.equal(again.revision,d.revision);
 await assert.rejects(()=>repository.withSpecialQuantityReviewLock(d.id,()=>update(d.id,{...cancel,expectedRevision:d.revision},context)),{code:'SPECIAL_QUANTITY_REVIEW_BUSY'});
}));
test('saved remote delivery plans cannot be discarded but can be explicitly replaced under the operation lock',()=>fixture(async()=>{
 const {createSpecialFulfillmentService}=await import('../../../src/special-stock-fulfillment.js');
 let d=await linked();d=await deliveryClaim(d.id,{expectedRevision:d.revision,fulfillmentMethod:'mbt_delivery',deliveryAddress:'Old site'},context);
 const old=d.fulfillmentChange.id,plan={version:1,id:8899911,target:{methodId:2}};
 await repository.saveSpecialFulfillmentPlan(d.id,old,plan);await repository.failSpecialFulfillmentChange(d.id,old,'Lost acknowledgement',context);
 d=await repository.getSpecialStockCase(d.id);assert.equal(d.fulfillmentChange.hasPlan,true);
 let prepared=0,applied=0;
 const update=createSpecialFulfillmentService({prepare:async input=>{prepared++;assert.equal(input.deliveryAddress,'Replacement site');return {...plan,target:{methodId:2},replacement:true};},
  apply:async saved=>{applied++;assert.equal(saved.replacement,true);return{deliveryMethodId:2};}});
 await assert.rejects(()=>update(d.id,{action:'discard',expectedRevision:d.revision,changeId:old},context),{code:'SPECIAL_FULFILLMENT_CANCEL_UNSAFE'});
 await assert.rejects(()=>update(d.id,{expectedRevision:d.revision,replaceChangeId:'foreign',fulfillmentMethod:'vendor_pickup'},context),{code:'SPECIAL_FULFILLMENT_STALE'});
 d=await update(d.id,{expectedRevision:d.revision,replaceChangeId:old,fulfillmentMethod:'mbt_delivery',deliveryAddress:'Replacement site'},context);
 assert.equal(prepared,1);assert.equal(applied,1);assert.equal(d.deliveryAddress,'Replacement site');assert.equal(d.fulfillmentChange.status,'complete');
}));

test('replacement pickup after an uncertain remote change must reverify NetSuite and cannot discard failed re-preparation',()=>fixture(async()=>{
 const {createSpecialFulfillmentService}=await import('../../../src/special-stock-fulfillment.js');
 let d=await linked();d=await deliveryClaim(d.id,{expectedRevision:d.revision,fulfillmentMethod:'mbt_delivery',deliveryAddress:'Original site'},context);
 const oldPlan={version:1,id:8899911,target:{methodId:2}};
 await repository.saveSpecialFulfillmentPlan(d.id,d.fulfillmentChange.id,oldPlan);
 await repository.failSpecialFulfillmentChange(d.id,d.fulfillmentChange.id,'Lost acknowledgement',context);
 d=await repository.getSpecialStockCase(d.id);
 let prepareFails=true,applied=0;
 const update=createSpecialFulfillmentService({prepare:async input=>{assert.equal(input.fulfillmentMethod,'vendor_pickup');if(prepareFails)throw Error('Cannot read current header');return {...oldPlan,target:{methodId:1}};},
  apply:async plan=>{applied++;assert.equal(plan.target.methodId,1);return {deliveryMethodId:1};}});
 await assert.rejects(update(d.id,{expectedRevision:d.revision,replaceChangeId:d.fulfillmentChange.id,fulfillmentMethod:'vendor_pickup'},context),/Cannot read current header/);
 d=await repository.getSpecialStockCase(d.id);assert.equal(d.fulfillmentChange.status,'attention');assert.equal(d.fulfillmentChange.hasPlan,true);
 await assert.rejects(update(d.id,{expectedRevision:d.revision,changeId:d.fulfillmentChange.id,action:'discard'},context),{code:'SPECIAL_FULFILLMENT_CANCEL_UNSAFE'});
 prepareFails=false;
 d=await update(d.id,{expectedRevision:d.revision,changeId:d.fulfillmentChange.id},context);
 assert.equal(applied,1);assert.equal(d.fulfillmentMethod,'vendor_pickup');assert.equal(d.fulfillmentChange.status,'complete');
 assert.equal(Number((await query('SELECT delivery_method_id FROM sales_orders WHERE netsuite_id=8899911')).rows[0].delivery_method_id),1);
}));

test('property: failed delivery attempts release editing exactly when no remote plan exists',async()=>{
 const {default:fc}=await import('fast-check');
 const {createSpecialFulfillmentService}=await import('../../../src/special-stock-fulfillment.js');
 await fc.assert(fc.asyncProperty(fc.boolean(),fc.constantFrom('yard_pickup','vendor_pickup'),async(hasPlan,method)=>fixture(async()=>{
  let d=await linked({method});d=await deliveryClaim(d.id,{expectedRevision:d.revision,fulfillmentMethod:'mbt_delivery',deliveryAddress:'Property site'},context);
  if(hasPlan)await repository.saveSpecialFulfillmentPlan(d.id,d.fulfillmentChange.id,{version:1,id:8899911,target:{methodId:2}});
  await repository.failSpecialFulfillmentChange(d.id,d.fulfillmentChange.id,'Property failure',context);
  d=await repository.getSpecialStockCase(d.id);assert.equal(d.fulfillmentChange.status,hasPlan?'attention':'failed');assert.equal(d.attention,hasPlan);
  const update=createSpecialFulfillmentService({prepare:()=>assert.fail('Discard must not read NetSuite'),apply:()=>assert.fail('Discard must not write NetSuite')});
  const input={expectedRevision:d.revision,changeId:d.fulfillmentChange.id,action:'discard'};
  if(hasPlan)await assert.rejects(update(d.id,input,context),{code:'SPECIAL_FULFILLMENT_CANCEL_UNSAFE'});
  else {const result=await update(d.id,input,context);assert.equal(result.fulfillmentChange.status,'cancelled');assert.equal(result.fulfillmentMethod,method);}
 })),{seed:631019,numRuns:16});
});

test('stale retry and conflicting recovery selectors cannot overwrite a delivery journal',()=>fixture(async()=>{
 const {createSpecialFulfillmentService}=await import('../../../src/special-stock-fulfillment.js');
 let d=await linked();const update=createSpecialFulfillmentService({prepare:()=>assert.fail('Pickup changes are local'),apply:()=>assert.fail('Pickup changes are local')});
 d=await update(d.id,{expectedRevision:d.revision,fulfillmentMethod:'vendor_pickup'},context);
 for(const input of [{changeId:'foreign'},{changeId:d.fulfillmentChange.id,replaceChangeId:d.fulfillmentChange.id}]) {
  await assert.rejects(update(d.id,{expectedRevision:d.revision,...input},context),{code:'SPECIAL_FULFILLMENT_STALE'});
 }
 await assert.rejects(update(d.id,{expectedRevision:d.revision,changeId:d.fulfillmentChange.id,action:'discard'},context),{code:'SPECIAL_FULFILLMENT_CANCEL_UNSAFE'});
 assert.equal((await repository.getSpecialStockCase(d.id)).revision,d.revision);
}));
