import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createDispatchV2Fixture } from "../support/dispatch-v2-fixture.js";
import { query } from "../../../src/db.js";
import { deactivateDispatchGlobalOrderDefinitions, syncDispatchDeliveryGroupsFromPlan }
  from "../../../src/dispatch-delivery-group-repository.js";

let fixture;
const planIds = [];
before(async () => { fixture = await createDispatchV2Fixture(); });
after(async () => {
  try {
    if (fixture) { await query("DELETE FROM dispatch_plan_edit_leases WHERE operator_id=$1", [fixture.operator.id]); }
    await query("DELETE FROM dispatch_global_order_groups WHERE group_ref=$1", ["GOA-REGROUP-HTTP"]);
    await query("DELETE FROM dispatch_audit_log WHERE plan_id=ANY($1::bigint[])", [planIds]);
    await query("DELETE FROM dispatch_plans WHERE id=ANY($1::bigint[])", [planIds]);
  } finally { await fixture?.close(); }
});

test("HTTP: unassigned cross-date regroup acknowledgement allows the next ordinary save", async () => {
  const owner = await fixture.seedPlan({ date: "2097-11-28", refs: [] });
  planIds.push(owner.id);
  const target = await fixture.seedPlan({ date: "2097-11-29", refs: [] });
  planIds.push(target.id);
  const children = [1, 2].map(index => ({ id: `SO-REGROUP-HTTP-${index}`, type: "SO",
    sourceYard: "2967", pickupLocations: ["2967"], address: "1 HTTP Test Road",
    items: [{ sku: `REGROUP-HTTP-${index}`, quantity: index }], eligible: true, netsuiteActive: true }));
  const group = { ...children[0], id: "GOA-REGROUP-HTTP", childOrders: children.map(child => child.id),
    childOrderDetails: children, items: children.flatMap(child => child.items), planOwned: true };
  await syncDispatchDeliveryGroupsFromPlan({ id: owner.id, planDate: owner.plan_date,
    orders: [{ ...group, groupPlanId: owner.id }], trucks: [] });
  await deactivateDispatchGlobalOrderDefinitions([group.id]);
  const lease = await fixture.acquireLease({ planDate: target.plan_date, sessionId: "regroup-http" });
  const bootstrap = await fixture.request(`/api/dispatch/v2/bootstrap?planId=${target.id}&date=${target.plan_date}`);
  assert.equal(bootstrap.response.status, 200);
  let current = bootstrap.payload.plan;
  const payload = { planDate: target.plan_date, orders: [{ ...group, groupPlanId: target.id,
    groupPlanDate: target.plan_date }], trucks: [], summary: {} };
  async function save(commandId, extra = {}) {
    return fixture.request(`/api/dispatch/v2/plans/${target.id}/commands`, {
      method: "POST", headers: { "x-dispatch-edit-lease": lease },
      body: { commandId, baseRevision: current.revision, baseDigest: current.digest,
        sessionId: fixture.leaseSession(lease), commandType: "replace_plan", payload: { ...payload, ...extra } }
    });
  }
  const recreated = await save("regroup-http-recreate", { reactivatedGlobalOrderRefs: [group.id] });
  assert.equal(recreated.response.status, 200, JSON.stringify(recreated.payload));
  assert.notEqual(recreated.payload.applied, false);
  current = recreated.payload.plan;
  assert.equal((await query("SELECT active FROM dispatch_global_order_groups WHERE group_ref=$1", [group.id])).rows[0].active,
    true, "An HTTP success must also persist the explicitly recreated definition");
  const ordinary = await save("regroup-http-ordinary");
  assert.equal(ordinary.response.status, 200, JSON.stringify(ordinary.payload));
  assert.notEqual(ordinary.payload.applied, false);
  assert.equal(ordinary.payload.plan.revision, current.revision + 1);
  const stored = await query("SELECT orders FROM dispatch_plan_snapshots WHERE plan_id=$1", [target.id]);
  assert.deepEqual(stored.rows[0].orders.find(order => order.id === group.id).childOrders, group.childOrders);
});
