import assert from "node:assert/strict";
import {query,withTransaction,closeDb} from "../src/db.js";
import {loadSmartScmPlanningDemandStates} from "../src/smart-scm-planning-repository.js";
import {getSmartScmProposalInventorySnapshot} from "../src/smart-scm-proposal-editor.js";
import {refreshCompletedSplitDraftEvidence} from "./split-inbound-completion-refresh.mjs";

const mode=process.argv[2]||'read';
assert.ok(['read','rehearse','apply','verify'].includes(mode));
try {
  const result=await withTransaction(async()=>{
    await query(`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ ${['read','verify'].includes(mode)?', READ ONLY':''}`);
    const start=performance.now();
    const planning=await loadSmartScmPlanningDemandStates();
    const states=planning.states.filter(s=>Number(s.policy.item_id)===2277).map(s=>({yard:s.policy.yard_code,
      incomingSales:s.onOrderSales,releasedSplitSales:s.releasedSplitInboundSales,positionPallets:s.positionPallets}));
    const inventory=await getSmartScmProposalInventorySnapshot(2277,1,102.3);
    const maintenance=mode==='verify'?null:await refreshCompletedSplitDraftEvidence(389,{expectedRevision:2,write:mode!=='read'});
    const saved=(await query(`SELECT line.*,run.revision FROM scm_smart_proposal_lines line
      JOIN scm_smart_proposals proposal ON proposal.id=line.proposal_id
      JOIN scm_smart_planning_runs run ON run.id=proposal.run_id WHERE line.id=119322`)).rows[0];
    assert.equal(Number(saved.proposed_pallets),5);
    if(maintenance) {
      const target=maintenance.updates.find(row=>row.lineId===119322);
      assert.ok(target,'The reported saved draft must be included');
      assert.equal(target.after.quantityOnOrder,0);
    } else {
      assert.equal(saved.reason.quantityOnOrder,0);
      assert.equal(Number(saved.revision),3);
    }
    assert.equal(inventory.quantityReleasedSplitInbound,0);
    const fingerprints=(await query(`SELECT
      (SELECT md5(jsonb_agg(to_jsonb(line)-'reason'-'updated_at' ORDER BY line.id)::text)
       FROM scm_smart_proposal_lines line JOIN scm_smart_proposals proposal ON proposal.id=line.proposal_id WHERE proposal.run_id=389) AS line_values,
      (SELECT md5(jsonb_agg(to_jsonb(proposal) ORDER BY proposal.id)::text) FROM scm_smart_proposals proposal WHERE run_id=389) AS proposals`)).rows[0];
    return {mode,elapsedMs:Math.round(performance.now()-start),forecastRunId:planning.forecastRunId,states,inventory,maintenance,saved,fingerprints};
  },{rollback:mode!=='apply'});
  console.log(JSON.stringify(result));
}finally{await closeDb();}
