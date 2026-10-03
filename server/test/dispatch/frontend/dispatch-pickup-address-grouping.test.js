import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import fc from "fast-check";
import { planner } from "./dispatch-required-pickups.test.js";
import { insertDispatchLateOrder, splitDispatchPickupVisit } from "../../../src/dispatch-pickup-visits.js";
import { reconcileDependencyManagedPickups } from "../../../src/scm-dependency-plan-reconciler.js";
import { planJobsForDriver } from "../../../src/driver-repository.js";

const address = "195 Milner Ave, Scarborough, ON M1S 3R1";
const source = readFileSync(new URL("../../../public/dispatch.js", import.meta.url), "utf8");
function order(id, override = "") {
  return { id, type: "SO", sourceYard: "2967", pickupLocations: ["2967"],
    pickupAddressOverride: override, sourceAddress: override || "2967 Kennedy Road, Toronto, ON",
    address: `${id} Customer Road`, pallets: 1,
    items: [{ sku: id, itemType: "InvtPart", quantity: 20, pallets: 1 }] };
}
function stops(ref = "SOA09464") {
  return [{ id: "P", type: "pick", loadId: "LOAD", orderId: ref, orderRefs: [ref], location: "2967" },
    { id: "D", type: "drop", loadId: "LOAD", orderId: ref, location: "2967" }];
}
function plan(orders, entries = stops()) {
  return { id: 340, planDate: "2026-09-29", orders,
    ownYards: [{ code: "2967", address: "2967 Kennedy Road, Toronto, ON" }],
    trucks: [{ id: "T", plate: "BL27129", driver: "Aurther", driverLogin: "aurther", base: "2967",
      loads: [{ id: "LOAD", name: "Load 2", pickupVisitSchemaVersion: 1, stops: entries }] }] };
}
const pickups = (load) => load.stops.filter(stop => stop.type === "pick");

test("SOA09326 card displays the saved physical pickup override", () => {
  const start = source.indexOf("function orderPickupText(");
  const end = source.indexOf("\nfunction ", start + 1);
  const display = Function(`${source.slice(start, end)}; return orderPickupText;`)();
  assert.equal(display(order("SOA09326", address)), address);
  assert.equal(display(order("SOA09464")), "2967");
});

test("adding SOA09326 separates its override from the existing 2967 pickup and Driver manifest", () => {
  const orders = [order("SOA09464"), order("SOA09326", address)];
  const ui = planner(orders, stops());
  assert.equal(ui.addOrderToLoad("SOA09326", "LOAD"), true);
  assert.equal(pickups(ui.load).length, 2);
  assert.deepEqual(pickups(ui.load).map(stop => stop.orderRefs), [["SOA09464"], ["SOA09326"]]);
  assert.ok(pickups(ui.load).every(stop => stop.location === "2967"));
  assert.deepEqual(ui.validate(), []);
  const jobs = planJobsForDriver(plan(orders, ui.load.stops), "aurther").filter(job => job.stopType === "pickup");
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs.map(job => job.orderRefs), [["SOA09464"], ["SOA09326"]]);
  assert.equal(jobs[1].address, address);
});

test("changing one shared pickup override separates future work and remains idempotent", () => {
  const orders = [order("SOA09464"), order("SOA09326", address)];
  const entries = stops();
  entries[0].orderRefs.push("SOA09326");
  entries.push({ ...entries[1], id: "D2", orderId: "SOA09326" });
  const ui = planner(orders, entries);
  ui.cleanupOrphanPickupStops(); ui.syncPickupStops();
  assert.deepEqual(pickups(ui.load).map(stop => stop.orderRefs), [["SOA09464"], ["SOA09326"]]);
  const once = structuredClone(ui.load);
  ui.cleanupOrphanPickupStops(); ui.syncPickupStops();
  assert.deepEqual(ui.load, once);
  assert.deepEqual(ui.validate(), []);
});

