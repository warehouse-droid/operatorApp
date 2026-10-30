import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {query,closeDb,withTransaction} from '../../../src/db.js';
import {getBinCargoOptions,saveBinCargo} from '../../../src/mbt/bin-cargo-service.js';
import {getBinOrderWorkflow,configureBinOrderWorkflow} from '../../../src/mbt/bin-order-workflow-service.js';
import {run,storedPlan} from '../support/bin-planning-fixtures.js';
import {createDispatchCustomOrder,getDispatchCustomOrder,updateDispatchCustomOrder,cancelDispatchCustomOrder,canonicalizeDispatchCustomOrdersInPlan,dispatchOrderFromCustomOrder,listDispatchCustomOrders} from '../../../src/dispatch-custom-order-repository.js';
import {cargoFixture,cargoCommand,cargoInput,saveCargo,gravelPlan,cargoBoundary,yard150} from '../support/bin-cargo-fixtures.js';
after(closeDb);
async function visit(id) {return (await query('SELECT * FROM mbt_service_visits WHERE service_visit_id=$1',[id])).rows[0];}
async function customOrder() {return createDispatchCustomOrder({refNumber:`CARGO-${crypto.randomUUID()}`,pickupLocation:'4 Main St',dropoffLocation:'5 Main St',orderDetails:'Machine',weightLbs:100},'test');}
function customPlan(order) {return {mode:'custom',custom:{source:'existing',orderId:order.id,expectedUpdatedAt:new Date(order.updatedAt).toISOString(),pickup:{kind:'address',address:order.pickupLocation},dropoff:{kind:'address',address:order.dropoffLocation}}};}

