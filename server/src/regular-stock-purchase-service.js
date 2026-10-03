import {query,withTransaction} from './db.js';
import {getScmStockRequest,recordStockRequestEvent} from './stock-request-repository.js';
import {regularError} from './regular-stock-domain.js';
import {isPurchaseStocking,purchaseReviewQuantity} from './regular-stock-purchase-domain.js';
import {lockPurchaseStock,purchaseDemandRows,reconcilePurchaseStockAllocations,retirePurchaseStockProposals} from './regular-stock-purchase-repository.js';

async function purchaseRun(runId) {
  const settings=(await query('SELECT * FROM scm_smart_settings WHERE id=1')).rows[0];
  const pallet=(await query("SELECT item_weight FROM inventory_items WHERE UPPER(BTRIM(item_name))='PALLET' ORDER BY item_id LIMIT 1")).rows[0];
  settings.physical_pallet_weight_lbs=Number(pallet?.item_weight)||0;
  if(runId)return {id:Number(runId),settings};
  const latest=(await query("SELECT id FROM scm_smart_planning_runs WHERE status='ready' AND plan_kind='inventory' ORDER BY id DESC LIMIT 1")).rows[0];
  const row=latest||(await query(`INSERT INTO scm_smart_planning_runs(trigger_source,status,plan_kind,settings_snapshot,completed_at)
    VALUES('stocking-purchase','ready','inventory',$1::jsonb,now()) RETURNING id`,[JSON.stringify(settings)])).rows[0];
  return {id:Number(row.id),settings};
}

