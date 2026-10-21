/* global structuredClone */
import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { specialDispatchPlanning } from '../../../src/special-stock-planning.js';
import { prepareSpecialClosurePlan, applySpecialClosurePlan } from '../../../src/special-stock-closure-adapter.js';
import { specialPlanningStatus, specialClosureStatus, canRequestSpecialClosure } from '../../../public/special-stock-case-status.js';
import { prepareSpecialClosurePlanInNetSuite, applySpecialClosurePlanInNetSuite } from '../../../src/netsuite.js';

const order = (id, kind) => ({ id, kind, lines: [{ remoteLineId: id * 10, itemId: 2055, quantity: 50, description: 'Reviewed', unitId: 865 }] });
const orders = () => [order(101,'sales_order'), order(102,'purchase_order')];
function boundary() {
  const remote = new Map(orders().map(o => [o.id,[{ line: 1, item: { id: '2055' }, quantity: 50, description: 'Reviewed', units: '865', rate: 5, isClosed: false }]]));
  const writes = []; let loseResponse = false, execution = 0;
  return { remote, writes, set loseResponse(v) { loseResponse=v; }, set execution(v) { execution=v; },
    queryAll: async sql => { const id = Number(/tl.transaction = (\d+)/.exec(sql)[1]); return remote.get(id).map(l => ({ uniquekey: id*10, rest_line_id: l.line, item: l.item.id,
      execution_quantity: execution, billed_quantity: 0, line_closed: l.isClosed ? 'T' : 'F', status_text: l.isClosed ? 'Closed' : id===101?'Pending Fulfillment':'Pending Receipt' })); },
    rest: async (path, options = {}) => { const id = Number(/\/(\d+)/.exec(path)[1]);
      if (options.method === 'PATCH') { writes.push({ id, body: options.body }); for (const patch of options.body.item.items) remote.get(id).find(l => l.line === patch.line).isClosed = patch.isClosed;
        if (loseResponse) { loseResponse=false; throw Error('Lost close response'); } }
      return { data: { item: { items: structuredClone(remote.get(id)) } } };
    } };
}

test('property: SO-only closure verifies the SO and retries a lost response without a second write', async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 100000 }), async quantity => {
    const b = boundary(), so = order(101, 'sales_order');
    so.lines[0].quantity = quantity; b.remote.get(101)[0].quantity = quantity;
    const plan = await prepareSpecialClosurePlan({ orders: [so] }, b);
    assert.deepEqual(plan.orders.map(o => o.id), [101]);
    b.loseResponse = true;
    await assert.rejects(applySpecialClosurePlan(plan, b), /Lost close response/);
    assert.deepEqual((await applySpecialClosurePlan(plan, b)).verifiedOrderIds, [101]);
    assert.deepEqual(b.writes.map(w => w.id), [101]);
    assert.equal(b.remote.get(102)[0].isClosed, false);
  }), { seed: 260926, numRuns: 25 });
});

test('closure rejects a missing SO, duplicate identity, invalid kind and empty plans before any writes', async () => {
  for (const orders of [[], [order(102, 'purchase_order')], [order(101, 'sales_order'), order(101, 'purchase_order')], [order(101, 'sales_order'), order(102, 'sales_order')], [order(101, 'invoice')]]) {
    const b = boundary();
    await assert.rejects(prepareSpecialClosurePlan({ orders }, b), { status: 409 });
    await assert.rejects(applySpecialClosurePlan({ version: 1, orders }, b), { status: 409 });
    assert.equal(b.writes.length, 0);
  }
});

test('closure verifies both full records, closes PO before SO, and changes only closed flags', async () => {
  const b=boundary(), plan=await prepareSpecialClosurePlan({orders:orders()},b);
  assert.equal(b.writes.length,0);
  const result=await applySpecialClosurePlan(plan,b);
  assert.deepEqual(result.verifiedOrderIds,[102,101]);
  assert.deepEqual(b.writes,[102,101].map(id=>({id,body:{item:{items:[{line:1,isClosed:true}]}}})));
  assert.equal(b.remote.get(101)[0].quantity,50); assert.equal(b.remote.get(102)[0].rate,5);
  await applySpecialClosurePlan(plan,b); assert.equal(b.writes.length,2);
});