test("late-order command honors the physical pickup override", () => {
  const result = insertDispatchLateOrder({ plan: plan([order("SOA09464")]), loadId: "LOAD",
    order: order("SOA09326", address) });
  assert.equal(result.createdPickupStopIds.length, 1);
  assert.deepEqual(pickups(result.plan.trucks[0].loads[0]).map(stop => stop.orderRefs), [["SOA09464"], ["SOA09326"]]);
});

test("SCM reconciliation adds a separate overridden pickup", () => {
  const orders = [order("SOA09464"), order("SOA09326", address)];
  const entries = [...stops(), { ...stops()[1], id: "D2", orderId: "SOA09326" }];
  const result = reconcileDependencyManagedPickups({ plan: plan(orders, entries),
    enrichedOrders: orders, affectedTargetRefs: ["SOA09326"] });
  const visits = pickups(result.trucks[0].loads[0]);
  assert.equal(visits.length, 2);
  assert.deepEqual(visits[1].orderRefs, ["SOA09326"]);
});

test("SCM reconciliation shares an identical override and retains both order allocations", () => {
  const orders = [order("SOA09464", address), order("SOA09326", address.toUpperCase())];
  const entries = [...stops(), { ...stops()[1], id: "D2", orderId: "SOA09326" }];
  const result = reconcileDependencyManagedPickups({ plan: plan(orders, entries),
    enrichedOrders: orders, affectedTargetRefs: ["SOA09326"] });
  const visits = pickups(result.trucks[0].loads[0]);
  assert.equal(visits.length, 1);
  assert.deepEqual(visits[0].orderRefs, ["SOA09464", "SOA09326"]);
});

test("split command rejects merging into a different pickup override", () => {
  const orders = [order("A"), order("B"), order("C", address)];
  const entries = [
    { ...stops("A")[0], orderRefs: ["A", "B"] },
    { ...stops("C")[0], id: "P2" },
    ...orders.map(value => ({ ...stops(value.id)[1], id: `D-${value.id}` }))
  ];
  assert.throws(() => splitDispatchPickupVisit({ plan: plan(orders, entries), loadId: "LOAD",
    stopId: "P", orderRefs: ["B"], targetStopId: "P2" }), { code: "DISPATCH_PICKUP_SPLIT_TARGET_INVALID" });
});

test("pickup grouping conserves orders and respects overrides in any insertion order", () => {
  fc.assert(fc.property(fc.array(fc.constantFrom("", address, "12441 Woodbine Ave, ON"), { minLength: 2, maxLength: 8 }), values => {
    const orders = values.map((value, index) => order(`SO-${index}`, value));
    const ui = planner(orders);
    for (const value of orders) { assert.equal(ui.addOrderToLoad(value.id, "LOAD"), true); }
    const visits = pickups(ui.load);
    assert.equal(visits.length, new Set(values).size);
    assert.deepEqual(visits.flatMap(stop => stop.orderRefs).sort(), orders.map(value => value.id).sort());
    for (const visit of visits) {
      assert.equal(new Set(visit.orderRefs.map(ref => orders.find(value => value.id === ref).pickupAddressOverride)).size, 1);
    }
    assert.deepEqual(ui.validate(), []);
  }), { seed: 9326, numRuns: 60 });
});

test("override reconciliation leaves the entire started route prefix unchanged", () => {
  const orders = [order("SOA09464"), order("SOA09326", address)];
  const entries = stops();
  entries[0].orderRefs.push("SOA09326");
  entries[1].status = "in_progress";
  entries.push({ ...entries[1], id: "D2", orderId: "SOA09326", status: "pending" });
  const ui = planner(orders, entries);
  ui.cleanupOrphanPickupStops(); ui.syncPickupStops();
  assert.deepEqual(ui.load.stops.slice(0, 2), entries.slice(0, 2));
  assert.equal(pickups(ui.load).length, 1);
});
