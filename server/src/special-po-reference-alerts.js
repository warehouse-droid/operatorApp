import { createHash } from 'node:crypto';
import { query, withTransaction } from './db.js';
import { specialPurchaseOrderDisplayRef, poReferenceAlertAudience } from '../public/special-stock-po-reference.js';

/** @param {string} message @param {number} status */
const error = (message,status) => Object.assign(Error(message), { status, code:'SPECIAL_PO_REFERENCE_ALERT' });

/** @param {{audience?:string,operatorId?:string,authorizedStoreLocationIds?:number[]}} context
 * @param {number|null} [requestId] @param {boolean} [lock] */
async function readAlerts(context, requestId=null, lock=false) {
  const { audience, operatorId, authorizedStoreLocationIds=[] } = context;
  if (!operatorId || !['sales','dispatch'].includes(audience || '')) throw error('A private alert recipient is required.',400);
  // Read canonical committed references: every SCM editor uses this same PO
  // column, including schedule saves and the special-request mini bar.
  const { rows } = await query(`SELECT request.id, request.request_ref, special.fulfillment_method,
      po.netsuite_id, po.tranid, po.dispatch_ref,
      COALESCE(to_char(po.dispatch_ref_updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'') AS reference_updated_at
    FROM sales_stock_requests request
    JOIN sales_special_stock_cases special ON special.request_id=request.id
    JOIN purchase_orders po ON po.netsuite_id=special.purchase_order_netsuite_id
    JOIN special_stock_workflow_stages workflow ON workflow.request_id=request.id
    WHERE special.close_status='active' AND request.status<>'cancelled'
      AND workflow.stage NOT IN ('closed','completed') AND NOT special.purchase_order_skipped
      AND btrim(COALESCE(po.dispatch_ref,''))<>''
      AND NOT EXISTS (SELECT 1 FROM dispatch_scm_po_splits split WHERE split.split_po_id=po.netsuite_id)
      AND ($1::bigint IS NULL OR request.id=$1)
      AND (($2='sales' AND special.fulfillment_method='vendor_pickup' AND request.requested_by=$3
        AND request.destination_location_id=ANY($4::bigint[]))
        OR ($2='dispatch' AND special.fulfillment_method IN ('yard_pickup','mbt_delivery')))
    ORDER BY po.dispatch_ref_updated_at DESC NULLS LAST, request.id DESC
    ${lock ? 'FOR SHARE OF request, special, po' : ''}`,
  [requestId,audience,operatorId,authorizedStoreLocationIds]);
  return rows.map(/** @param {any} row */ row => ({ requestId:Number(row.id), requestRef:row.request_ref,
    audience:poReferenceAlertAudience(row.fulfillment_method), fulfillmentMethod:row.fulfillment_method,
    displayRef:specialPurchaseOrderDisplayRef({purchaseOrderRef:row.tranid,purchaseOrderReference:row.dispatch_ref}),
    noticeKey:createHash('sha256').update(JSON.stringify([row.id,row.netsuite_id,row.tranid,row.dispatch_ref,row.reference_updated_at,row.fulfillment_method])).digest('hex') }));
}

/** @param {{audience?:string,operatorId?:string,authorizedStoreLocationIds?:number[]}} context */
export async function listSpecialPoReferenceAlerts(context={}) {
  const alerts=await readAlerts(context);
  const { rows }=await query('SELECT request_id, notice_key FROM special_po_reference_alert_receipts WHERE operator_id=$1 AND audience=$2',
    [context.operatorId,context.audience]);
  const receipts=new Map(rows.map(/** @param {any} row */ row=>[Number(row.request_id),row.notice_key]));
  return { alerts:alerts.filter(/** @param {{requestId:number,noticeKey:string}} alert */ alert=>receipts.get(alert.requestId)!==alert.noticeKey) };
}

/** @param {unknown} requestId @param {{noticeKey?:unknown}} input
 * @param {{audience?:string,operatorId?:string,authorizedStoreLocationIds?:number[]}} context */
export async function acknowledgeSpecialPoReferenceAlert(requestId,input={},context={}) {
  const id=Number(requestId);
  if (!Number.isSafeInteger(id) || id<=0 || typeof input.noticeKey!=='string' || !/^[a-f0-9]{64}$/.test(input.noticeKey)) {
    throw error('A valid request and PO reference notice are required.',400);
  }
  return withTransaction(async()=>{
    const [current]=await readAlerts(context,id,true);
    if (!current) throw error('This PO reference notice is unavailable.',404);
    if (current.noticeKey!==input.noticeKey) throw error('Reference changed. Refresh and review the latest reference.',409);
    await query(`INSERT INTO special_po_reference_alert_receipts(operator_id,audience,request_id,notice_key)
      VALUES($1,$2,$3,$4) ON CONFLICT(operator_id,audience,request_id)
      DO UPDATE SET notice_key=EXCLUDED.notice_key, acknowledged_at=now()`,
    [context.operatorId,context.audience,id,current.noticeKey]);
    return { acknowledged:true };
  });
}
