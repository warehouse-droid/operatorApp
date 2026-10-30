import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { beginRollbackContext, closeDb, query } from '../../../src/db.js';
import * as repo from '../../../src/special-stock-request-repository.js';
import { createSpecialFulfillmentService } from '../../../src/special-stock-fulfillment.js';
import { canEditSpecialFulfillment } from '../../../public/special-stock-fulfillment.js';
import { readSpecialFulfillmentStarted } from '../../../src/special-stock-logistics.js';
import { withBackorderWorkflow, stockCaseWorkflow } from '../../../src/stock-case-workflow.js';
import { prepareSpecialFulfillmentPlan, applySpecialFulfillmentPlan } from '../../../src/special-stock-fulfillment-adapter.js';

after(closeDb);
const context = { operatorId: 'planned-method-test', authorizedStoreLocationIds: [1] };
const so = 8899971, po = 8899972;
const refs = ['TEST-PLANNED-METHOD-SO', 'TEST-PLANNED-METHOD-PO'];
const update = createSpecialFulfillmentService({ prepare: () => assert.fail('Pickup changes stay local'), apply: () => assert.fail('Pickup changes stay local') });
async function fixture(run, backorder=false) {
  if(backorder)return withBackorderWorkflow(()=>fixture(run));
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  const rollback = await beginRollbackContext();
  try { await rollback.run(async () => {
    await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,yard_location_ids) VALUES($1,$1,'TEST','hash','salt','admin',ARRAY['admin'],ARRAY[1]) ON CONFLICT DO NOTHING", [context.operatorId]);
    const regular=stockCaseWorkflow()==='backorder';
    if(regular)await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,raw,synced_at) VALUES(8899979,'TEST planned material','SQFT','{}',now()) ON CONFLICT DO NOTHING");
    let detail = await repo.createSpecialStockCase({ storeLocationId: 1, inquiryDate: '2099-01-01', customerName: 'TEST', vendorName: 'TEST', fulfillmentMethod: 'yard_pickup',
      lines: [{ productName: 'TEST material', quantity: 3, uom: 'SQFT', rate: 42, requiredDate: '2099-02-01',...(regular?{regularItemId:8899979,regularItemCode:'TEST'}:{}) }] }, context);
    await query("INSERT INTO sales_orders(netsuite_id,tranid,status,status_text,netsuite_active,order_location_id,delivery_method_id,sales_order_type,dispatch_planned) VALUES($1,$2,'B','Pending Fulfillment',true,1,1,'Pickup',true)", [so, refs[0]]);
    await query("INSERT INTO purchase_orders(netsuite_id,tranid,dispatch_ref,status,status_text,netsuite_active) VALUES($1,$2,'TEST-PLANNED-METHOD-VENDOR','B','Pending Receipt',true)", [po, refs[1]]);
    if(regular)await query("UPDATE sales_special_stock_cases SET sales_order_source='manual_link',purchase_order_custom_linkage=true WHERE request_id=$1",[detail.id]);
    await query("UPDATE sales_special_stock_cases SET sales_order_netsuite_id=$2,sales_order_ref=$3,sales_order_approved=true,purchase_order_netsuite_id=$4,purchase_order_ref=$5,operational_yard_location_id=1,handoff_route='via_yard' WHERE request_id=$1", [detail.id, so, refs[0], po, refs[1]]);
    await query("UPDATE sales_special_stock_lines SET supply_status='in_stock',sales_decision='accepted' WHERE request_id=$1", [detail.id]);
    await query("INSERT INTO scm_transport_schedule(order_kind,order_ref,source_id,status) VALUES('PO','TEST-PLANNED-METHOD-VENDOR',$1,'Planned')", [po]);
    await query("INSERT INTO sales_special_stock_handoffs(request_id,route,status,sales_order_netsuite_id,purchase_order_netsuite_id,pickup_address,destination_address,operational_yard_location_id) VALUES($1,'via_yard','planned',$2,$3,'TEST vendor','3445',1)", [detail.id,so,po]);
    const plan = (await query("INSERT INTO dispatch_plans(plan_date,status,revision,note) VALUES('2099-01-01','draft',2,'planned delivery method test') RETURNING id")).rows[0];
    await query(`INSERT INTO dispatch_plan_snapshots(plan_id,orders,trucks,summary) VALUES($1,$2::jsonb,$3::jsonb,'{}')`, [plan.id,
      JSON.stringify([{ id: 'GO-PLANNED-METHOD', type: 'SO', childOrders: refs, childOrderDetails: [{ id: refs[0], type: 'SO' }, { id: refs[1], type: 'PO' }] }]),
      JSON.stringify([{ id: 'test-truck', plate: 'TEST', loads: [{ id: 'test-load', name: 'TEST load', stops: [{ id: 'test-stop', type: 'drop', orderId: 'GO-PLANNED-METHOD' }] }] }])]);
    for (const ref of refs) await query("INSERT INTO dispatch_plan_order_assignments(plan_id,plan_date,order_ref,planned_order_ref,load_id,stop_id,assignment_kind,assignment) VALUES($1,'2099-01-01',$2,'GO-PLANNED-METHOD','test-load','test-stop','group_member','{}')", [plan.id,ref]);
    detail = await repo.getSpecialStockCase(detail.id, { audience: 'sales', authorizedStoreLocationIds: [1] });
    await run(detail, plan.id);
  }); } finally { await rollback.rollback(); }
}
const snapshot = async planId => (await query('SELECT * FROM dispatch_plan_snapshots WHERE plan_id=$1', [planId])).rows[0];
async function start(planId, reference, type='pickup', status='in_progress') {
  await query(`INSERT INTO driver_job_records(job_id,plan_id,plan_date,driver_login,load_id,stop_id,stop_type,order_refs,status,started_at,completed_at)
    VALUES('planned-method-job',$1,'2099-01-01','TEST','test-load','test-stop',$2,$3::jsonb,$4,now(),CASE WHEN $4='complete' THEN now() END)`, [planId,type,JSON.stringify([reference]),status]);
}

