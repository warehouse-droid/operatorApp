import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFileSync} from 'node:fs';
import express from 'express';
import {query,closeDb,withTransaction} from '../../../src/db.js';
import {createMbtRouter} from '../../../src/mbt/router.js';
import {getBinCargoOptions,saveBinCargo} from '../../../src/mbt/bin-cargo-service.js';
import {createDispatchCustomOrder,canonicalizeDispatchCustomOrdersInPlan,dispatchOrderFromCustomOrder} from '../../../src/dispatch-custom-order-repository.js';
import {cargoFixture,cargoInput,saveCargo,gravelPlan,cargoBoundary,cargoCommand} from '../support/bin-cargo-fixtures.js';
import {storedPlan} from '../support/bin-planning-fixtures.js';
after(closeDb);
test('cargo API: authenticated Details and commands enforce role, idempotency and revision contracts',async()=>{
  const f=await cargoFixture(),app=express();app.use(express.json());
  app.use((req,_res,next)=>{req.operator={id:f.actor.operatorId,roles:req.get('x-denied')?['sales']:['dispatcher']};next();});
  app.use('/api/mbt',createMbtRouter({authorizePhase3Capability:async()=>({}),binSelectionRouteEstimator:cargoBoundary.routeEstimator}));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const url=`http://127.0.0.1:${server.address().port}/api/mbt/planning/workflows/${f.part.visitId}/cargo`;
  try {
    assert.equal((await fetch(url)).status,200);assert.equal((await fetch(url,{headers:{'x-denied':'1'}})).status,403);
    assert.equal((await fetch(url.replace(f.part.visitId,'invalid'))).status,400);
    const input=await cargoInput(f,gravelPlan(false)),headers={'content-type':'application/json','idempotency-key':crypto.randomUUID()};
    const post=body=>fetch(url,{method:'POST',headers,body:JSON.stringify(body)});
    assert.equal((await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)})).status,400);
    assert.equal((await post({...input,expectedRevision:0})).status,409);
    headers['idempotency-key']=crypto.randomUUID();assert.equal((await post({...input,expectedVisits:[]})).status,409);
    headers['idempotency-key']=crypto.randomUUID();assert.equal((await post(input)).status,200);
    const replay=await post(input);assert.equal(replay.status,200);assert.equal(replay.headers.get('x-mbt-idempotent-replay'),'true');
    assert.equal((await post({...input,cargo:{mode:'none'}})).status,409);
  } finally {await new Promise(resolve=>server.close(resolve));}
});
test('cargo contracts: purchased materials added by Front Desk appear and must all be routed',async()=>{
  const f=await cargoFixture({ordered:true});await saveCargo(f);
  await query(`UPDATE mbt_service_visits SET service_snapshot=jsonb_set(service_snapshot,'{attachedAggregate,materials}',
    (service_snapshot->'attachedAggregate'->'materials') || $2::jsonb),revision=revision+1 WHERE service_visit_id=$1`,
  [f.frontVisitId,JSON.stringify([{itemCode:'SAND',displayName:'Sand',quantityMilliYards:1000,derivedWeightLbs:2000}])]);
  const options=await getBinCargoOptions(f.part.visitId);
  assert.deepEqual(options.cargo.materials.map(m=>m.description),['Gravel','Sand']);
  assert.ok(options.cargo.materials[0].pickup);assert.equal(options.cargo.materials[1].pickup,null);
  await assert.rejects(saveCargo(f,gravelPlan()),/all purchased/i);
  options.cargo.materials[1].pickup=options.cargo.materials[0].pickup;
  await saveCargo(f,options.cargo);assert.equal((await getBinCargoOptions(f.part.visitId)).cargo.materials.length,2);
});
async function custom(f) {return createDispatchCustomOrder({refNumber:`CONTRACT-${crypto.randomUUID()}`,pickupLocation:'1 Main St',dropoffLocation:'2 Main St',orderDetails:'Pallet',weightLbs:200},f.actor.operatorId);}
function orderCargo(order) {return {mode:'custom',custom:{source:'existing',orderId:order.id,expectedUpdatedAt:new Date(order.updatedAt).toISOString(),pickup:{kind:'address',address:order.pickupLocation},dropoff:{kind:'destination'}}};}
test('cargo contracts: closed, managed, missing and independently planned Custom Orders are rejected',async()=>{
  const f=await cargoFixture(),order=await custom(f),cargo=orderCargo(order);
  await assert.rejects(saveCargo(f,{...cargo,custom:{...cargo.custom,orderId:'bad'}}),/existing/i);
  await assert.rejects(saveCargo(f,{...cargo,custom:{...cargo.custom,orderId:'999999999'}}),/open/i);
  await query("UPDATE dispatch_custom_orders SET status='completed',completed_at=now() WHERE id=$1",[order.id]);
  await assert.rejects(saveCargo(f,cargo),/open/i);
  await query("UPDATE dispatch_custom_orders SET status='open',completed_at=NULL,system_managed=true WHERE id=$1",[order.id]);
  await assert.rejects(saveCargo(f,cargo),/editable/i);
  await query('UPDATE dispatch_custom_orders SET system_managed=false WHERE id=$1',[order.id]);
  const plan=await storedPlan(f.planId);plan.trucks[0].loads[0].stops=[{id:'planned-custom',type:'drop',orderId:order.refNumber}];
  await query('UPDATE dispatch_plan_snapshots SET trucks=$2::jsonb WHERE plan_id=$1',[f.planId,JSON.stringify(plan.trucks)]);
  await assert.rejects(saveCargo(f,cargo),/planned/i);
  assert.equal((await query('SELECT count(*)::int AS n FROM mbt_bin_cargo_plans WHERE order_id=$1',[f.frontVisitId])).rows[0].n,0);
});
test('cargo contracts: competing ordinary Dispatch and BIN claims have one winner',async()=>{
  const f=await cargoFixture(),order=await custom(f),plan=await storedPlan(f.planId);
  plan.orders=[dispatchOrderFromCustomOrder(order)];plan.trucks[0].loads[0].stops=[{id:'custom-drop',type:'drop',orderId:order.refNumber}];
  const outcomes=await Promise.allSettled([saveCargo(f,orderCargo(order)),withTransaction(async()=>{
    const normalized=await canonicalizeDispatchCustomOrdersInPlan(plan,{lockRows:true});
    await query('UPDATE dispatch_plan_snapshots SET orders=$2::jsonb,trucks=$3::jsonb WHERE plan_id=$1',[f.planId,JSON.stringify(normalized.orders),JSON.stringify(normalized.trucks)]);
  })]);
  assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1);
});
test('cargo contracts: rollback-safe migration, cancelled claims release, and unknown payload does not invent a zero limit',async()=>{
  const f=await cargoFixture(),order=await custom(f);await saveCargo(f,orderCargo(order));
  await query("UPDATE mbt_service_visits SET status='cancelled',cancelled_at=now(),cancellation_reason='Customer cancelled' WHERE service_visit_id=$1",[f.frontVisitId]);
  assert.ok((await query('SELECT completed_at FROM mbt_bin_cargo_plans WHERE order_id=$1',[f.frontVisitId])).rows[0].completed_at);
  const other=await cargoFixture();await query('UPDATE mbt_bin_types SET maximum_payload_kg=NULL WHERE bin_type_id=(SELECT bin_type_id FROM mbt_bin_assets WHERE asset_id=$1)',[other.assetId]);
  await saveCargo(other,gravelPlan(false));
  const beforeMigration=(await query('SELECT * FROM mbt_bin_cargo_plans ORDER BY order_id,part_role')).rows;
  await assert.rejects(withTransaction(async()=>{
    await query('DROP TRIGGER mbt_release_cancelled_bin_cargo ON mbt_service_visits;DROP FUNCTION mbt_release_cancelled_bin_cargo();DROP TABLE mbt_bin_cargo_plans');
    await query(readFileSync('migrations/308_bin_cargo_plans.sql','utf8'));
    assert.equal((await query('SELECT count(*)::int AS n FROM mbt_bin_cargo_plans')).rows[0].n,0);
    throw new Error('migration rollback rehearsal');
  }),/migration rollback rehearsal/);
  assert.deepEqual((await query('SELECT * FROM mbt_bin_cargo_plans ORDER BY order_id,part_role')).rows,beforeMigration);
  assert.equal((await getBinCargoOptions(f.part.visitId)).editable,false);
  await assert.rejects(saveBinCargo({...cargoCommand(other),...await cargoInput(other),actor:{operatorId:'x',roles:['sales']}},cargoBoundary),/Dispatcher|dispatch|access/i);
});
