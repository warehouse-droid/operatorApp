import assert from "node:assert/strict";
import test, { after } from "node:test";
import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { createDispatchPlan, saveDispatchPlanSnapshot } from "../../../src/dispatch-plan-repository.js";
import { syncDispatchDeliveryGroupsFromPlan } from "../../../src/dispatch-delivery-group-repository.js";
import { syncDispatchPlanOrderAssignments } from "../../../src/dispatch-planner-v2-repository.js";

after(closeDb);
async function isolated(run) {
  const rollback = await beginRollbackContext();
  try { await rollback.run(run); } finally { await rollback.rollback(); }
}

const members = ["SO-UNGROUP-ELSEWHERE-1", "SO-UNGROUP-ELSEWHERE-2"];
const groupRef = "GSO-UNGROUP-ELSEWHERE-1-2";
const order = (id) => ({ id, type: "SO", customer: id, address: "1 Regroup Road", pickupLocations: ["3445"],
  sourceYard: "3445", items: [{ itemId: 1, sku: "R", quantity: 1 }] });
const group = (plan, extra = {}) => ({ ...order(groupRef), childOrders: members, childOrderDetails: members.map(order),
  groupPlanId: String(plan.id), groupPlanDate: plan.planDate, planOwned: true, ...extra });

const definition = () => query(`SELECT active, source_plan_id, source_plan_date::text AS source_plan_date,
  full_order->>'note' AS note FROM dispatch_global_order_groups WHERE group_ref = $1`, [groupRef]).then(result => result.rows[0]);

// A group on another date's truck cannot be retired from this date: that plan
// would hold a retired group and every later save of it would be refused.
async function plannedOnAnotherDate({ onTruck }) {
  for (const [index, ref] of members.entries()) {
    await query(`INSERT INTO sales_orders(netsuite_id,tranid,customer,status,status_text,fulfillment_status,
      outbound_location_id,outbound_location,sales_order_type,operator_status,local_yard_order_status,netsuite_active)
      VALUES($1,$2,'Regroup','B','Pending Fulfillment','not_fulfilled',1,'3445','Delivery','open','Open',true)`,
    [8_900_201 + index, ref]);
  }
  const owner = await createDispatchPlan({ planDate: "2097-05-03" });
  const trucks = [{ id: "owner-truck", plate: "TEST-OWNER", loads: [{ id: "owner-load", name: "Load 1",
    stops: onTruck ? [{ id: "owner-group-drop", type: "drop", orderId: groupRef, location: "1 Regroup Road" }] : [] }] }];
  const planned = { ...owner, orders: [group(owner)], trucks };
  await query("UPDATE dispatch_plan_snapshots SET orders=$2::jsonb, trucks=$3::jsonb WHERE plan_id=$1",
    [owner.id, JSON.stringify(planned.orders), JSON.stringify(trucks)]);
  await syncDispatchDeliveryGroupsFromPlan(planned);
  await syncDispatchPlanOrderAssignments(planned);
  const other = await createDispatchPlan({ planDate: "2097-05-04" });
  return { owner, other };
}

test("ungrouping from another date is refused while the group is on a truck there", () => isolated(async () => {
  const { other } = await plannedOnAnotherDate({ onTruck: true });
  await assert.rejects(saveDispatchPlanSnapshot(other.id, { planDate: other.planDate, baseRevision: other.revision,
    orders: members.map(order), trucks: [], summary: {}, retiredGlobalOrderRefs: [groupRef] }),
  error => error.status === 409 && error.code === "DISPATCH_GROUP_PLANNED_ELSEWHERE" && /2097-05-03/u.test(error.message));
  assert.equal((await definition()).active, true);
}));

test("ungrouping from another date still works when the group is not on a truck", () => isolated(async () => {
  const { other } = await plannedOnAnotherDate({ onTruck: false });
  await saveDispatchPlanSnapshot(other.id, { planDate: other.planDate, baseRevision: other.revision,
    orders: members.map(order), trucks: [], summary: {}, retiredGlobalOrderRefs: [groupRef] });
  assert.equal((await definition()).active, false);
}));