test('planned SO, PO and handoff allow an audited method change while preserving saved plans and commercial orders', () => fixture(async (d, planId) => {
  assert.equal(d.stage, 'dispatch_arrangement'); assert.equal(d.dispatchPlanning.anyPlanned, true);
  assert.equal(canEditSpecialFulfillment(d), true);
  const before = await snapshot(planId), lines = d.lines;
  const orders = async () => [(await query('SELECT * FROM sales_orders WHERE netsuite_id=$1',[so])).rows[0], (await query('SELECT * FROM purchase_orders WHERE netsuite_id=$1',[po])).rows[0]];
  const priorOrders = await orders();
  d = await update(d.id, { expectedRevision: d.revision, fulfillmentMethod: 'vendor_pickup' }, context);
  assert.equal(d.fulfillmentMethod, 'vendor_pickup'); assert.equal(d.handoff, null);
  assert.deepEqual(await snapshot(planId), before); assert.deepEqual(await orders(), priorOrders); assert.deepEqual(d.lines, lines);
  d = await update(d.id, { expectedRevision: d.revision, fulfillmentMethod: 'yard_pickup' }, context);
  assert.equal(d.handoff.status, 'waiting_route'); assert.equal(d.handoff.route, null);
  assert.deepEqual(await snapshot(planId), before);
  const notices = (await query("SELECT details FROM sales_special_stock_events WHERE request_id=$1 AND event_type='special_delivery_method_updated' AND details->>'notifyTeams'='true'", [d.id])).rows;
  assert.equal(notices.length, 2);
}));

for (const [type,status,ref] of [['pickup','in_progress',refs[0]], ['dropoff','complete','TEST-PLANNED-METHOD-VENDOR'], ['travel','in_progress','GO-PLANNED-METHOD']]) {
  test(`${type} ${status} blocks a planned change before the journal is written`, () => fixture(async (d,planId) => {
    await start(planId,ref,type,status);
    const current = await repo.getSpecialStockCase(d.id);
    assert.equal(current.fulfillmentExecutionStarted, true); assert.equal(canEditSpecialFulfillment(current), false);
    await assert.rejects(update(d.id, { expectedRevision: d.revision, fulfillmentMethod: 'vendor_pickup' }, context), { code: 'SPECIAL_FULFILLMENT_STARTED' });
    assert.equal((await repo.getSpecialStockCase(d.id)).fulfillmentMethod, 'yard_pickup');
    assert.equal((await query("SELECT count(*)::int AS n FROM sales_special_stock_events WHERE request_id=$1 AND event_type='special_delivery_change_started'", [d.id])).rows[0].n, 0);
  }));
}

test('execution starting between claim and finalization leaves the saved target recoverable', () => fixture(async (d,planId) => {
  d = await repo.claimSpecialFulfillmentChange(d.id, { expectedRevision: d.revision, fulfillmentMethod: 'vendor_pickup' }, context);
  await start(planId,refs[0]);
  await assert.rejects(repo.finishSpecialFulfillmentChange(d.id,d.fulfillmentChange.id,{},context), {code:'SPECIAL_FULFILLMENT_STARTED'});
  const after = await repo.getSpecialStockCase(d.id);
  assert.equal(after.fulfillmentMethod,'yard_pickup'); assert.equal(after.fulfillmentChange.target.fulfillmentMethod,'vendor_pickup');
}));