async function buildOutstandingPurchaseLoads(runId) {
  const planner=await import('./smart-scm-planning-repository.js');
  const {id,settings}=await purchaseRun(runId);
  // Refresh dedicated editable loads together. Loads already merged or sent to
  // vendors stay intact and retain their existing allocations.
  const replace=(await query(`SELECT p.id FROM scm_smart_proposals p WHERE p.memo LIKE 'Stocking Purchase%'
    AND p.status IN ('draft','held','attention') AND p.order_requested_at IS NULL AND p.netsuite_purchase_order_id IS NULL
    AND NOT EXISTS(SELECT 1 FROM scm_smart_proposal_lines l WHERE l.proposal_id=p.id AND (l.added_source='manual' OR l.reason->>'manuallyAdjusted'='true'))
    FOR UPDATE`)).rows.map(row=>Number(row.id));
  await retirePurchaseStockProposals(replace);
  await reconcilePurchaseStockAllocations();
  const assigned=(await query('SELECT demand_id,SUM(quantity) AS quantity FROM regular_stock_purchase_allocations WHERE active GROUP BY demand_id')).rows;
  const byDemand=new Map(assigned.map(row=>[Number(row.demand_id),Number(row.quantity)]));
  const demands=await purchaseDemandRows();
  const drafts=[];
  for(const d of demands){
    const quantity=Number(d.approved_quantity)-Number(d.released_quantity)-(byDemand.get(Number(d.id))||0);
    if(quantity<=1e-6)continue;
    const policy=d.policy_snapshot,pallets=quantity/Number(d.to_plt);
    if(Number(policy.pallet_weight_lbs)+settings.physical_pallet_weight_lbs>Number(settings.truck_capacity_lbs))throw regularError(`${d.item_name} exceeds truck capacity for one pallet. Review its pallet weight and the truck settings.`);
    const line={itemId:Number(d.item_id),itemName:d.item_name,itemDescription:policy.item_description||'',unit:d.sales_uom,
      destinationLocationId:Number(d.destination_location_id),destinationName:d.destination_name,requiredPallets:pallets,proposedPallets:pallets,confirmedPallets:0,residualPallets:pallets,
      salesQuantity:quantity,palletWeight:Number(policy.pallet_weight_lbs),physicalPalletWeightLbs:settings.physical_pallet_weight_lbs,lineWeight:pallets*Number(policy.pallet_weight_lbs),
      toPlt:Number(d.to_plt),toLyr:Number(policy.to_lyr)||0,toSec:Number(policy.to_sec)||0,toPcs:Number(policy.to_pcs)||0,manualPlanningRequired:false,
      reason:{purchaseDemandIds:[Number(d.id)],stockingPurchase:true},urgent:false,provisional:false};
    drafts.push({proposalType:'PO',phase:'direct_vendor',sourceKind:'vendor',sourceLocationId:null,sourceVendorYardId:Number(d.vendor_yard_id),
      sourceName:policy.vendor_yard,plant:policy.vendor_yard,vendor:policy.vendor,destinationLocationId:line.destinationLocationId,destinationName:line.destinationName,
      memo:'Stocking Purchase requests',status:'held',lines:[line],urgent:false,provisional:false});
  }
  const {smartScmRouteRuleMap}=await import('./smart-scm-route-repository.js');
  const rules=await smartScmRouteRuleMap();
  // Purchase destinations must remain the requesting yards even when automatic
  // inventory planning redirects partial shop quantities through a hub.
  for(const rule of rules.values())rule.partialRedirectEnabled=false;
  const packed=planner.consolidateCompatibleDrafts(drafts,settings,`purchase-${Date.now()}`,rules)
    .map(draft=>({...draft,memo:`Stocking Purchase requests · ${draft.memo}`}));
  await planner.persistPurchaseStockDrafts(id,packed);
  await reconcilePurchaseStockAllocations();
  await query(`INSERT INTO regular_stock_purchase_runs(proposal_id,run_id)
    SELECT DISTINCT a.proposal_id,$1::bigint FROM regular_stock_purchase_allocations a JOIN scm_smart_proposals p ON p.id=a.proposal_id
    WHERE a.active AND (a.purchase_order_id IS NULL OR a.po_line_id IS NULL) AND p.status NOT IN ('cancelled','superseded') ON CONFLICT DO NOTHING`,[id]);
  await query(`INSERT INTO regular_stock_purchase_runs(proposal_id,run_id)
    SELECT DISTINCT p.id,p.run_id FROM scm_smart_proposals p JOIN regular_stock_purchase_allocations a ON a.proposal_id=p.id
    WHERE a.active AND a.purchase_order_id IS NULL ON CONFLICT DO NOTHING`);
  await query(`UPDATE scm_smart_proposals p SET run_id=$1 WHERE p.status IN ('draft','held','attention') AND p.order_requested_at IS NULL
    AND EXISTS(SELECT 1 FROM regular_stock_purchase_runs carry WHERE carry.proposal_id=p.id AND carry.run_id=$1)`,[id]);
  return id;
}

export async function syncPurchaseStockDemand({runId=null}={}) {
  return withTransaction(async()=>{
    await lockPurchaseStock();
    if(!(await query('SELECT 1 FROM regular_stock_purchase_demands LIMIT 1')).rowCount)return new Map();
    await buildOutstandingPurchaseLoads(runId);
    const coverage=new Map();
    const rows=(await query(`SELECT l.item_id,l.destination_location_id,SUM(l.sales_quantity/NULLIF(l.to_plt,0)) AS pallets
      FROM scm_smart_proposal_lines l JOIN scm_smart_proposals p ON p.id=l.proposal_id
      WHERE p.status NOT IN ('failed','cancelled','superseded')
      AND EXISTS(SELECT 1 FROM regular_stock_purchase_allocations a WHERE a.active AND a.proposal_id=p.id AND (a.purchase_order_id IS NULL OR a.po_line_id IS NULL))
      GROUP BY l.item_id,l.destination_location_id`)).rows;
    for(const row of rows)coverage.set(`${row.item_id}:${row.destination_location_id}`,Number(row.pallets));
    return coverage;
  });
}

