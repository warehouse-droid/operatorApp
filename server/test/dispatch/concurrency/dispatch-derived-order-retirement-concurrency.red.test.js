import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import {
  deactivateDispatchGlobalOrderDefinitions,
  syncDispatchDeliveryGroupsFromPlan
} from "../../../src/dispatch-delivery-group-repository.js";
import {
  getDispatchOrderCatalogOrder,
  listDispatchOrderPool,
  upsertDispatchOrderCatalog
} from "../../../src/dispatch-order-catalog-repository.js";

after(closeDb);

test("concurrent ungroup and delayed catalog refresh cannot resurrect a retired group", async () => {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
  const memberRefs = [`SO-RACE-${suffix}-1`, `SO-RACE-${suffix}-2`];
  const groupRef = `GO-RACE-${suffix}`;
  let planId = null;
  try {
    const inserted = await query(
      `INSERT INTO dispatch_plans (plan_date, status, note, revision)
       SELECT candidate.day::date, 'draft', $1, 1
         FROM generate_series(DATE '2099-01-01', DATE '2099-12-31', INTERVAL '1 day') candidate(day)
        WHERE NOT EXISTS (
          SELECT 1 FROM dispatch_plans existing WHERE existing.plan_date = candidate.day::date
        )
        ORDER BY candidate.day
        LIMIT 1
       RETURNING id, plan_date::text AS plan_date`,
      [`derived retirement race ${suffix}`]
    );
    assert.equal(inserted.rowCount, 1, "The isolated fixture needs one unused plan date.");
    planId = String(inserted.rows[0].id);
    const planDate = String(inserted.rows[0].plan_date).slice(0, 10);
    const members = memberRefs.map((id, index) => ({
      id,
      type: "SO",
      sourceTable: "sales_orders",
      customer: `Race member ${index + 1}`,
      sourceYard: index === 0 ? "2967" : "3445",
      pickupLocations: [index === 0 ? "2967" : "3445"],
      address: "1 Retirement Race Road",
      eligible: true,
      netsuiteActive: true,
      raw: { outbound_location: index === 0 ? "2967" : "3445" },
      items: [{ sku: `RACE-${index + 1}`, quantity: 1 }]
    }));
    const group = {
      ...members[0],
      id: groupRef,
      customer: "2 race orders grouped",
      sourceYard: "2967",
      pickupLocations: ["2967", "3445"],
      childOrders: memberRefs,
      childOrderDetails: members,
      planOwned: true
    };
    await upsertDispatchOrderCatalog({ orders: members, source: "retirement-race-members" });

    const plan = {
      id: planId,
      planDate,
      revision: 1,
      orders: [group],
      trucks: [{
        id: `TRUCK-${suffix}`,
        plate: `RACE-${suffix.slice(0, 4)}`,
        loads: [{
          id: `LOAD-${suffix}`,
          name: "Race load",
          stops: [{ id: `STOP-${suffix}`, type: "drop", orderId: groupRef }]
        }]
      }]
    };

    for (let round = 0; round < 40; round += 1) {
      plan.revision = round + 1;
      // Every round after the first intentionally recreates the same derived
      // ref so the race can be replayed. Mark that setup as an explicit
      // reactivation; ordinary stale snapshots must continue to be rejected.
      await syncDispatchDeliveryGroupsFromPlan(plan, {
        reactivatedGlobalOrderRefs: round === 0 ? [] : [groupRef]
      });
      assert.equal((await getDispatchOrderCatalogOrder(groupRef))?.globalGroupDefinition, true);

      const operations = [
        () => upsertDispatchOrderCatalog({
          orders: [group],
          source: `delayed-retirement-race-${round}`
        }),
        () => deactivateDispatchGlobalOrderDefinitions([groupRef])
      ];
      if (round % 2) {
        operations.reverse();
      }
      await Promise.all(operations.map((operation) => operation()));

      assert.equal(
        (await query(
          "SELECT active FROM dispatch_global_order_groups WHERE lower(group_ref) = lower($1)",
          [groupRef]
        )).rows[0]?.active,
        false,
        `Round ${round}: the group definition must remain retired.`
      );
      assert.equal(
        (await query(
          "SELECT count(*)::int AS count FROM dispatch_order_catalog_entries WHERE lower(order_ref) = lower($1)",
          [groupRef]
        )).rows[0].count,
        0,
        `Round ${round}: no stale catalog shadow may survive.`
      );
      assert.equal(await getDispatchOrderCatalogOrder(groupRef), null);
      assert.equal(
        (await listDispatchOrderPool({ type: "SO", search: groupRef, limit: 20 })).orders.length,
        0
      );
    }
  } finally {
    await deactivateDispatchGlobalOrderDefinitions([groupRef]).catch(() => null);
    await query(
      "DELETE FROM dispatch_order_catalog_entries WHERE lower(order_ref) = ANY($1::text[])",
      [[groupRef, ...memberRefs].map((ref) => ref.toLowerCase())]
    ).catch(() => null);
    if (planId) {
      await query("DELETE FROM dispatch_plans WHERE id = $1", [planId]).catch(() => null);
    }
  }
});

