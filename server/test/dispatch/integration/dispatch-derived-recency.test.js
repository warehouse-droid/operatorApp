import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { syncDispatchDeliveryGroupsFromPlan } from "../../../src/dispatch-delivery-group-repository.js";
import { listDispatchOrderPool, upsertDispatchOrderCatalog } from "../../../src/dispatch-order-catalog-repository.js";

after(closeDb);

test("derived cards and cursors use source recency despite later definition edits", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const suffix = `RECENCY-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
      const source = (ref, date) => ({
        id: `TO-${ref}-${suffix}`, type: "TO", sourceTable: "transfer_orders",
        firstSeenAt: `${date}T12:34:56.000Z`, sourceOrderDate: "2020-01-01", customer: "Recency fixture", address: "1 Recency Road",
        pickupLocations: ["3445"], sourceYard: "3445", eligible: true,
        items: [{ sku: `${suffix}-ITEM`, quantity: 10, pallets: 1 }],
        pallets: 1, salesQty: 10,
        raw: { source_table: "transfer_orders", source_order_date: date }
      });
      const latest = source("AAA-LATEST", "2026-09-30");
      const oldest = source("ZZZ-OLDEST", "2026-09-01");
      const splitParent = source("SPLIT-PARENT", "2026-09-20");
      const members = [source("GROUP-OLD", "2026-09-10"), source("GROUP-NEW", "2026-09-29")];
      await upsertDispatchOrderCatalog({ orders: [oldest, ...members, splitParent, latest], source: "recency-fixture" });
      const plan = (await query(
        `INSERT INTO dispatch_plans (plan_date, status, note, revision)
         VALUES ('2097-09-30', 'draft', $1, 1) RETURNING id`,
        [`derived recency ${suffix}`]
      )).rows[0];
      const split = {
        ...splitParent, id: `${splitParent.id}-S1`, originalOrderId: splitParent.id,
        isSplit: true, salesQty: 4, items: [{ ...splitParent.items[0], quantity: 4 }]
      };
      const group = {
        ...members[0], id: `GO-${suffix}`, isGrouped: true,
        customer: "2 orders grouped", childOrders: members.map(order => order.id),
        childOrderDetails: members,
        groupPlanId: String(plan.id), groupPlanDate: "2097-09-30", planOwned: true
      };
      await syncDispatchDeliveryGroupsFromPlan({
        id: String(plan.id), planDate: "2097-09-30", revision: 1,
        orders: [group, split], trucks: []
      });
      await query(
        "UPDATE dispatch_global_order_groups SET updated_at='2999-01-01' WHERE group_ref=$1",
        [group.id]
      );
      await query(
        "UPDATE dispatch_global_order_splits SET updated_at='2999-01-02' WHERE split_ref=$1",
        [split.id]
      );
      await upsertDispatchOrderCatalog({
        orders: [{ ...oldest, updatedAt: "2999-01-03T00:00:00Z", scm: { updatedAt: "2999-01-04T00:00:00Z" } }],
        source: "recency-old-order-edit"
      });

      const seen = [];
      let cursor = "";
      for (let page = 0; page < 4; page++) {
        const result = await listDispatchOrderPool({ type: "TO", search: suffix, limit: 1, cursor });
        assert.equal(result.orders.length, 1, `Expected source-recency page ${page + 1}.`);
        seen.push(result.orders[0].id);
        cursor = result.nextCursor;
        if (page < 3) assert.ok(cursor, "A continuation cursor must preserve access to older cards.");
      }
      assert.deepEqual(seen, [latest.id, group.id, split.id, oldest.id],
        "Definition edits and later source updates must not outrank newer arrivals.");
      assert.equal(cursor, "");
      assert.equal(new Set(seen).size, seen.length);
    });
  } finally {
    await rollback.rollback();
  }
});

test("legacy derived cards without inherited arrival use original definition creation despite later edits", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const suffix = `LEGACY-ARRIVAL-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
      const source = ref => ({
        id: `TO-${ref}-${suffix}`, type: "TO", sourceTable: "transfer_orders",
        sourceOrderDate: "2020-01-01", customer: "Legacy arrival fixture",
        address: "1 Legacy Arrival Road", pickupLocations: ["3445"], sourceYard: "3445",
        items: [{ sku: `${suffix}-ITEM`, quantity: 10, pallets: 1 }], pallets: 1, salesQty: 10,
        eligible: true
      });
      const newest = { ...source("NEWEST"), firstSeenAt: "2026-09-30T12:00:00Z" };
      const splitParent = source("SPLIT-PARENT");
      const members = [source("GROUP-ONE"), source("GROUP-TWO")];
      await upsertDispatchOrderCatalog({ orders: [newest, splitParent, ...members], source: "legacy-arrival-fixture" });
      const plan = (await query(
        `INSERT INTO dispatch_plans (plan_date, status, note, revision)
         VALUES ('2097-10-01', 'draft', $1, 1) RETURNING id`,
        [`legacy derived arrival ${suffix}`]
      )).rows[0];
      const split = {
        ...splitParent, id: `${splitParent.id}-S1`, originalOrderId: splitParent.id,
        isSplit: true, salesQty: 4, items: [{ ...splitParent.items[0], quantity: 4 }]
      };
      const group = {
        ...members[0], id: `GO-${suffix}`, isGrouped: true, customer: "2 orders grouped",
        childOrders: members.map(order => order.id), childOrderDetails: members,
        groupPlanId: String(plan.id), groupPlanDate: "2097-10-01", planOwned: true
      };
      await syncDispatchDeliveryGroupsFromPlan({
        id: String(plan.id), planDate: "2097-10-01", revision: 1,
        orders: [group, split], trucks: []
      });
      await query(
        `UPDATE dispatch_global_order_groups
            SET created_at='2026-09-20T08:12:23.123450Z', updated_at='2999-01-01T00:00:00Z'
          WHERE group_ref=$1`, [group.id]
      );
      await query(
        `UPDATE dispatch_global_order_splits
            SET created_at='2026-09-20T08:12:23.123456Z', updated_at='2999-01-02T00:00:00Z'
          WHERE split_ref=$1`, [split.id]
      );
      const definitions = (await query(
        `SELECT card, full_order FROM dispatch_global_order_groups WHERE group_ref=$1
         UNION ALL
         SELECT card, full_order FROM dispatch_global_order_splits WHERE split_ref=$2`,
        [group.id, split.id]
      )).rows;
      assert.equal(definitions.length, 2);
      for (const definition of definitions) {
        assert.equal(Object.hasOwn(definition.card, "firstSeenAt"), false);
        assert.equal(Object.hasOwn(definition.full_order, "firstSeenAt"), false,
          "The fixture must retain the legacy missing-arrival shape.");
      }
      const expected = [newest.id, split.id, group.id];
      const pool = await listDispatchOrderPool({ type: "TO", search: suffix, limit: 10 });
      assert.deepEqual(pool.orders.map(order => order.id), expected,
        "A recent arrival must outrank legacy definitions edited later, using their stable creation timestamps.");
      await query("UPDATE dispatch_global_order_groups SET updated_at='2999-02-02' WHERE group_ref=$1", [group.id]);
      await query("UPDATE dispatch_global_order_splits SET updated_at='2999-02-01' WHERE split_ref=$1", [split.id]);
      const afterEdit = await listDispatchOrderPool({ type: "TO", search: suffix, limit: 10 });
      assert.deepEqual(afterEdit.orders.map(order => order.id), expected,
        "Further edits must preserve the same legacy-arrival fallback ordering.");
      assert.equal(afterEdit.nextCursor, "");
      const paged = [];
      let cursor = "";
      for (let page = 0; page < expected.length; page++) {
        const result = await listDispatchOrderPool({ type: "TO", search: suffix, limit: 1, cursor });
        assert.equal(result.orders.length, 1,
          `Legacy creation timestamps in the same millisecond must retain every card on page ${page + 1}.`);
        paged.push(result.orders[0].id);
        cursor = result.nextCursor;
      }
      assert.deepEqual(paged, expected, "Submillisecond legacy timestamps must neither omit nor repeat a card across cursor pages.");
      assert.equal(cursor, "");
    });
  } finally {
    await rollback.rollback();
  }
});
