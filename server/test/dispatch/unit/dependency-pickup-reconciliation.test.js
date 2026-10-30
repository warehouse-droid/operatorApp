import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { reconcileDependencyManagedPickups } from "../../../src/scm-dependency-plan-reconciler.js";
import { validateDispatchPickupVisits } from "../../../src/dispatch-pickup-visits.js";

const target = "GOA-SYNTHETIC-A-B";
const stops = plan => plan.trucks[0].loads[0].stops;
function fixture() {
  const children = ["SO-TEST-A-S1", "SO-TEST-B-S1"].map(id => ({
    id, type: "SO", sourceYard: "3445", pickupLocations: ["3445"]
  }));
  return {
    orders: [{ id: target, type: "SO", sourceYard: "3445", pickupLocations: ["3445", "2967"],
      childOrders: children.map(child => child.id), childOrderDetails: children,
      directPickupManifest: [{ location: "2967", transferOrderRef: "TO-TEST" }] }],
    trucks: [{ id: "truck", loads: [{ id: "load", pickupVisitSchemaVersion: 1, stops: [
      { id: "native", type: "pick", location: "3445", orderId: target, orderRefs: [target] },
      { id: "transfer", type: "pick", location: "2967", orderId: target, orderRefs: [target], note: "keep shared note" },
      { id: "drop", type: "drop", orderId: target }
    ] }] }]
  };
}
function refreshed(plan) {
  return plan.orders.map(order => order.id === target
    ? { ...order, pickupLocations: ["3445"], directPickupManifest: [] } : order);
}
function reconcile(plan, options = {}) {
  return reconcileDependencyManagedPickups({ plan, enrichedOrders: refreshed(plan), affectedTargetRefs: [target],
    reconcileExplicitPickupAllocations: true, ...options });
}

test("ordinary projection retains invalid manual pickups for validation", () => {
  const plan = fixture();
  const result = reconcile(plan, { reconcileExplicitPickupAllocations: false });
  assert.deepEqual(stops(result), stops(plan));
  assert.ok(validateDispatchPickupVisits(result).some(conflict => conflict.code === "DISPATCH_PICKUP_ORDER_WRONG_YARD"));
});

test("obsolete explicit direct-TO pickup is removed for a grouped target", () => {
  const plan = fixture(), before = structuredClone(plan);
  assert.deepEqual(validateDispatchPickupVisits(plan), []);
  const result = reconcile(plan);
  assert.deepEqual(stops(result).map(stop => stop.id), ["native", "drop"]);
  assert.deepEqual(validateDispatchPickupVisits(result), []);
  assert.deepEqual(plan, before);
  assert.deepEqual(reconcile(result), result);
});

test("shared obsolete pickup retains other orders and correct primary reference", () => {
  const plan = fixture();
  plan.orders.push({ id: "OTHER", type: "SO", pickupLocations: ["2967"] });
  Object.assign(stops(plan)[1], { orderRefs: [target, "OTHER"], dependencyTargetRefs: [target, "OTHER"] });
  stops(plan).push({ id: "other-drop", type: "drop", orderId: "OTHER" });
  const result = reconcile(plan), shared = stops(result).find(stop => stop.id === "transfer");
  assert.deepEqual(shared, { ...stops(plan)[1], orderId: "OTHER", orderRefs: ["OTHER"], dependencyTargetRefs: ["OTHER"] });
  assert.deepEqual(validateDispatchPickupVisits(result), []);
});

test("newly required group is allocated to an existing explicit shared pickup", () => {
  const plan = fixture();
  plan.orders.push({ id: "OTHER", type: "SO", pickupLocations: ["2967"] });
  Object.assign(stops(plan)[1], { orderId: "OTHER", orderRefs: ["OTHER"] });
  stops(plan).push({ id: "other-drop", type: "drop", orderId: "OTHER" });
  const result = reconcile(plan, { enrichedOrders: plan.orders });
  assert.deepEqual(stops(result)[1].orderRefs, ["OTHER", target]);
  assert.deepEqual(validateDispatchPickupVisits(result), []);
  assert.equal(stops(result).filter(stop => stop.location === "2967").length, 1);
});

