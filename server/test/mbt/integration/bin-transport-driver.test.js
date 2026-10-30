import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {query,closeDb} from '../../../src/db.js';
import {getDriverDayJobs} from '../../../src/driver-repository.js';
import {startMbtDriverBinJob,completeMbtDriverBinJob} from '../../../src/mbt/driver-bin-execution-service.js';
import {transportFixture,transportInput} from '../support/bin-transport-fixtures.js';
import {saveTransportTrip,getTransportOptions} from '../../../src/mbt/bin-transport-service.js';
import {run,storedPlan} from '../support/bin-planning-fixtures.js';
import {availableDriverExecutionPlanDate,driverBinEvent,enabledDriverBinBoundary} from '../support/driver-bin-fixtures.js';
import {getSorSignatureSettings} from '../../../src/sor-rental-repository.js';
after(closeDb);
const boundary={capability:enabledDriverBinBoundary};
async function assigned(whole=false) {
  const f=await transportFixture({planDate:await availableDriverExecutionPlanDate()});
  const allocations=whole?[{lineKey:'loose-1',quantity:'2.5'},{lineKey:'machine-2',quantity:'1'}]:[{lineKey:'loose-1',quantity:'1.25'}];
  const trip=(await saveTransportTrip({...await transportInput(f,allocations),weightLbs:7000})).body.trip;
  await run(f,'assign',{visitId:trip.tripId,expectedVisitRevision:trip.revision,assetAssignments:[]});await run(f,'confirm');
  const jobs=(await getDriverDayJobs(f.driverLogin,{date:f.planDate,allowBin:true})).jobs.filter(j=>j.mbt?.transportTripId===trip.tripId);
  return {...f,trip,jobs,manifest:{manifestId:crypto.randomUUID(),schemaVersion:2,planId:f.planId,planRevision:(await storedPlan(f.planId)).revision}};
}
async function start(f,job,index) {
  return startMbtDriverBinJob({job,manifest:f.manifest,event:driverBinEvent(f,job,'job_started',index,{}, {manifestId:f.manifest.manifestId})},boundary);
}
async function completion(f,job,index) {
  const ref=`r2://driver-stop-photo/transport-${crypto.randomUUID()}.jpg`;
  const event=driverBinEvent(f,job,'job_completed',index,{mbt:{schemaVersion:'mbt-driver-bin-event-v1',actionCode:job.mbt.actionCode,
    scans:[{evidenceCode:'bin_scan',assetRole:'expected',assetId:f.assetId,scannedValue:f.assetCode}],photoEvidence:[{evidenceCode:'bin_photo',ordinal:0}]}},
  {manifestId:f.manifest.manifestId,photos:[{photoId:crypto.randomUUID(),ordinal:0,objectReference:ref,sha256:'c'.repeat(64),mimeType:'image/jpeg',byteSize:1024,durableReceipt:true}]});
  return {event,job,manifest:f.manifest,photoReferences:[ref]};
}
test('Transport Driver: source/bin/quantities, ordered evidence, partial cargo completion before empty return and immutable started route',async()=>{
  const f=await assigned();assert.equal(f.jobs.length,4);
  assert.ok(f.jobs.every(j=>j.mbt.displayReference.includes(f.sourceRef) && j.mbt.exactAssets.expected.assetCode===f.assetCode));
  assert.equal(f.jobs[1].mbt.cargo.quantity,'1.25');
  await assert.rejects(start(f,f.jobs[1],1),/earlier|previous|prior|complete/i);
  for (let i=0;i<3;i++) {
    const job=f.jobs[i];await start(f,job,i*10+10);
    const input=await completion(f,job,i*10+11);
    if (!i) {
      await assert.rejects(completeMbtDriverBinJob({...input,photoReferences:[]},boundary),/photo|evidence/i);
      await assert.rejects(completeMbtDriverBinJob({...input,event:{...input.event,details:{mbt:{...input.event.details.mbt,scans:[]}}}},boundary),/scan|evidence/i);
    }
    await completeMbtDriverBinJob(input,boundary);assert.equal((await completeMbtDriverBinJob(input,boundary)).replayed,true);
  }
  const row=(await query('SELECT * FROM mbt_transport_trips WHERE trip_id=$1',[f.trip.tripId])).rows[0];
  assert.ok(row.cargo_delivered_at);assert.equal(row.status,'in_progress');
  const options=await getTransportOptions({sourceRef:f.sourceRef,planDate:f.planDate});
  assert.equal(options.lines[0].delivered,'1.25');assert.equal(options.lines[0].remaining,'1.25');
  assert.equal((await query('SELECT count(*)::int AS n FROM dispatch_order_completion_events WHERE lower(order_ref)=$1',[f.sourceRef.toLowerCase()])).rows[0].n,0);
  await assert.rejects(run(f,'cancel',{visitId:f.trip.tripId,expectedVisitRevision:Number(row.revision)}),/started|locked/i);
  await start(f,f.jobs[3],50);await completeMbtDriverBinJob(await completion(f,f.jobs[3],51),boundary);
  assert.equal((await query('SELECT lifecycle_status FROM mbt_bin_asset_state WHERE asset_id=$1',[f.assetId])).rows[0].lifecycle_status,'available');
});
test('Transport Driver: all source quantities complete at cargo drop, completion rollback and conflicting replay remain atomic',async()=>{
  const f=await assigned(true);
  for (let i=0;i<2;i++) {await start(f,f.jobs[i],i*10+10);await completeMbtDriverBinJob(await completion(f,f.jobs[i],i*10+11),boundary);}
  const job=f.jobs[2];await start(f,job,30);const input=await completion(f,job,31);
  await assert.rejects(completeMbtDriverBinJob(input,{...boundary,hooks:{afterVisit:()=>{throw new Error('transport rollback');}}}),/transport rollback/);
  assert.equal((await query('SELECT cargo_delivered_at FROM mbt_transport_trips WHERE trip_id=$1',[f.trip.tripId])).rows[0].cargo_delivered_at,null);
  assert.equal((await query('SELECT count(*)::int AS n FROM dispatch_order_completion_events WHERE lower(order_ref)=$1',[f.sourceRef.toLowerCase()])).rows[0].n,0);
  await completeMbtDriverBinJob(input,boundary);
  assert.equal((await query('SELECT count(*)::int AS n FROM dispatch_order_completion_events WHERE lower(order_ref)=$1',[f.sourceRef.toLowerCase()])).rows[0].n,1);
  await assert.rejects(completeMbtDriverBinJob({...input,event:{...input.event,occurredAt:new Date(Date.parse(input.event.occurredAt)+1000).toISOString()}},boundary),/replay|changed|conflict/i);
});
test('Transport Driver: optional SOR signature carries frozen terms and persists separately from required BIN photos',async()=>{
  const f=await assigned(),settings=await getSorSignatureSettings(),drop=f.jobs[2];
  assert.deepEqual(drop.customerSignaturePrompt,{terms:settings.terms,revision:settings.revision,orderRefs:[f.sourceRef]});
  for(let i=0;i<2;i++) {await start(f,f.jobs[i],i*10+10);await completeMbtDriverBinJob(await completion(f,f.jobs[i],i*10+11),boundary);}
  await start(f,drop,30);const input=await completion(f,drop,31),photoId=crypto.randomUUID();
  input.event.details.customerSignature={photoId,termsRevision:settings.revision,signedBy:'Test customer',capturedAt:input.event.occurredAt};
  input.event.photos.push({photoId,ordinal:1,recordType:'driver-customer-signature',objectReference:`r2://driver/driver-customer-signature/${photoId}.jpg`,
    sha256:'d'.repeat(64),mimeType:'image/jpeg',byteSize:1024,durableReceipt:true});
  await completeMbtDriverBinJob(input,boundary);
  const record=(await query('SELECT job_details,photo_data_urls FROM driver_job_records WHERE job_id=$1',[drop.jobId])).rows[0];
  assert.equal(record.job_details.customerSignature.terms,settings.terms);
  assert.deepEqual(record.job_details.customerSignature.orderRefs,[f.sourceRef]);
  assert.equal(record.photo_data_urls.length,1);
});
test('Transport Driver: a BIN deactivated after release cannot start a physical trip',async()=>{
  const f=await assigned();await query('UPDATE mbt_bin_assets SET active=false WHERE asset_id=$1',[f.assetId]);
  await assert.rejects(start(f,f.jobs[0],10),/unavailable|inactive/i);
  assert.equal((await query('SELECT actual_started_at FROM mbt_transport_trips WHERE trip_id=$1',[f.trip.tripId])).rows[0].actual_started_at,null);
});
