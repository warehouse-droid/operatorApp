import assert from "node:assert/strict";
import test, { after } from "node:test";
import { closeDb, query } from "../../../src/db.js";
import { loadDispatchOrdersForResponse, assertNoRestrictedScmDispatchOrders } from "../../../src/server.js";
import { scenario, completeDriver } from "../support/fulfilled-so-fixture.js";
import { seedTransfer } from "../support/fulfilled-to-fixture.js";
import { listFulfilledTransferStates, assertTransferPlanningAllowed } from "../../../src/dispatch-fulfilled-to-repository.js";
after(closeDb);

test("NetSuite Received TO remains Completed and can be planned with its original cargo", () => scenario(async () => {
  const ref = "TO-CLEANUP-PLAN-G";
  await seedTransfer(827150001, ref);
  const orders = await loadDispatchOrdersForResponse({ type: "TO", search: ref, includeCompletedScmSearch: true });
  const order = orders.find(row => row.id === ref);
  assert.ok(order, "Explicit search includes the received transfer");
  await assertNoRestrictedScmDispatchOrders([ref]);
  assert.equal(order.dispatchCompletionStatus, "completed");
  assert.equal(order.dispatchFulfilledTransferPlanningEligible, true, "Receipt reconciliation must leave physical delivery pending planable");
  assert.equal(order.dispatchPlanningRestricted, false);
  assert.equal(order.items[0].quantity, 40, "Receiving completion must not erase outbound cargo");
  await assertNoRestrictedScmDispatchOrders([ref]);
}));

test("TO local delivery blocks planning even when an earlier search allowed it", () => scenario(async () => {
  const ref = "TO-CLEANUP-PLAN-DRIVER";
  await seedTransfer(827150002, ref);
  await completeDriver(ref);
  const orders = await loadDispatchOrdersForResponse({ type: "TO", search: ref, includeCompletedScmSearch: true });
  const order = orders.find(row => row.id === ref);
  assert.ok(order);
  assert.equal(order.dispatchFulfilledTransferPlanningEligible, false);
  assert.equal(order.dispatchPlanningRestricted, true);
  await assert.rejects(assertNoRestrictedScmDispatchOrders([ref]));
}));

test("TO Held and manual completion remain restricted after NetSuite receipt", () => scenario(async () => {
  for (const [i, scheduleStatus] of ["Hold", "Completed"].entries()) {
    const ref = `TO-CLEANUP-PLAN-GUARD-${i}`;
    await seedTransfer(827150010 + i, ref, { scheduleStatus, updatedBy: "operator" });
    if (scheduleStatus === "Completed") await query(`INSERT INTO dispatch_order_completion_events
      (order_kind,order_ref,dispatch_completed_at,completion_evidence_type,completion_evidence_id,actor_type,actor_id,reason)
      VALUES ('TO',$1,now(),'manual_dispatch',$1,'operator','to-cleanup-test','Physical delivery confirmed manually')`, [ref]);
    await assert.rejects(assertNoRestrictedScmDispatchOrders([ref]));
    assert.equal((await query("SELECT status FROM scm_transport_schedule WHERE order_ref=$1", [ref])).rows[0].status, scheduleStatus);
  }
}));

test("TO group and split planning use every current member and keep sibling delivery isolated", () => scenario(async () => {
  const parent = "TO-CLEANUP-PARENT", child1 = `${parent}-S1`, child2 = `${parent}-S2`;
  await seedTransfer(827150020, parent);
  for (const [index, ref] of [child1, child2].entries()) {
    const id = -827150021 - index;
    await seedTransfer(id, ref, { status: "B", scheduleStatus: "Queued" });
    await query("INSERT INTO dispatch_scm_to_splits (source_to_id,source_to_ref,split_to_id,split_to_ref,status) VALUES ($1,$2,$3,$4,'active')", [827150020, parent, id, ref]);
  }
  const plan = (await query("INSERT INTO dispatch_plans(plan_date) VALUES ('2096-12-01') RETURNING id")).rows[0];
  const group = "GTO-CLEANUP-SPLITS";
  await query(`INSERT INTO dispatch_global_order_groups(group_ref,order_type,source_plan_id,source_plan_date,full_order,card)
    VALUES ($1,'TO',$2,'2096-12-01','{}','{}')`, [group, plan.id]);
  for (const [i, ref] of [child1, child2].entries()) await query("INSERT INTO dispatch_global_order_group_members(group_ref,member_order_ref,position) VALUES ($1,$2,$3)", [group, ref, i]);
  assert.equal((await listFulfilledTransferStates([group])).get(group.toLowerCase()).eligible, true);
  await completeDriver(child1);
  const states = await listFulfilledTransferStates([parent, child1, child2, group]);
  assert.equal(states.get(parent.toLowerCase()).eligible, true);
  assert.equal(states.get(child2.toLowerCase()).eligible, true);
  assert.equal(states.get(child1.toLowerCase()).eligible, false);
  assert.equal(states.get(group.toLowerCase()).eligible, false);
  await assert.rejects(assertTransferPlanningAllowed([group]), { code: "DISPATCH_TRANSFER_DELIVERY_RESTRICTED" });
  await query("UPDATE dispatch_global_order_groups SET active=false WHERE group_ref=$1", [group]);
  assert.equal((await listFulfilledTransferStates([group])).get(group.toLowerCase()).blocked, true);
}));

test("a global TO group found through its saved definition retains complete-but-planable behavior", () => scenario(async () => {
  const refs = ["TO-CLEANUP-GLOBAL-A", "TO-CLEANUP-GLOBAL-B"], groupRef = "GTO-CLEANUP-GLOBAL";
  for (const [i, ref] of refs.entries()) await seedTransfer(827150030 + i, ref);
  const plan = (await query("INSERT INTO dispatch_plans(plan_date) VALUES ('2096-12-02') RETURNING id")).rows[0];
  const group = { id: groupRef, type: "TO", childOrders: refs, sourceYard: "3445", destinationYard: "12441",
    items: [{ itemId: 827159900, quantity: 80, pallets: 8 }], scm: { status: "Completed", method: "MBT" } };
  await query(`INSERT INTO dispatch_global_order_groups(group_ref,order_type,source_plan_id,source_plan_date,full_order,card,search_text)
    VALUES ($1,'TO',$2,'2096-12-02',$3::jsonb,$3::jsonb,lower($1))`, [groupRef, plan.id, JSON.stringify(group)]);
  for (const [i, ref] of refs.entries()) await query("INSERT INTO dispatch_global_order_group_members(group_ref,member_order_ref,position) VALUES ($1,$2,$3)", [groupRef, ref, i]);
  const orders = await loadDispatchOrdersForResponse({ type: "TO", search: groupRef, exactOrderRefs: [groupRef], includeCompletedScmSearch: true });
  const found = orders.find(row => row.id === groupRef);
  assert.ok(found, "Stored global TO group is discoverable by exact identity");
  assert.equal(found.dispatchFulfilledTransferPlanningEligible, true);
  assert.equal(found.dispatchCompletionStatus, "completed");
  await assertNoRestrictedScmDispatchOrders([groupRef, ...refs]);
  await completeDriver(refs[0]);
  await assert.rejects(assertTransferPlanningAllowed([groupRef]), { code: "DISPATCH_TRANSFER_DELIVERY_RESTRICTED" });
}));
