import {query,withTransaction} from './db.js';
import {allocatePurchaseQuantity} from './regular-stock-purchase-domain.js';
import {describePurchaseOrderLinePallets} from './scm-netsuite-po-unit-conversion.js';

const round=value=>Number(Number(value).toFixed(6));
const idsFor=line=>(line.reason?.purchaseDemandIds||[]).map(Number);
export const lockPurchaseStock = () => query("SELECT pg_advisory_xact_lock(hashtextextended('regular-stock-replenishments',0))");

export async function getPurchaseStockEvidence(itemId,locationId) {
  const {getStockRequestItemAvailability}=await import('./stock-request-repository.js');
  const availability=await getStockRequestItemAvailability(itemId,{locationId});
  const yard=availability.yards[0];
  let preferredStock=null;
  try {
    const {loadSmartScmPlanningDemandStates}=await import('./smart-scm-planning-repository.js');
    const planning=await loadSmartScmPlanningDemandStates({includeTemporarilyExcluded:true,includePausedItemIds:[Number(itemId)]});
    const state=planning.states.find(row=>row.key===`${Number(itemId)}:${Number(locationId)}`);
    if(state?.toPlt>0)preferredStock=round(state.preferred*state.toPlt);
  } catch { /* Review remains possible without a preferred-stock calculation. */ }
  return {onHand:yard?.syncedAt?yard.onHand:null,available:yard?.syncedAt?yard.requestableAvailable:null,preferredStock,syncedAt:yard?.syncedAt||null};
}

export async function purchaseDemandRows() {
  return (await query(`SELECT d.*,l.request_id,l.item_id,l.item_name,l.sales_uom,l.destination_location_id,l.destination_name
    FROM regular_stock_purchase_demands d JOIN sales_stock_request_lines l ON l.id=d.request_line_id
    ORDER BY d.accepted_at,d.id`)).rows;
}

