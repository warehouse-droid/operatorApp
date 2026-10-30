import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {closeDb,query} from '../../../src/db.js';
import {createMbtRouter} from '../../../src/mbt/router.js';
import {transportFixture,transportInput} from '../support/bin-transport-fixtures.js';
import {saveTransportTrip} from '../../../src/mbt/bin-transport-service.js';
import {run} from '../support/bin-planning-fixtures.js';
after(closeDb);
test('Transport canonical source: confirmation reads current operational source even before catalog refresh',async()=>{
  const f=await transportFixture();let current=f.order;
  createMbtRouter({transportSourceLoader:async()=>[current]});
  const trip=(await saveTransportTrip(await transportInput(f,[{lineKey:'loose-1',quantity:'1'}]))).body.trip;
  await run(f,'assign',{visitId:trip.tripId,expectedVisitRevision:trip.revision,assetAssignments:[]});
  current={...f.order,address:'900 Changed Destination Road'};
  await assert.rejects(run(f,'confirm'),error=>error.code==='MBT_TRANSPORT_SOURCE_CHANGED');
  assert.equal((await query('SELECT driver_released_at FROM mbt_transport_trips WHERE trip_id=$1',[trip.tripId])).rows[0].driver_released_at,null);
});
