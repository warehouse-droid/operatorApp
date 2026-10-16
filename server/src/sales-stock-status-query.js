import {query} from './db.js';
import {stockRequestBucket} from './stock-request-domain.js';
import {stockingDisplayStatus} from './regular-stock-reply-domain.js';
import {matchesSalesStockStatus} from '../public/sales-stock-status-filter.js';
import {conversationQueueActivitySql} from './stock-request-conversation-queue.js';

/** Read small status summaries before the page limit; hydrate only matching requests.
 * @param {{clauses:string[],params:any[],status:string,limit:number,offset:number}} options */
export async function salesStockRowsByStatus({clauses, params, status, limit, offset}) {
  const selected = [], batchSize = 250, at = Date.now();
  let scanned = 0, matched = 0;
  const scope = [...clauses], values = [...params];
  const backorderStatus = ['new_enquiry', 'pending_update', 'await_customer_confirmation', 'confirmed',
    'dispatch_arrangement', 'wait_for_production', 'closed', 'completed'].includes(status);
  const supply = status.startsWith('supply:');
  if (supply) {
    values.push(status.slice(7));
    scope.push(`request.regular_details->>'deliveryMethod'='backorder' AND EXISTS (
      SELECT 1 FROM sales_special_stock_lines line WHERE line.request_id=request.id AND line.supply_status=$${values.length})`);
  } else if (!backorderStatus) scope.push("COALESCE(request.regular_details->>'deliveryMethod','')<>'backorder'");
  while (selected.length < limit) {
    const rows = (await query(`SELECT request.*, ${conversationQueueActivitySql},
      ${backorderStatus ? 'stage.stage' : 'NULL::text'} AS filter_stage,
      CASE WHEN request.regular_details->>'deliveryMethod'='backorder' THEN
        (SELECT COALESCE(jsonb_agg(jsonb_build_object('supplyStatus',line.supply_status)),'[]'::jsonb)
          FROM sales_special_stock_lines line WHERE line.request_id=request.id)
      ELSE (SELECT COALESCE(jsonb_agg(jsonb_build_object('status',line.status,
        'replyStatus',CASE WHEN line.status NOT IN ('closed','rejected','cancelled','received','fulfilled')
          THEN request.regular_details->'stockingLines'->line.id::text->>'replyStatus' END,
        'resolution',COALESCE(NULLIF(request.regular_details->'stockingLines'->line.id::text->'resolution','null'::jsonb),
          CASE WHEN line.status='closed' THEN request.regular_details->'resolution' END),
        'purchase',jsonb_build_object('demandId',EXISTS(SELECT 1 FROM regular_stock_purchase_demands demand WHERE demand.request_line_id=line.id))
      )),'[]'::jsonb) FROM sales_stock_request_lines line WHERE line.request_id=request.id) END AS filter_lines
      FROM sales_stock_requests request
      ${backorderStatus ? 'LEFT JOIN special_stock_workflow_stages stage ON stage.request_id=request.id' : ''}
      WHERE ${scope.join(' AND ')}
      ORDER BY conversation_event_id DESC, EXISTS(SELECT 1 FROM sales_stock_request_lines priority_line WHERE priority_line.request_id=request.id AND priority_line.status='changes_requested') DESC,
        request.updated_at DESC,request.id DESC
      LIMIT $${values.length+1} OFFSET $${values.length+2}`, [...values, batchSize, scanned])).rows;
    for (const row of rows) {
      const summary = {requestType:row.request_type, workflowVersion:Number(row.workflow_version),
        status:row.status, regular:row.regular_details || {}, lines:row.filter_lines || [], bucket:'', displayStatus:''};
      summary.bucket = stockRequestBucket(summary);
      summary.displayStatus = summary.regular.deliveryMethod === 'backorder' ? row.filter_stage : stockingDisplayStatus(summary);
      if (!matchesSalesStockStatus(summary, status, at)) continue;
      if (matched++ < offset) continue;
      selected.push(row);
      if (selected.length === limit) break;
    }
    if (rows.length < batchSize) break;
    scanned += rows.length;
  }
  return selected;
}
