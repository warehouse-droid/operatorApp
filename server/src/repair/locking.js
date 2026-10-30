// Fleet changes keep their shared lock. Local stock/PO writes serialize only
// the affected repair requests and their existing purchase/stock row locks.
export const localPartsCommand=kind=>/^(?:issue_purchase_order|receive_purchase|request_parts|approve_parts|use_part|edit_part_usage|po_eta|po_invoice|complete_purchase|adjust_stock)(?::|$)/u.test(kind)||kind==='purchase';
export async function lockRepairScope(query,values){
 const ids=[...new Set(values.filter(value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)))];if(!ids.length)return;
 const rows=(await query(`SELECT id FROM repair_requests WHERE id=ANY($1::uuid[])
  UNION SELECT request_id FROM repair_jobs WHERE id=ANY($1::uuid[])
  UNION SELECT request_id FROM repair_part_requests WHERE id=ANY($1::uuid[])
  UNION SELECT request_id FROM repair_purchase_lines WHERE purchase_id=ANY($1::uuid[]) OR id=ANY($1::uuid[])
  UNION SELECT request_id FROM repair_issues WHERE id=ANY($1::uuid[])`,[ids])).rows;
 for(const id of rows.map(row=>row.id).filter(Boolean).sort())await query('SELECT pg_advisory_xact_lock(hashtext($1))',[`repair-request:${id}`]);
}
export function commandScope(kind,input){return [...kind.split(':'),input.jobId,input.requestId,input.purchaseId,...(Array.isArray(input.lines)?input.lines.flatMap(line=>[line.jobId,line.requestId,line.partRequestId]):[])];}