test('an unconfirmed PO close prevents any SO write',async()=>{
  const b=boundary(),plan=await prepareSpecialClosurePlan({orders:orders()},b),original=b.rest;
  b.rest=async(path,options={})=>{
    const result=await original(path,options);
    if(options.method==='PATCH')b.remote.get(102)[0].isClosed=false;
    return result;
  };
  await assert.rejects(applySpecialClosurePlan(plan,b),{status:409});assert.deepEqual(b.writes.map(w=>w.id),[102]);
  assert.equal(b.remote.get(101)[0].isClosed,false);
});
test('property: lost close response recovers without closing an already closed line twice', async () => {
  await fc.assert(fc.asyncProperty(fc.integer({min:1,max:100000}),async qty=>{
    const b=boundary(), expected=orders(); for(const o of expected){o.lines[0].quantity=qty;b.remote.get(o.id)[0].quantity=qty;}
    const plan=await prepareSpecialClosurePlan({orders:expected},b); b.loseResponse=true;
    await assert.rejects(applySpecialClosurePlan(plan,b),/Lost close response/);
    const result=await applySpecialClosurePlan(plan,b); assert.deepEqual(result.verifiedOrderIds,[102,101]);
    assert.deepEqual(b.writes.map(w=>w.id),[102,101]);
  }),{seed:260930,numRuns:35});
});
test('closure refuses lines changed or executed after preparing the current orders and before the first write', async () => {
  for(const mutate of [b=>b.remote.get(101).push({...b.remote.get(101)[0],line:2}), b=>{b.remote.get(102)[0].item.id='900';}, b=>{b.execution=1;}, b=>{b.remote.get(101)[0].quantity=51;}]) {
    const b=boundary(),plan=await prepareSpecialClosurePlan({orders:orders()},b);mutate(b);await assert.rejects(applySpecialClosurePlan(plan,b),{status:409}); assert.equal(b.writes.length,0);
  }
  const b=boundary(),plan=await prepareSpecialClosurePlan({orders:orders()},b); b.remote.get(101)[0].description='Changed';
  await assert.rejects(applySpecialClosurePlan(plan,b),{status:409});assert.equal(b.writes.length,0);
  await assert.rejects(prepareSpecialClosurePlan({orders:[order(0,'invoice')]},b),{status:409});
});
test('property: planned SO/PO child or split blocks closure; unassigned and cancelled plans do not', () => {
  fc.assert(fc.property(fc.integer({min:1,max:99999}),fc.constantFrom('SO','PO'),fc.boolean(),(id,kind,cancelled)=>{
    const ref=`${kind}${id}`, child=`${ref}-S1`;
    const plan={id:12,plan_date:'2026-09-26',status:cancelled?'cancelled':'draft',orders:[{id:'GROUP',childOrders:[child],childOrderDetails:[{id:child,originalOrderId:ref}]}],
      trucks:[{plate:'TEST',loads:[{name:'Load 1',stops:[{type:'drop',orderId:'GROUP'}]}]}]};
    const d={salesOrderId:1,salesOrderRef:kind==='SO'?ref:'OTHER-SO',purchaseOrderId:2,purchaseOrderRef:kind==='PO'?ref:'OTHER-PO'};
    const p=specialDispatchPlanning(d,[plan]); assert.equal(p.anyPlanned,!cancelled);assert.equal(p[kind==='SO'?'salesOrder':'purchaseOrder'].planned,!cancelled);
    if(!cancelled)assert.equal(p[kind==='SO'?'salesOrder':'purchaseOrder'].plans[0].planDate,'2026-09-26');
    plan.trucks=[];assert.equal(specialDispatchPlanning(d,[plan]).anyPlanned,false);
  }),{seed:260929,numRuns:80});
});
test('planning recognizes PO pickup stops and ignores return-only work and missing orders',()=>{
  const detail={salesOrderId:1,salesOrderRef:'SO1',purchaseOrderId:2,purchaseOrderRef:'PO2'};
  const plan={id:1,status:'ready',trucks:[{loads:[{stops:[{type:'pickup',orderId:'PO2'}]}]}]};
  assert.equal(specialDispatchPlanning(detail,[plan]).purchaseOrder.planned,true);
  plan.trucks[0].loads[0].returnOnly=true;assert.equal(specialDispatchPlanning(detail,[plan]).anyPlanned,false);
  assert.equal(specialDispatchPlanning({},[plan]).anyPlanned,false);
});