// Allocation identity follows a request item, not a load header which can be replaced.
async function persistAllocations(desired) {
  const existing=(await query('SELECT * FROM regular_stock_purchase_allocations WHERE active ORDER BY id')).rows;
  const key=row=>`${row.demand_id}:${row.proposal_line_id||0}:${row.purchase_order_id||0}:${row.po_line_id||0}`;
  const byKey=new Map(existing.map(row=>[key(row),row]));
  const kept=[];
  for(const value of desired){
    const row=byKey.get(key(value));
    if(row && Number(row.quantity)===value.quantity && Number(row.received_quantity)===value.received_quantity && Number(row.proposal_id)===Number(value.proposal_id)) {kept.push(Number(row.id));continue;}
    if(row)await query('UPDATE regular_stock_purchase_allocations SET active=false,retired_at=now() WHERE id=$1',[row.id]);
    const added=await query(`INSERT INTO regular_stock_purchase_allocations(demand_id,proposal_id,proposal_line_id,purchase_order_id,po_line_id,quantity,received_quantity)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,[value.demand_id,value.proposal_id,value.proposal_line_id,value.purchase_order_id,value.po_line_id,value.quantity,value.received_quantity]);
    kept.push(Number(added.rows[0].id));
  }
  await query('UPDATE regular_stock_purchase_allocations SET active=false,retired_at=now() WHERE active AND NOT(id=ANY($1::bigint[]))',[kept]);
}

export async function reconcilePurchaseStockAllocations() {
  return withTransaction(async()=>{
    await lockPurchaseStock();
    const demands=await purchaseDemandRows();
    if(!demands.length)return;
    const remaining=new Map(demands.map(d=>[Number(d.id),round(Number(d.approved_quantity)-Number(d.released_quantity))]));
    const lines=(await query(`SELECT l.*,p.netsuite_purchase_order_id,p.source_vendor_yard_id,p.status AS proposal_status
      FROM scm_smart_proposal_lines l JOIN scm_smart_proposals p ON p.id=l.proposal_id
      WHERE l.reason ? 'purchaseDemandIds' AND p.status NOT IN ('superseded','cancelled')
      ORDER BY (p.netsuite_purchase_order_id IS NOT NULL) DESC,p.id,l.id`)).rows;
    const poIds=[...new Set(lines.map(l=>Number(l.netsuite_purchase_order_id)).filter(Boolean))];
    const headers=poIds.length?(await query('SELECT netsuite_id,netsuite_active,status_text FROM purchase_orders WHERE netsuite_id=ANY($1::bigint[])',[poIds])).rows:[];
    const canonical=poIds.length?(await query(`SELECT l.*,COALESCE(l.location_id,p.destination_location_id) AS effective_location_id,p.netsuite_active AS order_active,p.status_text AS order_status
      FROM purchase_order_lines l JOIN purchase_orders p ON p.netsuite_id=l.purchase_order_id
      WHERE l.purchase_order_id=ANY($1::bigint[]) ORDER BY l.purchase_order_id,l.line_id,l.id`,[poIds])).rows:[];
    const consumed=new Map();
    const desired=[];
    for(const line of lines){
      const linked=demands.filter(d=>idsFor(line).includes(Number(d.id)) && Number(d.item_id)===Number(line.item_id)
        && Number(d.destination_location_id)===Number(line.destination_location_id) && Number(d.vendor_yard_id)===Number(line.source_vendor_yard_id));
      if(!linked.length)continue;
      const append=(quantity,received,poId=null,poLineId=null)=>{
        // Allocate sales units, preserving accepted quantities if the current
        // item master's pallet conversion changes after acceptance.
        const allocation=allocatePurchaseQuantity(linked.map(d=>({id:Number(d.id),remaining:remaining.get(Number(d.id))})),quantity,received);
        for(const item of allocation){
          const sales=item.quantity;
          desired.push({demand_id:item.demandId,proposal_id:Number(line.proposal_id),proposal_line_id:Number(line.id),purchase_order_id:poId,po_line_id:poLineId,quantity:sales,received_quantity:item.received});
          remaining.set(item.demandId,round(remaining.get(item.demandId)-sales));
        }
        return allocation.reduce((sum,item)=>sum+item.quantity,0);
      };
      if(line.netsuite_purchase_order_id){
        const orderRows=canonical.filter(row=>Number(row.purchase_order_id)===Number(line.netsuite_purchase_order_id));
        const matching=orderRows.filter(row=>Number(row.item_id)===Number(line.item_id)&&Number(row.effective_location_id)===Number(line.destination_location_id));
        const header=headers.find(row=>Number(row.netsuite_id)===Number(line.netsuite_purchase_order_id));
        // Keep an existing external commitment reserved while its first complete
        // item synchronization is pending. Never claim a receipt from a load.
        if(!matching.length && (!orderRows.length||line.proposal_status==='attention') && !line.reason.purchasePoLinesSynced
          && header?.netsuite_active!==false && !/cancel|closed/i.test(header?.status_text||'')){
          append(Number(line.sales_quantity),0,Number(line.netsuite_purchase_order_id));
        }
        for(const row of matching){
          const active=row.order_active!==false && row.netsuite_active!==false && !row.netsuite_closed && !/cancel|closed/i.test(row.order_status||'');
          const conversion=describePurchaseOrderLinePallets(row);
          const unitsPerPallet=conversion.palletQuantity>0&&conversion.nativeQuantity>0
            ? conversion.nativeQuantity/conversion.palletQuantity : conversion.unitsPerPallet;
          const sameUnit=String(row.unit||'').trim().toUpperCase()===String(line.unit||'').trim().toUpperCase();
          if(!sameUnit&&!(unitsPerPallet>0)){
            if(active)append(Number(line.sales_quantity),0,Number(line.netsuite_purchase_order_id));
            continue;
          }
          const salesPerNative=sameUnit?1:Number(line.to_plt)/unitsPerPallet;
          const received=Math.max(0,Number(row.netsuite_received_qty)||0)*salesPerNative;
          const total=active?conversion.nativeQuantity*salesPerNative:received;
          const used=consumed.get(Number(row.id))||0;
          const allocated=append(Math.max(0,total-used),Math.max(0,received-used),Number(row.purchase_order_id),Number(row.line_id));
          consumed.set(Number(row.id),used+allocated);
        }
      }else if(!['completed','failed'].includes(line.proposal_status))append(Number(line.sales_quantity),0);
    }
    await persistAllocations(desired);
    const receivedByDemand=new Map();
    for(const row of desired)receivedByDemand.set(row.demand_id,(receivedByDemand.get(row.demand_id)||0)+row.received_quantity);
    const statuses=[];
    for(const d of demands){
      const received=receivedByDemand.get(Number(d.id))||0;
      const target=Number(d.approved_quantity)-Number(d.released_quantity);
      statuses.push(target<=0?'closed':round(received)>=round(target)?'received':'approved');
    }
    await query(`UPDATE sales_stock_request_lines l SET status=next.status,updated_at=now()
      FROM unnest($1::bigint[],$2::text[]) AS next(id,status) WHERE l.id=next.id AND l.status IS DISTINCT FROM next.status`,[demands.map(d=>Number(d.request_line_id)),statuses]);
    const requestIds=[...new Set(demands.map(d=>Number(d.request_id)))];
    await query(`UPDATE sales_stock_requests r SET status=CASE WHEN NOT EXISTS(SELECT 1 FROM sales_stock_request_lines l WHERE l.request_id=r.id
      AND l.status NOT IN ('received','rejected','cancelled','closed','fulfilled')) THEN 'completed' ELSE 'active' END
      WHERE r.id=ANY($1::bigint[])`,[requestIds]);
  });
}

export async function retirePurchaseStockProposals(proposalIds) {
  const linked=(await query(`SELECT DISTINCT proposal_id FROM scm_smart_proposal_lines WHERE proposal_id=ANY($1::bigint[]) AND reason ? 'purchaseDemandIds'`,[proposalIds])).rows;
  const preserved=linked.map(row=>Number(row.proposal_id));
  if(preserved.length)await query("UPDATE scm_smart_proposals SET status='superseded',superseded_at=now(),updated_at=now() WHERE id=ANY($1::bigint[])",[preserved]);
  return preserved;
}

export async function decoratePurchaseStockRequest(request) {
  const demands=(await query(`SELECT d.* FROM regular_stock_purchase_demands d JOIN sales_stock_request_lines l ON l.id=d.request_line_id WHERE l.request_id=$1 ORDER BY d.id`,[request.id])).rows;
  const ids=demands.map(d=>Number(d.id));
  const allocations=ids.length?(await query(`SELECT a.*,p.status AS proposal_status,p.netsuite_purchase_order_ref,po.tranid,po.vendor_reference,po.status_text,po.expected_delivery_date
    FROM regular_stock_purchase_allocations a LEFT JOIN scm_smart_proposals p ON p.id=a.proposal_id
    LEFT JOIN purchase_orders po ON po.netsuite_id=a.purchase_order_id WHERE a.demand_id=ANY($1::bigint[]) ORDER BY a.id DESC`,[ids])).rows:[];
  const incoming=(await query(`SELECT l.*,po.tranid,po.vendor_reference,po.status_text,po.expected_delivery_date,po.vendor,po.dispatch_vendor_yard
    FROM purchase_order_lines l JOIN purchase_orders po ON po.netsuite_id=l.purchase_order_id
    WHERE l.item_id=ANY($1::bigint[]) AND COALESCE(l.location_id,po.destination_location_id)=$2
      AND po.netsuite_active=true AND l.netsuite_active=true AND NOT COALESCE(l.netsuite_closed,false)
      AND NOT COALESCE(po.is_blanket_po,false) AND LOWER(COALESCE(po.status_text,'')) !~ '(cancel|closed|fully received)'
      AND COALESCE(l.quantity,0)>COALESCE(l.netsuite_received_qty,0) ORDER BY po.expected_delivery_date NULLS LAST,po.netsuite_id,l.id`,
    [request.lines.map(l=>l.itemId),request.destinationLocationId])).rows;
  for(const line of request.lines){
    const demand=demands.find(d=>Number(d.request_line_id)===line.id);
    const rows=demand?allocations.filter(a=>Number(a.demand_id)===Number(demand.id)):[];
    const current=rows.filter(a=>a.active);
    const ordered=current.filter(a=>a.purchase_order_id&&a.po_line_id!==null).reduce((sum,a)=>sum+Number(a.quantity),0);
    const pendingVerification=current.filter(a=>a.purchase_order_id&&a.po_line_id===null).reduce((sum,a)=>sum+Number(a.quantity),0);
    const received=current.reduce((sum,a)=>sum+Number(a.received_quantity),0);
    const approved=Number(demand?.approved_quantity)||0,released=Number(demand?.released_quantity)||0;
    const orders=new Map();
    for(const a of rows.filter(a=>a.purchase_order_id)){
      const key=`${a.purchase_order_id}:${a.po_line_id}`;
      if(orders.has(key))continue;
      orders.set(key,{purchaseOrderId:Number(a.purchase_order_id),lineId:a.po_line_id===null?null:Number(a.po_line_id),purchaseOrderNumber:a.tranid||a.netsuite_purchase_order_ref,
        purchaseOrderRef:a.vendor_reference||'',status:a.status_text||a.proposal_status,expectedArrival:a.expected_delivery_date,quantity:Number(a.quantity),receivedQuantity:Number(a.received_quantity),active:a.active,direct:true});
      if(a.active&&a.po_line_id===null)orders.get(key).pendingVerification=true;
    }
    for(const row of incoming.filter(row=>Number(row.item_id)===line.itemId)){
      const key=`${row.purchase_order_id}:${row.line_id}`;
      if(orders.has(key))continue;
      orders.set(key,{purchaseOrderId:Number(row.purchase_order_id),lineId:Number(row.line_id),purchaseOrderNumber:row.tranid,purchaseOrderRef:row.vendor_reference||'',status:row.status_text,
        expectedArrival:row.expected_delivery_date,vendorYard:row.dispatch_vendor_yard||row.vendor,quantity:Number(row.quantity),receivedQuantity:Number(row.netsuite_received_qty)||0,unit:row.unit,direct:false,active:true});
    }
    line.purchase={demandId:demand?Number(demand.id):null,requestedQuantity:Number(demand?.requested_quantity??line.salesQty),reviewedQuantity:Number(demand?.reviewed_quantity??line.salesQty),
      approvedQuantity:approved,orderedQuantity:round(ordered),receivedQuantity:round(received),releasedQuantity:released,unorderedQuantity:round(Math.max(0,approved-released-ordered)),
      pendingVerificationQuantity:round(pendingVerification),
      releaseReason:demand?.release_reason||'',proposals:current.filter(a=>!a.purchase_order_id).map(a=>({proposalId:Number(a.proposal_id),lineId:Number(a.proposal_line_id),quantity:Number(a.quantity),status:a.proposal_status})),orders:[...orders.values()]};
  }
}
