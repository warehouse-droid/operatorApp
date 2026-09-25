import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { VOYAGE_DISPATCH_YARD, SALES_ORDER_SYNC_LOCATIONS, withVoyageDispatchYard } from "../../../src/dispatch-sales-order-locations.js";
import { dispatchRequiredPickupLocations } from "../../../src/dispatch-load-assignment.js";
import { reconcileDependencyManagedPickups } from "../../../src/scm-dependency-plan-reconciler.js";
import { evaluateExecutedPrefixPolicy } from "../../../src/dispatch-planner-performance.js";
import { materializeDispatchPickupVisits } from "../../../src/dispatch-pickup-visits.js";
import { sovDispatchSourceRefs } from "../../../src/sov-dispatch-repair.js";

export function sovOrder(ref = "SOV02345", extras = {}) {
  return { id: ref, type: "SO", sourceYard: "195", pickupLocations: ["195"],
    address: "20 Test Customer Road", items: [{ itemId: 2836, itemType: "InvtPart", quantity: 39, pallets: 0 }], ...extras };
}

export function sovPlan(orders = [sovOrder()], stops = []) {
  return { id: "test-plan", orders, trucks: [{ id: "truck", loads: [{ id: "load", stops }] }] };
}

function reconcile(plan, activity = []) {
  return reconcileDependencyManagedPickups({ plan, enrichedOrders: plan.orders,
    affectedTargetRefs: plan.orders.map(order => order.id), activity });
}

const drop = (ref = "SOV02345", id = "drop") => ({ id, type: "drop", orderId: ref, location: "Customer" });
const activityAt = (id, status = "in_progress", type = "dropoff", extra = {}) =>
  ({ load_id: "load", stop_id: id, status, stop_type: type, order_refs: ["SOV02345"], ...extra });

test("SOV-01 Voyage is location 4 and has the exact dispatch address", () => {
  assert.deepEqual(VOYAGE_DISPATCH_YARD, { code: "195", name: "195", locationId: 4,
    address: "195 Milner Ave Unit 5, Scarborough, ON M1S 4P4" });
  assert.deepEqual(SALES_ORDER_SYNC_LOCATIONS, [1, 28, 15, 26, 4, 50]);
});

test("SOV-02 saved setup gains Voyage once without changing existing yards", () => {
  const before = [{ code: "3445", address: "Custom existing address", lat: 1 }];
  const after = withVoyageDispatchYard(before);
  assert.equal(after.length, 2);
  assert.deepEqual(after[0], before[0]);
  assert.equal(after[1].locationId, 4);
  assert.deepEqual(withVoyageDispatchYard(after), after);
  assert.equal(before.length, 1);
});

test("SOV-03 ordinary loose stock at 195 requires a native pickup", () => {
  assert.deepEqual(dispatchRequiredPickupLocations({}, sovOrder()), ["195"]);
});

test("SOV-04 pending delivery gains a pickup before delivery and repeat refresh is identical", () => {
  const plan = sovPlan(undefined, [drop()]);
  const next = reconcile(plan);
  assert.deepEqual(next.trucks[0].loads[0].stops.map(stop => stop.type), ["pick", "drop"]);
  assert.equal(next.trucks[0].loads[0].stops[0].location, "195");
  assert.deepEqual(reconcile(next), next);
  assert.deepEqual(plan.trucks[0].loads[0].stops, [drop()]);
});

for (const status of ["in_progress", "complete"]) {
  test(`SOV-05 ${status} delivery is never given a retroactive pickup`, () => {
    const plan = { ...sovPlan(undefined, [drop()]), ownYardCodes: ["195"] };
    const next = reconcile(plan, [activityAt("drop", status)]);
    assert.deepEqual(next, plan);
  });
}