test("exported stale sync cannot outrun retirement for groups, splits, or consolidations", async () => {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
  let planId = null;
  const definitionRefs = [];
  try {
    const inserted = await query(
      `INSERT INTO dispatch_plans (plan_date, status, note, revision)
       SELECT candidate.day::date, 'draft', $1, 1
         FROM generate_series(DATE '2100-01-01', DATE '2100-12-31', INTERVAL '1 day') candidate(day)
        WHERE NOT EXISTS (
          SELECT 1 FROM dispatch_plans existing WHERE existing.plan_date = candidate.day::date
        )
        ORDER BY candidate.day
        LIMIT 1
       RETURNING id, plan_date::text AS plan_date`,
      [`sync versus retirement race ${suffix}`]
    );
    assert.equal(inserted.rowCount, 1, "The race fixture needs one isolated plan date.");
    planId = String(inserted.rows[0].id);
    const planDate = String(inserted.rows[0].plan_date).slice(0, 10);
    const members = [1, 2].map((index) => ({
      id: `SO-SYNC-RACE-${suffix}-${index}`,
      type: "SO",
      sourceTable: "sales_orders",
      customer: `Sync race member ${index}`,
      sourceYard: index === 1 ? "3445" : "2967",
      pickupLocations: [index === 1 ? "3445" : "2967"],
      address: "1 Sync Retirement Race Road",
      eligible: true,
      netsuiteActive: true,
      items: [{ sku: `SYNC-RACE-${index}`, quantity: 1 }]
    }));
    const group = {
      ...members[0],
      id: `GO-SYNC-RACE-${suffix}`,
      customer: "2 sync race orders grouped",
      childOrders: members.map((member) => member.id),
      childOrderDetails: members,
      groupPlanId: planId,
      groupPlanDate: planDate,
      planOwned: true
    };
    const splitParent = {
      ...members[0],
      id: `TO-SYNC-RACE-${suffix}`,
      type: "TO"
    };
    const split = {
      ...splitParent,
      id: `${splitParent.id}-S1`,
      originalOrderId: splitParent.id,
      salesQty: 1,
      planOwned: true
    };
    const consolidation = {
      ...splitParent,
      id: `TO-DRAFT-SYNC-RACE-${suffix}`,
      sourceOrderId: members[0].id,
      globalOrderDefinitionKind: "consolidation",
      planOwned: true
    };
    const cases = [
      { label: "group", order: group },
      { label: "split", order: split },
      { label: "consolidation", order: consolidation }
    ];
    definitionRefs.push(...cases.map(({ order }) => order.id));

    const definitionState = async (orderRef) => {
      const result = await query(
        `SELECT definition_kind, active
           FROM (
             SELECT group_ref AS order_ref, 'group'::text AS definition_kind, active
               FROM dispatch_global_order_groups
             UNION ALL
             SELECT split_ref AS order_ref, definition_kind, active
               FROM dispatch_global_order_splits
           ) definition
          WHERE lower(order_ref) = lower($1)`,
        [orderRef]
      );
      assert.equal(result.rowCount, 1, `Expected exactly one durable definition for ${orderRef}.`);
      return result.rows[0];
    };

    let revision = 1;
    for (const fixture of cases) {
      for (const launchOrder of ["sync-first", "retire-first"]) {
        for (let round = 0; round < 6; round += 1) {
          const plan = {
            id: planId,
            planDate,
            revision: revision += 1,
            orders: [fixture.order],
            trucks: []
          };
          await syncDispatchDeliveryGroupsFromPlan(plan, {
            reactivatedGlobalOrderRefs: [fixture.order.id]
          });
          assert.equal((await definitionState(fixture.order.id)).active, true);

          const staleSync = () => syncDispatchDeliveryGroupsFromPlan({
            ...plan,
            revision: revision += 1
          });
          const retire = () => deactivateDispatchGlobalOrderDefinitions([fixture.order.id]);
          await Promise.all(launchOrder === "sync-first"
            ? [staleSync(), retire()]
            : [retire(), staleSync()]);

          const finalState = await definitionState(fixture.order.id);
          assert.equal(finalState.definition_kind, fixture.label);
          assert.equal(
            finalState.active,
            false,
            `${fixture.label} ${launchOrder} round ${round}: retirement must win over a stale exported sync`
          );
        }
      }
    }
  } finally {
    await deactivateDispatchGlobalOrderDefinitions(definitionRefs).catch(() => null);
    await query(
      "DELETE FROM dispatch_order_catalog_entries WHERE lower(order_ref) = ANY($1::text[])",
      [definitionRefs.map((ref) => ref.toLowerCase())]
    ).catch(() => null);
    await query(
      "DELETE FROM dispatch_global_order_splits WHERE lower(split_ref) = ANY($1::text[])",
      [definitionRefs.map((ref) => ref.toLowerCase())]
    ).catch(() => null);
    await query(
      "DELETE FROM dispatch_global_order_groups WHERE lower(group_ref) = ANY($1::text[])",
      [definitionRefs.map((ref) => ref.toLowerCase())]
    ).catch(() => null);
    if (planId) {
      await query("DELETE FROM dispatch_plans WHERE id = $1", [planId]).catch(() => null);
    }
  }
});
