import assert from "node:assert/strict";
import test from "node:test";

import {
  insertDispatchLateOrder,
  splitDispatchPickupVisit,
  validateDispatchPickupVisits
} from "../../../src/dispatch-pickup-visits.js";

function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function planFor(count) {
  const refs = Array.from({ length: count }, (_unused, index) => `SO-${index + 1}`);
  return {
    id: 81,
    planDate: "2026-09-02",
    pickupVisitSchemaVersion: 1,
    orders: refs.map((id, index) => ({
      id,
      type: "SO",
      pickupLocations: [index % 3 === 0 ? "3445 : Main" : "3445"],
      address: `${id} delivery`,
      items: [{ lineRowId: `${id}-line`, pallets: index + 1 }]
    })),
    trucks: [{ id: "T", plate: "T", driverLogin: "driver", loads: [{
      id: "L",
      stops: [{
        id: "P",
        loadId: "L",
        type: "pick",
        location: "3445",
        orderId: refs[0],
        orderRefs: refs
      }, ...refs.map((ref) => ({ id: `D-${ref}`, loadId: "L", type: "drop", orderId: ref, orderRefs: [ref] }))]
    }]}]
  };
}

test("RP-04 property: arbitrary whole-order partitions conserve every order and item", () => {
  const random = seeded(7894);
  for (let example = 0; example < 200; example += 1) {
    const count = 2 + Math.floor(random() * 19);
    const source = planFor(count);
    const refs = source.trucks[0].loads[0].stops[0].orderRefs;
    const selected = refs.filter(() => random() >= 0.5);
    if (!selected.length) {selected.push(refs.at(-1));}
    if (selected.length === refs.length) {selected.pop();}
    const itemSnapshot = JSON.stringify(source.orders.map((order) => order.items));
    const result = splitDispatchPickupVisit({
      plan: source,
      loadId: "L",
      stopId: "P",
      orderRefs: selected,
      makeStopId: () => `P2-${example}`
    });
    const pickups = result.plan.trucks[0].loads[0].stops.filter((stop) => stop.type === "pick");
    const allocations = pickups.flatMap((stop) => stop.orderRefs);
    assert.equal(allocations.length, refs.length);
    assert.deepEqual([...allocations].sort(), [...refs].sort());
    assert.equal(new Set(allocations).size, refs.length);
    assert.equal(JSON.stringify(result.plan.orders.map((order) => order.items)), itemSnapshot);
    assert.deepEqual(validateDispatchPickupVisits(result.plan), []);
  }
});

test("RP-01/RP-02 property: late adds reuse only a legal future visit", () => {
  const random = seeded(3445);
  for (let example = 0; example < 150; example += 1) {
    const source = planFor(2 + Math.floor(random() * 8));
    const lateId = `LATE-${example}`;
    const completed = random() >= 0.5;
    const result = insertDispatchLateOrder({
      plan: source,
      loadId: "L",
      order: {
        id: lateId,
        type: "SO",
        pickupLocations: ["3445"],
        address: source.orders[0].address,
        items: [{ lineRowId: `${lateId}-line`, pallets: 1 }]
      },
      activity: completed ? [{
        status: "complete",
        load_id: "L",
        stop_id: "P",
        stop_type: "pickup",
        order_refs: source.trucks[0].loads[0].stops[0].orderRefs
      }] : [],
      makeStopId: (kind) => `${kind}-${example}`
    });
    const pickups = result.plan.trucks[0].loads[0].stops.filter((stop) => stop.type === "pick");
    const carryingLate = pickups.filter((stop) => stop.orderRefs.includes(lateId));
    assert.equal(carryingLate.length, 1);
    assert.equal(pickups.length, completed ? 2 : 1);
    if (completed) {assert.equal(source.trucks[0].loads[0].stops[0].orderRefs.includes(lateId), false);}
    assert.deepEqual(validateDispatchPickupVisits(result.plan), []);
  }
});
