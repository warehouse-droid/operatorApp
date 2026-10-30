import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {query,closeDb} from '../../../src/db.js';
import {getDriverDayJobs} from '../../../src/driver-repository.js';
import {createDispatchCustomOrder,getDispatchCustomOrder} from '../../../src/dispatch-custom-order-repository.js';
import {startMbtDriverBinJob,completeMbtDriverBinJob} from '../../../src/mbt/driver-bin-execution-service.js';
import {getBinOrderWorkflow} from '../../../src/mbt/bin-order-workflow-service.js';
import {assertPlanningCapacity} from '../../../src/mbt/bin-planning-capacity.js';
import {run,storedPlan} from '../support/bin-planning-fixtures.js';
import {availableDriverExecutionPlanDate,driverBinEvent,enabledDriverBinBoundary} from '../support/driver-bin-fixtures.js';
import {cargoFixture,saveCargo,gravelPlan} from '../support/bin-cargo-fixtures.js';
after(closeDb);
const boundary={capability:enabledDriverBinBoundary};
async function assigned(custom=false) {
  const f=await cargoFixture({ordered:!custom,planDate:await availableDriverExecutionPlanDate()});
  let cargo=gravelPlan(),order;
  if(custom) {
    order=await createDispatchCustomOrder({refNumber:`DRIVER-CARGO-${crypto.randomUUID()}`,pickupLocation:'1 Pickup Rd',dropoffLocation:'2 Drop Rd',orderDetails:'Equipment',weightLbs:100},f.actor.operatorId);
    cargo={mode:'custom',custom:{source:'existing',orderId:order.id,expectedUpdatedAt:new Date(order.updatedAt).toISOString(),pickup:{kind:'address',address:order.pickupLocation},dropoff:{kind:'address',address:order.dropoffLocation}}};
  }
  await saveCargo(f,cargo);const part=(await getBinOrderWorkflow(f.frontVisitId)).parts[0];
  await run(f,'assign',{visitId:part.visitId,expectedVisitRevision:part.revision});await run(f,'confirm');
  const jobs=(await getDriverDayJobs(f.driverLogin,{date:f.planDate,allowBin:true})).jobs.filter(j=>j.mbt);
  return {...f,part,jobs,order,manifest:{manifestId:crypto.randomUUID(),schemaVersion:2,planId:f.planId,planRevision:(await storedPlan(f.planId)).revision}};
}
async function start(f,job,index) {
  return startMbtDriverBinJob({job,manifest:f.manifest,event:driverBinEvent(f,job,'job_started',index,{}, {manifestId:f.manifest.manifestId})},boundary);
}
async function complete(f,job,index,options={}) {
  if(!options.started) await start(f,job,index);
  const ref=`r2://driver-stop-photo/cargo-${crypto.randomUUID()}.jpg`;
  const event=driverBinEvent(f,job,'job_completed',index+1,{mbt:{schemaVersion:'mbt-driver-bin-event-v1',actionCode:job.mbt.actionCode,
    scans:[{evidenceCode:'bin_scan',assetRole:'expected',assetId:f.assetId,scannedValue:f.assetCode}],photoEvidence:[{evidenceCode:'bin_photo',ordinal:0}]}},
  {manifestId:f.manifest.manifestId,photos:[{photoId:crypto.randomUUID(),ordinal:0,objectReference:ref,sha256:'c'.repeat(64),mimeType:'image/jpeg',byteSize:1024,durableReceipt:true}]});
  const input={event,job,manifest:f.manifest,photoReferences:[ref]};
  await completeMbtDriverBinJob(input,{...boundary,hooks:options.hooks});return input;
}
async function asset(f) {return (await query('SELECT lifecycle_status,location_kind,truck_id FROM mbt_bin_asset_state WHERE asset_id=$1',[f.assetId])).rows[0];}
test('cargo driver: Gravel pickup follows empty-bin pickup, keeps truck custody and blocks early delivery',async()=>{
  const f=await assigned();assert.equal(f.jobs.length,3);
  const pickup=f.jobs[1];assert.equal(pickup.mbt.cargo.description,'Gravel');assert.equal(pickup.mbt.cargo.weightLbs,2600);
  assert.equal(pickup.mbt.actionName,'Pick up Gravel');assert.equal(pickup.mbt.exactAssets.expected.assetCode,f.assetCode);
  assert.equal(pickup.stopType,'pickup');assert.match(pickup.address,/150 Clark/);
  await assert.rejects(start(f,pickup,1),/prior|earlier|preced|previous|complete/i);
  await complete(f,f.jobs[0],10);
  await assert.rejects(start(f,f.jobs[2],20),/prior|earlier|preced|previous|complete/i);
  await complete(f,pickup,30);assert.equal((await asset(f)).lifecycle_status,'on_truck');
  await assertPlanningCapacity(await storedPlan(f.planId));
  const input=await complete(f,f.jobs[2],40);await completeMbtDriverBinJob(input,boundary);
  assert.equal((await asset(f)).lifecycle_status,'at_customer');assert.equal((await getBinOrderWorkflow(f.frontVisitId)).status,'completed');
  assert.equal(f.jobs[2].mbt.cargoDropoffs[0].description,'Gravel');
});
test('cargo driver: existing Custom Order completes only at its separate drop and rolls back with driver evidence',async()=>{
  const f=await assigned(true);assert.equal(f.jobs.length,4);
  await complete(f,f.jobs[0],10);await complete(f,f.jobs[1],20);
  assert.equal((await getDispatchCustomOrder(f.order.id)).status,'open');
  await assert.rejects(complete(f,f.jobs[2],30,{hooks:{afterVisit:()=>{throw new Error('cargo completion rollback');}}}),/cargo completion rollback/);
  assert.equal((await getDispatchCustomOrder(f.order.id)).status,'open');
  const input=await complete(f,f.jobs[2],40,{started:true});await completeMbtDriverBinJob(input,boundary);
  assert.equal((await getDispatchCustomOrder(f.order.id)).status,'completed');assert.equal((await asset(f)).lifecycle_status,'on_truck');
  await complete(f,f.jobs[3],50);assert.equal((await asset(f)).lifecycle_status,'at_customer');
});
