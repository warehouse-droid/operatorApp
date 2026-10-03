import test from "node:test";
import assert from "node:assert/strict";
import { executedOrderContexts, buildExecutedOrderReviews, reviewedExecutionComparison, reconcileExecutedSourcePlan, executedChangeMessage } from "../../../src/dispatch-executed-order-review.js";
import { evaluateExecutedPrefixPolicy } from "../../../src/dispatch-planner-performance.js";
import "../../../public/dispatch-address-guard.js";
import { aggregateGlobalGroup } from "../../../src/dispatch-delivery-group-repository.js";

const address = "15 Snowy Meadow Ave, Richmond Hill, ON L4E 3V3";
export function incident() {
  const order = { id: "TOB01111", type: "TO", sourceYard: "150", pickupLocations: ["150"], address: "2967 Kennedy Road, Toronto, ON", pallets: 27,
    items: [{ lineId: 4977214, itemId: 4773, sku: "PER-MM80S-2237-SCG", quantity: 326.48, unit: "SQFT", pallets: 4 },
      { lineId: 4977427, itemId: 1784, sku: "PALLET", description: "PALLET DEPOSIT", quantity: 29, unit: "EACH", pallets: 0 }] };
  const previousPlan = { id: "331", orders: [order], trucks: [{ id: "T5", plate: "CC46868", loads: [
    { id: "l2", name: "Load 2", driverLogin: "li", driverName: "Li", truckId: "T5", truckPlate: "CC46868", driverSequence: 1, plannedStartMinute: 500,
      stops: [{ id: "p", type: "pick", orderId: order.id, location: "150" }, { id: "d", type: "drop", orderId: order.id }] }
  ] }] };
  const activity = [{ status: "complete", load_id: "l2", stop_id: "d", stop_type: "drop" }];
  const source = { ...structuredClone(order), pallets: 48, items: [{ ...order.items[1], quantity: 25, pallets: 25 }] };
  return { previousPlan, activity, sourceOrders: [source] };
}

test("TOB01111 review reports removed line, deposit quantity and calculated pallets separately", () => {
  const reviews = buildExecutedOrderReviews(incident());
  assert.equal(reviews.length, 1);
  const review = reviews[0];
  assert.equal(review.orderRef, "TOB01111");
  assert.equal(review.contexts[0].driverLogin, "li");
  assert.equal(review.contexts[0].truckPlate, "CC46868");
  assert.equal(review.contexts[0].loadName, "Load 2");
  assert.deepEqual(review.changes.find(c => c.field === "item_removed")?.before, { quantity: 326.48, unit: "SQFT" });
  assert.equal(review.changes.find(c => c.item === "PALLET" && c.field === "quantity")?.after, 25);
  assert.equal(review.changes.find(c => c.field === "calculated_pallets")?.after, 48);
  assert.match(review.message, /source.*recorded plan/i);
  assert.doesNotMatch(review.message, /dispatcher removed|after.*complet/i);
});

test("review version is stable across metadata and future work, but changes with source values", () => {
  const input = incident();
  const first = buildExecutedOrderReviews(input)[0];
  input.previousPlan.revision = 999;
  input.sourceOrders[0].raw = { dispatch_planned: true };
  assert.equal(buildExecutedOrderReviews(input)[0].token, first.token);
  input.sourceOrders[0].items[0].quantity = 24;
  assert.notEqual(buildExecutedOrderReviews(input)[0].token, first.token);
});

test("verified source data passes before confirmation while arbitrary edits and physical route changes remain blocked", () => {
  const input = incident();
  const reviews = buildExecutedOrderReviews(input).map(review => ({ ...review, acknowledged: true }));
  const nextPlan = { ...structuredClone(input.previousPlan), orders: structuredClone(input.sourceOrders) };
  const comparison = reviewedExecutionComparison({ ...input, nextPlan, reviews });
  assert.equal(evaluateExecutedPrefixPolicy({ previousPlan: comparison, nextPlan, activity: input.activity }).allowed, true);
  assert.deepEqual(input.previousPlan.orders[0].items[0].quantity, 326.48);
  nextPlan.orders[0].items[0].quantity = 123;
  const hostile = reviewedExecutionComparison({ ...input, nextPlan, reviews });
  assert.equal(evaluateExecutedPrefixPolicy({ previousPlan: hostile, nextPlan, activity: input.activity }).allowed, false);
  nextPlan.orders = structuredClone(input.sourceOrders);
  nextPlan.trucks[0].loads[0].stops.reverse();
  assert.equal(evaluateExecutedPrefixPolicy({ previousPlan: comparison, nextPlan, activity: input.activity }).allowed, false);
  const unconfirmed = reviewedExecutionComparison({ ...input, nextPlan: { ...nextPlan, trucks: input.previousPlan.trucks }, reviews: buildExecutedOrderReviews(input) });
  assert.equal(evaluateExecutedPrefixPolicy({ previousPlan: unconfirmed, nextPlan: { ...nextPlan, trucks: input.previousPlan.trucks }, activity: input.activity }).allowed, true);
});

