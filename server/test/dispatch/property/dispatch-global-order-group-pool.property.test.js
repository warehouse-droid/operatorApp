import assert from "node:assert/strict";
import test, { after } from "node:test";
import fc from "fast-check";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import {
  deactivateDispatchGlobalOrderDefinitions,
  syncDispatchDeliveryGroupsFromPlan
} from "../../../src/dispatch-delivery-group-repository.js";
import {
  listDispatchOrderPool,
  upsertDispatchOrderCatalog
} from "../../../src/dispatch-order-catalog-repository.js";

after(closeDb);

test("global group property: arbitrary SO/PO/TO members are replaced by one searchable group and restored on retirement", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const seededPlan = await query(
        `INSERT INTO dispatch_plans (plan_date, status, note, revision)
         VALUES ('2096-08-28', 'draft', 'global group property', 1)
         RETURNING id`
      );
      let run = 0;
      await fc.assert(fc.asyncProperty(
        fc.record({
          memberCount: fc.integer({ min: 2, max: 5 }),
          type: fc.constantFrom("SO", "PO", "TO")
        }),
        async ({ memberCount, type }) => {
          run += 1;
          const groupRef = `G${type}-PROPERTY-${run}`;
          const memberRefs = Array.from(
            { length: memberCount },
            (_, index) => `${type}-PROPERTY-${run}-${index + 1}`
          );
          const members = memberRefs.map((id, index) => ({
            id,
            type,
            customer: `Property member ${index + 1}`,
            address: "1 Property Road",
            pickupLocations: ["12441"],
            items: [{ sku: `PROPERTY-${run}-${index + 1}` }]
          }));
          await upsertDispatchOrderCatalog({ orders: members, source: "global-group-property" });
          const group = {
            ...members[0],
            id: groupRef,
            customer: `${memberCount} orders grouped`,
            childOrders: memberRefs,
            childOrderDetails: members,
            groupPlanId: String(seededPlan.rows[0].id),
            groupPlanDate: "2096-08-28",
            planOwned: true
          };
          const plan = {
            id: String(seededPlan.rows[0].id),
            planDate: "2096-08-28",
            revision: run,
            orders: [group],
            trucks: []
          };
          await syncDispatchDeliveryGroupsFromPlan(plan);

          const grouped = await listDispatchOrderPool({ type, search: groupRef, limit: 20 });
          assert.deepEqual(grouped.orders.map((order) => order.id), [groupRef]);
          assert.deepEqual(grouped.orders[0].childOrders, memberRefs);
          for (const memberRef of memberRefs) {
            assert.deepEqual(
              (await listDispatchOrderPool({ type, search: memberRef, limit: 20 }))
                .orders.map((order) => order.id),
              [groupRef]
            );
          }

          await syncDispatchDeliveryGroupsFromPlan({ ...plan, revision: run + 1, orders: [] });
          assert.deepEqual(
            (await listDispatchOrderPool({ type, search: groupRef, limit: 20 })).orders.map((order) => order.id),
            [groupRef],
            "A compact plan omission is only an unassignment."
          );
          await deactivateDispatchGlobalOrderDefinitions([groupRef]);
          assert.equal(
            (await listDispatchOrderPool({ type, search: groupRef, limit: 20 })).orders.length,
            0
          );
          for (const memberRef of memberRefs) {
            assert.deepEqual(
              (await listDispatchOrderPool({ type, search: memberRef, limit: 20 }))
                .orders.map((order) => order.id),
              [memberRef]
            );
          }
        }
      ), { numRuns: 12 });
    });
  } finally {
    await rollback.rollback();
  }
});
