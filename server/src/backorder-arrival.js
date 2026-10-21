// @ts-check
import {createHash} from 'node:crypto';
import {query} from './db.js';
import {purchaseOrderArrived} from './backorder-arrival-status.js';
/** @typedef {Record<string,any>} Row */
/** @param {unknown} value */
const reference=value=>String(value || '').trim().toUpperCase();

/** Read-only receipt projection shared by details, queues and Sales alerts.
 * Unknown or ambiguous PO numbers never provide receipt evidence.
 * @param {Row[]} details @param {Row[]} lineRows */
export async function backorderArrivals(details,lineRows) {
  const eligible=new Map(details.filter(d=>d.workflowKind==='backorder' && d.closeStatus==='active'
    && d.status!=='cancelled').map(d=>[Number(d.id),d]));
  const ordered=lineRows.filter(line=>eligible.has(Number(line.request_id)) && line.supply_status==='already_ordered');
  const refs=[...new Set(ordered.map(line=>reference(line.backorder_po_number)).filter(Boolean))];
  /** @type {Map<number,Row>} */
  const result=new Map();
  if (!refs.length) return result;
  /** @type {Row[]} */
  const orders=(await query('SELECT netsuite_id,tranid,status_text,netsuite_active FROM purchase_orders WHERE upper(btrim(tranid))=ANY($1::text[])',[refs])).rows;
  /** @type {Row[]} */
  const lines=orders.length?(await query('SELECT purchase_order_id,quantity,netsuite_received_qty,netsuite_active,item_type FROM purchase_order_lines WHERE purchase_order_id=ANY($1::bigint[])',[orders.map(order=>order.netsuite_id)])).rows:[];
  /** @type {Map<string,Row[]>} */
  const matches=new Map();
  for (const order of orders) {
    const key=reference(order.tranid);
    matches.set(key,[...(matches.get(key)||[]),order]);
  }
  for (const [id,detail] of eligible) {
    const materials=ordered.filter(line=>Number(line.request_id)===id);
    if (!materials.length) continue;
    const tracked=[...new Set(materials.map(line=>reference(line.backorder_po_number)))].map(ref=>{
      const found=matches.get(ref)||[],order=found.length===1?found[0]:null;
      return {reference:ref,purchaseOrderId:order?Number(order.netsuite_id):null,
        arrived:purchaseOrderArrived(order,lines.filter(line=>String(line.purchase_order_id)===String(order?.netsuite_id))),
        lineIds:materials.filter(line=>reference(line.backorder_po_number)===ref).map(line=>Number(line.id))};
    });
    const received=tracked.filter(order=>order.arrived),salesOrderRef=detail.alreadyOrderedSalesOrderRef || detail.salesOrderRef || '';
    // Receipt identity excludes sync timestamps and request revisions: an unrelated edit cannot re-alert.
    const key=received.length?createHash('sha256').update(JSON.stringify([reference(salesOrderRef),...received.map(order=>order.purchaseOrderId).sort((a,b)=>Number(a)-Number(b))])).digest('hex'):null;
    result.set(id,{status:tracked.every(order=>order.arrived)?'arrived':'arrival',key,salesOrderRef,orders:tracked});
  }
  return result;
}

/** @param {string} operatorId @param {number[]} yards */
export async function backorderArrivalAlerts(operatorId,yards) {
  const requests=[];let after=0;
  // Completed requests participate. Page the scope, rather than silently dropping older unread arrivals.
  while (true) {
    /** @type {Row[]} */
    const rows=(await query(`SELECT request.id,request.request_ref,request.status,request.regular_details,
        special.sales_order_ref,seen.backorder_arrival_key
      FROM sales_stock_requests request JOIN sales_special_stock_cases special ON special.request_id=request.id
      LEFT JOIN regular_stock_decision_reads seen ON seen.request_id=request.id AND seen.operator_id=$1
      WHERE request.id>$3 AND request.requested_by=$1 AND request.destination_location_id=ANY($2::bigint[])
        AND request.request_type='regular' AND special.workflow_kind='backorder' AND special.close_status='active'
        AND request.status<>'cancelled'
        AND EXISTS(SELECT 1 FROM sales_special_stock_lines line WHERE line.request_id=request.id AND line.removed_at IS NULL AND line.supply_status='already_ordered')
      ORDER BY request.id LIMIT 100`,[operatorId,yards,after])).rows;
    if (!rows.length) break;
    const details=rows.map(row=>({id:Number(row.id),workflowKind:'backorder',closeStatus:'active',status:row.status,
      alreadyOrderedSalesOrderRef:row.regular_details?.alreadyOrderedSalesOrderRef,salesOrderRef:row.sales_order_ref}));
    const lines=(await query('SELECT id,request_id,supply_status,backorder_po_number FROM sales_special_stock_lines WHERE request_id=ANY($1::bigint[]) AND removed_at IS NULL',[rows.map(row=>row.id)])).rows;
    const arrivals=await backorderArrivals(details,lines);
    for (const row of rows) {
      const arrival=arrivals.get(Number(row.id));
      if (!arrival?.key || arrival.key===row.backorder_arrival_key) continue;
      const purchaseOrderRef=arrival.orders.filter((/** @type {Row} */ order)=>order.arrived).map((/** @type {Row} */ order)=>order.reference).join(', ');
      requests.push({id:Number(row.id),requestRef:row.request_ref,eventId:1,action:'arrival',arrivalKey:arrival.key,
        purchaseOrderRef,message:`Stock arrived · ${purchaseOrderRef} fully received${arrival.salesOrderRef?' · SO: '+arrival.salesOrderRef:''}`});
    }
    after=Number(rows[rows.length-1].id);
  }
  return requests;
}
