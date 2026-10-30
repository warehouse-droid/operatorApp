import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {query,closeDb,withTransaction} from '../../../src/db.js';
import {recordAssetMovement} from '../../../src/mbt/asset-service.js';
import {runMbtBinPlanningCommand} from '../../../src/mbt/bin-planning-service.js';
import {getMbtBinPlanning} from '../../../src/mbt/bin-planning-read.js';
import {linkedFixture,linkedIntent,linkedLoad} from '../support/bin-linked-delivery-fixtures.js';
import {run,storedPlan,command,boundary} from '../support/bin-planning-fixtures.js';
after(closeDb);
const ids=load=>[...new Set(load.stops.map(s=>s.mbt.visitId))];
test('linked route: collection-only board intent adds cargo and delivery atomically with stable replay',async()=>{
  const f=await linkedFixture(),before=await storedPlan(f.planId);
  const windows=await query('SELECT service_visit_id,scheduled_start_at,scheduled_end_at FROM mbt_service_visits WHERE service_visit_id=ANY($1::uuid[]) ORDER BY service_visit_id',[[f.collection.visitId,f.delivery.visitId]]);
  const input=await command(f,'save_board',{loads:[linkedLoad(f,[await linkedIntent(f.collection)])]});
  const result=await runMbtBinPlanningCommand(input,boundary),replay=await runMbtBinPlanningCommand(input,boundary);
  assert.equal(replay.replayed,true);assert.deepEqual(replay.body,result.body);
  const plan=await storedPlan(f.planId),load=plan.trucks[0].loads[0];
  assert.deepEqual(ids(load),[f.collection.visitId,f.delivery.visitId]);
  assert.deepEqual(load.stops.map(s=>s.actionCode),['pickup_bin','dump_bin','cargo_pickup_1','deliver_bin']);
  assert.deepEqual(plan.trucks[1],before.trucks[1]);
  const claims=await query('SELECT visit_id,asset_id,truck_id FROM mbt_bin_workflow_claims WHERE visit_id=ANY($1::uuid[]) AND released_at IS NULL',[[f.collection.visitId,f.delivery.visitId]]);
  assert.equal(claims.rows.length,2);assert.ok(claims.rows.every(c=>c.asset_id===f.assetId&&String(c.truck_id)===String(f.binTruckId)));
  assert.deepEqual((await query('SELECT service_visit_id,scheduled_start_at,scheduled_end_at FROM mbt_service_visits WHERE service_visit_id=ANY($1::uuid[]) ORDER BY service_visit_id',[[f.collection.visitId,f.delivery.visitId]])).rows,windows.rows);
});
test('linked route: delivery cannot be planned alone; assigning collection adds both and move/cancel keeps the pair',async()=>{
  const f=await linkedFixture(),before=await storedPlan(f.planId);
  await assert.rejects(run(f,'assign',{...await linkedIntent(f.delivery)}),/linked|collection/i);
  assert.deepEqual(await storedPlan(f.planId),before);
  await run(f,'assign',{...await linkedIntent(f.collection)});
  assert.deepEqual(ids((await storedPlan(f.planId)).trucks[0].loads[0]),[f.collection.visitId,f.delivery.visitId]);
  const assigned=await storedPlan(f.planId);
  await assert.rejects(run(f,'move',{...await linkedIntent(f.delivery),toLoadId:' '}),error=>error.status===400);
  assert.deepEqual(await storedPlan(f.planId),assigned);
  await run(f,'move',{...await linkedIntent(f.delivery),toLoadId:f.binLoadIds[1]});
  const moved=await storedPlan(f.planId);assert.equal(moved.trucks[0].loads[0].stops.length,0);
  assert.deepEqual(ids(moved.trucks[0].loads[1]),[f.collection.visitId,f.delivery.visitId]);
  await run(f,'cancel',{...await linkedIntent(f.collection)});
  assert.equal((await storedPlan(f.planId)).trucks[0].loads[1].stops.length,0);
  assert.equal((await query('SELECT count(*)::int n FROM mbt_bin_workflow_claims WHERE visit_id=ANY($1::uuid[]) AND released_at IS NULL',[[f.collection.visitId,f.delivery.visitId]])).rows[0].n,0);
});
test('linked route: filtered feed includes the receiving card and identifies its post-dump source',async()=>{
  const f=await linkedFixture();
  const feed=await getMbtBinPlanning({actor:f.actor,planDate:f.planDate,search:f.collection.reference,limit:1},boundary);
  assert.equal(feed.pool.items[0].workflow.linkedDeliveryVisitId,f.delivery.visitId);
  const receiving=feed.linked.find(c=>c.mbt.visitId===f.delivery.visitId);
  assert.equal(receiving.workflow.linkedCollection.visitId,f.collection.visitId);
  assert.equal(receiving.workflow.source.address,'3445 Kennedy Road');
  assert.equal(receiving.stops[0].actionCode,'cargo_pickup_1');
});
test('linked route: split loads, reversed steps and stale receiving revisions roll back',async()=>{
  const f=await linkedFixture(),c=await linkedIntent(f.collection),d=await linkedIntent(f.delivery),before=await storedPlan(f.planId);
  for(const loads of [[linkedLoad(f,[c]),linkedLoad(f,[d],1)],[linkedLoad(f,[d,c])],[linkedLoad(f,[c,{...d,expectedVisitRevision:999}])]]) {
    await assert.rejects(run(f,'save_board',{loads}));assert.deepEqual(await storedPlan(f.planId),before);
  }
});
test('linked route: failed receiving cargo validation leaves neither leg nor claim assigned',async()=>{
  const f=await linkedFixture(),before=await storedPlan(f.planId);
  await query("UPDATE mbt_service_visits SET service_snapshot=jsonb_set(service_snapshot,'{cargoPlan,materials,0,pickup}','null') WHERE service_visit_id=$1",[f.delivery.visitId]);
  await assert.rejects(run(f,'save_board',{loads:[linkedLoad(f,[await linkedIntent(f.collection)])]}),/cargo|pickup|material/i);
  assert.deepEqual(await storedPlan(f.planId),before);
  assert.equal((await query('SELECT count(*)::int n FROM mbt_bin_workflow_claims WHERE visit_id=ANY($1::uuid[]) AND released_at IS NULL',[[f.collection.visitId,f.delivery.visitId]])).rows[0].n,0);
});
test('linked route: concurrent distinct saves cannot partially assign or duplicate a shared-bin route',async()=>{
  const f=await linkedFixture(),input=await command(f,'save_board',{loads:[linkedLoad(f,[await linkedIntent(f.collection)])]});
  const outcomes=await Promise.allSettled([runMbtBinPlanningCommand(input,boundary),runMbtBinPlanningCommand({...input,idempotencyKey:input.idempotencyKey+'-other'},boundary)]);
  assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1);
  assert.deepEqual(ids((await storedPlan(f.planId)).trucks[0].loads[0]),[f.collection.visitId,f.delivery.visitId]);
});
test('linked route: a completed collection permits its remaining delivery without replanning completed work',async()=>{
  const f=await linkedFixture(),dump=f.collection.steps.find(s=>s.actionCode==='dump_bin').location;
  await withTransaction(()=>recordAssetMovement({query,ambientTransaction:true},{assetId:f.assetId,movementType:'dump_bin_expected',afterStatus:'at_dump',
    afterLocation:{kind:'dump_site',dumpSiteId:dump.id,reference:dump.address},source:'linked-route-test',actorType:'system',actorId:'test',occurredAt:`${f.planDate}T11:00:00Z`}));
  await query("UPDATE mbt_visit_steps SET status='completed',completed_at=$2 WHERE service_visit_id=$1",[f.collection.visitId,`${f.planDate}T11:00:00Z`]);
  await query("UPDATE mbt_service_visits SET status='completed',actual_completed_at=$2 WHERE service_visit_id=$1",[f.collection.visitId,`${f.planDate}T11:00:00Z`]);
  await run(f,'assign',{...await linkedIntent(f.delivery)});
  assert.deepEqual(ids((await storedPlan(f.planId)).trucks[0].loads[0]),[f.delivery.visitId]);
});
