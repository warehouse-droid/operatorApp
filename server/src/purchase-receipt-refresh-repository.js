// @ts-check
import {query,withTransaction} from './db.js';
import {enqueueDelayedStatusRefresh} from './netsuite-delayed-status-refresh-repository.js';
import {upsertPurchaseOrderLines,markMissingInboundOrderLines} from './order-sync-repository.js';
import {purchaseOrderArrived} from './backorder-arrival-status.js';

// A split is an application alias. NetSuite receipt quantities live on its source.
/** @param {unknown} orderId @param {{availableAt?:Date,rerunIfRunning?:boolean}} [options] */
export async function enqueuePurchaseReceiptRefresh(orderId,{availableAt=new Date(Date.now()+10_000),rerunIfRunning=true}={}) {
  const id=Number(orderId);
  if(!Number.isSafeInteger(id) || !id) return null;
  const result=await query(`WITH RECURSIVE family(id,path) AS (
      SELECT $1::bigint,ARRAY[$1::bigint]
      UNION ALL
      SELECT split.source_po_id,family.path||split.source_po_id
        FROM family JOIN dispatch_scm_po_splits split ON split.split_po_id=family.id
       WHERE NOT split.source_po_id=ANY(family.path) AND cardinality(family.path)<16
    )
    SELECT DISTINCT po.netsuite_id,po.tranid FROM family
      JOIN purchase_orders po ON po.netsuite_id=family.id
     WHERE po.netsuite_id>0 AND NOT EXISTS (
       SELECT 1 FROM dispatch_scm_po_splits parent WHERE parent.split_po_id=family.id
     )`,[id]);
  // Ambiguous/cyclic identities are never guessed.
  if(result.rows.length!==1) return null;
  const source=result.rows[0];
  return enqueueDelayedStatusRefresh({orderType:'purchase_order',netsuiteOrderId:Number(source.netsuite_id),
    tranid:source.tranid,availableAt,rerunIfRunning});
}

/** @param {Record<string,any>} [stored] */
export async function enqueuePurchaseReceiptWebhook(stored={}) {
  if(!stored.ok || stored.ignored || stored.stale || stored.sourceOrderKind!=='PO') return null;
  return enqueuePurchaseReceiptRefresh(stored.sourceOrderId);
}

/** @param {{netsuiteOrderId:number,lines:Record<string,any>[]}} input */
export async function applyPurchaseReceiptProgress({netsuiteOrderId,lines}) {
  if(!Array.isArray(lines) || !lines.length) return null;
  return withTransaction(async()=>{
    await upsertPurchaseOrderLines(netsuiteOrderId,lines);
    await markMissingInboundOrderLines(netsuiteOrderId,lines.map(line=>Number(line.line_id)));
    const material=lines.filter(line=>['InvtPart','NonInvtPart'].includes(line.item_type) && Number(line.quantity)>0);
    const arrived=purchaseOrderArrived({netsuite_active:true,status_text:''},material);
    const status=arrived?'received':material.some(line=>Number(line.netsuite_received_qty)>0)?'partial_received':'not_received';
    // Local receipt records remain independent evidence until their IR is posted.
    await query(`WITH local AS (SELECT EXISTS(SELECT 1 FROM receiving_receipt_records
        WHERE order_id=$1 AND receipt_status IN ('received','partial_received')) AS received)
      UPDATE purchase_orders SET
        receipt_status=CASE WHEN $2='received' THEN $2 WHEN local.received THEN receipt_status ELSE $2 END,
        received_at=CASE WHEN $2='received' THEN COALESCE(received_at,now())
          WHEN local.received THEN received_at ELSE NULL END
      FROM local WHERE netsuite_id=$1`,[netsuiteOrderId,status]);
    return {receiptStatus:status,lines:lines.length};
  });
}

export async function queueStalePurchaseReceiptRefreshes({now=new Date(),limit=10}={}) {
  const boundedLimit=Math.max(1,Math.min(10,Math.trunc(Number(limit)||10)));
  return withTransaction(async()=>{
    // Multiple app processes share one bounded catch-up selection.
    await query("SELECT pg_advisory_xact_lock(hashtextextended('purchase-receipt-catchup',0))");
    const rows=await query(`WITH links AS (
        SELECT c.purchase_order_netsuite_id AS id,c.purchase_order_ref AS ref
          FROM sales_special_stock_cases c JOIN sales_stock_requests r ON r.id=c.request_id
         WHERE c.close_status='active' AND r.status<>'cancelled'
        UNION
        SELECT NULL,l.backorder_po_number FROM sales_special_stock_lines l
          JOIN sales_special_stock_cases c ON c.request_id=l.request_id
          JOIN sales_stock_requests r ON r.id=c.request_id
         WHERE c.close_status='active' AND r.status<>'cancelled' AND l.removed_at IS NULL
           AND l.supply_status='already_ordered'
        UNION
        SELECT p.netsuite_purchase_order_id,NULL FROM scm_smart_proposals p
          JOIN scm_smart_proposal_lines l ON l.proposal_id=p.id
         WHERE p.status NOT IN ('superseded','cancelled') AND l.reason ? 'purchaseDemandIds'
      ), linked AS (
        SELECT DISTINCT COALESCE(split.source_po_id,po.netsuite_id) AS id
          FROM links JOIN purchase_orders po ON po.netsuite_id=links.id OR upper(btrim(po.tranid))=upper(btrim(links.ref))
          LEFT JOIN dispatch_scm_po_splits split ON split.split_po_id=po.netsuite_id
      )
      SELECT po.netsuite_id,po.synced_at FROM linked JOIN purchase_orders po ON po.netsuite_id=linked.id
       WHERE po.netsuite_id>0 AND po.netsuite_active=true
         AND NOT EXISTS(SELECT 1 FROM netsuite_delayed_status_refresh_jobs job
           WHERE job.order_type='purchase_order' AND job.netsuite_order_id=po.netsuite_id
             AND (job.status IN ('pending','running','retry') OR job.created_at>$1::timestamptz-interval '6 hours'))
         AND (po.synced_at<$1::timestamptz-interval '6 hours' OR NOT EXISTS (
           SELECT 1 FROM purchase_order_lines l WHERE l.purchase_order_id=po.netsuite_id
             AND l.netsuite_active AND l.synced_at>$1::timestamptz-interval '6 hours'))
       ORDER BY po.synced_at NULLS FIRST,po.netsuite_id LIMIT $2`,[now,boundedLimit]);
    const queued=[];
    for(const row of rows.rows) {
      const job=await enqueuePurchaseReceiptRefresh(row.netsuite_id,{availableAt:now,rerunIfRunning:false});
      if(job) queued.push(job);
    }
    return queued;
  });
}
