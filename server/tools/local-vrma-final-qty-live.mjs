// Read-only operational verification, run through Node stdin in the live /app.
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
const { query, closeDb } = await import(pathToFileURL(path.resolve("src/db.js")).href);
const { listVrmaDeliveryPrepOrders } = await import(pathToFileURL(path.resolve("src/delivery-repository.js")).href);
const expected = new Map([["RP-UNI-GORMLEY-3445-0928-1", 150], ["RP-UNI-AYR-150-0916-1", 320]]);
try {
  const { rows } = await query(`SELECT v.vrma_ref, v.operator_status,
    SUM(l.quantity) AS final_qty, SUM(l.loaded_qty) AS loaded_qty, SUM(l.pallet_qty) AS pallets,
    SUM(GREATEST(l.quantity-l.loaded_qty,0)) AS remaining_qty,
    (SELECT COUNT(*) FROM operator_load_records r WHERE r.order_family='vrma_order' AND r.order_id=v.id) AS proof_count,
    (SELECT COUNT(*) FROM delivery_audit_log a WHERE a.action='delivery.vrma.finalize_legacy_short_load' AND a.order_id=v.id) AS repair_audit_count
    FROM scm_vrma_orders v JOIN scm_vrma_order_lines l ON l.vrma_order_id=v.id
    WHERE v.vrma_ref=ANY($1::text[]) GROUP BY v.id ORDER BY v.vrma_ref`, [[...expected.keys()]]);
  assert.equal(rows.length, expected.size);
  for (const row of rows) {
    assert.equal(Number(row.final_qty), expected.get(row.vrma_ref));
    assert.equal(Number(row.loaded_qty), expected.get(row.vrma_ref));
    assert.equal(Number(row.pallets), expected.get(row.vrma_ref));
    assert.equal(Number(row.remaining_qty), 0);
    assert.equal(row.operator_status, "loaded");
    assert.equal(Number(row.proof_count), 1);
    assert.equal(Number(row.repair_audit_count), 1);
  }
  for (const status of ["active", "packed"]) {
    const listed = await listVrmaDeliveryPrepOrders({ status });
    assert.equal(listed.some(order => expected.has(order.tranid)), false);
  }
  const health = await fetch("http://127.0.0.1:3000/health", { signal: AbortSignal.timeout(5000) });
  assert.equal(health.status, 200);
  console.log(JSON.stringify({ verified: true, orders: rows, absentFromActiveAndPackedOperatorLists: true, health: 200 }, null, 2));
} finally { await closeDb(); }
