import { query, withTransaction, closeDb } from "./src/db.js";

try {
  const evidence = await withTransaction(async () => {
    await query("SET TRANSACTION READ ONLY");
    await query("SET LOCAL statement_timeout='20s'");
    const receipts = (await query(`SELECT request_id,action,status,created_at,completed_at,error,
      result->>'status' AS result_status,result->>'pending' AS pending,
      result->>'planId' AS plan_id,result->>'planRevision' AS plan_revision,
      result->'allocations' AS allocations
      FROM scm_dependency_action_receipts WHERE request_id=ANY($1::uuid[]) ORDER BY created_at`,
    [["0deb97b1-de3b-442a-96a4-62d0816e3807", "abea9d55-9d0d-415e-8674-ed78f75dfd1c"]])).rows;
    const audit = (await query(`SELECT id,created_at,action,order_id,plan_id,details
      FROM dispatch_audit_log
      WHERE created_at BETWEEN '2026-10-14T21:49:00Z' AND '2026-10-14T22:03:00Z'
        AND (order_id=$1 OR details::text ILIKE $2)
      ORDER BY id LIMIT 160`, ["GOA-9948-9949-9998", "%GOA-9948-9949-9998%"])).rows;
    const allocations = (await query(`SELECT id,dispatch_target_ref,dispatch_target_line_key,
      sales_order_ref,sales_line_id,po_order_ref,po_line_id,status,
      created_at,updated_at,cancelled_at,cancelled_by,allocated_sales_qty
      FROM dispatch_so_po_allocations WHERE dispatch_target_ref=$1 ORDER BY id`,
    ["GOA-9948-9949-9998"])).rows;
    const itemLines = (await query(`SELECT s.tranid,l.id,l.line_id,l.item_id,l.item_name,l.sku,
      l.item_description,l.unit,l.quantity,s.dispatch_parse_source
      FROM sales_order_lines l JOIN sales_orders s ON s.netsuite_id=l.sales_order_id
      WHERE s.tranid=ANY($1::text[]) ORDER BY s.tranid,l.id`,
    [["SOA09948", "SOA09948-S1", "SOA09948-S2", "SOA09949-S1"]])).rows;
    return { readOnly: true, receipts, allocations, audit, itemLines };
  });
  console.log(JSON.stringify(evidence));
} finally {
  await closeDb();
}
