import assert from "node:assert/strict";
import {query,withTransaction,closeDb} from '../src/db.js';
import {resumeSmartScmBlanketCoveredPlanningExclusions} from '../src/smart-scm-planning-exclusion-repository.js';
import {loadSmartScmPlanningDemandStates,smartScmPackWholePalletLines} from '../src/smart-scm-planning-repository.js';
import {smartScmBlanketDraftGroupsForPlanning} from '../src/smart-scm-blanket-repository.js';
import {smartScmRouteRuleKey} from '../src/smart-scm-route-repository.js';

const apply=process.argv.includes('--apply');
try {
  const result=await withTransaction(async()=>{
    await query("SET LOCAL statement_timeout='45s'");
    const resumed=await resumeSmartScmBlanketCoveredPlanningExclusions();
    const planning=await loadSmartScmPlanningDemandStates({includeTemporarilyExcluded:false});
    const groups=smartScmBlanketDraftGroupsForPlanning({states:planning.states}).filter(g=>g.source.source_po_ref==='POB03737');
    const loads=groups.flatMap(group=>{
      const sourceName=group.source.pickup_point||group.source.vendor||group.source.source_po_ref;
      return smartScmPackWholePalletLines(group.lines,Number(planning.settings.truck_capacity_lbs),{
        proposalType:'PO',sourceName,maxStops:2,routeRule:planning.routeRules.get(smartScmRouteRuleKey(sourceName))
      });
    });
    const holds=await query(`SELECT exclusion.id,exclusion.item_id,item.item_name,exclusion.deactivated_at,exclusion.deactivation_note
      FROM scm_smart_planning_exclusions exclusion JOIN inventory_items item USING(item_id)
      WHERE exclusion.id=ANY($1::bigint[]) ORDER BY exclusion.id`,[[33,34,35,36,37]]);
    assert.equal(holds.rows.length,5);
    assert.ok(holds.rows.every(row=>row.deactivated_at));
    assert.ok(loads.length>0,'POB03737 must now participate in the actual planner.');
    const audits=await query(`SELECT id,details,created_at FROM delivery_audit_log
      WHERE action='smart_scm.planning_exclusion.auto_resume_blanket'
        AND (details->>'exclusionId')::bigint=ANY($1::bigint[]) ORDER BY id`,[[33,34,35,36,37]]);
    return {mode:apply?'applied':'rollback rehearsal',resumed,holds:holds.rows,audits:audits.rows,
      preview:{sourcePoRef:'POB03737',forecastRunId:planning.forecastRunId,loadCount:loads.length,
        pallets:loads.reduce((sum,load)=>sum+load.totalPallets,0),loads:loads.map(load=>({
          pallets:load.totalPallets,lines:load.lines.map(line=>({item:line.itemName,yard:line.destinationName,pallets:line.proposedPallets}))
        }))}};
  },{rollback:!apply});
  console.log(JSON.stringify(result,null,2));
}finally{await closeDb();}
