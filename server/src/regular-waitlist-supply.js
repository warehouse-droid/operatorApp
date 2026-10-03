import {query} from './db.js';
import {roundWaitlistQuantity,waitlistError,waitlistQuantity} from './regular-waitlist-domain.js';

export function normalizedWaitlistUnit(value) {
  const unit=String(value || '').trim().toUpperCase().replace(/[.\s_-]/gu,'');
  if(['SQFT','SF','SQUAREFEET','SQUAREFOOT'].includes(unit))return 'SQFT';
  if(['EA','EACH','PC','PCS','PIECE','PIECES'].includes(unit))return 'EA';
  return unit;
}

export function waitlistPoSalesQuantity(line, salesUom) {
  const quantity=waitlistQuantity(line.quantity,{allowZero:true});
  const native=normalizedWaitlistUnit(line.unit),sales=normalizedWaitlistUnit(salesUom);
  if(native===sales)return quantity;
  const column={PLT:'to_plt',PALLET:'to_plt',PALLETS:'to_plt',LYR:'to_lyr',LAYER:'to_lyr',LAYERS:'to_lyr',SEC:'to_sec',SECTION:'to_sec',SECTIONS:'to_sec',EA:'to_pcs'}[native];
  const factor=Number(column?line[column]:0);
  if(!sales || !column || !Number.isFinite(factor) || factor<=0)throw waitlistError('The PO quantity has no verified conversion to '+salesUom+'.','WAITLIST_PO_UNIT_INVALID',409);
  return waitlistQuantity(roundWaitlistQuantity(quantity*factor),{allowZero:true});
}

export async function resolveWaitlistPo(reference) {
  const ref=String(reference || '').trim();
  if(!ref || ref.length>120)throw waitlistError('Select an existing PO or split PO.');
  const result=await query(`SELECT * FROM purchase_orders WHERE lower(tranid)=lower($1)
    OR lower(COALESCE(NULLIF(dispatch_ref,''),''))=lower($1) OR netsuite_id::text=$1 ORDER BY netsuite_id`,[ref]);
  if(result.rowCount!==1)throw waitlistError('Select one exact existing PO or split PO.','WAITLIST_PO_NOT_FOUND',409);
  return result.rows[0];
}

export async function searchWaitlistPurchaseOrders(search='') {
  const term=String(search).trim().slice(0,120);
  const result=await query(`SELECT o.netsuite_id AS id,COALESCE(NULLIF(o.dispatch_ref,''),o.tranid) AS ref,o.tranid AS original_ref,
    o.status_text,o.expected_delivery_date,array_agg(DISTINCT l.item_id) FILTER(WHERE l.item_id IS NOT NULL) AS item_ids
    FROM purchase_orders o JOIN purchase_order_lines l ON l.purchase_order_id=o.netsuite_id AND l.netsuite_active=true
    WHERE o.netsuite_active=true AND COALESCE(o.status_text,'') !~* 'cancel|closed'
    AND ($1='' OR strpos(lower(o.tranid),lower($1))>0 OR strpos(lower(COALESCE(o.dispatch_ref,'')),lower($1))>0)
    GROUP BY o.netsuite_id ORDER BY o.trandate DESC NULLS LAST,o.tranid LIMIT 30`,[term]);
  const ids=result.rows.map(row=>Number(row.id));
  const lines=ids.length?(await query(`SELECT l.purchase_order_id,l.item_id,i.item_name AS item_code,i.display_name,l.quantity,l.unit,
    i.stock_unit AS sales_uom,COALESCE(l.to_plt,i.to_plt) AS to_plt,COALESCE(l.to_lyr,i.to_lyr) AS to_lyr,
    COALESCE(l.to_sec,i.to_sec) AS to_sec,COALESCE(l.to_pcs,i.to_pcs) AS to_pcs
    FROM purchase_order_lines l JOIN inventory_items i ON i.item_id=l.item_id
    WHERE l.purchase_order_id=ANY($1::bigint[]) AND l.netsuite_active=true ORDER BY l.id`,[ids])).rows:[];
  return result.rows.map(row=>({id:Number(row.id),ref:row.ref,originalRef:row.original_ref,status:row.status_text,eta:row.expected_delivery_date,
    items:lines.filter(line=>Number(line.purchase_order_id)===Number(row.id)).map(line=>{
      let quantity=null;try{quantity=waitlistPoSalesQuantity(line,line.sales_uom);}catch{/* Show the item; pool creation explains unsupported units. */}
      return {itemId:Number(line.item_id),itemCode:line.item_code,itemName:line.display_name||line.item_code,quantity,salesUom:line.sales_uom};
    })}));
}