test('cargo routing: existing Gravel is required before assignment and saves without changing price or window',async()=>{
  const f=await cargoFixture({ordered:true}),before=await visit(f.frontVisitId);
  const options=await getBinCargoOptions(f.part.visitId);
  assert.equal(options.orderedMaterials[0].itemCode,'GRAVEL');assert.equal(options.cargo.materials[0].weightLbs,2600);
  assert.ok(['3445','2967','150'].every(code=>options.yards.some(y=>y.yardCode===code)));
  await assert.rejects(run(f,'assign',{visitId:f.part.visitId,expectedVisitRevision:f.part.revision}),/material.*pickup|cargo.*pickup/i);
  const input=await cargoInput(f);const result=await saveBinCargo(input,cargoBoundary);
  assert.equal(result.status,200);assert.equal((await saveBinCargo(input,cargoBoundary)).replayed,true);
  const part=(await getBinOrderWorkflow(f.frontVisitId)).parts[0];
  assert.deepEqual(part.steps.map(s=>s.actionCode),['collect_empty_bin','cargo_pickup_1','deliver_bin']);
  assert.equal(part.steps[1].location.id,yard150);
  assert.equal(part.steps.at(-1).cargoDropoffs[0].description,'Gravel');
  const after=await visit(f.frontVisitId);assert.deepEqual(after.service_snapshot,before.service_snapshot);
  assert.deepEqual([after.scheduled_start_at,after.scheduled_end_at],[before.scheduled_start_at,before.scheduled_end_at]);
  await run(f,'assign',{visitId:part.visitId,expectedVisitRevision:part.revision});
  assert.equal((await storedPlan(f.planId)).trucks[0].loads[0].stops.length,3);
});
test('cargo routing: unconfigured order saves manual cargo and reconfiguration retains it',async()=>{
  const f=await cargoFixture({configured:false});
  await saveCargo(f,gravelPlan(false));
  let workflow=await getBinOrderWorkflow(f.frontVisitId);assert.equal(workflow.configured,false);
  workflow=(await configureBinOrderWorkflow({...cargoCommand(f),expectedRevision:workflow.revision,deliveryAssetId:f.assetId})).body;
  assert.equal(workflow.parts[0].steps.length,3);
  const cargo=(await getBinCargoOptions(workflow.parts[0].visitId)).cargo;
  assert.equal(cargo.materials[0].description,'Gravel');
  workflow=(await configureBinOrderWorkflow({...cargoCommand(f),expectedRevision:workflow.revision,deliveryAssetId:f.assetId})).body;
  assert.equal(workflow.parts[0].steps.length,3);
  await saveCargo({...f,part:workflow.parts[0]},{mode:'none'});
  assert.equal((await getBinOrderWorkflow(f.frontVisitId)).parts[0].steps.length,2);
});
test('cargo routing: released route changes require lease, republish atomically, and reject stale or started work',async()=>{
  const f=await cargoFixture();await run(f,'assign',{visitId:f.part.visitId,expectedVisitRevision:f.part.revision});await run(f,'confirm');
  const input=await cargoInput(f,gravelPlan(false)),before=await storedPlan(f.planId);
  await assert.rejects(saveBinCargo({...input,plans:[]},cargoBoundary),/plan|lease/i);
  await assert.rejects(saveBinCargo(input,{...cargoBoundary,hooks:{beforeCommit:()=>{throw new Error('cargo rollback');}}}),/cargo rollback/);
  assert.equal((await storedPlan(f.planId)).digest,before.digest);
  const results=await Promise.allSettled(Array.from({length:6},()=>saveBinCargo({...input,idempotencyKey:crypto.randomUUID()},cargoBoundary)));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1,results.map(r=>r.reason?.message).join('; '));
  const active=(await query('SELECT released_at,snapshot FROM mbt_bin_planning_assignments WHERE service_visit_id=$1 AND withdrawn_at IS NULL',[f.part.visitId])).rows;
  assert.equal(active.length,1);assert.ok(active[0].released_at);assert.equal(active[0].snapshot.stops.length,3);
  await query("UPDATE mbt_visit_steps SET started_at=now(),status='in_progress' WHERE service_visit_id=$1 AND sequence_number=0",[f.part.visitId]);
  assert.equal((await getBinCargoOptions(f.part.visitId)).editable,false);
  await assert.rejects(saveCargo(f,{mode:'none'}),/started/i);
});
test('cargo routing: custom claims exclude ordinary dispatch, edits and other bins until removed',async()=>{
  const a=await cargoFixture(),b=await cargoFixture(),order=await customOrder(),cargo=customPlan(order);
  const results=await Promise.allSettled([saveCargo(a,cargo),saveCargo(b,cargo)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const winner=results[0].status==='fulfilled'?a:b;
  assert.equal((await listDispatchCustomOrders()).some(o=>o.id===order.id),false);
  await assert.rejects(updateDispatchCustomOrder(order.id,{weightLbs:200},'test'),/BIN|bin/);
  await assert.rejects(cancelDispatchCustomOrder(order.id,'test'),/BIN|bin/);
  const plan={orders:[dispatchOrderFromCustomOrder(order)],trucks:[{id:'1',loads:[{id:'load',stops:[{id:'drop',orderId:order.refNumber,type:'drop'}]}]}]};
  await assert.rejects(withTransaction(()=>canonicalizeDispatchCustomOrdersInPlan(plan,{lockRows:true})),/BIN|bin/);
  await saveCargo(winner,{mode:'none'});
  assert.ok((await listDispatchCustomOrders()).some(o=>o.id===order.id));
  assert.equal((await getDispatchCustomOrder(order.id)).status,'open');
  await updateDispatchCustomOrder(order.id,{weightLbs:200},'test');
  await assert.rejects(saveCargo(winner,cargo),/changed|refresh/i);
});
test('cargo routing: oversized bin payload is rejected while excess truck weight is advisory',async()=>{
  const f=await cargoFixture();
  const oversized=gravelPlan(false);oversized.materials[0].weightLbs=1_000_000;
  await assert.rejects(saveCargo(f,oversized),/payload|capacity/i);
  assert.equal((await visit(f.part.visitId)).dispatch_plan_id,null);
  await saveCargo(f,gravelPlan(false));const part=(await getBinOrderWorkflow(f.frontVisitId)).parts[0];
  const tare=Number((await query('SELECT tare_weight_kg FROM mbt_bin_assets WHERE asset_id=$1',[f.assetId])).rows[0].tare_weight_kg)*2.2046226218;
  await query('UPDATE dispatch_trucks SET capacity_lbs=$2 WHERE id=$1',[f.binTruckId,Math.ceil(tare+50)]);
  const result=await run(f,'assign',{visitId:part.visitId,expectedVisitRevision:part.revision});
  assert.equal(result.status,201);
  const warning=result.body.plan.binCapacityWarnings.find(w=>w.visitId===part.visitId);
  assert.equal(warning.code,'MBT_BIN_WEIGHT_WARNING');
  assert.equal(warning.weightLbs,tare+100);assert.equal(warning.capacityLbs,Math.ceil(tare+50));
  assert.equal((await visit(part.visitId)).dispatch_plan_id,String(f.planId));
});