test("SOV-06 repair occurs after completed work and preserves its allocation", () => {
  const first = sovOrder("SOV00001");
  const plan = { ...sovPlan([first, sovOrder()], [
    { id: "old-pick", type: "pick", location: "195", orderId: first.id, orderRefs: [first.id] },
    drop(first.id, "old-drop"), drop()
  ]), ownYardCodes: ["195"] };
  const activity = [activityAt("old-drop", "complete", "dropoff", { order_refs: [first.id] })];
  const next = reconcile(plan, activity);
  assert.deepEqual(next.trucks[0].loads[0].stops.map(stop => stop.type), ["pick", "drop", "pick", "drop"]);
  assert.deepEqual(next.trucks[0].loads[0].stops.slice(0, 2), plan.trucks[0].loads[0].stops.slice(0, 2));
  assert.deepEqual(evaluateExecutedPrefixPolicy({ previousPlan: plan, nextPlan: next, activity }), { allowed: true, conflicts: [] });
});

test("SOV-07 travel already heading to the delivery protects the insertion point", () => {
  const plan = { ...sovPlan(undefined, [drop()]), ownYardCodes: ["195"] };
  assert.deepEqual(reconcile(plan, [activityAt("travel-to-drop", "in_progress", "travel",
    { job_details: { toStopId: "drop" } })]), plan);
});

test("SOV-07b an unresolved active travel target requires review instead of guessing", () => {
  const plan = { ...sovPlan(undefined, [drop()]), ownYardCodes: ["195"] };
  assert.deepEqual(reconcile(plan, [activityAt("unknown-travel", "in_progress", "travel")]), plan);
});

test("SOV-08 a pending shared pickup gets the SOV allocation without duplicates", () => {
  const plan = sovPlan([sovOrder("SOV00001"), sovOrder()], [
    { id: "shared", type: "pick", location: "195", orderId: "SOV00001", orderRefs: ["SOV00001"] },
    drop("SOV00001", "first-drop"), drop()
  ]);
  const next = reconcile(plan);
  assert.deepEqual(next.trucks[0].loads[0].stops[0].orderRefs, ["SOV00001", "SOV02345"]);
  assert.equal(next.trucks[0].loads[0].stops.length, 3);
  assert.deepEqual(reconcile(next), next);
});

test("SOV-09 native cargo selection excludes fees and fully allocated alternate stock", () => {
  const fee = sovOrder("SOV-FEE", { items: [{ itemType: "OthCharge", sku: "Delivery Charge", quantity: 1 }] });
  assert.deepEqual(dispatchRequiredPickupLocations({}, fee), []);
  assert.deepEqual(dispatchRequiredPickupLocations({}, { ...fee, pickupAddressOverride: "10 Alternate Pickup Road" }), ["195"]);
  assert.deepEqual(dispatchRequiredPickupLocations({}, sovOrder("SOV-ALLOC", {
    items: [{ itemId: 2836, itemType: "InvtPart", quantity: 39, poAllocatedSalesQty: 39 }]
  })), []);
});

test("SOV-10 pending pickup repair is idempotent for positive loose quantities", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 10000 }), quantity => {
    const plan = sovPlan([sovOrder("SOV02345", { items: [{ itemType: "InvtPart", quantity }] })], [drop()]);
    const next = reconcile(plan);
    assert.equal(next.trucks[0].loads[0].stops.filter(stop => stop.type === "pick").length, 1);
    assert.deepEqual(reconcile(next), next);
    assert.deepEqual(next.orders, plan.orders);
  }), { seed: 20260914, numRuns: 60 });
});

