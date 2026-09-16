import assert from "node:assert/strict";
import test,{after} from "node:test";
import {closeDb,query} from "../../../src/db.js";
import {isolated,fixture,child,completed,phaseRun,itemId,itemName} from "../../support/split-inbound-completion-fixture.mjs";
import {refreshCompletedSplitDraftEvidence} from "../../../tools/split-inbound-completion-refresh.mjs";

after(closeDb);
async function seedDraft() {
  const f=await fixture();
  const c=await child(f);
  await completed(c.ref);
  const runId=await phaseRun();
  await query(`UPDATE scm_smart_planning_runs SET plan_kind='blanket',planning_phase='integrated' WHERE id=$1`,[runId]);
  const proposal=(await query(`INSERT INTO scm_smart_proposals(run_id,proposal_key,proposal_type,phase,source_kind,
    destination_location_id,destination_name,status,proposal_origin,total_pallets,total_weight_lbs)
    VALUES($1,'refresh-test','PO','direct_vendor','vendor',1,'3445','held','blanket',5,15000) RETURNING *`,[runId])).rows[0];
  const line=(await query(`INSERT INTO scm_smart_proposal_lines(proposal_id,item_id,item_name,destination_location_id,
    destination_name,to_plt,proposed_pallets,sales_quantity,reason)
    VALUES($1,$2,$3,1,'3445',102.3,5,511.5,$4::jsonb) RETURNING *`,[proposal.id,itemId,itemName,JSON.stringify({quantityReleasedSplitInbound:2455.2,quantityOnOrder:2455.2,manuallyAdjusted:true})])).rows[0];
  return {runId,proposal,line};
}

test('draft evidence refresh preserves manual quantities and is audited and idempotent',()=>isolated(async()=>{
  const {runId,proposal,line}=await seedDraft();
  const preview=await refreshCompletedSplitDraftEvidence(runId,{expectedRevision:1});
  assert.equal(preview.updates.length,1);
  assert.deepEqual((await query('SELECT * FROM scm_smart_proposal_lines WHERE id=$1',[line.id])).rows[0],line);
  const applied=await refreshCompletedSplitDraftEvidence(runId,{expectedRevision:1,write:true});
  assert.equal(applied.revision,2);
  const afterLine=(await query('SELECT * FROM scm_smart_proposal_lines WHERE id=$1',[line.id])).rows[0];
  assert.deepEqual({...afterLine,reason:line.reason,updated_at:line.updated_at},line);
  assert.equal(afterLine.reason.quantityOnOrder,0);
  assert.equal(afterLine.reason.manuallyAdjusted,true);
  assert.deepEqual((await query('SELECT * FROM scm_smart_proposals WHERE id=$1',[proposal.id])).rows[0],proposal);
  const again=await refreshCompletedSplitDraftEvidence(runId,{expectedRevision:2,write:true});
  assert.deepEqual(again.updates,[]);
  const audits=(await query(`SELECT details FROM delivery_audit_log WHERE action='smart_scm.split_inbound_completion.inventory_refresh' AND details->>'runId'=$1`,[String(runId)])).rows;
  assert.equal(audits.length,1);
  assert.deepEqual(audits[0].details.updates[0].before,line.reason);
  assert.deepEqual(audits[0].details.updates[0].after,afterLine.reason);
}));

test('a changed draft revision aborts evidence maintenance',()=>isolated(async()=>{
  const {runId,line}=await seedDraft();
  await assert.rejects(()=>refreshCompletedSplitDraftEvidence(runId,{expectedRevision:99,write:true}),/Run changed/);
  assert.deepEqual((await query('SELECT * FROM scm_smart_proposal_lines WHERE id=$1',[line.id])).rows[0],line);
}));
