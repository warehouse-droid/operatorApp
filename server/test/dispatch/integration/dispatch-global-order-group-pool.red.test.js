import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import {
  deactivateDispatchGlobalOrderDefinitions,
  syncDispatchDeliveryGroupsFromPlan
} from "../../../src/dispatch-delivery-group-repository.js";
import {
  getDispatchOrderCatalogOrder,
  listDispatchOrderPool,
  upsertDispatchOrderCatalog
} from "../../../src/dispatch-order-catalog-repository.js";
import { syncDispatchPlanOrderAssignments } from "../../../src/dispatch-planner-v2-repository.js";

after(closeDb);

function truckWithOrders(orderRefs = []) {
  return [{
    id: "global-group-truck",
    plate: "GLOBAL-1",
    driverName: "Global Group Driver",
    loads: [{
      id: "global-group-load",
      name: "Load 1",
      stops: orderRefs.map((orderRef, index) => ({
        id: `global-group-stop-${index}`,
        type: "drop",
        orderId: orderRef
      }))
    }]
  }];
}

test("a grouped order stays globally searchable while its CO and final-delivery assignments remain independent", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const suffix = crypto.randomUUID().slice(0, 8).toUpperCase();
      const memberRefs = [`SO-GLOBAL-${suffix}-1`, `SO-GLOBAL-${suffix}-2`];
      const groupRef = `GO-GLOBAL-${suffix}`;
      const coRef = `CO-${groupRef}`;
      const owner = await query(
        `INSERT INTO dispatch_plans (plan_date, status, note, revision)
         VALUES ('2097-08-28', 'confirmed', $1, 1) RETURNING id`,
        [`global group owner ${suffix}`]
      );
      const next = await query(
        `INSERT INTO dispatch_plans (plan_date, status, note, revision)
         VALUES ('2097-08-29', 'confirmed', $1, 1) RETURNING id`,
        [`global group next ${suffix}`]
      );
      const members = memberRefs.map((id, index) => ({
        id,
        type: "SO",
        customer: `Global member ${index + 1}`,
        address: "1 Global Pool Road",
        pickupLocations: ["12441"],
        items: [{ sku: `GLOBAL-${index + 1}` }]
      }));
      const group = {
        ...members[0],
        id: groupRef,
        customer: "2 orders grouped",
        childOrders: memberRefs,
        childOrderDetails: members,
        groupPlanId: String(owner.rows[0].id),
        groupPlanDate: "2097-08-28",
        planOwned: true
      };
      const co = {
        id: coRef,
        type: "CUSTOM",
        customer: "Transit move",
        address: "12441",
        pickupLocations: ["3445"]
      };
      await upsertDispatchOrderCatalog({ orders: [...members, co], source: "global-group-red" });

      const ownerPlan = {
        id: String(owner.rows[0].id),
        planDate: "2097-08-28",
        revision: 1,
        orders: [group, co],
        trucks: truckWithOrders([coRef])
      };
      await syncDispatchPlanOrderAssignments(ownerPlan);
      await syncDispatchDeliveryGroupsFromPlan(ownerPlan);

      const globalSearch = await listDispatchOrderPool({ type: "SO", search: groupRef, limit: 20 });
      assert.equal(globalSearch.orders.length, 1);
      assert.equal(globalSearch.orders[0].id, groupRef);
      assert.deepEqual(globalSearch.orders[0].childOrders, memberRefs);
      assert.equal(globalSearch.orders[0].dispatchPlanned, false);
      const hydratedGroup = await getDispatchOrderCatalogOrder(groupRef);
      assert.equal(hydratedGroup.globalGroupDefinition, true);
      assert.equal(hydratedGroup.globalGroupSourcePlanId, String(owner.rows[0].id));
      assert.deepEqual(hydratedGroup.childOrders, memberRefs);

      const memberSearch = await listDispatchOrderPool({ type: "SO", search: memberRefs[0], limit: 20 });
      assert.deepEqual(
        memberSearch.orders.map((order) => order.id),
        [groupRef],
        "An active group must replace its raw members in the global pool."
      );
      const coSearch = await listDispatchOrderPool({ search: coRef, limit: 20 });
      assert.equal(coSearch.orders.find((order) => order.id === coRef)?.dispatchPlanned, true);

      const nextPlan = {
        id: String(next.rows[0].id),
        planDate: "2097-08-29",
        revision: 1,
        orders: [group],
        trucks: truckWithOrders([groupRef])
      };
      await syncDispatchPlanOrderAssignments(nextPlan);
      await syncDispatchDeliveryGroupsFromPlan(nextPlan);
      const assignedSearch = await listDispatchOrderPool({ type: "SO", search: groupRef, limit: 20 });
      assert.equal(assignedSearch.orders[0].dispatchPlanned, true);
      assert.equal(assignedSearch.orders[0].dispatchPlanId, String(next.rows[0].id));
      assert.equal(assignedSearch.orders[0].dispatchPlanDate, "2097-08-29");

      await syncDispatchDeliveryGroupsFromPlan(ownerPlan);
      const ownershipAfterStaleOwnerSave = await query(
        `SELECT source_plan_id::text AS source_plan_id
           FROM dispatch_global_order_groups
          WHERE group_ref = $1`,
        [groupRef]
      );
      assert.equal(
        ownershipAfterStaleOwnerSave.rows[0].source_plan_id,
        String(owner.rows[0].id),
        "The source plan is immutable provenance; assignment never owns the global definition."
      );

      const ungroupedNextPlan = { ...nextPlan, orders: [], trucks: truckWithOrders([]) };
      await syncDispatchPlanOrderAssignments(ungroupedNextPlan);
      await syncDispatchDeliveryGroupsFromPlan(ungroupedNextPlan);
      assert.equal(
        (await listDispatchOrderPool({ type: "SO", search: groupRef, limit: 20 })).orders.length,
        1,
        "Removing an assignment must keep the global definition."
      );
      await deactivateDispatchGlobalOrderDefinitions([groupRef]);
      assert.equal(
        (await listDispatchOrderPool({ type: "SO", search: groupRef, limit: 20 })).orders.length,
        0,
        "An explicit ungroup operation must retire the global definition."
      );
      assert.deepEqual(
        (await listDispatchOrderPool({ type: "SO", search: memberRefs[0], limit: 20 }))
          .orders.map((order) => order.id),
        [memberRefs[0]],
        "Retiring a group must expose its eligible raw members again."
      );
    });
  } finally {
    await rollback.rollback();
  }
});
