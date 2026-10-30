import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {query,closeDb} from '../../../src/db.js';
import {editFixture,visitState} from '../support/bin-workflow-edit-fixtures.js';
import {run,storedPlan} from '../support/bin-planning-fixtures.js';
import {getBinOrderWorkflowOptions,configureBinOrderWorkflow,getBinOrderWorkflow} from '../../../src/mbt/bin-order-workflow-service.js';
after(closeDb);

async function futureReturn() {
  const f=await editFixture({linked:false,sequence:'collection_first'});
  await run(f,'assign',{assetAssignments:[],visitId:f.collection.visitId,expectedVisitRevision:f.collection.revision});
  return f;
}
async function chooseReturnedBin(f) {
  const flow=await getBinOrderWorkflow(f.target.frontVisitId);
  const response=await configureBinOrderWorkflow({visitId:f.target.frontVisitId,expectedRevision:flow.revision,
    deliveryAssetId:f.assetId,actor:f.target.actor,idempotencyKey:crypto.randomUUID(),correlationId:crypto.randomUUID(),requestId:crypto.randomUUID()});
  return response.body.parts[0];
}
test('planned availability: draft collection return supplies next-day delivery without Driver evidence',async()=>{
  const f=await futureReturn();
  const physical=(await query('SELECT * FROM mbt_bin_asset_state WHERE asset_id=$1',[f.assetId])).rows[0];
  const options=await getBinOrderWorkflowOptions(f.target.frontVisitId);
  const candidate=options.assets.find(a=>a.asset_id===f.assetId);
  assert.equal(candidate?.availability?.available,true);
  assert.equal(candidate.availability.projected,true);
  assert.equal(candidate.availability.predecessorId,f.collection.visitId);
  assert.equal(candidate.availability.location.kind,'yard');
  const delivery=await chooseReturnedBin(f);
  assert.equal(delivery.steps[0].location.kind,'yard');
  await run(f.target,'assign',{assetAssignments:[],visitId:delivery.visitId,expectedVisitRevision:delivery.revision});
  const afterPhysical=(await query('SELECT * FROM mbt_bin_asset_state WHERE asset_id=$1',[f.assetId])).rows[0];
  assert.deepEqual(afterPhysical,physical);
  assert.equal((await query('SELECT count(*)::int AS count FROM mbt_bin_workflow_claims WHERE asset_id=$1 AND released_at IS NULL',[f.assetId])).rows[0].count,2);
  const beforeSource=await visitState(f.collection.visitId),beforeTarget=await storedPlan(f.target.planId);
  await assert.rejects(run(f,'cancel',{visitId:f.collection.visitId,expectedVisitRevision:Number(beforeSource.visit.revision)}),/depend|return|available|reserved/i);
  assert.deepEqual(await visitState(f.collection.visitId),beforeSource);
  assert.equal((await storedPlan(f.target.planId)).digest,beforeTarget.digest);
});

test('planned availability: an unrelated delivery with no return cannot be selected or configured again',async()=>{
  const f=await editFixture({linked:false});
  await run(f.spare,'assign',{visitId:f.spare.part.visitId,expectedVisitRevision:f.spare.part.revision});
  const options=await getBinOrderWorkflowOptions(f.target.frontVisitId);
  assert.equal(options.assets.find(a=>a.asset_id===f.spare.assetId)?.availability?.available,false);
  const flow=await getBinOrderWorkflow(f.target.frontVisitId);
  await assert.rejects(configureBinOrderWorkflow({visitId:f.target.frontVisitId,expectedRevision:flow.revision,
    deliveryAssetId:f.spare.assetId,actor:f.target.actor,idempotencyKey:crypto.randomUUID(),correlationId:crypto.randomUUID(),requestId:crypto.randomUUID()}),/reserved|available|return/i);
});
