import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {query,closeDb} from '../../../src/db.js';
import {getMbtBinPlanning} from '../../../src/mbt/bin-planning-read.js';
import {configureBinOrderWorkflow,getBinOrderWorkflowOptions} from '../../../src/mbt/bin-order-workflow-service.js';
import {finalCollectionFixture,completeRentalPart,addUnconfiguredExchange} from '../support/bin-final-collection-fixtures.js';
import {linkedIntent,linkedLoad} from '../support/bin-linked-delivery-fixtures.js';
import {run,storedPlan,boundary} from '../support/bin-planning-fixtures.js';
after(closeDb);
const read=async f=>(await getMbtBinPlanning({planDate:f.planDate,search:f.final.reference},boundary)).pool.items.find(c=>c.mbt.visitId===f.finalId);

test('final collection: unfinished rental work keeps unconfigured collection visible with an explicit hold',async()=>{
  const f=await finalCollectionFixture({configured:false}),card=await read(f);
  assert.ok(card);assert.equal(card.workflow.configurationRequired,true);
  assert.deepEqual(card.workflow.collectionHold?.references.sort(),[f.delivery.reference,f.collection.reference].sort());
  assert.equal(card.mbt.frontLeg.dispatchable,false);assert.match(card.blockedReason,/waiting.*complete/i);
  const feed=await getMbtBinPlanning({planDate:f.planDate,search:f.collection.reference},boundary);
  assert.equal(feed.pool.items.find(c=>c.mbt.visitId===f.collection.visitId).mbt.frontLeg.dispatchable,true);
});
test('final collection: direct and board planning reject pending work atomically while route edits stay available',async()=>{
  const f=await finalCollectionFixture(),before=await storedPlan(f.planId),part=f.final.parts[0];
  const revision=(await query('SELECT revision FROM mbt_service_visits WHERE service_visit_id=$1',[part.visitId])).rows[0].revision;
  await assert.rejects(run(f,'assign',await linkedIntent(part)),/waiting.*complete/i);
  await assert.rejects(run(f,'assign',{...await linkedIntent(part),previousAssignment:{
    service_visit_id:part.visitId,dispatch_plan_id:String(f.planId),service_line_id:f.serviceLineId,
    service_snapshot:{binWorkflow:{kind:'collection'}}}}),/waiting.*complete/i);
  await assert.rejects(run(f,'save_board',{loads:[linkedLoad(f,[await linkedIntent(part)])]}),/waiting.*complete/i);
  assert.deepEqual(await storedPlan(f.planId),before);
  assert.equal((await query('SELECT revision FROM mbt_service_visits WHERE service_visit_id=$1',[part.visitId])).rows[0].revision,revision);
  assert.equal((await query('SELECT 1 FROM mbt_bin_workflow_claims WHERE visit_id=$1',[part.visitId])).rowCount,0);
  const options=await getBinOrderWorkflowOptions(part.visitId);assert.equal(options.editability.collection,true);
  const changed=await configureBinOrderWorkflow({visitId:f.successorVisitId,expectedRevision:options.workflow.revision,
    actor:f.actor,idempotencyKey:crypto.randomUUID(),correlationId:crypto.randomUUID(),requestId:crypto.randomUUID(),
    dumpSiteId:f.dumpIds[1],destination:{kind:'yard',yardId:'00000000-0000-4000-8000-000000012441'}});
  assert.equal(changed.body.parts[0].assetId,part.assetId);assert.deepEqual(changed.body.parts[0].window,part.window);
  assert.equal((await read(f)).mbt.frontLeg.dispatchable,false);
});
test('final collection: completing only replacement delivery is insufficient; every exchange part must finish',async()=>{
  const f=await finalCollectionFixture(),part=f.final.parts[0];
  await completeRentalPart(f,f.delivery);
  assert.deepEqual((await read(f)).workflow.collectionHold?.references,[f.collection.reference]);
  await assert.rejects(run(f,'assign',await linkedIntent(part)),/waiting.*complete/i);
  await completeRentalPart(f,f.collection);
  const card=await read(f);assert.equal(card.workflow.collectionHold,null);assert.equal(card.mbt.frontLeg.dispatchable,true);
  assert.equal(card.mbt.assetRequirements[0].exactAssetId,f.delivery.assetId);
  await run(f,'assign',await linkedIntent(part));
  assert.equal((await query('SELECT dispatch_plan_id FROM mbt_service_visits WHERE service_visit_id=$1',[part.visitId])).rows[0].dispatch_plan_id,String(f.planId));
});
test('final collection: unconfigured exchanges block, cancelled work and unfinished other rentals do not',async()=>{
  const f=await finalCollectionFixture();await completeRentalPart(f,f.delivery);await completeRentalPart(f,f.collection);
  const draft=await addUnconfiguredExchange(f);
  assert.deepEqual((await read(f)).workflow.collectionHold?.references,[draft.reference]);
  await query("UPDATE mbt_service_visits SET status='cancelled',cancelled_at=now(),cancellation_reason='Test cancelled exchange' WHERE service_visit_id=$1",[draft.orderId]);
  const card=await read(f);assert.equal(card.workflow.collectionHold,null);assert.equal(card.mbt.frontLeg.dispatchable,true);
  assert.equal((await query('SELECT status FROM mbt_service_visits WHERE service_visit_id=$1',[f.target.part.visitId])).rows[0].status,'ready');
});