export async function addPurchaseStockProposals(id,input,context,dependencies={}) {
  const selected=Array.isArray(input.lines)?input.lines:[];
  if(!Number.isSafeInteger(Number(id))||Number(id)<=0||!selected.length||selected.length>100||selected.some(line=>!line||!Number.isSafeInteger(Number(line.lineId))||Number(line.lineId)<=0)||new Set(selected.map(line=>Number(line.lineId))).size!==selected.length)throw regularError('Select valid Purchase request items.','REGULAR_PURCHASE_INVALID',400);
  return withTransaction(async()=>{
    await lockPurchaseStock();
    await query('SELECT id FROM sales_stock_requests WHERE id=$1 FOR UPDATE',[id]);
    const request=await getScmStockRequest(id);
    if(!isPurchaseStocking(request))throw regularError('Only Stocking Purchase requests can be added to PO proposals.');
    const existing=selected.map(value=>request.lines.find(line=>line.id===Number(value.lineId)));
    if(existing.some(line=>!line))throw regularError('A selected item does not belong to this request.');
    const replay=existing.every((line,index)=>line.purchase?.demandId && line.purchase.reviewedQuantity===Number(selected[index].reviewedSalesQty??line.salesQty));
    if(replay)return request;
    if(Number(input.expectedRevision)!==request.revision)throw regularError('This request changed. Reload and review again.','STOCK_REQUEST_REVISION_CONFLICT');
    const {getSmartScmProposalItemPolicy}=await import('./smart-scm-proposal-editor.js');
    for(let index=0;index<selected.length;index++){
      const line=existing[index];
      if(line.status!=='submitted')throw regularError('Only pending Purchase items can be accepted.');
      const policy=await (dependencies.loadPurchasePolicy||((itemId,yardId)=>getSmartScmProposalItemPolicy(itemId,yardId,{allowExcluded:true,allowForcedPurchase:true})))(line.itemId,request.destinationLocationId);
      if(!policy||!(Number(policy.vendor_id)>0)||!(Number(policy.vendor_yard_id)>0)||!policy.vendor_yard||!(Number(policy.pallet_weight_lbs)>0))throw regularError(`Configure the vendor yard, NetSuite vendor and pallet weight for ${line.itemName} before adding it to proposals.`);
      const quantity=purchaseReviewQuantity(line.salesQty,policy.to_plt,selected[index].reviewedSalesQty??line.salesQty);
      const changedConversion=await query(`SELECT 1 FROM regular_stock_purchase_demands d JOIN sales_stock_request_lines l ON l.id=d.request_line_id
        WHERE l.item_id=$1 AND l.status='approved' AND d.approved_quantity>d.released_quantity AND d.to_plt<>$2 LIMIT 1`,[line.itemId,quantity.toPlt]);
      if(changedConversion.rowCount)throw regularError(`The pallet conversion for ${line.itemName} changed. Receive or release its existing Purchase demand before accepting a different conversion.`);
      await query(`INSERT INTO regular_stock_purchase_demands(request_line_id,vendor_yard_id,vendor_id,policy_snapshot,requested_quantity,reviewed_quantity,approved_quantity,to_plt,accepted_by)
        VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9)`,[line.id,policy.vendor_yard_id,policy.vendor_id,JSON.stringify(policy),quantity.requestedQuantity,quantity.reviewedQuantity,quantity.approvedQuantity,quantity.toPlt,context.operatorId]);
      await query("UPDATE sales_stock_request_lines SET status='approved',regular_decision='po',decided_by=$2,decided_at=now(),updated_at=now() WHERE id=$1",[line.id,context.operatorId]);
    }
    await buildOutstandingPurchaseLoads();
    const event=await query(`INSERT INTO sales_stock_request_events(request_id,event_type,actor_id,details)
      VALUES($1,'regular_manual_decision',$2,$3::jsonb) RETURNING id`,[id,context.operatorId,JSON.stringify({decision:'po',stockingType:'purchase',lineIds:selected.map(line=>Number(line.lineId))})]);
    await query(`UPDATE sales_stock_requests SET status='active',revision=revision+1,first_scm_decision_at=COALESCE(first_scm_decision_at,now()),
      manual_decision_event_id=$2,updated_at=now() WHERE id=$1`,[id,event.rows[0].id]);
    return getScmStockRequest(id);
  });
}

