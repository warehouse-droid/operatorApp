import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";

import { query } from "../../../src/db.js";
import {
  syncDispatchDeliveryGroupsFromPlan,
  syncDispatchGlobalOrderTransitCo
} from "../../../src/dispatch-delivery-group-repository.js";
import { upsertDispatchOrderCatalog } from "../../../src/dispatch-order-catalog-repository.js";
import { createDispatchV2Fixture } from "../support/dispatch-v2-fixture.js";

let fixture;

before(async () => {
  fixture = await createDispatchV2Fixture();
});

after(async () => {
  await fixture?.close();
});

test("legacy and versioned HTTP feeds expose one global grouped order with current CO pickup metadata", async () => {
  const suffix = crypto.randomUUID().slice(0, 8).toUpperCase();
  const plan = await query(
    `INSERT INTO dispatch_plans (plan_date, status, note, revision)
     VALUES ('2099-08-31', 'draft', $1, 1)
     RETURNING id`,
    [`global HTTP definition ${suffix}`]
  );
  const members = [1, 2].map((index) => ({
    id: `SO-HTTP-GLOBAL-${suffix}-${index}`,
    type: "SO",
    customer: `Global HTTP member ${index}`,
    address: `${index} Global HTTP Road`,
    sourceYard: "2967",
    pickupLocations: ["2967"],
    items: [{ sku: `HTTP-${index}`, quantity: 1 }],
    eligible: true
  }));
  const group = {
    ...members[0],
    id: `GSO-HTTP-GLOBAL-${suffix}`,
    childOrders: members.map((member) => member.id),
    childOrderDetails: members,
    groupPlanId: String(plan.rows[0].id),
    groupPlanDate: "2099-08-31"
  };
  try {
    await upsertDispatchOrderCatalog({ orders: members, source: "global-derived-http-red" });
    await syncDispatchDeliveryGroupsFromPlan({
      id: String(plan.rows[0].id),
      planDate: "2099-08-31",
      revision: 1,
      orders: [group],
      trucks: []
    });
    await syncDispatchGlobalOrderTransitCo({
      sourceOrderRef: group.id,
      co: {
        co_ref: `CO-${group.id}`,
        source_order_ref: group.id,
        from_location: "2967",
        to_location: "12441",
        status: "pending_load"
      }
    });

    const legacy = await fixture.request(
      `/api/dispatch/orders?type=SO&search=${encodeURIComponent(group.id)}`
    );
    assert.equal(legacy.response.status, 200, JSON.stringify(legacy.payload));
    const legacyOrder = legacy.payload.find((order) => order.id === group.id);
    assert.ok(legacyOrder, "The legacy planner feed must read the canonical global definition.");
    assert.equal(legacyOrder.globalGroupDefinition, true);
    assert.equal(legacyOrder.sourceYard, "12441");
    assert.deepEqual(legacyOrder.pickupLocations, ["12441"]);

    const versioned = await fixture.request(
      `/api/dispatch/v2/order-feed/${encodeURIComponent(group.id)}`
    );
    assert.equal(versioned.response.status, 200, JSON.stringify(versioned.payload));
    assert.equal(versioned.payload.order?.id, group.id);
    assert.equal(versioned.payload.order?.globalGroupDefinition, true);
    assert.equal(versioned.payload.order?.sourceYard, "12441");
    assert.deepEqual(versioned.payload.order?.pickupLocations, ["12441"]);
  } finally {
    await query("DELETE FROM dispatch_global_order_groups WHERE group_ref = $1", [group.id]);
    await query(
      "DELETE FROM dispatch_order_catalog_entries WHERE lower(order_ref) = ANY($1::text[])",
      [members.map((member) => member.id.toLowerCase())]
    );
    await query("DELETE FROM dispatch_plans WHERE id = $1", [plan.rows[0].id]);
  }
});
