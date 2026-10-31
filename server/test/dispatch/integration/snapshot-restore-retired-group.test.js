import assert from "node:assert/strict";
import test, { after } from "node:test";
import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { createDispatchPlan, restoreDispatchPlanSnapshot, saveDispatchPlanSnapshot } from "../../../src/dispatch-plan-repository.js";
import { deactivateDispatchGlobalOrderDefinitions } from "../../../src/dispatch-delivery-group-repository.js";

after(closeDb);
async function isolated(run) {
  const rollback = await beginRollbackContext();
  try { await rollback.run(run); } finally { await rollback.rollback(); }
}

const planDate = "2097-04-02";
const members = ["SO-RESTORE-1", "SO-RESTORE-2"];
const groupRef = "GSO-RESTORE-1-2";
const order = (id) => ({ id, type: "SO", customer: id, address: "1 Restore Road", pickupLocations: ["3445"],
  sourceYard: "3445", items: [{ itemId: 1, sku: "R", quantity: 1 }] });

// A snapshot taken before an Ungroup holds a group that the Ungroup retired.
// Restoring it brings the group back when its members are free again.
async function seedUngroupedPlan() {
  for (const [index, ref] of members.entries()) {
    await query(`INSERT INTO sales_orders(netsuite_id,tranid,customer,status,status_text,fulfillment_status,
      outbound_location_id,outbound_location,sales_order_type,operator_status,local_yard_order_status,netsuite_active)
      VALUES($1,$2,'Restore','B','Pending Fulfillment','not_fulfilled',1,'3445','Delivery','open','Open',true)`,
    [8_900_001 + index, ref]);
  }
  const plan = await createDispatchPlan({ planDate });
  const group = { ...order(groupRef), childOrders: members, childOrderDetails: members.map(order),
    groupPlanId: String(plan.id), groupPlanDate: planDate, planOwned: true };
  const grouped = await saveDispatchPlanSnapshot(plan.id, { planDate, baseRevision: plan.revision, orders: [group],
    trucks: [], summary: {} });
  await saveDispatchPlanSnapshot(plan.id, { planDate, baseRevision: grouped.revision, orders: members.map(order),
    trucks: [], summary: grouped.summary });
  await deactivateDispatchGlobalOrderDefinitions([groupRef]);
  const archived = (await query(`SELECT id FROM dispatch_plan_snapshot_history
    WHERE plan_id = $1 AND orders::text LIKE $2 ORDER BY id DESC LIMIT 1`, [plan.id, `%${groupRef}%`])).rows[0];
  assert.ok(archived, "the grouped state must be archived");
  return { plan, historyId: archived.id };
}

const groupActive = () => query("SELECT active FROM dispatch_global_order_groups WHERE group_ref = $1", [groupRef])
  .then((result) => result.rows[0]?.active);

test("restoring a snapshot from before an Ungroup brings the group back", () => isolated(async () => {
  const { historyId } = await seedUngroupedPlan();
  const restored = await restoreDispatchPlanSnapshot(historyId, { sessionId: "restore-retired-group" });
  assert.ok(restored.plan.orders.some((candidate) => candidate.id === groupRef));
  assert.equal(await groupActive(), true);
}));

test("restore stays refused while a member now belongs to another group", () => isolated(async () => {
  const { plan, historyId } = await seedUngroupedPlan();
  await query(`INSERT INTO dispatch_global_order_groups(group_ref,order_type,source_plan_id,source_plan_date,full_order,card)
    VALUES('GSO-RESTORE-OTHER','SO',$1,$2,'{}'::jsonb,'{}'::jsonb)`, [plan.id, planDate]);
  await query("INSERT INTO dispatch_global_order_group_members(group_ref,member_order_ref,position) VALUES('GSO-RESTORE-OTHER',$1,0)",
    [members[0]]);
  await assert.rejects(restoreDispatchPlanSnapshot(historyId, { sessionId: "restore-retired-group" }),
    { code: "DISPATCH_DERIVED_ORDER_RETIRED" });
  assert.equal(await groupActive(), false);
}));
