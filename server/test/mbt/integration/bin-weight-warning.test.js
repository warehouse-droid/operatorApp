import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {query,closeDb} from '../../../src/db.js';
import {transportFixture,transportInput} from '../support/bin-transport-fixtures.js';
import {saveTransportTrip} from '../../../src/mbt/bin-transport-service.js';
import {run,storedPlan,boundary} from '../support/bin-planning-fixtures.js';
import {assertPlanningCapacity} from '../../../src/mbt/bin-planning-capacity.js';
import {getMbtBinPlanning} from '../../../src/mbt/bin-planning-read.js';
import {createLoadedDumpDriverBinFixture} from '../support/driver-bin-scenario-fixtures.js';
after(closeDb);

test('Truck weight warning: overweight transport assigns, saves, confirms and reloads with a specific warning',async()=>{
  const f=await transportFixture();
  await query('UPDATE dispatch_trucks SET capacity_lbs=5000 WHERE id=$1',[f.binTruckId]);
  await query("UPDATE dispatch_plan_snapshots SET trucks=jsonb_set(trucks,'{0,capacityLbs}','5000') WHERE plan_id=$1",[f.planId]);
  await query('UPDATE mbt_bin_assets SET tare_weight_kg=1000 WHERE asset_id=$1',[f.assetId]);
  const trip=(await saveTransportTrip(await transportInput(f,[{lineKey:'loose-1',quantity:'1'}]))).body.trip;
  const result=await run(f,'assign',{visitId:trip.tripId,expectedVisitRevision:trip.revision,assetAssignments:[]});
  assert.equal(result.status,201);
  const warning=result.body.plan.binCapacityWarnings.find(w=>w.visitId===trip.tripId);
  assert.equal(warning.code,'MBT_BIN_WEIGHT_WARNING');assert.equal(warning.loadId,f.binLoadIds[0]);
  assert.equal(warning.capacityLbs,5000);assert.equal(warning.weightLbs,6000+1000*2.2046226218);
  assert.equal(warning.estimated,false);assert.match(warning.message,/8,204\.623.*5,000/);
  assert.ok(warning.message.includes(f.sourceRef));
  await run(f,'confirm');
  const read=await getMbtBinPlanning({planDate:f.planDate},boundary);
  assert.ok(read.capacityWarnings.some(w=>w.visitId===trip.tripId && w.weightLbs===warning.weightLbs));
  assert.equal((await storedPlan(f.planId)).status,'confirmed');
});

test('Truck weight warning: unknown loaded collection uses an explicitly labelled estimate and valid movement checks remain',async()=>{
  const f=await createLoadedDumpDriverBinFixture();
  await query('UPDATE dispatch_trucks SET capacity_lbs=48000 WHERE id=$1',[f.binTruckId]);
  await query('UPDATE mbt_bin_types SET maximum_payload_kg=27215 WHERE bin_type_id=(SELECT bin_type_id FROM mbt_bin_assets WHERE asset_id=$1)',[f.assetId]);
  const plan=await storedPlan(f.planId);
  assert.equal(await assertPlanningCapacity(plan),true);
  assert.ok(plan.binCapacityWarnings.length);assert.ok(plan.binCapacityWarnings.some(w=>w.estimated));
  assert.match(plan.binCapacityWarnings.find(w=>w.estimated).message,/estimated.*bin payload limit/i);
  const stop=plan.trucks[0].loads[0].stops[0];
  await query("UPDATE mbt_visit_steps SET action_code='unknown_movement' WHERE service_visit_id=$1 AND action_code=$2",[f.frontVisitId,stop.actionCode]);
  stop.actionCode='unknown_movement';
  await assert.rejects(()=>assertPlanningCapacity(plan),e=>e.code==='MBT_BIN_ROUTE_INVALID');
  const read=await getMbtBinPlanning({planDate:plan.planDate},boundary);
  assert.ok(read.plan,'The read-only screen must remain available to correct an invalid route.');
});