test("scope covers preceding loads, excludes a travel destination and future work", () => {
  const { previousPlan } = incident();
  previousPlan.trucks[0].loads.push({ id: "l3", name: "Load 3", driverLogin: "li", truckId: "T5", truckPlate: "CC46868", driverSequence: 2, plannedStartMinute: 900,
    stops: [{ id: "future", type: "pick", orderId: "TOB01115", location: "150" }] });
  const activity = [{ status: "in_progress", load_id: "l3", stop_id: "travel-future", stop_type: "travel", job_details: { toStopId: "future" } }];
  const contexts = executedOrderContexts(previousPlan, activity);
  assert.ok(contexts.some(c => c.orderRef === "TOB01111"));
  assert.ok(!contexts.some(c => c.orderRef === "TOB01115"));
});

test("GOA-8930-8931 and its child retain valid addresses during blank refresh", () => {
  const previous = { id: "GOA-8930-8931", address, childOrderDetails: [{ id: "SOA08930", address }, { id: "SOA08931", address }] };
  const incoming = structuredClone(previous);
  incoming.address = " "; incoming.childOrderDetails[0].address = "";
  const result = globalThis.DispatchAddressGuard.preserve(previous, incoming);
  assert.equal(result.order.address, address);
  assert.equal(result.order.childOrderDetails[0].address, address);
  assert.deepEqual(result.warnings.map(w => w.orderRef).sort(), ["GOA-8930-8931", "SOA08930"]);
  assert.ok(result.warnings.every(w => w.message.includes(address)));
  assert.equal(incoming.address, " ");
  assert.equal(globalThis.DispatchAddressGuard.validate(previous.id, { address: " " }).code, "DISPATCH_ADDRESS_REQUIRED");
  assert.equal(globalThis.DispatchAddressGuard.validate(previous.id, {}), null);
});

test("prefix conflict names the exact order, address and item edits", () => {
  const input = incident();
  const nextPlan = { ...structuredClone(input.previousPlan), orders: structuredClone(input.sourceOrders) };
  nextPlan.orders[0].address = "";
  const policy = evaluateExecutedPrefixPolicy({ ...input, nextPlan });
  assert.equal(policy.allowed, false);
  const details = JSON.stringify(policy.conflicts);
  assert.match(details, /TOB01111/);
  assert.match(details, /PER-MM80S-2237-SCG/);
  assert.match(details, /326.48/);
  assert.match(details, /2967 Kennedy/);
  assert.match(details, /Load 2/);
});

test("backend aggregation cannot erase a grouped child's address", () => {
  const previous = { id: "GOA-8930-8931", type: "SO", address, childOrderDetails: [{ id: "SOA08930", address }, { id: "SOA08931", address }] };
  const children = structuredClone(previous.childOrderDetails);
  children[0].address = "";
  const group = aggregateGlobalGroup(previous, children);
  assert.equal(group.address, address);
  assert.equal(group.childOrderDetails[0].address, address);
});

test("an unrelated source review cannot approve editing another group's recorded allocation", () => {
  const f = incident();
  const child = { id: "SO-CHILD", items: [{ itemId: 1, sku: "Material", quantity: 4 }] };
  const group = { id: "GO-OTHER", type: "SO", address, childOrders: [child.id], childOrderDetails: [child], items: [{ ...child.items[0], quantity: 5 }] };
  f.previousPlan.orders.push(group);
  f.previousPlan.trucks[0].loads[0].stops.push({ id: "other", type: "drop", orderId: group.id });
  f.activity.push({ status: "complete", load_id: "l2", stop_id: "other", stop_type: "drop" });
  const nextPlan = structuredClone(f.previousPlan);
  nextPlan.orders[1].items = structuredClone(child.items);
  const reviews = buildExecutedOrderReviews(f);
  const comparison = reviewedExecutionComparison({ ...f, nextPlan, reviews });
  assert.equal(evaluateExecutedPrefixPolicy({ previousPlan: comparison, nextPlan, activity: f.activity }).allowed, false);
});

