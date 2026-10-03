import { query, withTransaction } from './db.js';
import { regularReplenishmentQuantity, regularError } from './regular-stock-domain.js';
import { writeAudit } from './auth-repository.js';

export const lockRegularReplenishments = () => query("SELECT pg_advisory_xact_lock(hashtextextended('regular-stock-replenishments',0))");

export async function enqueueRegularReplenishments(request) {
  return withTransaction(async()=>{
    await lockRegularReplenishments();
    const handoff=(await query('SELECT * FROM regular_stock_handoffs WHERE request_id=$1',[request.id])).rows[0];
    if(!handoff || handoff.plan.mode==='location'&&!handoff.location_applied)throw regularError('Replenishment must wait for the SO commitment.');
    if(handoff.plan.mode==='transfer'){
      const incomplete=await query(`SELECT id FROM sales_stock_transfers WHERE request_id=$1 AND netsuite_transfer_order_id IS NULL`,[request.id]);
      if(!request.transfers.length||incomplete.rowCount)throw regularError('Replenishment must wait for every TO commitment.');
    }
    for(const line of request.lines.filter(line=>line.decision==='po')){
      const linked=await query('SELECT replenishment_id FROM regular_stock_replenishment_requests WHERE request_line_id=$1',[line.id]);
      if(linked.rowCount)continue;
      const group=await query(`INSERT INTO regular_stock_replenishments(item_id,source_location_id) VALUES($1,$2)
        ON CONFLICT(item_id,source_location_id) WHERE released_at IS NULL DO UPDATE SET updated_at=now(),revision=regular_stock_replenishments.revision+1 RETURNING id`,[line.itemId,line.sourceLocationId]);
      await query('INSERT INTO regular_stock_replenishment_requests(request_line_id,replenishment_id) VALUES($1,$2)',[line.id,group.rows[0].id]);
    }
    await query('UPDATE regular_stock_handoffs SET replenishment_ready=true WHERE request_id=$1',[request.id]);
  });
}

export async function listRegularReplenishments({runId=null}={}){
  const {rows}=await query(`SELECT g.*,i.item_name,i.stock_unit,p.status AS proposal_status,p.netsuite_purchase_order_ref,
    COALESCE((SELECT jsonb_agg(DISTINCT ordered.netsuite_purchase_order_ref) FROM scm_smart_proposals ordered WHERE ordered.regular_replenishment_id=g.id AND ordered.netsuite_purchase_order_ref IS NOT NULL),'[]') AS purchase_order_refs,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('requestId',r.id,'requestRef',r.request_ref,'salesOrderRef',h.sales_order_ref,'arrivalAt',r.regular_details->>'arrivalAt') ORDER BY r.id)
      FROM regular_stock_replenishment_requests link JOIN sales_stock_request_lines l ON l.id=link.request_line_id
      JOIN sales_stock_requests r ON r.id=l.request_id LEFT JOIN regular_stock_handoffs h ON h.request_id=r.id WHERE link.replenishment_id=g.id),'[]') AS requests
    FROM regular_stock_replenishments g JOIN inventory_items i ON i.item_id=g.item_id LEFT JOIN scm_smart_proposals p ON p.id=g.current_proposal_id
    WHERE g.released_at IS NULL AND ($1::bigint IS NULL OR EXISTS(SELECT 1 FROM regular_stock_replenishment_runs link WHERE link.replenishment_id=g.id AND link.run_id=$1)) ORDER BY g.created_at,g.id`,[runId]);
  return rows.map(row=>({id:Number(row.id),itemId:Number(row.item_id),itemName:row.item_name,unit:row.stock_unit,
    sourceLocationId:Number(row.source_location_id),revision:Number(row.revision),quantity:Number(row.quantity),evidence:row.evidence,
    currentProposalId:row.current_proposal_id?Number(row.current_proposal_id):null,proposalStatus:row.proposal_status||null,
    purchaseOrderRef:row.netsuite_purchase_order_ref||null,purchaseOrderRefs:row.purchase_order_refs||[],requests:row.requests}));
}

async function ensureRun(runId,planning){
  if(runId)return Number(runId);
  const latest=await query("SELECT id FROM scm_smart_planning_runs WHERE status='ready' AND plan_kind='inventory' ORDER BY id DESC LIMIT 1");
  if(latest.rowCount)return Number(latest.rows[0].id);
  const created=await query(`INSERT INTO scm_smart_planning_runs(trigger_source,status,plan_kind,settings_snapshot,completed_at)
    VALUES('regular-stock-request','ready','inventory',$1::jsonb,now()) RETURNING id`,[JSON.stringify(planning.settings)]);
  return Number(created.rows[0].id);
}

