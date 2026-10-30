import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {query,closeDb,withTransaction} from '../../../src/db.js';
import {recordAssetMovement} from '../../../src/mbt/asset-service.js';
import {driverCompanyDate} from '../../../src/driver-plan-date-policy.js';
import {getDriverDayJobs} from '../../../src/driver-repository.js';
import {persistDriverOfflineDayPlan,registerDriverOfflineSync,markDriverOfflinePhotoDurable} from '../../../src/driver-offline-repository.js';
import {processDriverOfflineQueue} from '../../../src/driver-offline-service.js';
import {applyMbtDriverBinOfflineEvent} from '../../../src/mbt/driver-bin-offline-application.js';
import {transportFixture,transportInput} from '../support/bin-transport-fixtures.js';
import {saveTransportTrip} from '../../../src/mbt/bin-transport-service.js';
import {run,storedPlan} from '../support/bin-planning-fixtures.js';
import {driverBinEvent} from '../support/driver-bin-fixtures.js';
after(closeDb);
test('Transport offline: issued manifest retains trip/cargo identity and durable scan/photo events apply and replay once',async()=>{
  const f=await transportFixture({planDate:driverCompanyDate()});
  // The generic fixture registers at 06:00 UTC, which is in the future just
  // after Toronto midnight. Establish a past state before this live-clock
  // manifest, as the existing Driver offline fixture does. Keep chronology
  // enforcement and every application/replay assertion unchanged.
  const state=(await query('SELECT * FROM mbt_bin_asset_state WHERE asset_id=$1',[f.assetId])).rows[0];
  await withTransaction(()=>recordAssetMovement({query,ambientTransaction:true},{
    assetId:f.assetId,movementType:'synthetic_offline_manifest_clock_baseline',afterStatus:state.lifecycle_status,
    afterLocation:{kind:state.location_kind,reference:state.location_reference,yardId:state.yard_id},
    source:'transport_offline_fixture',actorType:'system',actorId:'transport-offline-test',
    occurredAt:new Date(Date.now()-1000)
  }));
  const trip=(await saveTransportTrip(await transportInput(f,[{lineKey:'loose-1',quantity:'1'}]))).body.trip;
  await run(f,'assign',{visitId:trip.tripId,expectedVisitRevision:trip.revision,assetAssignments:[]});await run(f,'confirm');
  const day=await getDriverDayJobs(f.driverLogin,{date:f.planDate,allowBin:true}),plan=await storedPlan(f.planId);
  const deviceId=`transport-${f.suffix}`,manifestId=crypto.randomUUID();
  const manifest=await persistDriverOfflineDayPlan({manifestId,driverLogin:f.driverLogin,deviceId,plan,
    planMetadata:{planId:f.planId,planDate:f.planDate,planRevision:plan.revision},jobs:day.jobs,
    driverProfile:{login:f.driverLogin},dayState:{truckId:f.binTruckId,truckPlate:day.jobs[0].truckPlate}});
  const jobs=manifest.jobs.filter(job=>job.mbt?.transportTripId===trip.tripId);
  assert.equal(jobs.length,4);assert.equal(jobs[1].mbt.cargo.quantity,'1');assert.equal(jobs[0].mbt.sourceRef,f.sourceRef);
  const job=jobs[0],photoId=crypto.randomUUID(),objectReference=`r2://driver/driver-stop-photo/2026/10/23/${photoId}/bin.jpg`,sha256='a'.repeat(64);
  const identity={manifestId,deviceId,jobFingerprint:job.fingerprint,predecessorFingerprint:job.predecessorFingerprint,locationStatus:'not_checked_offline'};
  const started=driverBinEvent(f,job,'job_started',1,{},identity);
  const completed=driverBinEvent(f,job,'job_completed',2,{mbt:{schemaVersion:'mbt-driver-bin-event-v1',actionCode:job.mbt.actionCode,
    scans:[{evidenceCode:'bin_scan',assetRole:'expected',assetId:f.assetId,scannedValue:f.assetCode}],photoEvidence:[{evidenceCode:'bin_photo',ordinal:0}]}},
  {...identity,photos:[{photoId,ordinal:0,recordType:'driver-stop-photo',mimeType:'image/jpeg',byteSize:1024,sha256}]});
  await registerDriverOfflineSync({driverLogin:f.driverLogin,deviceId,manifestId,events:[started,completed],photoReceipts:[{photoId,objectReference,byteSize:1024,sha256}]});
  await markDriverOfflinePhotoDurable(photoId,{objectReference,verifiedByteSize:1024,verifiedSha256:sha256,receipt:{provider:'synthetic-test'}});
  const execute=()=>processDriverOfflineQueue({driverLogin:f.driverLogin,planDate:f.planDate,deviceId,applyEvent:applyMbtDriverBinOfflineEvent});
  const applied=await execute();assert.deepEqual(applied.map(event=>event.status),['applied','applied'],JSON.stringify(applied));
  assert.deepEqual((await execute()).map(event=>event.status),['applied','applied']);
  assert.equal((await query('SELECT count(*)::int AS n FROM mbt_transport_driver_events WHERE trip_id=$1',[trip.tripId])).rows[0].n,2);
  assert.equal((await query("SELECT count(*)::int AS n FROM mbt_bin_movements WHERE asset_id=$1 AND source='mbt-transport-driver'",[f.assetId])).rows[0].n,1);
});
