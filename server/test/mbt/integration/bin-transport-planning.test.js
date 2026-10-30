import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {query,closeDb} from '../../../src/db.js';
import {transportFixture,transportInput} from '../support/bin-transport-fixtures.js';
import {saveTransportTrip} from '../../../src/mbt/bin-transport-service.js';
import {run,storedPlan} from '../support/bin-planning-fixtures.js';
after(closeDb);

test('Transport planning: assign, confirm, unplan retain source quantity, physical custody and assignment history',async()=>{
  const f=await transportFixture(),saved=await saveTransportTrip(await transportInput(f,[{lineKey:'loose-1',quantity:'1.25'}]));
  const trip=saved.body.trip,physical=(await query('SELECT * FROM mbt_bin_asset_state WHERE asset_id=$1',[f.assetId])).rows[0];
  const result=await run(f,'assign',{visitId:trip.tripId,expectedVisitRevision:trip.revision,assetAssignments:[]});
  assert.equal(result.status,201);
  const plan=await storedPlan(f.planId),stops=plan.trucks.flatMap(t=>t.loads.flatMap(l=>l.stops)).filter(s=>s.mbt?.transportTripId===trip.tripId);
  assert.equal(stops.length,4);assert.ok(stops.every(s=>s.reference.includes(f.sourceRef) && s.assetCode===f.assetCode));
  assert.ok(stops.every(s=>s.mbt.driverReleased===false));
  const claim=(await query('SELECT * FROM mbt_transport_trips WHERE trip_id=$1',[trip.tripId])).rows[0];
  assert.equal(String(claim.plan_id),f.planId);assert.equal(claim.status,'planned');
  assert.deepEqual((await query('SELECT * FROM mbt_bin_asset_state WHERE asset_id=$1',[f.assetId])).rows[0],physical);
  await run(f,'confirm');
  const released=(await storedPlan(f.planId)).trucks.flatMap(t=>t.loads.flatMap(l=>l.stops)).filter(s=>s.mbt?.transportTripId===trip.tripId);
  assert.ok(released.every(s=>s.mbt.driverReleased===true));
  const revision=(await query('SELECT revision FROM mbt_transport_trips WHERE trip_id=$1',[trip.tripId])).rows[0].revision;
  await run(f,'cancel',{visitId:trip.tripId,expectedVisitRevision:revision});
  const unplanned=(await query('SELECT * FROM mbt_transport_trips WHERE trip_id=$1',[trip.tripId])).rows[0];
  assert.equal(unplanned.plan_id,null);assert.equal(unplanned.status,'ready');assert.deepEqual(unplanned.allocations,claim.allocations);
  assert.ok((await query('SELECT withdrawn_at FROM mbt_transport_assignment_history WHERE trip_id=$1',[trip.tripId])).rows[0].withdrawn_at);
});

test('Transport planning: changing a draft board preserves typed transport work and validates source revisions',async()=>{
  const f=await transportFixture(),trip=(await saveTransportTrip(await transportInput(f,[{lineKey:'loose-1',quantity:'1'}]))).body.trip;
  const before=await storedPlan(f.planId),load=before.trucks[0].loads[0];
  const desired={id:load.id,name:'Cargo trip',truckId:f.binTruckId,driverId:f.driverId,
    startMode:'fixed',start:'07:00',driverSequence:1,truckStartYard:'12441',switchYard:'12441',plannedStartMinute:420,plannedFinishMinute:480,
    visits:[{visitId:trip.tripId,expectedVisitRevision:trip.revision,stopTimings:[],stopOverrides:[],assetAssignments:[]}]};
  await run(f,'save_board',{loads:[desired],driverLaneOrder:[]});
  const planned=(await query('SELECT revision FROM mbt_transport_trips WHERE trip_id=$1',[trip.tripId])).rows[0];
  const stable=await storedPlan(f.planId);
  await assert.rejects(run(f,'save_board',{loads:[{...desired,name:'Stale change'}],driverLaneOrder:[]}),/changed|revision|refresh/i);
  assert.equal((await storedPlan(f.planId)).digest,stable.digest);assert.ok(planned.revision>trip.revision);
});
