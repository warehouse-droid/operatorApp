import assert from "node:assert/strict";
import {query,withTransaction} from "../src/db.js";
import {writeAudit} from "../src/auth-repository.js";
import {getSmartScmProposalInventorySnapshot} from "../src/smart-scm-proposal-editor.js";

// One-time maintenance of inventory evidence on a specified, still-editable run.
// Proposal quantities, priorities, reservations, and dispatch/receipt records are retained.
export async function refreshCompletedSplitDraftEvidence(runId,{expectedRevision,write=false}={}) {
  return withTransaction(async()=>{
    const run=(await query(`SELECT * FROM scm_smart_planning_runs WHERE id=$1 ${write?'FOR UPDATE':''}`,[runId])).rows[0];
    assert.ok(run && run.plan_kind==='blanket' && run.status==='ready','Select a ready Blanket run');
    assert.equal(Number(run.revision),expectedRevision,'Run changed; review fresh evidence before applying');
    const rows=(await query(`SELECT line.* FROM scm_smart_proposals proposal
      JOIN scm_smart_proposal_lines line ON line.proposal_id=proposal.id
      WHERE proposal.run_id=$1 AND proposal.proposal_origin='blanket'
        AND proposal.status IN ('draft','held')
        AND proposal.netsuite_purchase_order_id IS NULL
        AND proposal.netsuite_purchase_order_ref IS NULL
      ORDER BY line.id ${write?'FOR UPDATE OF proposal,line':''}`,[runId])).rows;
    const updates=[];
    const snapshots=new Map();
    for(const row of rows) {
      const before=row.reason||{};
      if(!(Number(before.quantityReleasedSplitInbound)>0))continue;
      const key=`${row.item_id}:${row.destination_location_id}:${row.to_plt}`;
      if(!snapshots.has(key))snapshots.set(key,await getSmartScmProposalInventorySnapshot(row.item_id,row.destination_location_id,row.to_plt));
      const inventory=snapshots.get(key);
      if(inventory.quantityReleasedSplitInbound>=Number(before.quantityReleasedSplitInbound)-0.000001)continue;
      const position=(inventory.quantityAvailable+inventory.quantityOnOrder-inventory.quantityBackordered-inventory.quantityReservedOutbound)/Number(row.to_plt);
      const after={...before,...inventory,positionPallets:Math.round(position*1e6)/1e6,
        destinationAvailablePallets:inventory.availablePallets,
        destinationExpectedAvailablePallets:inventory.expectedAvailablePallets};
      const change={lineId:Number(row.id),proposalId:Number(row.proposal_id),itemId:Number(row.item_id),
        itemName:row.item_name,destinationName:row.destination_name,proposedPallets:Number(row.proposed_pallets),before,after};
      updates.push(change);
      if(write) {
        const result=await query(`UPDATE scm_smart_proposal_lines SET reason=$2::jsonb,updated_at=now()
          WHERE id=$1 AND reason=$3::jsonb`,[row.id,JSON.stringify(after),JSON.stringify(before)]);
        assert.equal(result.rowCount,1,'Line changed; refresh aborted');
      }
    }
    if(write && updates.length) {
      await query(`UPDATE scm_smart_planning_runs SET revision=revision+1 WHERE id=$1`,[runId]);
      await query(`INSERT INTO scm_smart_plan_revisions(run_id,revision,reason,before_snapshot,after_snapshot,diff)
        VALUES($1,$2,'Completed split incoming inventory corrected','{}','{}',$3::jsonb)`,[runId,expectedRevision+1,JSON.stringify({updates})]);
      await writeAudit({actorType:'system',source:'smart_scm',action:'smart_scm.split_inbound_completion.inventory_refresh',details:{runId,revision:expectedRevision+1,updates}});
    }
    return {runId,revision:expectedRevision+(write&&updates.length?1:0),written:write,updates};
  });
}