test("warnings explain stop timing and quantity units in dispatch terms", () => {
  const f = incident(); const nextPlan = structuredClone(f.previousPlan);
  f.previousPlan.trucks[0].loads[0].stops[1].timing = { arrival: 784, depart: 820 };
  nextPlan.trucks[0].loads[0].stops[1].timing = { arrival: 745, depart: 781 };
  const policy = evaluateExecutedPrefixPolicy({ ...f, nextPlan });
  assert.equal(policy.allowed, false);
  assert.match(JSON.stringify(policy.conflicts), /planned arrival: 13:04 → 12:25/);
  assert.match(executedChangeMessage({ field: "quantity", item: "PALLET", before: 29, after: 25, unit: "EACH" }), /29 EACH → 25 EACH/);
});

test("source address and cargo changes retain the executed snapshot while preserving later work", () => {
  const f = incident(); f.sourceOrders[0].address = "99 Updated Source Road";
  const nextPlan = structuredClone(f.previousPlan); nextPlan.orders = structuredClone(f.sourceOrders);
  nextPlan.trucks[0].loads.push({ id: "future", stops: [{ id: "future-drop", type: "drop", orderId: "NEXT" }] });
  nextPlan.orders.push({ id: "NEXT", address: "New delivery", items: [] });
  const reviews = buildExecutedOrderReviews(f);
  const result = reconcileExecutedSourcePlan({ ...f, nextPlan, reviews });
  assert.deepEqual(result.orders[0], f.previousPlan.orders[0]);
  assert.equal(result.trucks[0].loads[1].id, "future");
  assert.equal(result.orders[1].id, "NEXT");
  assert.equal(f.sourceOrders[0].address, "99 Updated Source Road");
  assert.equal(nextPlan.orders[0].address, "99 Updated Source Road");
  nextPlan.orders[0].items[0].quantity = 999;
  const forged = reconcileExecutedSourcePlan({ ...f, nextPlan, reviews });
  assert.equal(evaluateExecutedPrefixPolicy({ ...f, nextPlan: forged }).allowed, false);
});

test("grouped source changes preserve each recorded child and do not hide a sibling's manual edit", () => {
  const f = incident(); const leaf = f.previousPlan.orders[0];
  const group = { id: "GTO-EXECUTED", type: "TO", address: leaf.address, destinationAddress: leaf.address,
    childOrders: [leaf.id, "TO-SIBLING"], childOrderDetails: [leaf, { id: "TO-SIBLING", items: [{ itemId: 99, quantity: 1 }] }],
    items: [...leaf.items, { itemId: 99, quantity: 1 }] };
  f.previousPlan.orders = [group];
  for (const stop of f.previousPlan.trucks[0].loads[0].stops) { stop.orderId = group.id; }
  f.sourceOrders[0].address = "Updated source address";
  f.sourceOrders[0].weight = 100;
  const nextPlan = structuredClone(f.previousPlan);
  nextPlan.orders[0].childOrderDetails[0] = structuredClone(f.sourceOrders[0]);
  nextPlan.orders[0].items = nextPlan.orders[0].childOrderDetails.flatMap(child => child.items);
  nextPlan.orders[0].address = nextPlan.orders[0].destinationAddress = f.sourceOrders[0].address;
  const reviews = buildExecutedOrderReviews(f);
  const saved = reconcileExecutedSourcePlan({ ...f, nextPlan, reviews });
  assert.deepEqual(saved.orders[0], group);
  nextPlan.orders[0].childOrderDetails[1].items[0].quantity = 900;
  assert.equal(evaluateExecutedPrefixPolicy({ ...f, nextPlan: reconcileExecutedSourcePlan({ ...f, nextPlan, reviews }) }).allowed, false);
});

