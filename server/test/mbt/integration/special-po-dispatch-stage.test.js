import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFileSync} from 'node:fs';
import test,{before,after} from 'node:test';
import {app} from '../../../src/server.js';
import {createOperator} from '../../../src/auth-repository.js';
import {query,closeDb} from '../../../src/db.js';
import * as cases from '../../../src/special-stock-request-repository.js';
import {submitBackorderRequest} from '../../../src/backorder-request-service.js';
import {withBackorderWorkflow} from '../../../src/stock-case-workflow.js';
import {updateScmScheduleEntry,updatePurchaseOrderDispatchRef} from '../../../src/dispatch-repository.js';

const users={},requests=[],orders=[];
const sku=91910001;
let server,base;
const scoped=(kind,fn)=>kind==='backorder'?withBackorderWorkflow(fn):fn();
const context=()=>({operatorId:users.sales.id,authorizedStoreLocationIds:[1],authorizedDestinationLocationIds:[1]});
const load=d=>scoped(d.workflowKind,()=>cases.getSpecialStockCase(d.id));
async function get(role,path) {
  const response=await fetch(base+path,{headers:{authorization:'Bearer '+users[role].token}});
  const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body;
}

async function fixture(kind,method='mbt_delivery') {
  const input={storeLocationId:1,destinationLocationId:1,inquiryDate:'2099-01-01',customerName:'TEST Dispatch Stage',
    vendorId:331,vendorName:'TEST Vendor',fulfillmentMethod:method,deliveryAddress:'TEST Delivery address',
    lines:[{itemId:sku,salesQty:1,productName:'TEST Dispatch Material',quantity:1,uom:kind==='special'?'EACH':'EA',rate:25,requiredDate:'2099-02-01'}]};
  let d=kind==='backorder'?await submitBackorderRequest(input,context()):await cases.createSpecialStockCase(input,context());
  requests.push(d.id);
  d=await scoped(kind,()=>cases.saveSpecialStockChecks(d.id,{expectedRevision:d.revision,lines:[{lineId:d.lines[0].id,kind:'response',
    supplyStatus:'production',availabilityMode:'dated',availableDate:'2099-02-01',vendorId:331,vendorName:'TEST Vendor',vendorYard:'TEST Yard'}]}, {operatorId:users.scm.id}));
  d=await scoped(kind,()=>cases.saveSpecialCustomerDecisions(d.id,{expectedRevision:d.revision,lines:[{lineId:d.lines[0].id,decision:'accepted'}]},context()));
  const so=91920000+d.id*2,po=so+1;
  orders.push({so,po});
  await query("INSERT INTO sales_orders(netsuite_id,tranid,status,status_text,fulfillment_status,netsuite_active) VALUES($1,$2,'B','Sales Order : Pending Fulfillment','not_fulfilled',true)",[so,'TEST-DISPATCH-SO-'+d.id]);
  await query("INSERT INTO purchase_orders(netsuite_id,tranid,status,status_text,receipt_status,netsuite_active,initial_scm_status) VALUES($1,$2,'B','Purchase Order : Pending Receipt','not_received',true,'Hold')",[po,'TEST-DISPATCH-PO-'+d.id]);
  await query("UPDATE sales_special_stock_cases SET sales_order_source='manual_link',purchase_order_custom_linkage=true,sales_order_operation_status='linked',purchase_order_operation_status='linked',sales_order_netsuite_id=$2,sales_order_ref=$3,purchase_order_netsuite_id=$4,purchase_order_ref=$5 WHERE request_id=$1",[d.id,so,'TEST-DISPATCH-SO-'+d.id,po,'TEST-DISPATCH-PO-'+d.id]);
  return load(d);
}

async function projections(d,stage) {
  assert.equal(d.stage,stage,d.workflowKind);assert.equal(d.operationallyComplete,stage==='completed');
  assert.equal((await query('SELECT stage FROM special_stock_workflow_stages WHERE request_id=$1',[d.id])).rows[0].stage,stage);
  for(const role of ['sales','scm']) {
    const path=`/api/${role}/${d.workflowKind==='backorder'?'stock-requests':'special-stock-requests'}`;
    assert.equal((await get(role,path+'/'+d.id)).stage,stage);
    const filter=d.workflowKind==='backorder'?(role==='sales'?`type=backorder&bucket=${stage==='completed'?'completed':'pending'}&stage=${stage}`:`type=backorder&queue=${stage==='completed'?'closed':'request'}&stage=${stage}`):`stages=${stage}`;
    assert.ok((await get(role,path+'?'+filter+'&search='+d.requestRef)).requests.some(row=>row.id===d.id&&row.stage===stage));
  }
}

async function schedule(d,status,reference) {
  const ref=reference===undefined?d.purchaseOrderReference:reference;
  const existing=(await query("SELECT to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS token FROM scm_transport_schedule WHERE order_kind='PO' AND lower(order_ref)=lower($1)",[d.purchaseOrderReference||d.purchaseOrderRef])).rows[0];
  await updateScmScheduleEntry({orderKind:'PO',orderRef:d.purchaseOrderReference||d.purchaseOrderRef,expectedUpdatedAt:existing?.token||null,
    patch:{status,packingSlipRef:ref,method:'MBT'},updatedBy:users.scm.id});
  return load(d);
}

