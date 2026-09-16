import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { pool, query, withTransaction, closeDb } from "../src/db.js";
import { getDeliveryOrdersBatch } from "../src/delivery-repository.js";

pool.options.options = "-c default_transaction_read_only=on -c jit=off -c statement_timeout=90000";
const headerFields = ["netsuite_id", "tranid", "trandate", "status", "status_text", "outbound_location_id", "outbound_location",
  "sales_order_type", "operator_status", "local_yard_order_status", "netsuite_active", "fulfillment_status"];
const lineFields = ["id", "sales_order_id", "line_id", "item_id", "item_name", "sku", "item_type", "item_type_text", "quantity", "unit",
  "location_id", "location", "pallet_qty", "layer_qty", "section_qty", "piece_qty", "to_plt", "to_lyr", "to_sec", "to_pcs",
  "packed_pallet_qty", "packed_layer_qty", "packed_section_qty", "packed_piece_qty", "packed_sales_qty", "loaded_qty", "netsuite_active", "sync_exception"];
const select = (record, fields) => Object.fromEntries(fields.map(field => [field, record[field] ?? null]));
try {
  const report = await withTransaction(async () => {
    await query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const candidates = (await query(`SELECT netsuite_id FROM sales_orders
      WHERE sales_order_type='Delivery' AND COALESCE(is_test_fixture,false)=false
      ORDER BY (tranid IN ('SOB120124','SOB120358')) DESC, (operator_status='packed') DESC NULLS LAST, netsuite_id DESC LIMIT 1500`)).rows;
    const orders = [];
    for (let index = 0; index < candidates.length; index += 100) {
      orders.push(...await getDeliveryOrdersBatch(candidates.slice(index, index + 100).map(row => row.netsuite_id)));
    }
    const selected = orders.filter(order => !order.reload_authorized).slice(0, 1200);
    assert(selected.length >= 1000, `Only ${selected.length} orders are available`);
    assert(selected.some(order => order.tranid === "SOB120124"));
    return { capturedAt: new Date().toISOString(), readOnly: true, projection: "Operator effective yard quantities after linked supply allocations",
      headerFields, lineFields, orders: selected.map(order => ({ ...select(order, headerFields), lines: order.lines.map(line => select(line, lineFields)) })) };
  }, { rollback: true });
  const output = JSON.stringify(report);
  writeFileSync("test-artifacts/group-underpack-20260915/replay-input.json", output + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ capturedAt: report.capturedAt, orders: report.orders.length,
    lines: report.orders.reduce((count, order) => count + order.lines.length, 0), sha256: createHash("sha256").update(output + "\n").digest("hex"), readOnly: true }));
} finally { await closeDb(); }
