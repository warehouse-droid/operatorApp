import {query,closeDb} from './src/db.js';
import {fetchTransactionStatusesFromNetSuite,suiteqlAll} from './src/netsuite.js';
const positive=value=>Number.isSafeInteger(Number(value))&&Number(value)>0;
const complete=header=>header&&['C','F','G','H'].includes(String(header.status).split(':').at(-1));
try {
 const candidates=(await query(`SELECT c.id,c.completion_event_id,c.dispatch_order_ref,c.status,c.gate_key,c.external_id,
    e.dispatch_completed_at,e.completion_evidence_type,e.completion_evidence_id,
    so.netsuite_id AS local_order_id,so.tranid AS local_order_ref,
    COALESCE(split.source_so_id,so.netsuite_id) AS source_order_id,
    COALESCE(split.source_so_ref,so.tranid) AS source_order_ref
   FROM dispatch_sales_order_if_candidates c
   LEFT JOIN dispatch_effective_order_completion_events e ON e.id=c.completion_event_id
   LEFT JOIN sales_orders so ON lower(btrim(so.tranid))=lower(btrim(c.dispatch_order_ref))
   LEFT JOIN dispatch_scm_so_splits split ON split.split_so_id=so.netsuite_id AND split.status='active'
   WHERE c.status='gate_disabled' ORDER BY c.created_at,c.id`)).rows;
 const directEvents=(await query(`SELECT e.*,po.netsuite_id AS local_order_id,po.tranid AS local_order_ref,
    COALESCE(split.source_po_id,po.netsuite_id) AS source_order_id,
    COALESCE(split.source_po_ref,po.tranid) AS source_order_ref
   FROM dispatch_effective_order_completion_events e
   JOIN purchase_orders po ON po.netsuite_id=(e.metadata->>'poOrderId')::bigint
   LEFT JOIN dispatch_scm_po_splits split ON split.split_po_id=po.netsuite_id AND split.status='active'
   WHERE e.order_kind='PO' AND e.metadata->>'directPoLink'='true'
     AND e.metadata->>'directShipCoverageVerified'='true' ORDER BY e.id`)).rows;
 const report={readOnly:true,checkedAt:new Date().toISOString(),candidates,directEvents};
 for(const [rows,type] of [[candidates,'SalesOrd'],[directEvents,'PurchOrd']]){
  const ids=[...new Set(rows.map(row=>Number(row.source_order_id)).filter(positive))];
  const headers=ids.length?await fetchTransactionStatusesFromNetSuite(ids,type):[];
  const byId=new Map(headers.map(header=>[Number(header.id),header]));
  const openIds=ids.filter(id=>byId.has(id)&&!complete(byId.get(id)));
  const lines=[];
  for(let offset=0;offset<openIds.length;offset+=100){
   lines.push(...await suiteqlAll(`SELECT tl.transaction AS order_id,tl.uniquekey AS source_line_key,tl.id AS rest_order_line,
       tl.item AS item_id,BUILTIN.DF(tl.item) AS item_name,i.itemtype AS item_type,i.isfulfillable AS is_fulfillable,
       ABS(NVL(tl.quantity,0)) AS quantity,ABS(NVL(tl.quantityshiprecv,0)) AS completed_quantity,
       tl.isclosed AS line_closed,tl.location AS location_id
      FROM transactionline tl LEFT JOIN item i ON i.id=tl.item
      WHERE tl.transaction IN (${openIds.slice(offset,offset+100).join(',')})
        AND tl.mainline='F' AND (tl.taxline='F' OR tl.taxline IS NULL) AND tl.item IS NOT NULL`));
  }
  for(const row of rows){
   row.liveHeader=byId.get(Number(row.source_order_id))||null;
   row.liveLines=lines.filter(line=>Number(line.order_id)===Number(row.source_order_id));
   row.disposition=!row.dispatch_completed_at?'local_completion_no_longer_effective':!positive(row.source_order_id)?'parent_mapping_unavailable'
     :!row.liveHeader?'live_order_unavailable':complete(row.liveHeader)?'live_order_complete_skip':'open_check_lines_before_post';
  }
 }
 const counts={};for(const row of candidates){counts[row.disposition]=(counts[row.disposition]||0)+1;}
 report.summary={candidateCount:candidates.length,directEventCount:directEvents.length,dispositions:counts};
 console.log(JSON.stringify(report));
} finally {await closeDb();}
