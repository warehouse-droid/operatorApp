// @ts-check
import { pool, query, withTransaction } from './db.js';
import { writeAudit } from './auth-repository.js';
import { locallyReopenedSalesOrderSql } from './local-sales-order-reopen.js';
import { enqueueNetSuiteMirrorOrderEvent } from './netsuite-mirror-repository.js';
import { STOCK_REQUEST_SO_REFRESH_INTERVAL_MS } from './stock-request-so-refresh-domain.js';
/** @typedef {{requestId:number,revision:number,kind:string,method:string}} Link */
/** @typedef {{id:number,ref:string,syncedAt:string|null,links:Link[]}} Candidate */
/** @typedef {ReturnType<typeof import('./stock-request-so-refresh-domain.js').stockRequestSalesOrderObservation>} Observation */
const lockKey = 'stock-request-so-hourly-refresh';
const startedAction = 'stock_request.so_refresh.started';

/** No transaction/row locks span the remote reads. The dedicated session lock
 * prevents overlapping workers; the indexed audit timestamp survives restarts.
 * @param {Date} now @param {(check:()=>Promise<void>)=>Promise<any>} run */
export async function withStockRequestRefreshSlot(now, run) {
  const client = await pool.connect();
  let acquired = false, lost = false;
  const onError = () => { lost = true; };
  client.on('error',onError);
  try {
    acquired = (await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired',[lockKey])).rows[0].acquired;
    if (!acquired) return {started:false,reason:'already_running'};
    const recent = (await client.query('SELECT created_at FROM delivery_audit_log WHERE action=$1 ORDER BY created_at DESC LIMIT 1',[startedAction])).rows[0];
    if (recent && +now - +new Date(recent.created_at) < STOCK_REQUEST_SO_REFRESH_INTERVAL_MS) return {started:false,reason:'not_due'};
    await client.query(`INSERT INTO delivery_audit_log(actor_type,source,action,details,created_at)
      VALUES('system','stock-request',$1,'{"intervalMinutes":60}',$2)`,[startedAction,now]);
    return await run(async()=>{
      if (lost) throw Error('Hourly SO refresh lock connection lost.');
      await client.query('SELECT 1');
    });
  } finally {
    if (acquired && !lost) await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[lockKey]).catch(()=>{lost=true;});
    client.removeListener('error',onError);client.release(lost);
  }
}

/** @param {{orderId?:number|null,limit?:number}} [options] @returns {Promise<Candidate[]>} */
export async function listStockRequestSalesOrders({orderId=null,limit=200}={}) {
  const rows = (await query(`WITH linked AS (
    SELECT r.id,r.revision,c.workflow_kind AS kind,c.fulfillment_method AS method,
      c.sales_order_netsuite_id AS order_id,c.sales_order_ref AS order_ref,r.regular_details
    FROM sales_stock_requests r JOIN sales_special_stock_cases c ON c.request_id=r.id
    LEFT JOIN special_stock_completion_evidence completion ON completion.request_id=r.id
    WHERE r.status<>'cancelled' AND c.close_status='active' AND c.fulfillment_method IN ('yard_pickup','vendor_pickup')
      AND NOT c.sales_order_skipped AND completion.completed IS DISTINCT FROM true
    UNION ALL
    SELECT r.id,r.revision,'regular',r.regular_details->>'deliveryMethod',h.sales_order_id,h.sales_order_ref,r.regular_details
    FROM sales_stock_requests r JOIN regular_stock_handoffs h ON h.request_id=r.id
    WHERE r.request_type='regular' AND r.status<>'cancelled' AND r.regular_details->>'deliveryMethod'='pickup'
      AND h.status='complete' AND r.regular_details->>'salesOrderId'=h.sales_order_id::text
      AND r.regular_details->>'salesOrderRef'=h.sales_order_ref
    UNION ALL
    SELECT r.id,r.revision,'backorder_reference',c.fulfillment_method,optional_so.netsuite_id,optional_so.tranid,r.regular_details
    FROM sales_stock_requests r JOIN sales_special_stock_cases c ON c.request_id=r.id
    JOIN sales_orders optional_so ON upper(btrim(optional_so.tranid))=upper(btrim(r.regular_details->>'alreadyOrderedSalesOrderRef'))
    WHERE c.workflow_kind='backorder' AND c.sales_order_netsuite_id IS NULL AND c.close_status='active' AND r.status<>'cancelled'
      AND c.fulfillment_method IN ('yard_pickup','vendor_pickup')
      AND (SELECT count(*) FROM sales_orders same_ref WHERE upper(btrim(same_ref.tranid))=upper(btrim(optional_so.tranid)))=1
  ) SELECT s.netsuite_id,s.tranid,s.synced_at::text,
      jsonb_agg(jsonb_build_object('requestId',linked.id,'revision',linked.revision,'kind',linked.kind,'method',linked.method) ORDER BY linked.id) AS links,
      (SELECT max(a.created_at) FROM delivery_audit_log a WHERE a.order_id=s.netsuite_id
        AND a.action IN ('stock_request.so_refresh.observed','stock_request.so_refresh.failed','stock_request.so_refresh.stale')) AS attempted_at
    FROM linked JOIN sales_orders s ON s.netsuite_id=linked.order_id AND s.tranid=linked.order_ref
    WHERE s.netsuite_id>0 AND s.netsuite_active IS DISTINCT FROM false AND NOT COALESCE(s.is_test_fixture,false)
      AND NOT ${locallyReopenedSalesOrderSql('s')}
      AND (linked.regular_details->'salesOrderProgress'->>'terminal' IS DISTINCT FROM 'true'
        OR linked.regular_details->'salesOrderProgress'->>'id' IS DISTINCT FROM s.netsuite_id::text)
      AND ($1::bigint IS NULL OR s.netsuite_id=$1)
    GROUP BY s.netsuite_id,s.tranid,s.synced_at
    ORDER BY attempted_at ASC NULLS FIRST,s.netsuite_id LIMIT $2`,[orderId,Math.max(1,Math.min(200,Number(limit)||200))])).rows;
  return rows.map((/** @type {Record<string,any>} */ row)=>({id:Number(row.netsuite_id),ref:row.tranid,syncedAt:row.synced_at,links:row.links}));
}

