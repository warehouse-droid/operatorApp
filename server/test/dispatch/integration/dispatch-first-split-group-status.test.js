import assert from "node:assert/strict";
import test, { after } from "node:test";
import { closeDb, query } from "../../../src/db.js";
import { getDispatchOrderCatalogOrder } from "../../../src/dispatch-order-catalog-repository.js";
import {
  assertSalesDeliveryPlanningAllowed, listFulfilledSalesDeliveryStates,
  overlayFulfilledSalesDeliveryPlanning
} from "../../../src/dispatch-fulfilled-so-repository.js";
import { scenario, seedSalesOrder, completeDriver, splitSalesOrder } from "../support/fulfilled-so-fixture.js";

after(closeDb);

async function registerSplit(parent, { suffix = "S1", active = true } = {}) {
  const ref = `${parent}-${suffix}`;
  const order = { id: ref, type: "SO", originalOrderId: parent, scm: { status: "Queued" } };
  await query(`INSERT INTO dispatch_global_order_splits
    (split_ref,order_type,parent_order_ref,source_plan_date,full_order,card,active)
    VALUES ($1,'SO',$2,'2096-10-01',$3::jsonb,$3::jsonb,$4)`, [ref, parent, JSON.stringify(order), active]);
  return ref;
}

const groupFor = childOrders => ({
  id: "GOA-FIRST-SPLIT-STATUS", type: "SO", childOrders, scm: { status: "Queued" },
  childOrderDetails: childOrders.map(id => ({ id, type: "SO", scm: { status: "Queued" } }))
});
const readGroup = async refs => (await overlayFulfilledSalesDeliveryPlanning([groupFor(refs)]))[0];

test("an unplanned group of registered first splits stays queued and available on catalog hydration", () => scenario(async () => {
  const parents = ["SO-FIRST-GROUP-A", "SO-FIRST-GROUP-B"];
  const refs = [];
  for (const [index, parent] of parents.entries()) {
    await seedSalesOrder(817161000 + index, parent, { status: "B" });
    refs.push(await registerSplit(parent));
  }
  const group = groupFor(refs);
  await query(`INSERT INTO dispatch_global_order_groups
    (group_ref,order_type,source_plan_date,full_order,card)
    VALUES ($1,'SO','2096-10-01',$2::jsonb,$2::jsonb)`, [group.id, JSON.stringify(group)]);
  const sourceRows = async () => (await query("SELECT row_to_json(s) AS value FROM sales_orders s WHERE tranid=ANY($1) ORDER BY tranid", [parents])).rows;
  const before = await sourceRows();
  const hydrated = await getDispatchOrderCatalogOrder(group.id);
  assert.equal(hydrated.dispatchPlanningRestricted, false);
  assert.equal(hydrated.dispatchFulfilledSalesPlanningEligible, false);
  assert.equal(hydrated.dispatchCompletionStatus === "completed", false);
  assert.equal(hydrated.scm.status, "Queued");
  assert.ok(hydrated.childOrderDetails.every(child => !child.dispatchPlanningRestricted));
  await assertSalesDeliveryPlanningAllowed(refs);
  assert.deepEqual(await sourceRows(), before);
  assert.equal((await query("SELECT count(*)::int AS count FROM dispatch_plan_order_assignments WHERE order_ref=ANY($1)", [[group.id, ...refs]])).rows[0].count, 0);
  assert.equal((await query("SELECT count(*)::int AS count FROM sales_orders WHERE tranid=ANY($1)", [refs])).rows[0].count, 0);
}));

test("first split identities are resolved with case and surrounding whitespace normalised", () => scenario(async () => {
  const parent = "SO-FIRST-IDENTITY";
  await seedSalesOrder(817161010, parent, { status: "B" });
  const ref = await registerSplit(parent);
  const states = await listFulfilledSalesDeliveryStates([` ${ref.toLowerCase()} `]);
  assert.equal(states.get(ref.toLowerCase())?.blocked, false);
  assert.equal(states.get(ref.toLowerCase())?.locallyCompleted, false);
  assert.equal(states.get(ref.toLowerCase())?.fulfilled, false);
}));

test("first splits inherit current source fulfillment without treating pending members as completed", () => scenario(async () => {
  const refs = [];
  for (const [index, status] of ["F", "G", "B"].entries()) {
    const parent = `SO-FIRST-FULFILLMENT-${status}`;
    await seedSalesOrder(817161020 + index, parent, { status });
    refs.push(await registerSplit(parent));
  }
  const fulfilled = await readGroup(refs.slice(0, 2));
  assert.equal(fulfilled.dispatchFulfilledSalesPlanningEligible, true);
  assert.equal(fulfilled.dispatchPlanningRestricted, false);
  const mixed = await readGroup(refs);
  assert.equal(mixed.dispatchFulfilledSalesPlanningEligible, false);
  assert.equal(mixed.dispatchPlanningRestricted, false);
  assert.equal(mixed.dispatchCompletionStatus === "completed", false);
}));