test("SOV-19 property: completed allocations and an editable suffix stay separate", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 5 }), fc.integer({ min: 1, max: 10000 }),
    (count, quantity) => {
      const oldOrders = Array.from({ length: count }, (_, index) => sovOrder(`SOV0000${index}`));
      const pending = sovOrder("SOV02345", { items: [{ itemType: "InvtPart", quantity }] });
      const stops = [{ id: "recorded-pick", type: "pick", location: "195", orderId: oldOrders[0].id,
        orderRefs: oldOrders.map(order => order.id) }, ...oldOrders.map(order => drop(order.id, order.id)), drop()];
      const plan = sovPlan([...oldOrders, pending], stops);
      const activity = [activityAt(oldOrders.at(-1).id, "complete")];
      const next = reconcile(plan, activity);
      const nextStops = next.trucks[0].loads[0].stops;
      assert.deepEqual(nextStops.slice(0, count + 1), stops.slice(0, count + 1));
      assert.equal(nextStops.length, stops.length + 1);
      assert.deepEqual(nextStops.at(-2).orderRefs, [pending.id]);
      assert.deepEqual(reconcile(next, activity), next);
      const started = [activityAt("drop", "in_progress")];
      assert.deepEqual(reconcile(plan, started), plan);
    }), { seed: 1952026, numRuns: 50 });
});

test("SOV-21 historical compatibility cannot authorize removing a recorded pickup", () => {
  const previousPlan = sovPlan(undefined, [
    { id: "recorded-pick", type: "pick", location: "195", orderId: "SOV02345", orderRefs: ["SOV02345"] }, drop()
  ]);
  previousPlan.trucks[0].loads[0].pickupVisitSchemaVersion = 1;
  const next = structuredClone(previousPlan);
  next.trucks[0].loads[0].stops.shift();
  const result = materializeDispatchPickupVisits(next, { previousPlan, allowLegacyPassthrough: true,
    activity: [activityAt("drop")] });
  assert.ok(result.conflicts.some(conflict => conflict.code === "DISPATCH_PICKUP_ORDER_MISSING"));
});

test("SOV-24 grouped and split SOV orders retain pickup cargo and canonical eligibility", () => {
  const first = sovOrder("SOV02345-S1", { originalOrderId: "SOV02345" });
  const second = sovOrder("SOV02333");
  const group = sovOrder("GOV-02345-02333", { childOrders: [first.id, second.id],
    childOrderDetails: [first, second], items: [...first.items, ...second.items] });
  assert.deepEqual(sovDispatchSourceRefs(first), ["SOV02345"]);
  assert.deepEqual(sovDispatchSourceRefs(group), ["SOV02345", "SOV02333"]);
  for (const order of [first, group]) {
    const plan = sovPlan([order], [drop(order.id)]);
    const next = reconcile(plan);
    assert.deepEqual(next.trucks[0].loads[0].stops.map(stop => stop.type), ["pick", "drop"]);
    assert.deepEqual(next.trucks[0].loads[0].stops[0].orderRefs, [order.id]);
    assert.deepEqual(next.orders, plan.orders);
  }
});

test("SOV-25 setup maintenance backs up settings and adds Voyage exactly once", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sov-setup-"));
  try {
    const setup = path.join(directory, "setup.json");
    const backup = path.join(directory, "backup");
    const before = { ownYards: [{ code: "3445", address: "Existing custom address" }], customSetting: "retain" };
    await fs.writeFile(setup, JSON.stringify(before));
    const run = apply => {
      const result = spawnSync(process.execPath, ["tools/sov-dispatch-maintenance.mjs", "setup", "--setup", setup,
        "--backup-dir", backup, ...(apply ? ["--apply"] : [])], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return JSON.parse(result.stdout);
    };
    assert.equal(run(false).changed, true);
    assert.deepEqual(JSON.parse(await fs.readFile(setup, "utf8")), before);
    assert.equal(run(true).changed, true);
    const saved = JSON.parse(await fs.readFile(setup, "utf8"));
    assert.equal(saved.customSetting, before.customSetting);
    assert.deepEqual(saved.ownYards[0], before.ownYards[0]);
    assert.deepEqual(saved.ownYards[1], VOYAGE_DISPATCH_YARD);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(backup, "dispatch-setup.json"), "utf8")), before);
    assert.equal(run(true).changed, false);
    assert.deepEqual(JSON.parse(await fs.readFile(setup, "utf8")), saved);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