/** Whether the observation changes anything a person viewing or editing the request relies on.
 * SPREQ-000187: an hourly check that found the SO exactly as linked still bumped the revision,
 * so SCM's PO creation in progress failed with "This Special Item case changed".
 * @param {Link} link @param {Observation} progress @param {Record<string,any>} saved */
function materialSalesOrderChange(link, progress, saved) {
  const previous = saved.progress;
  if (previous) return ['status', 'fulfillmentStatus', 'completed', 'terminal'].some(key => previous[key] !== progress[key]);
  const caseApproval = link.kind !== 'regular' && link.kind !== 'backorder_reference'
    && saved.sales_order_approved !== !['A', 'C', 'H'].includes(progress.status);
  return progress.completed || progress.terminal || progress.fulfillmentStatus !== 'not_fulfilled' || caseApproval;
}

/** @param {Link} link @param {Observation & {checkedAt:string}} progress */
async function reconcileRequest(link, progress) {
  const saved = (await query(`SELECT request.regular_details->'salesOrderProgress' AS progress, special.sales_order_approved
      FROM sales_stock_requests request LEFT JOIN sales_special_stock_cases special ON special.request_id=request.id
     WHERE request.id=$1`, [link.requestId])).rows[0] || {};
  if (!materialSalesOrderChange(link, progress, saved)) {
    // Record the check without a new revision or audit entry, so open forms stay valid.
    if (link.kind !== 'regular' && link.kind !== 'backorder_reference') {
      await query('UPDATE sales_special_stock_cases SET sales_order_status=$2 WHERE request_id=$1', [link.requestId, progress.statusText]);
    }
    await query(`UPDATE sales_stock_requests SET regular_details=jsonb_set(regular_details,'{salesOrderProgress}',$2::jsonb) WHERE id=$1`,
      [link.requestId, JSON.stringify(progress)]);
    return;
  }
  if (link.kind === 'regular' && progress.completed) {
    await query(`UPDATE sales_stock_request_lines SET status='fulfilled',updated_at=now()
      WHERE request_id=$1 AND status NOT IN ('rejected','cancelled','closed','fulfilled','received')`,[link.requestId]);
  }
  if (link.kind !== 'regular') {
    if (link.kind !== 'backorder_reference') {
      await query(`UPDATE sales_special_stock_cases SET sales_order_status=$2,sales_order_approved=$3,updated_at=now() WHERE request_id=$1`,
        [link.requestId,progress.statusText,!['A','C','H'].includes(progress.status)]);
    }
    await query(`INSERT INTO sales_special_stock_events(request_id,event_type,details)
      VALUES($1,'special_sales_order_status_reconciled',$2::jsonb)`,[link.requestId,JSON.stringify({source:'hourly-so-refresh',...progress})]);
  }
  await query(`UPDATE sales_stock_requests SET regular_details=jsonb_set(regular_details,'{salesOrderProgress}',$2::jsonb),
    status=CASE WHEN $3 THEN 'completed' ELSE status END,revision=revision+1,updated_at=now() WHERE id=$1`,
    [link.requestId,JSON.stringify(progress),link.kind==='regular' && progress.completed]);
  await query(`INSERT INTO sales_stock_request_events(request_id,event_type,details)
    VALUES($1,'linked_so_status_refreshed',$2::jsonb)`,[link.requestId,JSON.stringify(progress)]);
}