test("actual driver dropoff of a first split or its source still restricts planning; pickup alone does not", () => scenario(async () => {
  for (const [index, [target, stopType]] of [["split", "pickup"], ["split", "dropoff"], ["source", "dropoff"]].entries()) {
    const parent = `SO-FIRST-DRIVER-${index}`;
    await seedSalesOrder(817161030 + index, parent, { status: "B" });
    const ref = await registerSplit(parent);
    await completeDriver(target === "split" ? ref : parent, { stopType });
    const group = await readGroup([ref]);
    assert.equal(group.dispatchPlanningRestricted, stopType === "dropoff", `${target} ${stopType}`);
    assert.equal(group.dispatchCompletionStatus === "completed", stopType === "dropoff");
    if (stopType === "dropoff") {
      await assert.rejects(assertSalesDeliveryPlanningAllowed([ref]), /completed/i);
    } else {
      await assertSalesDeliveryPlanningAllowed([ref]);
    }
  }
}));

test("manual and dependency completion evidence for first split aliases remains authoritative", () => scenario(async () => {
  for (const [index, kind] of ["manual_dispatch", "direct_dependency"].entries()) {
    const parent = `SO-FIRST-EVIDENCE-${index}`;
    await seedSalesOrder(817161040 + index, parent, { status: "B" });
    const ref = await registerSplit(parent);
    await query(`INSERT INTO dispatch_order_completion_events
      (order_kind,order_ref,dispatch_completed_at,completion_evidence_type,completion_evidence_id,actor_type,actor_id,reason)
      VALUES ('SO',$1,now(),$2,$1,'operator','test','Delivered split')`, [ref, kind]);
    const group = await readGroup([ref]);
    assert.equal(group.dispatchPlanningRestricted, true, kind);
    assert.equal(group.dispatchCompletionStatus, "completed", kind);
    await assert.rejects(assertSalesDeliveryPlanningAllowed([ref]), { code: "DISPATCH_SALES_DELIVERY_RESTRICTED" });
  }
}));

test("a sibling split's delivery does not mark the first split or its group completed", () => scenario(async () => {
  const parent = "SO-FIRST-SIBLING";
  await seedSalesOrder(817161050, parent, { status: "B" });
  const first = await registerSplit(parent);
  await seedSalesOrder(-817161050, `${parent}-S2`, { status: "B" });
  await splitSalesOrder(817161050, parent, -817161050, `${parent}-S2`);
  await completeDriver(`${parent}-S2`);
  const group = await readGroup([first]);
  assert.equal(group.dispatchPlanningRestricted, false);
  assert.equal(group.dispatchCompletionStatus === "completed", false);
  await assertSalesDeliveryPlanningAllowed([first]);
}));

test("unknown, inactive or ambiguous split references still restrict groups", () => scenario(async () => {
  for (const [index, kind] of ["unregistered", "inactive", "missing", "duplicate"].entries()) {
    const parent = `SO-FIRST-UNKNOWN-${kind}`;
    if (kind !== "missing") { await seedSalesOrder(817161060 + index, parent, { status: "B" }); }
    if (kind === "duplicate") { await seedSalesOrder(817161160 + index, parent, { status: "B" }); }
    const ref = kind === "unregistered" ? `${parent}-S1`
      : await registerSplit(parent, { active: kind !== "inactive" });
    const group = await readGroup([ref]);
    assert.equal(group.dispatchPlanningRestricted, true, kind);
    assert.equal(group.dispatchCompletionStatus === "completed", false, kind);
  }
}));

test("source lifecycle and reconciliation restrictions also apply to first split aliases", () => scenario(async () => {
  for (const [index, kind] of ["Hold", "Closed", "missing", "review", "reload"].entries()) {
    const parent = `SO-FIRST-RESTRICT-${kind}`;
    const id = 817161070 + index;
    await seedSalesOrder(id, parent, { status: kind === "Closed" ? "H" : "B", yard: kind === "Hold" ? "Hold" : "Open" });
    const ref = await registerSplit(parent);
    if (kind === "missing") { await query("UPDATE sales_orders SET netsuite_missing_at=now() WHERE netsuite_id=$1", [id]); }
    if (kind === "review") {
      await query(`INSERT INTO scm_reconciliation_order_state
        (order_kind,source_order_netsuite_id,source_order_ref,reconciliation_status,application_status)
        VALUES ('SO',$1,$2,'review','Reconcile Review')`, [id, parent]);
    }
    if (kind === "reload") {
      await query(`INSERT INTO operator_reload_cycles (sales_order_id,order_ref,cycle_number,request_id,reason)
        VALUES ($1,$2,1,'20261001-0000-4000-8000-000000000001','Test reload')`, [id, parent]);
    }
    assert.equal((await readGroup([ref])).dispatchPlanningRestricted, true, kind);
    await assert.rejects(assertSalesDeliveryPlanningAllowed([ref]), { code: "DISPATCH_SALES_DELIVERY_RESTRICTED" });
  }
}));

test("a materialized first split uses its own lifecycle instead of the display alias fallback", () => scenario(async () => {
  const parent = "SO-FIRST-MATERIALIZED";
  await seedSalesOrder(817161080, parent, { status: "F" });
  const first = await registerSplit(parent);
  await seedSalesOrder(-817161080, first, { status: "B", active: false });
  await splitSalesOrder(817161080, parent, -817161080, first, "cancelled");
  const group = await readGroup([first]);
  assert.equal(group.dispatchFulfilledSalesPlanningEligible, false);
  assert.equal(group.dispatchPlanningRestricted, true);
}));