// Queue references are viewing evidence only; they do not reserve PO quantity.
export async function recentQueuedWaitlistPurchaseOrders(itemIds){
  const result=new Map();if(!itemIds.length)return result;
  const rows=(await query(`WITH candidates AS (
    SELECT DISTINCT ON(l.item_id,o.netsuite_id) l.item_id,o.netsuite_id AS id,
      COALESCE(NULLIF(o.dispatch_ref,''),o.tranid) AS ref,
      COALESCE(split.source_po_ref,o.tranid) AS source_ref,split.id IS NOT NULL AS is_split,
      COALESCE(schedule.eta_date,o.expected_delivery_date) AS eta,
      COALESCE(schedule.created_at,split.created_at,o.synced_at,o.status_updated_at,o.trandate::timestamptz) AS queued_at
    FROM purchase_orders o JOIN purchase_order_lines l ON l.purchase_order_id=o.netsuite_id
    LEFT JOIN LATERAL (SELECT s.* FROM scm_transport_schedule s WHERE s.order_kind='PO'
      AND lower(s.order_ref)=lower(COALESCE(NULLIF(o.dispatch_ref,''),o.tranid)) ORDER BY s.id DESC LIMIT 1) schedule ON true
    LEFT JOIN dispatch_scm_po_splits split ON split.split_po_id=o.netsuite_id AND split.status='active'
    WHERE l.item_id=ANY($1::bigint[]) AND o.netsuite_active=true AND l.netsuite_active=true AND l.netsuite_closed=false
      AND COALESCE(o.status_text,'') !~* 'cancel|closed'
      AND lower(trim(COALESCE(NULLIF(schedule.status,''),NULLIF(o.initial_scm_status,''),'Queued')))='queued'
      AND COALESCE(l.quantity,0)>GREATEST(COALESCE(l.netsuite_received_baseline_qty,0),COALESCE(l.netsuite_received_qty,0))
      AND NOT EXISTS(SELECT 1 FROM dispatch_scm_po_splits inactive WHERE inactive.split_po_id=o.netsuite_id
        AND inactive.status<>'active' AND NOT EXISTS(SELECT 1 FROM dispatch_scm_po_splits active WHERE active.split_po_id=o.netsuite_id AND active.status='active'))
    ORDER BY l.item_id,o.netsuite_id,split.created_at DESC NULLS LAST
  ), ranked AS (SELECT *,row_number() OVER(PARTITION BY item_id ORDER BY queued_at DESC NULLS LAST,id DESC) AS rank FROM candidates)
  SELECT * FROM ranked WHERE rank<=3 ORDER BY item_id,rank`,[[...new Set(itemIds)]])).rows;
  for(const row of rows){
    const itemId=Number(row.item_id);if(!result.has(itemId))result.set(itemId,[]);
    result.get(itemId).push({id:Number(row.id),ref:row.ref,sourceRef:row.source_ref,isSplit:row.is_split,
      eta:row.eta?new Date(row.eta).toISOString().slice(0,10):null,queuedAt:row.queued_at?new Date(row.queued_at).toISOString():null});
  }
  return result;
}

