import {query,closeDb} from '../../src/db.js';
import {listOperatorNetSuitePostingAttentionCommands} from '../../src/operator-netsuite-posting-repository.js';
import {listSalesOrderAutoFulfillmentCandidates} from '../../src/sales-order-auto-fulfillment-repository.js';
try {
 const native=await listOperatorNetSuitePostingAttentionCommands({limit:500});
 const sales=await listSalesOrderAutoFulfillmentCandidates({statuses:['waiting_evidence','attention','uncertain','failed','historical','gate_disabled'],limit:500});
 const refs=sales.map(c=>c.dispatchOrderRef);
 const orders=(await query(`SELECT o.netsuite_id,o.tranid,o.status,o.status_text,o.sales_order_type,o.outbound_location_id,
   o.operator_status,o.local_yard_order_status,o.fulfillment_status,
   (SELECT jsonb_agg(jsonb_build_object('id',l.id,'lineId',l.line_id,'orderLine',l.netsuite_order_line,'itemId',l.item_id,'itemType',l.item_type,
    'quantity',l.quantity,'loaded',l.loaded_qty,'unit',l.unit,'location',l.location_id,'active',l.netsuite_active)) FROM sales_order_lines l WHERE l.sales_order_id=o.netsuite_id) AS lines,
   (SELECT jsonb_agg(jsonb_build_object('id',r.id,'createdAt',r.created_at,'lines',r.line_snapshot)) FROM operator_load_records r WHERE r.order_id=o.netsuite_id) AS loads
   FROM sales_orders o WHERE lower(o.tranid)=ANY($1::text[])`,[refs.map(r=>r.toLowerCase())])).rows;
 const events=(await query(`SELECT c.id,c.completion_event_id,e.order_ref,e.completion_evidence_type,e.plan_id,e.load_id,e.plan_date,
   e.dispatch_completed_at,(effective.id IS NOT NULL) AS effective
   FROM dispatch_sales_order_if_candidates c LEFT JOIN dispatch_order_completion_events e ON e.id=c.completion_event_id
   LEFT JOIN dispatch_effective_order_completion_events effective ON effective.id=e.id
   WHERE c.id=ANY($1::uuid[])`,[sales.map(c=>c.id)])).rows;
 console.log(JSON.stringify({at:new Date().toISOString(),native,sales,orders,events},null,2));
}finally{await closeDb();}