test("legacy load and activity aliases still identify the protected source order", () => {
  const f = incident();
  const load = f.previousPlan.trucks[0].loads[0]; load.loadId = load.id; delete load.id;
  for (const stop of load.stops) { stop.stopId = stop.id; delete stop.id; stop.stopType = stop.type; delete stop.type; }
  f.activity = [{ status: "complete", loadId: "l2", stopId: "d", stopType: "drop" }];
  assert.equal(buildExecutedOrderReviews(f)[0]?.orderRef, "TOB01111");
});

test("legacy quantity and unit aliases cannot disguise a manual allocation change", () => {
  const f = incident(); const reviews = buildExecutedOrderReviews(f);
  for (const alias of ["sales_qty", "pallet_qty", "layer_qty", "section_qty", "piece_qty", "split_qty"]) {
    const nextPlan = { ...structuredClone(f.previousPlan), orders: structuredClone(f.sourceOrders) };
    const item = nextPlan.orders[0].items[0];
    for (const field of ["quantity", "pallets", "layers", "sections", "pieces", "splitQty"]) { delete item[field]; }
    Object.assign(item, { quantity: 25, pallets: 25 });
    if (alias === "sales_qty") { delete item.quantity; }
    if (alias === "pallet_qty") { delete item.pallets; }
    item[alias] = 900;
    const comparison = reviewedExecutionComparison({ ...f, nextPlan, reviews });
    assert.equal(evaluateExecutedPrefixPolicy({ previousPlan: comparison, nextPlan, activity: f.activity }).allowed, false, alias);
  }
});

test("stale raw blank addresses are repaired without inventing a source edit", () => {
  const previous = { id: "GOA-8930-8931", address };
  const result = globalThis.DispatchAddressGuard.preserve(previous, { ...previous, raw: { dispatch_address: "  " } });
  assert.equal(result.order.raw.dispatch_address, address);
  assert.equal(result.warnings.length, 0);
  assert.equal(globalThis.DispatchAddressGuard.validate(previous.id, { address }), null);
});

test("source values copied onto executed stops save without changing the recorded route", () => {
  const f = incident();
  const load = f.previousPlan.trucks[0].loads[0];
  load.stops[1].dropAddress = f.previousPlan.orders[0].address;
  load.stops[1].dropPallets = 27;
  f.sourceOrders[0].address = "99 Updated Source Road";
  f.sourceOrders[0].sourceYard = "3445";
  f.sourceOrders[0].pickupLocations = ["3445"];
  const reviews = buildExecutedOrderReviews(f);
  const nextPlan = { ...structuredClone(f.previousPlan), orders: structuredClone(f.sourceOrders) };
  const nextLoad = nextPlan.trucks[0].loads[0];
  nextLoad.stops[0].location = "3445";
  nextLoad.stops[1].dropAddress = f.sourceOrders[0].address;
  nextLoad.stops[1].dropPallets = 48;
  const saved = reconcileExecutedSourcePlan({ ...f, nextPlan, reviews });
  assert.deepEqual(saved.trucks, f.previousPlan.trucks);
  assert.equal(evaluateExecutedPrefixPolicy({ ...f, nextPlan: saved }).allowed, true);
  assert.equal(nextLoad.stops[1].dropAddress, "99 Updated Source Road", "input stays immutable");
  nextLoad.stops[1].dropAddress = "Unverified manual address";
  assert.equal(evaluateExecutedPrefixPolicy({ ...f, nextPlan: reconcileExecutedSourcePlan({ ...f, nextPlan, reviews }) }).allowed, false);
  nextLoad.stops[1].dropAddress = f.sourceOrders[0].address;
  nextLoad.stops[1].instructions = "Unverified manual instruction";
  assert.equal(evaluateExecutedPrefixPolicy({ ...f, nextPlan: reconcileExecutedSourcePlan({ ...f, nextPlan, reviews }) }).allowed, false);
});

test("a blank PO pickup override cannot be replaced by the delivery address", () => {
  const previous = { id: "PO-ADDRESS", type: "PO", address: "Receiving yard", sourceAddress: "Vendor pickup", raw: { dispatch_address: "", dispatch_delivery_address: "" } };
  const incoming = { ...previous, address: " " };
  const result = globalThis.DispatchAddressGuard.preserve(previous, incoming);
  assert.equal(result.order.address, "Receiving yard");
  assert.equal(result.order.sourceAddress, "Vendor pickup");
  assert.deepEqual(result.order.raw, previous.raw, "PO dispatch_address describes pickup, not delivery");
});