export async function syncRegularReplenishments({runId=null,planning=null}={}){
  const active=await query('SELECT item_id FROM regular_stock_replenishments WHERE released_at IS NULL');
  if(!active.rowCount)return new Map();
  const planner=await import('./smart-scm-planning-repository.js');
  const current=planning||await planner.loadSmartScmPlanningDemandStates({includeTemporarilyExcluded:true,includePausedItemIds:active.rows.map(row=>Number(row.item_id))});
  return withTransaction(async()=>{
    await lockRegularReplenishments();
    const targetRun=await ensureRun(runId,current);
    const groups=(await query('SELECT * FROM regular_stock_replenishments WHERE released_at IS NULL ORDER BY id FOR UPDATE')).rows;
    const coverage=new Map();
    for(const group of groups){
      await query('INSERT INTO regular_stock_replenishment_runs(replenishment_id,run_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[group.id,targetRun]);
      const key=`${group.item_id}:${group.source_location_id}`;
      const state=current.states.find(candidate=>candidate.key===key);
      const proposal=group.current_proposal_id?(await query('SELECT * FROM scm_smart_proposals WHERE id=$1 FOR UPDATE',[group.current_proposal_id])).rows[0]:null;
      const requestLineIds=(await query('SELECT request_line_id FROM regular_stock_replenishment_requests WHERE replenishment_id=$1 ORDER BY request_line_id',[group.id])).rows.map(row=>Number(row.request_line_id));
      const descendants=proposal?(await query(`WITH RECURSIVE family AS (
        SELECT id FROM scm_smart_proposals WHERE id=$1 UNION SELECT child.id FROM scm_smart_proposals child JOIN family ON child.parent_proposal_id=family.id
      ) SELECT p.*,COALESCE((SELECT SUM(sales_quantity) FROM scm_smart_proposal_lines WHERE proposal_id=p.id),0) AS sales_quantity
        FROM family JOIN scm_smart_proposals p ON p.id=family.id WHERE p.id<>$1 AND p.status NOT IN ('cancelled','superseded')`,[proposal.id])).rows:[];
      const placed=Boolean(proposal?.netsuite_purchase_order_id||descendants.some(row=>row.netsuite_purchase_order_id));
      const newDemand=requestLineIds.some(id=>!group.evidence?.requestLineIds?.includes(id));
      const descendantPending=descendants.filter(row=>!row.netsuite_purchase_order_id);
      if(descendants.length&&(descendantPending.length||!newDemand)){
        if(state?.toPlt>0)coverage.set(key,descendantPending.reduce((sum,row)=>sum+Number(row.sales_quantity),0)/state.toPlt);
        continue;
      }
      const pending=proposal&&!placed&&(proposal.order_requested_at||!['draft','held','attention'].includes(proposal.status))&&!['cancelled','superseded'].includes(proposal.status);
      if(pending || placed&&!newDemand){
        if(pending&&state?.toPlt>0)coverage.set(key,Number(group.quantity)/state.toPlt);
        continue;
      }
      const editable=proposal&&!placed&&['draft','held','attention'].includes(proposal.status);
      let quantity=0,proposalId=group.current_proposal_id;
      let evidence={calculatedAt:new Date().toISOString()};
      if(!state||!(state.toPlt>0)||!state.inventorySyncedAt){
        evidence.error='Current preferred stock, inventory or purchase conversion is unavailable.';
        if(editable)await query("UPDATE scm_smart_proposals SET status='attention',updated_at=now() WHERE id=$1",[proposal.id]);
      }else{
        quantity=regularReplenishmentQuantity({preferredQuantity:state.preferred*state.toPlt,inventoryPositionQuantity:state.positionPallets*state.toPlt,purchaseIncrement:1});
        evidence={...evidence,requestLineIds,preferredQuantity:state.preferred*state.toPlt,inventoryPositionQuantity:state.positionPallets*state.toPlt,
          availableQuantity:state.availableSales,quantity,unit:state.policy.stock_unit};
        if(quantity>0){
          proposalId=await planner.persistRegularReplenishmentDraft({runId:targetRun,group:{...group,current_proposal_id:editable?group.current_proposal_id:null},state,quantity,settings:current.settings});
          coverage.set(key,quantity/state.toPlt);
        }else if(editable){
          await query("UPDATE scm_smart_proposals SET status='superseded',superseded_at=now(),updated_at=now() WHERE id=$1",[proposal.id]);
          proposalId=null;
        }else if(placed){quantity=Number(group.quantity);}
      }
      await query(`UPDATE regular_stock_replenishments SET quantity=$2,evidence=$3::jsonb,current_proposal_id=$4,revision=revision+1,updated_at=now() WHERE id=$1`,[group.id,quantity,JSON.stringify(evidence),proposalId]);
    }
    return coverage;
  });
}

export function creditRegularReplenishments(states,coverage){
  return states.map(state=>{
    const pallets=coverage.get(state.key)||0;
    return pallets>0?{...state,requiredPallets:Math.max(0,state.requiredPallets-pallets),
      residualRequiredPallets:Math.max(0,(state.residualRequiredPallets??state.requiredPallets)-pallets)}:state;
  });
}

export async function releaseRegularReplenishment(id,{expectedRevision},context){
  return withTransaction(async()=>{
    await lockRegularReplenishments();
    const group=(await query('SELECT * FROM regular_stock_replenishments WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!group)throw regularError('Replenishment load not found.','REGULAR_NOT_FOUND',404);
    if(group.released_at)return {released:true};
    if(Number(group.revision)!==Number(expectedRevision))throw regularError('This load changed. Refresh before releasing.');
    await query('UPDATE regular_stock_replenishments SET released_at=now(),released_by=$2,revision=revision+1 WHERE id=$1',[id,context.operatorId]);
    await writeAudit({actorOperatorId:context.operatorId,source:'smart_scm',action:'regular_stock.replenishment.release',details:{replenishmentId:Number(id),proposalId:group.current_proposal_id}});
    return {released:true};
  });
}
