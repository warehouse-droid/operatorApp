// @ts-check

import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import {
  getScmPurchaseOrderCatalogOrder,
  listScmPurchaseOrderCatalog,
  replaceScmPurchaseOrderCatalog
} from "../../../src/scm-purchase-order-catalog-repository.js";

function order(index, updatedAt, extras = {}) {
  return {
    id: `PO-CATALOG-${String(index).padStart(3, "0")}`,
    type: "PO",
    customer: `Vendor ${index}`,
    updatedAt,
    destinationYard: index % 2 ? "12441" : "3445",
    sourceYard: index % 3 ? "Yard A" : "Yard B",
    items: [{ lineRowId: index, sku: `SKU-${index}`, itemName: `Item ${index}`, quantity: index }],
    ...extras
  };
}

beforeEach(async () => {
  await query("TRUNCATE scm_purchase_order_catalog_entries, scm_purchase_order_catalog_state RESTART IDENTITY CASCADE");
  await query("INSERT INTO scm_purchase_order_catalog_state (singleton, status) VALUES (true, 'warming')");
});

after(async () => {
  await closeDb();
});

test("WL-13 PO catalog returns 200 recent summary cards with stable cursor and no line/raw payload", async () => {
  const orders = Array.from({ length: 225 }, (_, index) => order(
    index + 1,
    new Date(Date.UTC(2026, 7, 27, 0, index)).toISOString()
  ));
  await replaceScmPurchaseOrderCatalog({ orders, source: "test" });
  const first = await listScmPurchaseOrderCatalog({ limit: 200 });
  assert.equal(first.orders.length, 200);
  assert.equal(first.orders[0].id, "PO-CATALOG-225");
  assert.ok(first.nextCursor);
  assert.equal(first.orders.some((candidate) => "items" in candidate || "raw" in candidate), false);
  const second = await listScmPurchaseOrderCatalog({ limit: 200, cursor: first.nextCursor });
  assert.equal(second.orders.length, 25);
  assert.equal(new Set([...first.orders, ...second.orders].map((candidate) => candidate.id)).size, 225);
});

test("WL-14 exact linked split/group references use indexed search and detail hydration remains separate", async () => {
  await replaceScmPurchaseOrderCatalog({ orders: [order(1, "2026-08-27T15:00:00.000Z", {
    id: "PO-SOURCE",
    correspondingPoRefs: ["PO-SPLIT-ALIAS"],
    scmSearchRefs: ["PO-SOURCE", "PO-SPLIT-ALIAS", "PGOB-ALIAS"],
    childOrders: ["PO-SPLIT-ALIAS"]
  })], source: "test" });
  const linked = await listScmPurchaseOrderCatalog({ search: "PGOB-ALIAS", limit: 200 });
  assert.deepEqual(linked.orders.map((candidate) => candidate.id), ["PO-SOURCE"]);
  assert.deepEqual(linked.orders[0].linkedRefs.sort(), ["PGOB-ALIAS", "PO-SOURCE", "PO-SPLIT-ALIAS"].sort());
  const detail = await getScmPurchaseOrderCatalogOrder("PO-SOURCE");
  assert.equal(detail.items[0].sku, "SKU-1");
});

test("WL-15 active assignment projection is authoritative for PO planned state", async () => {
  const plan = await query(
    `INSERT INTO dispatch_plans (plan_date, status, note) VALUES ('2026-08-29', 'draft', 'po catalog assignment test') RETURNING id`
  );
  await replaceScmPurchaseOrderCatalog({ orders: [order(2, "2026-08-27T15:00:00.000Z")], source: "test" });
  await query(
    `INSERT INTO dispatch_plan_order_assignments (plan_id, plan_date, order_ref, planned_order_ref, assignment)
     VALUES ($1, '2026-08-29', 'PO-CATALOG-002', 'PO-CATALOG-002', '{"dispatchTruckPlate":"TRUCK-1"}'::jsonb)`,
    [plan.rows[0].id]
  );
  const listed = await listScmPurchaseOrderCatalog({ search: "PO-CATALOG-002" });
  assert.equal(listed.orders[0].dispatchPlanned, true);
  assert.equal(listed.orders[0].dispatchPlanDate, "2026-08-29");
  await query("DELETE FROM dispatch_plans WHERE id = $1", [plan.rows[0].id]);
});