// Walk split lineage to its canonical source, and enforce every ancestor's capacity.
async function supplyGraph(pool,lock){
  const lines=(await query(`SELECT l.*,o.netsuite_active AS po_active,o.status_text AS po_status,
    i.stock_unit AS item_sales_uom,COALESCE(l.to_plt,i.to_plt) AS to_plt,COALESCE(l.to_lyr,i.to_lyr) AS to_lyr,
    COALESCE(l.to_sec,i.to_sec) AS to_sec,COALESCE(l.to_pcs,i.to_pcs) AS to_pcs
    FROM purchase_order_lines l JOIN purchase_orders o ON o.netsuite_id=l.purchase_order_id
    JOIN inventory_items i ON i.item_id=l.item_id WHERE l.item_id=$1 ORDER BY l.id`+(lock?' FOR SHARE OF l,o':''),[pool.item_id])).rows;
  const edges=(await query(`SELECT ledger.source_line_id,ledger.split_line_id,split.status FROM dispatch_scm_po_split_lines ledger
    JOIN dispatch_scm_po_splits split ON split.id=ledger.split_id JOIN purchase_order_lines line ON line.id=ledger.split_line_id
    WHERE line.item_id=$1`,[pool.item_id])).rows;
  const byId=new Map(lines.map(line=>[Number(line.id),line])),parent=new Map(),children=new Map(),inactive=new Set();
  for(const edge of edges){
    const child=Number(edge.split_line_id),source=Number(edge.source_line_id);
    if(edge.status!=='active'){inactive.add(child);continue;}
    if(parent.has(child)&&parent.get(child)!==source)throw waitlistError('This PO split has conflicting source lines.','WAITLIST_PO_LINEAGE_CONFLICT',409);
    parent.set(child,source);if(!children.has(source))children.set(source,new Set());children.get(source).add(child);
  }
  for(const child of parent.keys())inactive.delete(child);
  function path(id){
    const result=[];let node=id;
    while(node){
      if(result.includes(node)||result.length>=32||!byId.has(node))throw waitlistError('This PO split has an invalid source lineage.','WAITLIST_PO_LINEAGE_CONFLICT',409);
      result.push(node);node=parent.get(node);
    }return result;
  }
  const selected=lines.filter(line=>Number(line.purchase_order_id)===Number(pool.purchase_order_id)&&!inactive.has(Number(line.id)));
  const roots=new Set(selected.map(line=>path(Number(line.id)).at(-1)));
  const family=lines.filter(line=>roots.has(path(Number(line.id)).at(-1)));
  const commitments=(await query(`SELECT s.root_line_id,s.po_line_id,SUM(s.quantity) AS quantity
    FROM regular_waitlist_allocation_sources s JOIN regular_waitlist_allocations a ON a.id=s.allocation_id
    WHERE (s.root_line_id=ANY($1::bigint[]) OR s.po_line_id=ANY($2::bigint[])) AND a.status IN ('reserved','converting','committed')
    GROUP BY s.root_line_id,s.po_line_id`,[[...roots],family.map(line=>Number(line.id))])).rows;
  return {selected,family,commitments,children,path};
}
const activeLine=line=>line.netsuite_active&&line.po_active&&!line.netsuite_closed&&!/cancel|closed/iu.test(line.po_status||'');
export async function waitlistPoolSupply(pool,{lock=false}={}){
  const graph=await supplyGraph(pool,lock);
  if(!graph.selected.length)return {capacityQty:0,sourceAvailableQty:0,sources:[],attention:'This PO no longer contains an active matching item.'};
  const capacity=new Map(),used=new Map(),subtreeUsed=new Map(),remaining=new Map();let attention='';
  for(const line of graph.family){
    const id=Number(line.id),qty=activeLine(line)?waitlistPoSalesQuantity(line,pool.sales_uom):0;
    capacity.set(id,qty);used.set(id,0);subtreeUsed.set(id,0);
    if(normalizedWaitlistUnit(line.item_sales_uom)!==normalizedWaitlistUnit(pool.sales_uom))attention='The item sales unit changed. SCM must review this pool.';
  }
  for(const commitment of graph.commitments){
    const id=Number(commitment.po_line_id),qty=Number(commitment.quantity),path=graph.path(id);
    if(path.at(-1)!==Number(commitment.root_line_id))attention='The PO split source changed. SCM must review existing commitments.';
    used.set(id,(used.get(id)||0)+qty);
    for(const ancestor of path)subtreeUsed.set(ancestor,(subtreeUsed.get(ancestor)||0)+qty);
  }
  for(const [id,qty] of capacity){
    remaining.set(id,Math.max(0,qty-(subtreeUsed.get(id)||0)));
    if((subtreeUsed.get(id)||0)>qty+0.000001)attention='The source PO/split quantity is below existing waitlist commitments.';
    const childQty=[...(graph.children.get(id)||[])].reduce((sum,child)=>sum+(capacity.get(child)||0),0);
    if((used.get(id)||0)>Math.max(0,qty-childQty)+0.000001)attention='The selected PO/split quantity is below existing waitlist commitments.';
  }
  const sources=[];let capacityQty=0;
  for(const line of graph.selected){
    const id=Number(line.id),path=graph.path(id),childQty=[...(graph.children.get(id)||[])].reduce((sum,child)=>sum+(capacity.get(child)||0),0);
    const branchCapacity=Math.max(0,(capacity.get(id)||0)-childQty);
    if(path.some(ancestor=>!capacity.get(ancestor)))attention='The selected PO or one of its split sources is inactive, closed or has no item quantity.';
    const available=Math.max(0,Math.min(branchCapacity-(used.get(id)||0),...path.map(ancestor=>remaining.get(ancestor)||0)));
    for(const ancestor of path)remaining.set(ancestor,Math.max(0,(remaining.get(ancestor)||0)-available));
    sources.push({lineId:id,rootLineId:path.at(-1),capacityQty:roundWaitlistQuantity(branchCapacity),availableQty:roundWaitlistQuantity(available)});capacityQty+=branchCapacity;
  }
  if(!capacityQty&&!attention)attention='The PO or split PO is inactive, closed or has no quantity for this item.';
  return {capacityQty:roundWaitlistQuantity(capacityQty),sourceAvailableQty:roundWaitlistQuantity(sources.reduce((sum,row)=>sum+row.availableQty,0)),sources,attention};
}