test('planned yard pickup can become verified MBT delivery with a fresh handoff and unchanged commercial lines', () => fixture(async (d,planId) => {
  const record={id:String(so),entity:{id:'8899100'},location:{id:'1'},custbody3:{id:'1'},item:{items:[{line:1,item:{id:'2055'},quantity:3,units:'1',rate:42,description:'TEST material',location:{id:'1'}}]}};
  const originalItems=JSON.stringify(record.item), originalPlan=await snapshot(planId);let patches=0;
  const boundary={config:{pickupMethodId:1,deliveryMethodId:2},queryAll:async()=>[{uniquekey:101,rest_line_id:1,item:2055,status:'B',execution_quantity:0,billed_quantity:0,line_closed:'F'}],
    rest:async(_path,options={})=>{if(options.method==='PATCH'){patches++;Object.assign(record,options.body);}return{data:structuredClone(record)};}};
  const deliver=createSpecialFulfillmentService({prepare:input=>prepareSpecialFulfillmentPlan(input,boundary),apply:plan=>applySpecialFulfillmentPlan(plan,boundary)});
  d=await deliver(d.id,{expectedRevision:d.revision,fulfillmentMethod:'mbt_delivery',deliveryAddress:'TEST customer site',deliveryDate:'2099-02-01'},context);
  assert.equal(d.fulfillmentMethod,'mbt_delivery');assert.equal(patches,1);assert.equal(JSON.stringify(record.item),originalItems);
  assert.equal(d.handoff.status,'waiting_route');assert.equal(d.handoff.route,null);assert.equal(d.handoff.destinationAddress,'TEST customer site');
  assert.deepEqual(await snapshot(planId),originalPlan);
}));

