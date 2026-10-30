import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {query,closeDb} from '../../../src/db.js';
import {transportFixture,transportInput} from '../support/bin-transport-fixtures.js';
import {saveTransportTrip} from '../../../src/mbt/bin-transport-service.js';
import {run,storedPlan} from '../support/bin-planning-fixtures.js';
import {upsertDispatchOrderCatalog} from '../../../src/dispatch-order-catalog-repository.js';
after(closeDb);
test('Transport dependencies: a future trip keeps the earlier planned empty return intact across plan dates',async()=>{
  const first=await transportFixture(),next=await transportFixture();
  const one=(await saveTransportTrip(await transportInput(first,[{lineKey:'loose-1',quantity:'1'}]))).body.trip;
  await run(first,'assign',{visitId:one.tripId,expectedVisitRevision:one.revision,assetAssignments:[]});
  const two=(await saveTransportTrip({...await transportInput(next,[{lineKey:'loose-1',quantity:'1'}]),assetId:first.assetId})).body.trip;
  assert.equal(two.route.source.availabilityPredecessorId,one.tripId);
  await run(next,'assign',{visitId:two.tripId,expectedVisitRevision:two.revision,assetAssignments:[]});
  const before=await storedPlan(first.planId),after=await storedPlan(next.planId);
  const revision=(await query('SELECT revision FROM mbt_transport_trips WHERE trip_id=$1',[one.tripId])).rows[0].revision;
  await assert.rejects(run(first,'cancel',{visitId:one.tripId,expectedVisitRevision:revision}),/return|depend|pickup/i);
  assert.equal((await storedPlan(first.planId)).digest,before.digest);assert.equal((await storedPlan(next.planId)).digest,after.digest);
});
test('Transport dependencies: changed source quantities cannot be confirmed from an old saved route',async()=>{
  const f=await transportFixture(),trip=(await saveTransportTrip(await transportInput(f,[{lineKey:'loose-1',quantity:'1'}]))).body.trip;
  await run(f,'assign',{visitId:trip.tripId,expectedVisitRevision:trip.revision,assetAssignments:[]});
  await upsertDispatchOrderCatalog({orders:[{...f.order,items:f.order.items.map(line=>({...line,quantity:0.5}))}],source:'test'});
  await assert.rejects(run(f,'confirm'),error=>error.code==='MBT_TRANSPORT_SOURCE_CHANGED');
  assert.equal((await query('SELECT driver_released_at FROM mbt_transport_trips WHERE trip_id=$1',[trip.tripId])).rows[0].driver_released_at,null);
});