test('planning recognizes the Dispatch pick and delivery stop aliases',()=>{
  for (const type of ['pick','delivery']) {
    const plan={id:1,status:'ready',trucks:[{loads:[{stops:[{type,orderRefs:['PO2']}]}]}]};
    assert.equal(specialDispatchPlanning({purchaseOrderId:2,purchaseOrderRef:'PO2'},[plan]).purchaseOrder.planned,true);
  }
});

test('request cards and detail show planning; pending closure exposes SCM actions only',()=>{
  const d={closeStatus:'active',salesOrderId:1,salesOrderRef:'SO1',purchaseOrderId:2,purchaseOrderRef:'PO2',dispatchPlanning:{anyPlanned:false,salesOrder:{planned:false},purchaseOrder:{planned:false}}};
  assert.equal(canRequestSpecialClosure(d),true);assert.match(specialPlanningStatus(d,true),/SO: Not planned · PO: Not planned/);
  d.dispatchPlanning={anyPlanned:true,salesOrder:{planned:false},purchaseOrder:{planned:true,plans:[{planDate:'2026-09-26'}]}};
  assert.equal(canRequestSpecialClosure(d),false);assert.match(specialPlanningStatus(d),/PO: Planned \(2026-09-26\)/);
  assert.equal(specialPlanningStatus({}), ''); assert.equal(specialClosureStatus(d,'scm'),'');
  Object.assign(d,{closeStatus:'closure_pending',closureReason:'Customer <cancelled>',closureReview:{id:'test',status:'pending'}});
  assert.doesNotMatch(specialClosureStatus(d,'sales'),/data-special-closure-review-form|type="submit"/);
  assert.match(specialClosureStatus(d,'scm'),/Confirm closure of SO and PO/);assert.match(specialClosureStatus(d,'scm'),/Reject closure/);
  assert.match(specialClosureStatus(d,'scm'),/&lt;cancelled&gt;/);
  d.closureReview={id:'test',status:'attention',remoteStarted:true,error:'Lost response'};
  assert.match(specialClosureStatus(d,'scm'),/Retry closure of SO and PO/);assert.doesNotMatch(specialClosureStatus(d,'scm'),/Reject closure/);
  d.closureReview.status='applying';assert.match(specialClosureStatus(d,'sales'),/Closing the linked SO and PO/);
});

test('production NetSuite closure wrappers retain the exact read-only preparation and queued close contract',async()=>{
  const b=boundary();const plan=await prepareSpecialClosurePlanInNetSuite({orders:orders()},b);
  assert.equal(b.writes.length,0);assert.deepEqual((await applySpecialClosurePlanInNetSuite(plan,b)).verifiedOrderIds,[102,101]);
});

test('property: executed orders always reject closure and untouched complete pairs can close',async()=>{
  await fc.assert(fc.asyncProperty(fc.integer({min:0,max:1000}),async executed=>{
    const b=boundary();b.execution=executed;
    if(executed){await assert.rejects(prepareSpecialClosurePlan({orders:orders()},b),{status:409});assert.equal(b.writes.length,0);}
    else {const plan=await prepareSpecialClosurePlan({orders:orders()},b);assert.deepEqual((await applySpecialClosurePlan(plan,b)).verifiedOrderIds,[102,101]);}
  }),{seed:260931,numRuns:50});
});