before(async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');assert.equal(new URL(process.env.DATABASE_URL).hostname,'db');
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'");
  await query("INSERT INTO inventory_items(item_id,item_name,display_name,stock_unit,vendor,raw,synced_at) VALUES($1,'TEST-DISPATCH-SKU','TEST Regular Material','EA','TEST Vendor','{}',now()) ON CONFLICT DO NOTHING",[sku]);
  server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base='http://127.0.0.1:'+server.address().port;
  for(const role of ['sales','scm']) {
    const username='dispatch-stage-'+role+'-'+crypto.randomUUID(),password=crypto.randomUUID();
    users[role]=await createOperator({username,password,displayName:'TEST '+role,role,roles:[role],yardLocationIds:[1]});
    const response=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password})});
    assert.equal(response.status,200);users[role].token=(await response.json()).token;
  }
});
after(async()=>{
  try {
    if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
    await query('DELETE FROM sales_stock_requests WHERE id=ANY($1::bigint[])',[requests]);
    await query("DELETE FROM scm_transport_schedule WHERE order_kind='PO' AND order_ref LIKE 'TEST-DISPATCH-%'");
    await query('DELETE FROM purchase_orders WHERE netsuite_id=ANY($1::bigint[])',[orders.map(o=>o.po)]);
    await query('DELETE FROM sales_orders WHERE netsuite_id=ANY($1::bigint[])',[orders.map(o=>o.so)]);
    for(const user of Object.values(users)){await query('DELETE FROM delivery_audit_log WHERE actor_operator_id=$1',[user.id]);await query('DELETE FROM operators WHERE id=$1',[user.id]);}
  } finally {await closeDb();}
});

test('Special and Backorder wait for a PO reference with Queued, including accepted production ETAs',async()=>{
  for(const kind of ['special','backorder']) {
    let d=await fixture(kind);await projections(d,'confirmed');
    d=await schedule(d,'Queued','');await projections(d,'confirmed');
    d=await schedule(d,'Hold','TEST-DISPATCH-REF-'+d.id);await projections(d,'confirmed');
    d=await schedule(d,'Queued');await projections(d,'dispatch_arrangement');
    assert.equal(d.purchaseOrderDispatchStatus,'Queued');assert.equal(d.lines[0].supplyStatus,'production');
    assert.ok(d.purchaseOrderReference);assert.equal(d.purchaseOrderReference,'TEST-DISPATCH-REF-'+d.id);
    const original=(await query('SELECT * FROM sales_special_stock_cases WHERE request_id=$1',[d.id])).rows[0];
    await query(readFileSync(new URL('../../../migrations/289_special_po_dispatch_stage.sql',import.meta.url),'utf8'));
    await query(readFileSync(new URL('../../../migrations/296_special_vendor_confirmation.sql',import.meta.url),'utf8'));
    await projections(await load(d),'dispatch_arrangement');
    assert.deepEqual((await query('SELECT * FROM sales_special_stock_cases WHERE request_id=$1',[d.id])).rows[0],original);
  }
});

test('reference changes and Hold saves use current canonical SCM state without a request edit',async()=>{
  for(const kind of ['special','backorder']) {
    let d=await schedule(await fixture(kind),'Queued','TEST-DISPATCH-FIRST-'+kind);
    await projections(d,'dispatch_arrangement');const revision=d.revision;
    d=await schedule(d,'Hold');await projections(d,'confirmed');
    await updatePurchaseOrderDispatchRef({poRef:d.purchaseOrderRef,newRef:'TEST-DISPATCH-SECOND-'+kind,updatedBy:users.scm.id});
    d=await load(d);await projections(d,'confirmed');
    d=await schedule(d,'Queued');await projections(d,'dispatch_arrangement');assert.equal(d.revision,revision);
    await query("UPDATE scm_transport_schedule SET status='In Transit' WHERE order_kind='PO' AND order_ref=$1",[d.purchaseOrderReference]);
    await projections(await load(d),'dispatch_arrangement');
  }
});

test('approved PO plus queued reference advances Special; pending approval keeps Confirmed',async()=>{
  let d=await schedule(await fixture('special'),'Queued','TEST-DISPATCH-APPROVAL');
  await query("UPDATE purchase_orders SET status='A',status_text='Purchase Order : Pending Supervisor Approval' WHERE netsuite_id=$1",[d.purchaseOrderId]);
  await projections(await load(d),'confirmed');
  await query("UPDATE purchase_orders SET status='B',status_text='Purchase Order : Pending Receipt' WHERE netsuite_id=$1",[d.purchaseOrderId]);
  await projections(await load(d),'dispatch_arrangement');
});

test('Backorder SO linkage completes only when the linked orders have actual completion evidence',async()=>{
  for(const method of ['vendor_pickup','yard_pickup','mbt_delivery']) {
    let d=await schedule(await fixture('backorder',method),'Queued','TEST-DISPATCH-COMPLETE-'+method);
    await projections(d,'dispatch_arrangement');
    if(method==='mbt_delivery') {
      await query("SELECT dispatch_record_order_completion('SO',$1,'2099-02-02T12:00:00Z','reconciliation',$2)",[d.salesOrderRef,'TEST-DISPATCH-COMPLETE-SO-'+d.id]);
      await projections(await load(d),'dispatch_arrangement');
      await query("SELECT dispatch_record_order_completion('PO',$1,'2099-02-02T13:00:00Z','reconciliation',$2)",[d.purchaseOrderReference,'TEST-DISPATCH-COMPLETE-PO-'+d.id]);
    } else {
      await query("UPDATE sales_orders SET status='F',status_text='Sales Order : Pending Billing' WHERE netsuite_id=$1",[d.salesOrderId]);
      await projections(await load(d),'dispatch_arrangement');
      await query("UPDATE purchase_orders SET status='D',status_text='Purchase Order : Pending Bill',receipt_status='received',received_at='2099-02-02T13:00:00Z' WHERE netsuite_id=$1",[d.purchaseOrderId]);
    }
    await projections(await load(d),'completed');
  }
});
