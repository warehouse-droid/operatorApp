import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { destinationFunctions } from "../../support/dispatch-po-line-destination-functions.mjs";
import { projectPurchaseOrderRouteResidual } from "../../../src/dispatch-po-route-projection.js";

const yards = [
  { code: "2967", address: "2967 Kennedy Road, Toronto, ON" },
  { code: "3445", address: "3445 Kennedy Road, Toronto, ON" }
];
const { slimAssignedOrder } = destinationFunctions("../../src/dispatch-planner-v2-repository.js", ["text", "slimAssignedOrder"]);
const { normalizePoDropoffs } = destinationFunctions("../../public/dispatch.js", ["normalizePoDropoffs"], {
  HUBS: Object.fromEntries(yards.map(yard => [yard.code, { address: yard.address }])),
  dispatchLocationHierarchyRoot: value => value
});

function fixtureOrder() {
  const quantities = [[492674, 28, "2967", 1, 720, 2.6], [494106, 28, "2967", 1, 70, 50],
    [494107, 28, "2967", 2, 140, 50], [493317, 1, "3445", 1, 720, 2.6],
    [494109, 1, "3445", 1, 70, 50], [494110, 1, "3445", 1, 70, 50], [494111, 1, "3445", 2, 140, 50]];
  return {
    id: "SN1401728", type: "PO", originalPoRef: "POB03969", destinationLocationId: 28,
    destinationYard: "2967", destinationAddress: yards[0].address,
    defaultDestinationAddress: yards[0].address, deliveryAddressOverride: "", pallets: 9, weight: 28244,
    items: quantities.map(([lineRowId, destinationLocationId, destinationYard, pallets, quantity, itemWeight]) => ({
      lineRowId, destinationLocationId, destinationYard, pallets, quantity, itemWeight, lineWeight: quantity * itemWeight
    }))
  };
}

function fixtureAllocation() {
  return { id: 207, status: "active", po_line_id: 492674, po_order_ref: "SN1401728",
    dispatch_target_ref: "SOA09523", sales_order_ref: "SOA09523", allocated_pallet_qty: 1, allocated_sales_qty: 720 };
}

function repository(allocations = []) {
  return destinationFunctions("../../src/dispatch-repository.js", [
    "toNumber", "locationIdFromText", "locationTextFromId", "normalizeScmDestinationLocationId",
    "dispatchItemHasQuantity", "purchaseOrderDropoffs", "enrichDispatchOrdersWithPoTargetAllocations"
  ], {
    SCM_VRMA_OWN_YARDS: yards,
    poPickupSql: { location: "po.destination_location", address: "po.dispatch_address", joins: "" },
    query: async () => ({ rows: structuredClone(allocations) }),
    projectPurchaseOrderRouteResidual
  });
}

function withDropoffs(order, repo = repository()) {
  return { ...order, dropoffs: repo.purchaseOrderDropoffs(order.items, {
    destinationLocationId: order.destinationLocationId, destinationYard: order.destinationYard,
    destinationAddress: order.defaultDestinationAddress, destinationAddressOverride: order.deliveryAddressOverride
  }) };
}

function destinations(order) {
  return order.poRouteProjection.dropoffs.map(drop => [drop.destinationYard, drop.pallets, drop.weight]);
}

test("PDD-1 compact assigned snapshots retain full dropoffs and delivery address metadata", () => {
  const order = withDropoffs(fixtureOrder());
  const compact = slimAssignedOrder(order);
  assert.deepEqual(compact.dropoffs, order.dropoffs);
  assert.equal(compact.defaultDestinationAddress, order.defaultDestinationAddress);
  assert.equal(compact.deliveryAddressOverride, "");
  assert.equal(Object.hasOwn(compact, "raw"), false);
});

test("PDD-2 compact response, browser normalization, and direct-pickup recalculation retain 2967 and 3445", async () => {
  const repo = repository([fixtureAllocation()]);
  const order = withDropoffs(fixtureOrder(), repo);
  const initial = (await repo.enrichDispatchOrdersWithPoTargetAllocations([order]))[0];
  const compact = slimAssignedOrder(initial);
  const candidate = { ...compact, dropoffs: normalizePoDropoffs(compact, "PO", compact.items) };
  const saved = (await repo.enrichDispatchOrdersWithPoTargetAllocations([candidate]))[0];
  assert.deepEqual(destinations(saved), [["2967", 3, 10500], ["3445", 5, 15872]]);
  assert.equal(saved.poRouteProjection.pallets, 8);
  assert.equal(saved.poRouteProjection.weight, 26372);
  assert.deepEqual(saved.poRouteProjection.targetRefs, ["SOA09523"]);
});

