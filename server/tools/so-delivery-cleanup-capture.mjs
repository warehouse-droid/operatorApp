// Read-only evidence capture. Run from the server root (or /app in the live container).
// This tool has no apply mode and does not invoke NetSuite mutations or app startup.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const source = (name) => pathToFileURL(path.resolve("src", name)).href;
const { pool, query, withTransaction, closeDb } = await import(source("db.js"));
pool.options.options = "-c jit=off -c default_transaction_read_only=on -c statement_timeout=45000";
const { listDriverPwaCompletedDispatchRefs } = await import(source("dispatch-history-mode.js"));
const { listBilledSalesOrderFamilyRefs } = await import(source("sales-order-reconciliation-repository.js"));
const { listClosedNetSuiteOrders } = await import(source("netsuite-closed-order-repository.js"));
const { listDeliveryOrders, listDeliveryLoadOrders } = await import(source("delivery-repository.js"));

try {
  const snapshot = await withTransaction(async () => {
    await query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const { rows: [database] } = await query(`SELECT current_database() AS name, now() AS captured_at,
      current_setting('transaction_read_only') AS transaction_read_only,
      current_setting('transaction_isolation') AS transaction_isolation`);
    assert.equal(database.transaction_read_only, "on");
    const { rows: orders } = await query(`SELECT netsuite_id, tranid, trandate, status, status_text,
      sales_order_type, netsuite_sales_order_type, netsuite_active, is_test_fixture, synced_at,
      operator_status, local_yard_order_status, fulfillment_status, status_updated_at,
      preparing_operator_id IS NOT NULL AS has_preparing_operator, preparing_started_at,
      last_item_fulfillment_id, last_item_fulfillment_tranid, fulfilled_at,
      dispatch_planned, dispatch_plan_date, dispatch_planned_at
      FROM sales_orders ORDER BY netsuite_id`);
    const ids = orders.filter((o) => o.sales_order_type === "Delivery").map((o) => o.netsuite_id);
    const refs = orders.filter((o) => o.sales_order_type === "Delivery").map((o) => o.tranid);
    const { rows: lines } = await query(`SELECT id, sales_order_id, line_id, item_id, sku, item_name,
      item_type, quantity, unit, pallet_qty, layer_qty, section_qty, piece_qty,
      to_plt, to_lyr, to_sec, to_pcs, loaded_qty, loaded_uom, netsuite_active,
      packed_pallet_qty, packed_layer_qty, packed_section_qty, packed_piece_qty,
      packed_sales_qty, confirmed, sync_exception,
      fulfilled_pallet_qty, fulfilled_layer_qty, fulfilled_section_qty, fulfilled_piece_qty
      FROM sales_order_lines WHERE sales_order_id = ANY($1::bigint[]) ORDER BY sales_order_id,id`, [ids]);
    const { rows: completions } = await query(`SELECT completion_event_id, order_ref,
      dispatch_completion_status, dispatch_completed_at, completion_evidence_type, completion_evidence_id,
      plan_id, plan_date, load_id, metadata FROM dispatch_order_completion_status
      WHERE order_kind='SO' ORDER BY order_ref`);
    const { rows: driverJobs } = await query(`SELECT id, job_id, plan_id, plan_date,
      stop_type, order_refs, status, started_at, completed_at,
      job_details->'orders' AS orders, job_details->'orderTypes' AS order_types
      FROM driver_job_records WHERE status IN ('complete','completed','in_progress')
      ORDER BY id`);
    const { rows: splits } = await query(`SELECT source_so_id, source_so_ref, split_so_id, split_so_ref,
      status FROM dispatch_scm_so_splits ORDER BY id`);
    const { rows: groups } = await query(`SELECT g.group_ref,g.plan_id,g.plan_date,g.active,
      array_agg(m.member_order_ref ORDER BY m.position) AS members
      FROM dispatch_delivery_groups g JOIN dispatch_delivery_group_members m ON m.group_ref=g.group_ref
      GROUP BY g.group_ref ORDER BY g.group_ref`);
    const { rows: reloadCycles } = await query(`SELECT id,sales_order_id,order_ref,status,authorized_at,
      completed_at,workflow_kind,reattempt_order_ref,reattempt_order_id
      FROM operator_reload_cycles ORDER BY id`);
    const { rows: allocations } = await query(`SELECT a.sales_line_id,
      SUM(a.sales_qty) AS sales_qty, SUM(a.pallet_qty) AS pallet_qty,
      SUM(a.layer_qty) AS layer_qty, SUM(a.section_qty) AS section_qty, SUM(a.piece_qty) AS piece_qty
      FROM (
        SELECT sales_line_id,allocated_sales_qty AS sales_qty,allocated_pallet_qty AS pallet_qty,
          allocated_layer_qty AS layer_qty,allocated_section_qty AS section_qty,allocated_piece_qty AS piece_qty
        FROM dispatch_so_po_allocations WHERE status='active'
        UNION ALL
        SELECT dl.sales_line_id,dl.allocated_quantity,dl.pallet_qty,dl.layer_qty,dl.section_qty,dl.piece_qty
        FROM order_dependency_lines dl JOIN order_dependencies d ON d.id=dl.dependency_id
        WHERE d.dependency_mode='direct_to_customer' AND d.status<>'cancelled'
      ) a JOIN sales_order_lines l ON l.id=a.sales_line_id
      WHERE l.sales_order_id=ANY($1::bigint[]) GROUP BY a.sales_line_id`, [ids]);
    const { rows: localCos } = await query(`SELECT co_ref,source_order_ref,status
      FROM local_co_orders WHERE status IN ('pending_load','preparing','packed','planned') ORDER BY co_ref`);
    const driverCompletedRefs = [...await listDriverPwaCompletedDispatchRefs({candidateRefs:refs})];
    const billedFamilyRefs = await listBilledSalesOrderFamilyRefs();
    const closedOrders = await listClosedNetSuiteOrders(refs);
    const operatorFeeds = {};
    for (const [name, fn, options] of [
      ["deliveryActive",listDeliveryOrders,{status:"active",orderType:"sales_order"}],
      ["deliveryPacked",listDeliveryOrders,{status:"packed",orderType:"sales_order"}],
      ["deliveryLoadActive",listDeliveryLoadOrders,{status:"active"}]
    ]) {
      // Savepoints let the report retain other evidence if a read path attempts a write.
      await query("SAVEPOINT feed_read");
      try {
        const rows = await fn(options);
        operatorFeeds[name] = rows.map((o) => ({id:o.netsuite_id,ref:o.tranid,
          operator_status:o.operator_status,local_yard_order_status:o.local_yard_order_status,
          underpack_count:o.underpack_count,warning_count:o.warning_count,
          is_dispatch_group:o.is_dispatch_group,child_order_ids:o.child_order_ids,
          reload_cycle_id:o.reload_cycle_id}));
        await query("RELEASE SAVEPOINT feed_read");
      } catch (error) {
        await query("ROLLBACK TO SAVEPOINT feed_read");
        operatorFeeds[name] = {error:error.message,code:error.code};
      }
    }
    const sourceHashes = Object.fromEntries([
      "delivery-repository.js","dispatch-repository.js","dispatch-completion-repository.js",
      "dispatch-history-mode.js","server.js","sales-order-reconciliation.js"
    ].map((name) => [name,createHash("sha256").update(readFileSync(path.resolve("src",name))).digest("hex")]));
    return {mode:"dry-run-read-only",database,sourceHashes,orders,lines,completions,driverJobs,
      splits,groups,reloadCycles,allocations,localCos,driverCompletedRefs,billedFamilyRefs,closedOrders,operatorFeeds};
  }, {rollback:true});
  process.stdout.write(`${JSON.stringify(snapshot,null,2)}\n`);
} finally {
  await closeDb();
}
