// @ts-check

import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import {
  listDispatchOrderPool,
  replaceDispatchOrderCatalog
} from "../../../src/dispatch-order-catalog-repository.js";

beforeEach(async () => {
  await query("TRUNCATE dispatch_order_catalog_refresh_outbox, dispatch_order_relation_edges, dispatch_order_catalog_entries, dispatch_order_catalog_state RESTART IDENTITY CASCADE");
  await query("INSERT INTO dispatch_order_catalog_state (singleton, status) VALUES (true, 'warming')");
});

after(async () => {
  await closeDb();
});

test("WL-17 Dispatch initial pool returns the 200 most recently updated unplanned summaries", async () => {
  const orders = Array.from({ length: 225 }, (_, index) => ({
    id: `SO-RECENT-${String(index + 1).padStart(3, "0")}`,
    type: "SO",
    customer: `Customer ${index + 1}`,
    expectedDeliveryDate: "2026-08-29",
    updatedAt: new Date(Date.UTC(2026, 7, 27, 0, index)).toISOString(),
    items: [{ sku: `SKU-${index + 1}`, quantity: index + 1 }]
  }));
  await replaceDispatchOrderCatalog({ orders, source: "wl17" });
  const first = await listDispatchOrderPool({ type: "SO", limit: 200 });
  assert.equal(first.orders.length, 200);
  assert.equal(first.orders[0].id, "SO-RECENT-225");
  assert.equal(first.orders.at(-1).id, "SO-RECENT-026");
  assert.ok(first.nextCursor);
  const second = await listDispatchOrderPool({ type: "SO", limit: 200, cursor: first.nextCursor });
  assert.equal(second.orders.length, 25);
  assert.equal(second.orders[0].id, "SO-RECENT-025");
});
