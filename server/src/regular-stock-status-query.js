import {query,withTransaction,hasActiveTransaction} from './db.js';
import {conversationQueueActivitySql} from './stock-request-conversation-queue.js';
import {regularStockStatusSummary,matchesRegularStatusSummary} from '../public/regular-stock-status.js';
import {matchesSalesStockStatus} from '../public/sales-stock-status-filter.js';

/** Filter complete workflow evidence before applying the requested page. The
 * snapshot and clock are shared by the filter and the returned status summaries.
 * @param {{clauses:string[],params:any[],filters:ReturnType<typeof import('../public/regular-stock-status.js').parseRegularStatusFilters>,limit:number,offset:number,hydrate:(rows:any[])=>Promise<any[]>,legacyStatus?:string}} options */
export async function regularStockRowsBySummary({clauses,params,filters,limit,offset,hydrate,legacyStatus=''}) {
  const ownTransaction = !hasActiveTransaction();
  return withTransaction(async()=>{
    if (ownTransaction) await query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const selected = [], at = Date.now(), batchSize = 100;
    let scanned = 0, matched = 0;
    while (selected.length < limit) {
      const rows = (await query(`SELECT request.id,request.regular_details,${conversationQueueActivitySql}
        FROM sales_stock_requests request WHERE ${clauses.join(' AND ')}
        ORDER BY conversation_event_id DESC, request.updated_at DESC,request.id DESC
        LIMIT $${params.length+1} OFFSET $${params.length+2}`,[...params,batchSize,scanned])).rows;
      const details = await hydrate(rows);
      for (const detail of details) {
        detail.statusSummary = regularStockStatusSummary(detail,at);
        if (!matchesRegularStatusSummary(detail.statusSummary,filters) || legacyStatus && !matchesSalesStockStatus(detail,legacyStatus,at)) continue;
        if (matched++ < offset) continue;
        selected.push(detail);
        if (selected.length === limit) break;
      }
      if (rows.length < batchSize) break;
      scanned += rows.length;
    }
    return selected;
  });
}
