// Read-only operational verification. Run from /app in the deployed container.
import assert from "node:assert/strict";
import { query, withTransaction, closeDb } from "./src/db.js";
import { getDispatchOrderCatalogOrder, listDispatchOrderPool } from "./src/dispatch-order-catalog-repository.js";
import { validateDispatchPickupVisits } from "./src/dispatch-pickup-visits.js";

const ref = "GOA-10724S1-10878S1";
try {
  await withTransaction(async () => {
    await query("SET TRANSACTION READ ONLY");
    const cancelled = new Set((await query("SELECT id::text FROM order_dependencies WHERE id IN (300,301) AND status='cancelled'"))
      .rows.map(row => row.id));
    const full = await getDispatchOrderCatalogOrder(ref);
    const pool = await listDispatchOrderPool({ search: ref, limit: 10 });
    const card = pool.orders.find(order => order.id === ref);
    assert.ok(full && card, "The reported group must be available in both detail and search responses");
    const visit = order => {
      for (const link of order.orderDependencies || []) assert.ok(!cancelled.has(String(link.id)), "Cancelled dependency returned");
      for (const link of order.directPickupManifest || []) assert.ok(!cancelled.has(String(link.dependencyId)), "Cancelled pickup returned");
      for (const child of order.childOrderDetails || []) visit(child);
    };
    visit(full);
    assert.deepEqual(card.pickupLocations, full.pickupLocations);
    const row = (await query(`SELECT p.id,p.revision,s.orders,s.trucks FROM dispatch_plans p
      JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.id=373`)).rows[0];
    const issues = validateDispatchPickupVisits(row).filter(issue => issue.orderRef === ref || issue.orderId === ref);
    assert.deepEqual(issues, []);
    const active = row.orders.find(order => order.id === ref);
    assert.ok(active);
    visit(active);
    assert.equal(active.pickupLocations.includes("2967"), false);
    assert.equal(full.pickupLocations.includes("2967"), false);
    console.log(JSON.stringify({ group: ref, planId: row.id, revision: row.revision,
      activePickupLocations: active.pickupLocations, detailPickupLocations: full.pickupLocations,
      searchPickupLocations: card.pickupLocations, cancelledLinksExcluded: [...cancelled],
      readOnly: true, targetPickupIssues: issues.length }));
  });
} finally { await closeDb(); }