test('explicit remaining-order closure preserves fulfilled and billed quantities and retries without duplicate writes', async () => {
 await fc.assert(fc.asyncProperty(fc.integer({min:1,max:50000}),fc.integer({min:0,max:50000}),async(executed,billed)=>{
  const b=boundary(),original=b.queryAll;
  b.queryAll=async sql=>(await original(sql)).map(row=>({...row,execution_quantity:executed,billed_quantity:billed,
   status_text:row.line_closed==='T'?'Closed':sql.includes('101')?'Sales Order : Pending Billing':'Purchase Order : Partially Received'}));
  const plan=await prepareSpecialClosurePlan({orders:orders(),closeRemaining:true},b);
  assert.equal(plan.closeRemaining,true);
  for(const order of plan.orders)assert.deepEqual([order.lines[0].executedQuantity,order.lines[0].billedQuantity],[executed,billed]);
  b.loseResponse=true;await assert.rejects(applySpecialClosurePlan(plan,b),/Lost close response/);
  assert.deepEqual((await applySpecialClosurePlan(plan,b)).verifiedOrderIds,[102,101]);
  assert.deepEqual(b.writes,[102,101].map(id=>({id,body:{item:{items:[{line:1,isClosed:true}]}}})));
  for(const line of [...b.remote.values()].flat()){assert.equal(line.quantity,50);assert.equal(line.rate,5);}
 }),{seed:631018,numRuns:35});
});
test('remaining-order closure freezes fulfillment and billing evidence before any writes', async()=>{
 for(const field of ['execution_quantity','billed_quantity']) {
  const b=boundary(),original=b.queryAll;let activity=5;
  b.queryAll=async sql=>(await original(sql)).map(row=>({...row,execution_quantity:5,billed_quantity:5,[field]:activity}));
  const plan=await prepareSpecialClosurePlan({orders:orders(),closeRemaining:true},b);
  activity=6;await assert.rejects(applySpecialClosurePlan(plan,b),{code:'SPECIAL_CLOSURE_REMOTE_CONFLICT'});assert.equal(b.writes.length,0);
 }
});
test('remaining-order closure rejects missing, malformed and negative activity evidence before writes', async()=>{
 for(const field of ['execution_quantity','billed_quantity'])for(const value of [null,undefined,'not-a-number',-1,Infinity]){
  const b=boundary(),original=b.queryAll;
  b.queryAll=async sql=>(await original(sql)).map(row=>({...row,[field]:value}));
  await assert.rejects(prepareSpecialClosurePlan({orders:orders(),closeRemaining:true},b),{code:'SPECIAL_CLOSURE_REMOTE_CONFLICT'});
  assert.equal(b.writes.length,0);
 }
});

test('property: remaining-order closure refuses any new execution or billing before writing',async()=>{
 await fc.assert(fc.asyncProperty(fc.constantFrom('execution_quantity','billed_quantity'),fc.integer({min:0,max:10000}),async(field,quantity)=>{
  const b=boundary(),original=b.queryAll;let activity=quantity;
  b.queryAll=async sql=>(await original(sql)).map(row=>({...row,[field]:activity}));
  const plan=await prepareSpecialClosurePlan({orders:orders(),closeRemaining:true},b);
  activity++;await assert.rejects(applySpecialClosurePlan(plan,b),{code:'SPECIAL_CLOSURE_REMOTE_CONFLICT'});assert.equal(b.writes.length,0);
 }),{seed:631020,numRuns:40});
});

test('remaining-order closure refuses unsupported status and inconsistent identities without any writes',async()=>{
 for(const mutate of [rows=>rows.map(r=>({...r,status_text:'Rejected by Supervisor'})),rows=>rows.map(r=>({...r,item:900})),
  rows=>rows.map(r=>({...r,line_closed:'unknown'})),rows=>[...rows,rows[0]]]) {
  const b=boundary(),original=b.queryAll;b.queryAll=async sql=>mutate(await original(sql));
  await assert.rejects(prepareSpecialClosurePlan({orders:orders(),closeRemaining:true},b),{code:'SPECIAL_CLOSURE_REMOTE_CONFLICT'});
  assert.equal(b.writes.length,0);
 }
});
