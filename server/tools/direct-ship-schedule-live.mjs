// Read-only verification of the schedule projection for existing direct links.
import assert from "node:assert/strict";
import { closeDb, query, withTransaction } from "./src/db.js";
import { listScmSchedule } from "./src/dispatch-repository.js";

try {
  const result = await withTransaction(async () => {
    await query("SET TRANSACTION READ ONLY");
    const links = (await query(`
      SELECT DISTINCT 'PO' AS kind, COALESCE(NULLIF(po.dispatch_ref, ''), po.tranid) AS ref
        FROM dispatch_so_po_allocations allocation
        JOIN purchase_orders po ON po.netsuite_id = allocation.po_order_id
       WHERE allocation.status = 'active'
      UNION
      SELECT 'TO', dependency.transfer_order_ref
        FROM order_dependencies dependency
       WHERE dependency.dependency_mode = 'direct_to_customer'
         AND dependency.status <> 'cancelled'
      ORDER BY kind, ref
    `)).rows;
    const refs = [...new Set(links.map(link => link.ref))];
    const rows = [];
    const start = performance.now();
    for (let offset = 0; offset < refs.length; offset += 150) {
      rows.push(...await listScmSchedule({ exactRefs: refs.slice(offset, offset + 150), statusProjectionOnly: true }));
    }
    const orders = rows.map(row => ({
      kind: links.find(link => link.ref === row.orderRef)?.kind,
      ref: row.orderRef,
      status: row.calculatedStatus,
      linked: row.directShipLinked === true
    }));
    if (process.env.SCM_DIRECT_SHIP_VERIFY === "1") {
      for (const row of orders) {
        if (row.linked) {
          assert.ok(!["Queued", "Planned", "Urgent", "Priority", "Surplus Only", "Book Appt"].includes(row.status), row.ref);
        }
      }
    }
    return {
      directLinks: links.length,
      visibleOrders: orders.length,
      statusCounts: orders.reduce((counts, row) => {
        const key = row.kind + ":" + row.status;
        counts[key] = (counts[key] || 0) + 1;
        return counts;
      }, {}),
      elapsedMs: Math.round(performance.now() - start),
      orders
    };
  });
  console.log(JSON.stringify(result));
} finally {
  await closeDb();
}