/** A truncated read must never turn one fulfilled line into a completed SO.
 * Validate against the current canonical identities without overwriting them.
 * @param {number} id @param {Observation} observation */
async function requireMatchingLines(id, observation) {
  const local=(await query(`SELECT line_id,item_id,quantity FROM sales_order_lines
    WHERE sales_order_id=$1 AND netsuite_active IS DISTINCT FROM false ORDER BY line_id FOR SHARE`,[id])).rows;
  const remote=new Map(observation.lines.map(line=>[String(line.lineId),line]));
  if (!local.length || local.length!==remote.size || local.some((/** @type {Record<string,any>} */ line)=>{
    const other=remote.get(String(line.line_id));
    return !other || Number(line.item_id)!==other.itemId || line.quantity===null || line.quantity===undefined || !Number.isFinite(Number(line.quantity))
      || Math.abs(Math.abs(Number(line.quantity))-other.quantity)>0.000001;
  })) throw Error('SO line snapshot is incomplete or does not match the current canonical lines.');
}

/** Fence remote reads against both canonical sync and the request/link snapshot.
 * Canonical lines, commercial values, local packing and NetSuite stay untouched.
 * @param {Candidate} candidate @param {Observation} observation */
export async function applyStockRequestSalesOrderObservation(candidate, observation) {
  if (candidate.id!==observation.id || candidate.ref!==observation.ref) throw Error('SO observation does not match its candidate.');
  return withTransaction(async()=>{
    const ids=candidate.links.map(link=>link.requestId);
    await query('SELECT id FROM sales_stock_requests WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE',[ids]);
    await query('SELECT request_id FROM sales_special_stock_cases WHERE request_id=ANY($1::bigint[]) ORDER BY request_id FOR UPDATE',[ids]);
    await query('SELECT request_id FROM regular_stock_handoffs WHERE request_id=ANY($1::bigint[]) ORDER BY request_id FOR UPDATE',[ids]);
    await query('SELECT netsuite_id FROM sales_orders WHERE netsuite_id=$1 FOR UPDATE',[candidate.id]);
    const current=(await listStockRequestSalesOrders({orderId:candidate.id}))[0];
    if (!current || current.syncedAt!==candidate.syncedAt || JSON.stringify(current.links)!==JSON.stringify(candidate.links)) return {updated:false,requestIds:[]};
    await requireMatchingLines(candidate.id,observation);
    const progress={...observation,checkedAt:new Date().toISOString()};
    await query(`UPDATE sales_orders SET status=$2,status_text=$3,fulfillment_status=$4,
      fulfilled_at=CASE WHEN $5 THEN COALESCE(fulfilled_at,now()) ELSE fulfilled_at END,
      status_updated_at=CASE WHEN status IS DISTINCT FROM $2 OR status_text IS DISTINCT FROM $3 OR fulfillment_status IS DISTINCT FROM $4 THEN now() ELSE status_updated_at END,
      synced_at=now() WHERE netsuite_id=$1`,[candidate.id,progress.status,progress.statusText,progress.fulfillmentStatus,progress.completed]);
    for (const link of candidate.links) await reconcileRequest(link,progress);
    await enqueueNetSuiteMirrorOrderEvent('sales_order',candidate.id,{changeType:'status'});
    await writeAudit({actorType:'system',source:'stock-request',action:'stock_request.so_refresh.observed',orderId:candidate.id,
      details:{...progress,requestIds:ids}});
    return {updated:true,requestIds:ids,completed:progress.completed};
  });
}
