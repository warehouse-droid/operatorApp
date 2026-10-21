import { query, closeDb } from '/app/src/db.js';
try {
  const items = (await query(`SELECT item_id,item_name,product_type,return_policy_override
    FROM inventory_items WHERE item_name ILIKE '%aggregate%' ORDER BY item_id`)).rows;
  const ids = items.map(item => item.item_id);
  const planning = (await query(`SELECT item_id,item_name,stock_unit,planning_enabled,inactive
    FROM scm_smart_item_policies WHERE item_id=ANY($1::bigint[]) ORDER BY item_id`, [ids])).rows;
  const salesFacts = (await query(`SELECT source,count(*)::int AS rows,min(transaction_date),max(transaction_date)
    FROM scm_smart_sales_facts WHERE item_id=ANY($1::bigint[]) GROUP BY source`, [ids])).rows;
  const webhookWeights = (await query(`SELECT w.id,w.received_at,w.payload->>'tranid' AS order_ref,
    line->>'itemId' AS item_id,line->>'unit' AS unit,line->>'quantity' AS quantity,line->>'itemWeight' AS item_weight
    FROM netsuite_order_webhook_inbox w CROSS JOIN LATERAL jsonb_array_elements(w.payload->'lines') AS line
    WHERE w.received_at>='2026-10-07' AND line->>'itemId'=ANY($1::text[])
    ORDER BY w.id DESC LIMIT 10`, [ids.map(String)])).rows;
  const aggregateRequests = (await query(`SELECT r.id,r.status,r.needs_review,r.acknowledged_at,
    jsonb_agg(jsonb_build_object('material',l.material_code,'requested',l.requested_loads,
      'confirmed',l.confirmed_loads,'actual',l.actual_loads) ORDER BY l.material_code) AS lines
    FROM aggregate_requests r JOIN aggregate_request_lines l ON l.request_id=r.id
    GROUP BY r.id ORDER BY r.id`)).rows;
  const requestErrors = [];
  for (const request of aggregateRequests) {
    if (request.lines.length !== 7 || new Set(request.lines.map(line => line.material)).size !== 7) requestErrors.push({id:request.id,error:'material_count'});
    for (const line of request.lines) {
      for (const field of ['requested','confirmed','actual']) {
        if (line[field] !== null && (!Number.isInteger(line[field]) || line[field] < 0)) requestErrors.push({id:request.id,error:field});
      }
    }
    if (request.status === 'reported') {
      const mismatch = request.lines.some(line => line.actual !== line.confirmed);
      if (request.needs_review !== (mismatch && request.acknowledged_at === null)) requestErrors.push({id:request.id,error:'variance_review'});
    }
  }
  const displays = (await query(`SELECT c.order_ref,c.full_order->>'weight' AS weight_lb,
    jsonb_path_query_array(c.full_order,'$.items[*] ? (@.itemId >= 9909 && @.itemId <= 9922)') AS items
    FROM dispatch_order_catalog_entries c WHERE c.order_ref IN ('SOB121756','SOB122244') ORDER BY c.order_ref`)).rows;
  console.log(JSON.stringify({checkedAt:new Date().toISOString(),items,planning,salesFacts,webhookWeights,
    aggregateRequests,aggregateRequestErrors:requestErrors,displays},null,2));
} finally {await closeDb();}