test('concurrent planned changes serialize and publish one method notice', () => fixture(async d => {
  const outcomes = await Promise.allSettled(['vendor_pickup','vendor_pickup'].map(fulfillmentMethod => update(d.id,{expectedRevision:d.revision,fulfillmentMethod},context)));
  assert.equal(outcomes.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(outcomes.filter(result=>result.status==='rejected').length,1);
  assert.equal((await query("SELECT count(*)::int AS n FROM sales_special_stock_events WHERE request_id=$1 AND event_type='special_delivery_method_updated'",[d.id])).rows[0].n,1);
}));

test('saving the same pickup method keeps the planned handoff and does not alert teams', () => fixture(async d => {
  d = await update(d.id,{expectedRevision:d.revision,fulfillmentMethod:'yard_pickup'},context);
  assert.equal(d.handoff.status,'planned'); assert.equal(d.handoff.route,'via_yard');
  assert.equal((await query("SELECT count(*)::int AS n FROM sales_special_stock_events WHERE request_id=$1 AND event_type='special_delivery_method_updated' AND details->>'notifyTeams'='true'",[d.id])).rows[0].n,0);
}));

test('withdrawn work and work on another load do not prevent an unstarted arrangement change', () => fixture(async (d,planId) => {
  assert.equal((await readSpecialFulfillmentStarted([])).size,0);
  await start(planId,refs[0]);
  await query("UPDATE driver_job_records SET mbt_assignment_withdrawn_at=now() WHERE job_id='planned-method-job'");
  assert.equal((await readSpecialFulfillmentStarted([d.id])).size,0);
  await query("UPDATE driver_job_records SET mbt_assignment_withdrawn_at=NULL,load_id='other-load',order_refs='[\"UNRELATED-ORDER\"]' WHERE job_id='planned-method-job'");
  assert.equal((await readSpecialFulfillmentStarted([d.id])).size,0);
  d=await update(d.id,{expectedRevision:d.revision,fulfillmentMethod:'vendor_pickup'},context);
  assert.equal(d.fulfillmentMethod,'vendor_pickup');
}));

test('planned Backorders retain their original edit restriction', () => fixture(async d => {
  await assert.rejects(update(d.id,{expectedRevision:d.revision,fulfillmentMethod:'vendor_pickup'},context),{code:'SPECIAL_FULFILLMENT_PLANNED'});
},true));

async function arrived(d,planId,{receipt=true,physical=true}={}) {
 await query('DELETE FROM dispatch_plan_order_assignments WHERE plan_id=$1 AND order_ref=$2',[planId,refs[0]]);
 await query("UPDATE sales_orders SET dispatch_planned=false,status='B',status_text='Sales Order : Pending Fulfillment',fulfillment_status='not_fulfilled' WHERE netsuite_id=$1",[so]);
 if(receipt)await query("UPDATE purchase_orders SET status='F',status_text='Purchase Order : Pending Bill',received_at=now() WHERE netsuite_id=$1",[po]);
 await query("UPDATE sales_special_stock_cases SET fulfillment_method='mbt_delivery',delivery_address='TEST customer site' WHERE request_id=$1",[d.id]);
 await query("UPDATE sales_special_stock_handoffs SET status='completed',route='via_yard' WHERE request_id=$1",[d.id]);
 if(physical){
  await start(planId,'TEST-PLANNED-METHOD-VENDOR','dropoff','complete');
  await query(`UPDATE driver_job_records SET job_details='{"orders":[{"orderRef":"TEST-PLANNED-METHOD-VENDOR","orderType":"PO"}]}' WHERE job_id='planned-method-job'`);
 }
 return repo.getSpecialStockCase(d.id);
}

test('completed PO inbound transport permits unfulfilled customer pickup and delivery with untouched prices and plans',()=>fixture(async(d,planId)=>{
 d=await arrived(d,planId);
 assert.equal(d.fulfillmentExecutionStarted,false);assert.equal(d.operationallyComplete,false);assert.equal(canEditSpecialFulfillment(d),true);
 const record={id:String(so),entity:{id:'8899100'},location:{id:'1'},custbody3:{id:'1'},item:{items:[{line:1,item:{id:'2055'},quantity:3,units:'1',rate:42,description:'TEST material',location:{id:'1'}}]}};
 const before=JSON.stringify(record.item),savedPlan=await snapshot(planId),patches=[];
 const boundary={config:{pickupMethodId:1,deliveryMethodId:2},queryAll:async()=>[{uniquekey:101,rest_line_id:1,item:2055,status:'B',execution_quantity:0,billed_quantity:0,line_closed:'F'}],
  rest:async(_path,options={})=>{if(options.method==='PATCH'){patches.push(options.body);Object.assign(record,options.body);}return{data:structuredClone(record)};}};
 const save=createSpecialFulfillmentService({prepare:input=>prepareSpecialFulfillmentPlan(input,boundary),apply:plan=>applySpecialFulfillmentPlan(plan,boundary)});
 d=await save(d.id,{expectedRevision:d.revision,fulfillmentMethod:'yard_pickup'},context);assert.equal(d.fulfillmentMethod,'yard_pickup');
 d=await save(d.id,{expectedRevision:d.revision,fulfillmentMethod:'mbt_delivery',deliveryAddress:'TEST new site'},context);assert.equal(d.fulfillmentMethod,'mbt_delivery');
 assert.equal(JSON.stringify(record.item),before);assert.deepEqual(await snapshot(planId),savedPlan);
 assert.ok(patches.every(patch=>!Object.hasOwn(patch,'item')));
 assert.equal((await query("SELECT count(*)::int AS n FROM sales_special_stock_events WHERE request_id=$1 AND event_type='special_delivery_method_updated' AND details->>'notifyTeams'='true'",[d.id])).rows[0].n,2);
}));

for(const physical of [false,true])test(`PO arrival by ${physical?'driver':'receipt'} rejects vendor pickup before journaling`,()=>fixture(async(d,planId)=>{
 d=await arrived(d,planId,{receipt:!physical,physical});
 await assert.rejects(update(d.id,{expectedRevision:d.revision,fulfillmentMethod:'vendor_pickup'},context),{code:'SPECIAL_VENDOR_PICKUP_AFTER_ARRIVAL'});
 assert.equal((await repo.getSpecialStockCase(d.id)).fulfillmentChange,null);
}));

test('PO arrival during a saved vendor-pickup change prevents retry and finalization',()=>fixture(async(d,planId)=>{
 const before=await snapshot(planId);
 d=await repo.claimSpecialFulfillmentChange(d.id,{expectedRevision:d.revision,fulfillmentMethod:'vendor_pickup'},context);
 const changeId=d.fulfillmentChange.id;
 await query('UPDATE purchase_orders SET received_at=now() WHERE netsuite_id=$1',[po]);
 await assert.rejects(repo.finishSpecialFulfillmentChange(d.id,changeId,{},context),{code:'SPECIAL_VENDOR_PICKUP_AFTER_ARRIVAL'});
 await assert.rejects(repo.claimSpecialFulfillmentChange(d.id,{expectedRevision:d.revision,changeId},context),{code:'SPECIAL_VENDOR_PICKUP_AFTER_ARRIVAL'});
 assert.deepEqual(await snapshot(planId),before);
 assert.equal((await repo.getSpecialStockCase(d.id)).fulfillmentMethod,'yard_pickup');
}));

test('fulfilled SO with stale local arrangement rejects delivery edits before the journal',()=>fixture(async d=>{
 await query("UPDATE sales_orders SET status='F',status_text='Sales Order : Pending Billing',fulfillment_status='not_fulfilled' WHERE netsuite_id=$1",[so]);
 await assert.rejects(update(d.id,{expectedRevision:d.revision,fulfillmentMethod:'vendor_pickup'},context),{code:'SPECIAL_FULFILLMENT_CLOSED'});
 assert.equal((await repo.getSpecialStockCase(d.id)).fulfillmentChange,null);
}));