export async function releasePurchaseStockDemand(id,input,context) {
  const reason=String(input.reason||'').trim();
  if(!Number.isSafeInteger(Number(id))||Number(id)<=0||!reason||reason.length>1000||!Array.isArray(input.lineIds)||!input.lineIds.length)throw regularError('Select items and enter a release reason (at most 1000 characters).','REGULAR_PURCHASE_INVALID',400);
  return withTransaction(async()=>{
    await lockPurchaseStock();
    await query('SELECT id FROM sales_stock_requests WHERE id=$1 FOR UPDATE',[id]);
    await reconcilePurchaseStockAllocations();
    const request=await getScmStockRequest(id);
    if(!isPurchaseStocking(request)||Number(input.expectedRevision)!==request.revision)throw regularError('This request changed. Reload before releasing.');
    for(const lineId of [...new Set(input.lineIds.map(Number))]){
      const line=request.lines.find(row=>row.id===lineId);
      if(!line?.purchase?.demandId||line.purchase.unorderedQuantity<=0)throw regularError('Only remaining unordered Purchase demand can be released.');
      const frozen=await query(`SELECT 1 FROM regular_stock_purchase_allocations a JOIN scm_smart_proposals p ON p.id=a.proposal_id
        WHERE a.demand_id=$1 AND a.active AND (a.purchase_order_id IS NULL OR a.po_line_id IS NULL)
        AND (a.purchase_order_id IS NOT NULL OR p.order_requested_at IS NOT NULL OR p.status NOT IN ('draft','held','attention'))`,[line.purchase.demandId]);
      if(frozen.rowCount)throw regularError('Cancel the active vendor ordering workflow before releasing its remaining Purchase quantity.');
      const drafts=(await query('SELECT * FROM regular_stock_purchase_allocations WHERE demand_id=$1 AND active AND purchase_order_id IS NULL',[line.purchase.demandId])).rows;
      for(const allocation of drafts){
        await query(`UPDATE scm_smart_proposal_lines SET sales_quantity=GREATEST(0,sales_quantity-$2),proposed_pallets=GREATEST(0,proposed_pallets-$2/NULLIF(to_plt,0)),
          required_pallets=GREATEST(0,required_pallets-$2/NULLIF(to_plt,0)),residual_pallets=GREATEST(0,residual_pallets-$2/NULLIF(to_plt,0)),
          line_weight_lbs=GREATEST(0,line_weight_lbs-$2/NULLIF(to_plt,0)*pallet_weight_lbs) WHERE id=$1`,[allocation.proposal_line_id,allocation.quantity]);
        await query('DELETE FROM scm_smart_proposal_lines WHERE id=$1 AND sales_quantity<=0',[allocation.proposal_line_id]);
        await query("UPDATE scm_smart_proposals SET status='superseded',superseded_at=now(),total_pallets=0,total_weight_lbs=0,utilization=0,route_stops='[]' WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM scm_smart_proposal_lines WHERE proposal_id=$1 AND sales_quantity>0)",[allocation.proposal_id]);
        const {refreshSmartScmProposalDerived}=await import('./smart-scm-proposal-editor.js');
        await refreshSmartScmProposalDerived(allocation.proposal_id);
      }
      await query('UPDATE regular_stock_purchase_demands SET released_quantity=released_quantity+$2,release_reason=$3,released_by=$4,updated_at=now() WHERE id=$1',[line.purchase.demandId,line.purchase.unorderedQuantity,reason,context.operatorId]);
    }
    await syncPurchaseStockDemand();
    await recordStockRequestEvent({requestId:Number(id),eventType:'regular_purchase_released',actorId:context.operatorId,details:{lineIds:input.lineIds,reason}});
    await query('UPDATE sales_stock_requests SET revision=revision+1,updated_at=now() WHERE id=$1',[id]);
    return getScmStockRequest(id);
  });
}