test("unrelated and unknown explicit pickup references remain untouched", () => {
  const plan = fixture();
  stops(plan)[1].orderRefs.push("UNKNOWN");
  const result = reconcile(plan);
  assert.deepEqual(stops(result)[1].orderRefs, ["UNKNOWN"]);
  assert.ok(validateDispatchPickupVisits(result).some(conflict => conflict.code === "DISPATCH_PICKUP_ORDER_NOT_IN_LOAD"));
  assert.deepEqual(stops(reconcile(plan, { affectedTargetRefs: [target, "UNKNOWN"] }))[1].orderRefs, ["UNKNOWN"]);
  assert.deepEqual(reconcile(plan, { affectedTargetRefs: [] }).trucks, plan.trucks);
});

test("repeat yard visits retain the group's existing allocation without duplicating it", () => {
  const plan = fixture();
  plan.orders.push({ id: "OTHER", type: "SO", pickupLocations: ["2967"] });
  stops(plan).unshift({ id: "earlier-shared", type: "pick", location: "2967", orderId: "OTHER", orderRefs: ["OTHER"] });
  stops(plan).push({ id: "other-drop", type: "drop", orderId: "OTHER" });
  const result = reconcile(plan, { enrichedOrders: plan.orders });
  assert.deepEqual(stops(result), stops(plan));
  assert.deepEqual(validateDispatchPickupVisits(result), []);
});

test("native child, remaining manifest and zero-cargo configured yards are preserved", () => {
  for (const configure of [
    order => { order.childOrderDetails[1].sourceYard = "2967"; order.childOrderDetails[1].pickupLocations = ["2967"]; },
    order => { order.directPickupManifest = [{ location: "2967", transferOrderRef: "OTHER-TO" }]; },
    order => { order.poPickupManifest = [{ location: "2967", poOrderRef: "PO-TEST" }]; },
    order => { order.pickupLocations = ["3445", "2967"]; order.items = []; }
  ]) {
    const plan = fixture(), enrichedOrders = refreshed(plan);
    configure(enrichedOrders[0]);
    const result = reconcile(plan, { enrichedOrders });
    assert.deepEqual(stops(result), stops(plan));
    assert.deepEqual(validateDispatchPickupVisits(result), []);
  }
});

test("started pickup, active travel and completed prefix are never pruned", () => {
  for (const activity of [
    { status: "in_progress", stop_id: "transfer", stop_type: "pickup" },
    { status: "complete", stop_id: "drop", stop_type: "dropoff" },
    { status: "in_progress", stop_id: "travel", stop_type: "travel", job_details: { toStopId: "transfer" } }
  ]) {
    const plan = fixture();
    assert.deepEqual(stops(reconcile(plan, { activity: [{ load_id: "load", ...activity }] })), stops(plan));
  }
});

test("generated shared visits retain exactly the still-valid references and are idempotent", () => {
  fc.assert(fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 20 }), required => {
    const plan = fixture();
    plan.orders = required.map((keep, index) => ({ id: `SO-${index}`, type: "SO", pickupLocations: keep ? ["2967"] : ["3445"] }));
    const references = plan.orders.map(order => order.id);
    plan.trucks[0].loads[0].stops = [
      { id: "shared", type: "pick", location: "2967", orderId: references[0], orderRefs: references },
      ...references.map(orderId => ({ id: `drop-${orderId}`, type: "drop", orderId }))
    ];
    const options = { enrichedOrders: plan.orders, affectedTargetRefs: references };
    const result = reconcile(plan, options), visit = stops(result).find(stop => stop.id === "shared");
    const retained = references.filter((_, index) => required[index]);
    assert.deepEqual(visit?.orderRefs || [], retained);
    if (retained.length) { assert.equal(visit.orderId, retained[0]); }
    assert.deepEqual(validateDispatchPickupVisits(result), []);
    assert.deepEqual(reconcile(result, options), result);
  }), { seed: 1072410878, numRuns: 120 });
});
