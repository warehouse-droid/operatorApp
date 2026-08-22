import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { searchScmDependencyTargets } from "../../../src/scm-dependency-search-repository.js";

after(closeDb);

async function seedSalesOrder(id, ref, quantity = 10) {
  await query(
    `INSERT INTO sales_orders (
       netsuite_id, tranid, trandate, customer, status, status_text,
       sales_order_type, fulfillment_status, operator_status,
       local_yard_order_status, netsuite_active
     ) VALUES ($1, $2, current_date, 'SCM Search', 'B',
       'Sales Order : Pending Fulfillment', 'Delivery', 'open', 'open', 'Open', true)`,
    [id, ref]
  );
  await query(
    `INSERT INTO sales_order_lines (
       sales_order_id, line_id, item_id, item_name, sku, item_type,
       item_type_text, quantity, unit, piece_qty, to_pcs, netsuite_active
     ) VALUES ($1, $2, $3, 'Search Item', 'SEARCH-ITEM', 'InvtPart',
       'Inventory Item', $4, 'EA', $4, 1, true)`,
    [id, Math.abs(id) + 100, 9_810_000_001, quantity]
  );
}

async function seedCatalog(ref) {
  const order = { id: ref, type: "SO", customer: "SCM Search", items: [] };
  await query(
    `INSERT INTO dispatch_order_catalog_entries (
       order_ref, order_type, eligible, sort_key, search_text, card, full_order, source
     ) VALUES ($1, 'SO', true, lower($1), lower($1), $2::jsonb, $2::jsonb, 'test')`,
    [ref, JSON.stringify(order)]
  );
}

test("global dependency search pages normal, group, split, and remaining source targets without snapshot scans", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const base = 9_810_000_000 + Number.parseInt(suffix.slice(0, 5), 16);
      const normalRef = `SO-NORMAL-${suffix}`;
      const parentRef = `SO-PARENT-${suffix}`;
      const splitRef = `${parentRef}-S1`;
      const groupRef = `SO-GROUP-${suffix}`;
      await seedSalesOrder(base + 1, normalRef, 3);
      await seedSalesOrder(base + 2, parentRef, 10);
      await seedSalesOrder(-(base + 3), splitRef, 4);
      await seedCatalog(normalRef);
      await seedCatalog(parentRef);
      await seedCatalog(splitRef);
      await query(
        `INSERT INTO dispatch_scm_so_splits (
           source_so_id, source_so_ref, split_so_id, split_so_ref, status, details
         ) VALUES ($1, $2, $3, $4, 'active', '{}'::jsonb)`,
        [base + 2, parentRef, -(base + 3), splitRef]
      );
      const plan = await query(
        `INSERT INTO dispatch_plans (plan_date, status, revision)
         VALUES ('2026-08-19', 'draft', 1) RETURNING id`
      );
      await query(
        `INSERT INTO dispatch_delivery_groups (
           group_ref, plan_id, plan_date, order_type, active
         ) VALUES ($1, $2, '2026-08-19', 'sales_order', true)`,
        [groupRef, plan.rows[0].id]
      );
      await query(
        `INSERT INTO dispatch_delivery_group_members (group_ref, member_order_ref, position)
         VALUES ($1, $2, 0), ($1, $3, 1)`,
        [groupRef, normalRef, splitRef]
      );

      const first = await searchScmDependencyTargets({ search: suffix, limit: 2 });
      assert.equal(first.targets.length, 2);
      assert.ok(first.nextCursor);
      const second = await searchScmDependencyTargets({ search: suffix, limit: 5, cursor: first.nextCursor });
      const targets = [...first.targets, ...second.targets];
      assert.deepEqual(new Set(targets.map((entry) => entry.ref)), new Set([
        normalRef,
        parentRef,
        splitRef,
        groupRef
      ]));
      assert.equal(targets.find((entry) => entry.ref === normalRef)?.kind, "normal");
      assert.equal(targets.find((entry) => entry.ref === parentRef)?.kind, "normal");
      assert.equal(targets.find((entry) => entry.ref === splitRef)?.kind, "split");
      assert.equal(targets.find((entry) => entry.ref === groupRef)?.kind, "group");
      assert.equal(targets.some((entry) => "orders" in entry), false, "search cards must not materialize saved snapshots");
    });
  } finally {
    await rollback.rollback();
  }
});

test("a fully allocated split source is not offered as a remaining source target", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const base = 9_820_000_000 + Number.parseInt(suffix.slice(0, 5), 16);
      const parentRef = `SO-FULL-${suffix}`;
      const splitRef = `${parentRef}-S1`;
      await seedSalesOrder(base + 1, parentRef, 5);
      await seedSalesOrder(-(base + 2), splitRef, 5);
      await seedCatalog(parentRef);
      await seedCatalog(splitRef);
      await query(
        `INSERT INTO dispatch_scm_so_splits (
           source_so_id, source_so_ref, split_so_id, split_so_ref, status, details
         ) VALUES ($1, $2, $3, $4, 'active', '{}'::jsonb)`,
        [base + 1, parentRef, -(base + 2), splitRef]
      );
      const result = await searchScmDependencyTargets({ search: suffix, limit: 10 });
      assert.equal(result.targets.some((entry) => entry.ref === parentRef), false);
      assert.equal(result.targets.some((entry) => entry.ref === splitRef), true);
    });
  } finally {
    await rollback.rollback();
  }
});