test("PDD-3 a stale header-only drop list is rebuilt from each PO line's destination", async () => {
  const order = fixtureOrder();
  order.dropoffs = normalizePoDropoffs(order, "PO", order.items);
  const saved = (await repository([fixtureAllocation()]).enrichDispatchOrdersWithPoTargetAllocations([order]))[0];
  assert.deepEqual(destinations(saved), [["2967", 3, 10500], ["3445", 5, 15872]]);
  assert.equal(saved.poRouteProjection.dropoffs[1].address, yards[1].address);
  assert.deepEqual(saved.dropoffs.map(drop => [drop.destinationYard, drop.pallets]), [["2967", 4], ["3445", 5]]);
});

test("PDD-4 header delivery overrides apply only to their own yard", async () => {
  const order = fixtureOrder();
  order.deliveryAddressOverride = "50 Dynamic Drive, Toronto, ON";
  const repo = repository([fixtureAllocation()]);
  const compact = slimAssignedOrder(withDropoffs(order, repo));
  const saved = (await repo.enrichDispatchOrdersWithPoTargetAllocations([compact]))[0];
  assert.deepEqual(saved.poRouteProjection.dropoffs.map(drop => drop.address), [order.deliveryAddressOverride, yards[1].address]);
  assert.equal(saved.defaultDestinationAddress, yards[0].address);
});

test("PDD-5 direct-pickup quantities and source lines remain unchanged", async () => {
  const repo = repository([fixtureAllocation()]);
  const order = withDropoffs(fixtureOrder(), repo);
  const original = structuredClone(order);
  const allocations = [fixtureAllocation()];
  const saved = (await repo.enrichDispatchOrdersWithPoTargetAllocations([order]))[0];
  assert.deepEqual(order, original);
  assert.deepEqual(saved.items, original.items);
  assert.equal(saved.pallets, 9);
  assert.deepEqual(saved.poRouteProjection.allocations.map(row => [row.poLineId, row.pallets, row.salesQty]), [["492674", 1, 720]]);
  assert.deepEqual(allocations, [fixtureAllocation()]);
});

test("PDD-6 randomized destination and allocation quantities conserve cargo through repeated reloads", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 100 }), fc.integer({ min: 1, max: 100 }),
    fc.integer({ min: 0, max: 100 }), async (first, second, requestedAllocation) => {
      const allocated = Math.min(first, requestedAllocation);
      const order = fixtureOrder();
      order.items = [
        { lineRowId: 492674, destinationLocationId: 28, destinationYard: "2967", pallets: first,
          quantity: first * 70, itemWeight: 50, lineWeight: first * 3500 },
        { lineRowId: 493317, destinationLocationId: 1, destinationYard: "3445", pallets: second,
          quantity: second * 70, itemWeight: 50, lineWeight: second * 3500 }
      ];
      const allocation = { ...fixtureAllocation(), allocated_pallet_qty: allocated, allocated_sales_qty: allocated * 70 };
      const repo = repository([allocation]);
      let saved = { ...order, dropoffs: normalizePoDropoffs(order, "PO", order.items) };
      for (let reload = 0; reload < 3; reload += 1) {
        const compact = slimAssignedOrder(saved);
        const normalized = { ...compact, dropoffs: normalizePoDropoffs(compact, "PO", compact.items) };
        saved = (await repo.enrichDispatchOrdersWithPoTargetAllocations([normalized]))[0];
        const expected = first > allocated ? [["2967", first - allocated, (first - allocated) * 3500]] : [];
        expected.push(["3445", second, second * 3500]);
        assert.deepEqual(destinations(saved), expected);
        assert.equal(saved.poRouteProjection.pallets + allocated, first + second);
        assert.equal(saved.poRouteProjection.weight + allocated * 3500, (first + second) * 3500);
        assert.deepEqual(saved.items, order.items);
      }
    }), { seed: 1401728, numRuns: 200 });
});
