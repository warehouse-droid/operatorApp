import assert from "node:assert/strict";
import test, { after } from "node:test";
import { closeDb, query, withTransaction } from "../../../src/db.js";
import { listDispatchOrders } from "../../../src/dispatch-repository.js";
import { listDispatchOrderPool, replaceDispatchOrderCatalog } from "../../../src/dispatch-order-catalog-repository.js";

after(closeDb);

test("the newest unplanned CO is first within the 500-order window and the optimized pool", async () => {
  await withTransaction(async () => {
    const base = 8_885_000_000_000 + Math.floor(Math.random() * 1000000);
    const prefix = `CO-RECENCY-${base}-`;
    // All 501 orders were created on the same day. Newer local orders have
    // more negative delivery IDs, and refs deliberately sort the other way.
    await query(`INSERT INTO co_orders (
      id, co_ref, source_order_ref, from_location_id, from_location,
      to_location_id, to_location, status, delivery_order_id, created_at, updated_at, details
    ) SELECT $1::bigint + n, $2 || lpad((502 - n)::text, 3, '0'), 'SO-RECENCY-' || n,
      1, '3445', 15, '12441', 'pending_load', -($1::bigint + n),
      '2099-09-15 00:00:00+00'::timestamptz + n * interval '1 second',
      '2099-09-15 00:00:00+00'::timestamptz + n * interval '1 second', '{}'
      FROM generate_series(1, 501) n`, [base, prefix]);
    const newestRef = `${prefix}001`;
    const oldestRef = `${prefix}501`;
    const capped = await listDispatchOrders({ type: "CO" });
    assert.equal(capped.length, 500);
    assert.equal(capped[0].id, newestRef);
    assert.ok(!capped.some(order => order.id === oldestRef));
    assert.equal(new Date(capped[0].createdAt).toISOString(), "2099-09-15T00:08:21.000Z");
    assert.equal(new Date(capped[0].updatedAt).toISOString(), "2099-09-15T00:08:21.000Z");
    await replaceDispatchOrderCatalog({ orders: capped, source: "co-pool-recency" });
    const pool = await listDispatchOrderPool({ type: "CO", limit: 200 });
    assert.equal(pool.orders.length, 200);
    assert.equal(pool.orders[0].id, newestRef);
    await query("UPDATE co_orders SET delivery_order_id = NULL WHERE co_ref = $1", [newestRef]);
    const withoutDeliveryId = (await listDispatchOrders({ type: "CO", search: newestRef }))[0];
    assert.equal(withoutDeliveryId.id, newestRef);
    assert.equal(new Date(withoutDeliveryId.createdAt).toISOString(), "2099-09-15T00:08:21.000Z");
    assert.equal(new Date(withoutDeliveryId.updatedAt).toISOString(), "2099-09-15T00:08:21.000Z",
      "CO timestamps do not depend on a populated delivery ID");
    const searched = await listDispatchOrders({ type: "CO", search: oldestRef });
    assert.ok(searched.some(order => order.id === oldestRef), "The cap still allows explicit searches for older COs");
    await query("UPDATE co_orders SET status = 'cancelled' WHERE co_ref = $1", [newestRef]);
    const afterCancel = await listDispatchOrders({ type: "CO" });
    assert.ok(!afterCancel.some(order => order.id === newestRef));
  }, { rollback: true });
});
