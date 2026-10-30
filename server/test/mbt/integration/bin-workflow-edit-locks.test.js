import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {query,closeDb} from '../../../src/db.js';
import {configureBinOrderWorkflow,getBinOrderWorkflow,getBinOrderWorkflowOptions} from '../../../src/mbt/bin-order-workflow-service.js';
import {getMbtBinPlanning} from '../../../src/mbt/bin-planning-read.js';
import {editFixture,editCommand,visitState} from '../support/bin-workflow-edit-fixtures.js';
import {linkedIntent} from '../support/bin-linked-delivery-fixtures.js';
import {run,command,storedPlan,boundary} from '../support/bin-planning-fixtures.js';
import {runMbtBinPlanningCommand} from '../../../src/mbt/bin-planning-service.js';
after(closeDb);

test('edit locks: both unplanned exchange legs allow sequence and dump changes while retaining linked cargo',async()=>{
  const f=await editFixture(),target=(await getBinOrderWorkflow(f.target.frontVisitId)).parts[0],before=await visitState(target.visitId);
  const options=await getBinOrderWorkflowOptions(f.collection.visitId);
  assert.equal(options.configurationIssue,null);
  assert.ok(options.targets.some(t=>t.order_id===f.target.frontVisitId),'the current linked receiving order stays selectable');
  await configureBinOrderWorkflow(await editCommand(f,{sequence:'collection_first',dumpSiteId:f.dumpIds[1]}));
  const after=await visitState(target.visitId);
  assert.equal(after.visit.service_snapshot.binWorkflow.source.address,'2967 Kennedy Road');
  assert.deepEqual(after.visit.service_snapshot.cargoPlan,before.visit.service_snapshot.cargoPlan);
  assert.deepEqual([after.visit.scheduled_start_at,after.visit.scheduled_end_at],[before.visit.scheduled_start_at,before.visit.scheduled_end_at]);
  assert.equal((await getBinOrderWorkflow(f.rootId)).configuration.sequence,'collection_first');
});
test('edit locks: planned delivery freezes sequence but permits dump and after-dump edits without touching its plan or instructions',async()=>{
  const f=await editFixture();await run(f,'assign',await linkedIntent(f.delivery));
  const before=await visitState(f.delivery.visitId),plan=await storedPlan(f.planId);
  await configureBinOrderWorkflow(await editCommand(f,{dumpSiteId:f.dumpIds[1]}));
  assert.deepEqual(await visitState(f.delivery.visitId),before);assert.deepEqual(await storedPlan(f.planId),plan);
  for(const change of [{sequence:'collection_first'},{reuse:'same_bin'},{deliveryAssetId:f.assetId}]) {
    await assert.rejects(configureBinOrderWorkflow(await editCommand(f,change)),/sequence|planned|locked/i);
    assert.deepEqual(await visitState(f.delivery.visitId),before);
  }
  await configureBinOrderWorkflow(await editCommand(f,{dumpSiteId:f.dumpIds[1],destination:{kind:'yard',yardId:'00000000-0000-4000-8000-000000012441'}}));
  assert.equal((await getBinOrderWorkflow(f.rootId)).configuration.parts.find(p=>p.role==='collection').destination.kind,'yard');
  assert.deepEqual(await visitState(f.delivery.visitId),before);assert.deepEqual(await storedPlan(f.planId),plan);
});
test('edit locks: planning collection locks its route and sequence, while its unplanned replacement stays editable',async()=>{
  const f=await editFixture({linked:false,sequence:'collection_first'});await run(f,'assign',await linkedIntent(f.collection));
  const before=await visitState(f.collection.visitId),plan=await storedPlan(f.planId);
  for(const change of [{dumpSiteId:f.dumpIds[1]},{sequence:'delivery_first'},{destination:{kind:'delivery',orderId:f.target.frontVisitId}},
    {cargo:{mode:'none'},cargoRole:'collection'}]) {
    await assert.rejects(configureBinOrderWorkflow(await editCommand(f,change)),/collection|sequence|planned|locked/i);
  }
  await configureBinOrderWorkflow(await editCommand(f,{deliveryAssetId:f.target.assetId}));
  assert.deepEqual(await visitState(f.collection.visitId),before);assert.deepEqual(await storedPlan(f.planId),plan);
});
test('edit locks: confirmed then withdrawn parts become editable without rewriting assignment history',async()=>{
  const f=await editFixture();await run(f,'assign',await linkedIntent(f.delivery));await run(f,'assign',await linkedIntent(f.collection));await run(f,'confirm');
  await run(f,'cancel',await linkedIntent(f.collection));await run(f,'cancel',await linkedIntent(f.delivery));
  const ids=[f.delivery.visitId,f.collection.visitId,(await getBinOrderWorkflow(f.target.frontVisitId)).parts[0].visitId];
  const history=await query('SELECT * FROM mbt_bin_planning_assignments WHERE service_visit_id=ANY($1::uuid[]) ORDER BY assignment_id',[ids]);
  assert.ok(history.rows.every(a=>a.released_at&&a.withdrawn_at));
  await configureBinOrderWorkflow(await editCommand(f,{dumpSiteId:f.dumpIds[1],sequence:'collection_first'}));
  assert.deepEqual((await query('SELECT * FROM mbt_bin_planning_assignments WHERE service_visit_id=ANY($1::uuid[]) ORDER BY assignment_id',[ids])).rows,history.rows);
});
test('edit locks: changing destination removes the old link and requires its receiving delivery to choose a bin again',async()=>{
  const f=await editFixture(),target=(await getBinOrderWorkflow(f.target.frontVisitId)).parts[0],before=await visitState(target.visitId);
  await configureBinOrderWorkflow(await editCommand(f,{destination:{kind:'yard',yardId:'00000000-0000-4000-8000-000000012441'}}));
  const links=await query('SELECT 1 FROM mbt_bin_workflow_dependencies WHERE dependent_visit_id=$1 AND prerequisite_visit_id=$2',[target.visitId,f.collection.visitId]);
  assert.equal(links.rowCount,0);
  const feed=await getMbtBinPlanning({planDate:f.planDate,search:target.reference},boundary),card=feed.pool.items.find(c=>c.mbt.visitId===target.visitId);
  assert.equal(card.mbt.frontLeg.dispatchable,false);assert.equal(card.workflow.configurationRequired,true);
  assert.deepEqual((await visitState(target.visitId)).visit.service_snapshot.cargoPlan,before.visit.service_snapshot.cargoPlan);
  await assert.rejects(run(f,'assign',await linkedIntent(target)),/configure|configuration|bin/i);
  await configureBinOrderWorkflow(await editCommand(f));
  assert.equal((await visitState(target.visitId)).visit.service_snapshot.binWorkflow.source.predecessorVisitId,f.collection.visitId);
});
test('edit locks: simultaneous collection planning and editing cannot partially rewrite an assigned route',async()=>{
  const f=await editFixture({linked:false,sequence:'collection_first'}),edit=await editCommand(f,{dumpSiteId:f.dumpIds[1]}),plan=await command(f,'assign',await linkedIntent(f.collection));
  const results=await Promise.allSettled([configureBinOrderWorkflow(edit),runMbtBinPlanningCommand(plan,boundary)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const current=await visitState(f.collection.visitId);
  assert.equal(current.visit.dump_site_id,current.visit.dispatch_plan_id?f.dumpIds[0]:f.dumpIds[1]);
});
test('edit locks: a started onward delivery cannot be detached, and a rejected change leaves all routes intact',async()=>{
  const f=await editFixture(),target=(await getBinOrderWorkflow(f.target.frontVisitId)).parts[0];
  // Represents an older route whose onward leg started without a current collection plan.
  await query("UPDATE mbt_service_visits SET status='in_progress',actual_started_at=now() WHERE service_visit_id=$1",[target.visitId]);
  const ids=[f.collection.visitId,f.delivery.visitId,target.visitId],before=await Promise.all(ids.map(visitState));
  const flow=await getBinOrderWorkflow(f.rootId);
  await assert.rejects(configureBinOrderWorkflow(await editCommand(f,{destination:{kind:'yard',yardId:'00000000-0000-4000-8000-000000012441'}})),/Unplan the linked receiving delivery/i);
  assert.deepEqual(await Promise.all(ids.map(visitState)),before);
  assert.deepEqual(await getBinOrderWorkflow(f.rootId),flow);
});
