import assert from "node:assert/strict";
import test from "node:test";

import { dispatchPhysicalStopVisits } from "../../../src/dispatch-load-assignment.js";
import {
  projectPurchaseOrderRouteResidual,
  purchaseOrderRouteItems,
  purchaseOrderRouteProjection
} from "../../../src/dispatch-po-route-projection.js";
import { driverOrderDetailsFromPlan } from "../../../src/driver-repository.js";
import { reconcileDependencyManagedPickups } from "../../../src/scm-dependency-plan-reconciler.js";

const TARGET_REF = "GOB-118278-118279";
const PO_REF = "SN1398699";

function productionPo() {
  return {
    id: PO_REF,
    type: "PO",
    sourceYard: "Ayr Yard - Unilock",
    sourceAddress: "2977 Cedar Creek Rd RR#1, Ayr, ON N0B 1E0",
    destinationYard: "3445",
    destinationLocationId: 1,
    destinationAddress: "3445 Kennedy Road, Toronto, ON",
    deliveryAddressOverride: "3445 Kennedy Road, Toronto, ON",
    pickupLocations: ["Ayr Yard - Unilock"],
    pallets: 51,
    salesQty: 2745.09,
    weight: 75986.2305,
    items: [
      {
        lineRowId: "dusk-line",
        itemId: 2874,
        sku: "UNI-WIN60S-1530-DUSK",
        unit: "SQFT",
        destinationLocationId: 1,
        destinationYard: "3445",
        pallets: 12,
        layers: 0,
        sections: 0,
        pieces: 0,
        quantity: 654,
        itemWeight: 27.44,
        lineWeight: 17945.76
      },
      {
        lineRowId: "urban-line",
        itemId: 4993,
        sku: "UNI-URBAN60S-1836-IB",
        unit: "SQFT",
        destinationLocationId: 1,
        destinationYard: "3445",
        pallets: 39,
        layers: 0,
        sections: 0,
        pieces: 0,
        quantity: 2040.09,
        itemWeight: 27.45,
        lineWeight: 56000.4705
      },
      {
        lineRowId: "pallet-line",
        itemId: 1784,
        sku: "PALLET",
        unit: "EACH",
        destinationLocationId: 1,
        destinationYard: "3445",
        pallets: 0,
        layers: 0,
        sections: 0,
        pieces: 0,
        quantity: 51,
        itemWeight: 40,
        lineWeight: 2040
      }
    ],
    dropoffs: [{
      key: "location:1",
      destinationLocationId: 1,
      destinationYard: "3445",
      defaultAddress: "3445 Kennedy Road, Toronto, ON",
      address: "3445 Kennedy Road, Toronto, ON",
      lineRowIds: ["dusk-line", "urban-line", "pallet-line"],
      pallets: 51,
      layers: 0,
      sections: 0,
      pieces: 0,
      salesQty: 2745.09,
      weight: 75986.2305
    }]
  };
}

function productionAllocations({ urbanPallets = 38, urbanSalesQty = 1987.78, palletSalesQty = 38 } = {}) {
  return [
    {
      id: 141,
      dispatch_target_ref: TARGET_REF,
      sales_order_ref: "SOB118279",
      po_order_ref: PO_REF,
      po_line_id: "urban-line",
      allocated_pallet_qty: urbanPallets,
      allocated_layer_qty: 0,
      allocated_section_qty: 0,
      allocated_piece_qty: 0,
      allocated_sales_qty: urbanSalesQty
    },
    {
      id: 142,
      dispatch_target_ref: TARGET_REF,
      sales_order_ref: "SOB118278",
      po_order_ref: PO_REF,
      po_line_id: "pallet-line",
      allocated_pallet_qty: 0,
      allocated_layer_qty: 0,
      allocated_section_qty: 0,
      allocated_piece_qty: 0,
      allocated_sales_qty: palletSalesQty
    }
  ];
}

function targetOrder() {
  return {
    id: TARGET_REF,
    type: "SO",
    sourceYard: "3445",
    pickupLocations: ["Ayr Yard - Unilock"],
    pallets: 38,
    weight: 56084.561,
    items: [],
    poPickupManifest: [{
      poOrderRef: PO_REF,
      location: "Ayr Yard - Unilock",
      address: "2977 Cedar Creek Rd RR#1, Ayr, ON N0B 1E0",
      items: [
        { sku: "UNI-URBAN60S-1836-IB", pallets: 38, quantity: 1987.78, itemWeight: 27.45 },
        { sku: "PALLET", pallets: 0, quantity: 38, itemWeight: 40 }
      ]
    }]
  };
}

function planWithTarget(po, { extraLoads = [] } = {}) {
  return {
    id: 257,
    planDate: "2026-08-26",
    orders: [targetOrder(), po],
    trucks: [{
      id: "T6",
      plate: "CE94489",
      loads: [{
        id: "T6-L1",
        stops: [{ id: "target-drop", type: "drop", orderId: TARGET_REF, location: "Customer" }]
      }, ...extraLoads]
    }]
  };
}

test("SOB118279/SN1398699 projects the linked 38 pallets out of the 51-pallet PO route", () => {
  const source = productionPo();
  const projected = projectPurchaseOrderRouteResidual(source, productionAllocations());

  assert.deepEqual(source, productionPo(), "Dispatch projection must not mutate the SCM/source PO balance");
  assert.equal(projected.pallets, 51, "source PO total remains available to SCM");
  assert.equal(projected.items[1].pallets, 39, "source PO lines remain intact");
  assert.equal(projected.poRouteProjection.pallets, 13);
  assert.equal(projected.poRouteProjection.salesQty, 719.31);
  assert.equal(projected.poRouteProjection.weight, 19901.67);
  assert.deepEqual(
    projected.poRouteProjection.items.map((item) => [item.sku, item.pallets, item.quantity]),
    [
      ["UNI-WIN60S-1530-DUSK", 12, 654],
      ["UNI-URBAN60S-1836-IB", 1, 52.31],
      ["PALLET", 0, 13]
    ]
  );
  assert.deepEqual(projected.poRouteProjection.targetRefs, [TARGET_REF]);
  assert.deepEqual(projected.poRouteProjection.dropoffs.map((dropoff) => ({
    yard: dropoff.destinationYard,
    address: dropoff.address,
    pallets: dropoff.pallets,
    weight: dropoff.weight
  })), [{
    yard: "3445",
    address: "3445 Kennedy Road, Toronto, ON",
    pallets: 13,
    weight: 19901.67
  }]);
});

test("full allocation produces no residual route while an unlinked PO is unchanged", () => {
  const unlinked = productionPo();
  assert.strictEqual(projectPurchaseOrderRouteResidual(unlinked, []), unlinked);

  const fullyAllocated = projectPurchaseOrderRouteResidual(productionPo(), productionAllocations({
    urbanPallets: 39,
    urbanSalesQty: 2040.09,
    palletSalesQty: 51
  }).concat({
    id: 143,
    dispatch_target_ref: TARGET_REF,
    sales_order_ref: "SOB118279",
    po_order_ref: PO_REF,
    po_line_id: "dusk-line",
    allocated_pallet_qty: 12,
    allocated_layer_qty: 0,
    allocated_section_qty: 0,
    allocated_piece_qty: 0,
    allocated_sales_qty: 654
  }));
  assert.equal(fullyAllocated.poRouteProjection.hasResidual, false);
  assert.equal(fullyAllocated.poRouteProjection.pallets, 0);
  assert.equal(fullyAllocated.poRouteProjection.weight, 0);
  assert.deepEqual(fullyAllocated.poRouteProjection.items, []);
  assert.deepEqual(fullyAllocated.poRouteProjection.dropoffs, []);
});

test("legacy aliases and sparse PO line evidence still produce a bounded projection", () => {
  assert.equal(purchaseOrderRouteProjection(null), null);
  assert.equal(purchaseOrderRouteProjection({ type: "SO", poRouteProjection: { version: 1 } }), null);
  assert.equal(purchaseOrderRouteProjection({ orderType: "PO", po_route_projection: { version: 0 } }), null);
  const snakeProjection = { version: 1, items: [{ sku: "PROJECTED" }] };
  assert.strictEqual(
    purchaseOrderRouteProjection({ order_type: "PO", po_route_projection: snakeProjection }),
    snakeProjection
  );
  assert.deepEqual(purchaseOrderRouteItems({ type: "PO", items: [{ sku: "SOURCE" }] }), [{ sku: "SOURCE" }]);
  assert.deepEqual(purchaseOrderRouteItems({ type: "PO", poRouteProjection: snakeProjection }), snakeProjection.items);

  const po = {
    id: "PO-LEGACY-ALIASES",
    type: "PO",
    destination_location_id: 1,
    destination_yard: "3445",
    destination_address: "3445 Kennedy Road, Toronto, ON",
    defaultDestinationAddress: "Default 3445",
    items: [
      {
        id: "legacy-a",
        item_id: 10,
        item_name: "LEGACY-A",
        destination_location_id: 15,
        destination_yard: "2967",
        pallet_qty: 4,
        layer_qty: 2,
        section_qty: 1,
        piece_qty: 3,
        sales_qty: 40,
        line_weight: 80
      },
      {
        line_row_id: "legacy-b",
        itemName: "LEGACY-B",
        destinationYard: "12441",
        pieces: 5,
        lineWeight: 50
      },
      {
        sku: "SKU-ONLY",
        destinationYard: "3445",
        salesQty: 10
      }
    ],
    dropoffs: [
      {
        key: "location:15",
        destination_location_id: 15,
        destination_yard: "2967",
        default_address: "Default 2967",
        address: "2967 Kennedy Road, Toronto, ON"
      },
      {
        destination_yard: "12441",
        line_row_ids: ["legacy-b"],
        address: "12441 Woodbine Avenue, Whitchurch-Stouffville, ON"
      }
    ]
  };
  const projected = projectPurchaseOrderRouteResidual(po, [
    {
      id: "not-a-number",
      status: "active",
      dispatchTargetRef: "SO-ITEM-ID",
      salesOrderRef: "SO-ITEM-ID",
      poOrderRef: po.id,
      itemId: 10,
      pallets: 1,
      layers: 1,
      sections: 1,
      pieces: 1,
      salesQty: 20
    },
    {
      id: 302,
      poLineId: "legacy-b",
      sales_order_ref: "SO-LINE-ID",
      allocated_piece_qty: 2
    },
    {
      id: 303,
      itemName: "SKU-ONLY",
      salesOrderRef: "SO-SKU",
      salesQty: 4
    }
  ], { force: true, targetRefs: "not-an-array" });

  assert.deepEqual(projected.poRouteProjection.items.map((item) => ({
    sku: item.sku || item.itemName || item.item_name,
    pallets: item.pallets,
    layers: item.layers,
    sections: item.sections,
    pieces: item.pieces,
    quantity: item.quantity,
    weight: item.lineWeight
  })), [
    { sku: "LEGACY-A", pallets: 3, layers: 1, sections: 0, pieces: 2, quantity: 20, weight: 40 },
    { sku: "LEGACY-B", pallets: 0, layers: 0, sections: 0, pieces: 3, quantity: 0, weight: 30 },
    { sku: "SKU-ONLY", pallets: 0, layers: 0, sections: 0, pieces: 0, quantity: 6, weight: 0 }
  ]);
  assert.deepEqual(projected.poRouteProjection.targetRefs, ["SO-ITEM-ID", "SO-LINE-ID", "SO-SKU"]);
  assert.deepEqual(projected.poRouteProjection.allocationIds, [302, 303]);
  assert.deepEqual(projected.poRouteProjection.dropoffs.map((dropoff) => [
    dropoff.key,
    dropoff.destinationYard,
    dropoff.defaultAddress,
    dropoff.weight
  ]), [
    ["location:15", "2967", "Default 2967", 40],
    ["yard:12441", "12441", "Default 3445", 30],
    ["yard:3445", "3445", "Default 3445", 0]
  ]);
});

test("unlinking the final allocation restores the full PO route from the immutable source fields", () => {
  const partial = projectPurchaseOrderRouteResidual(productionPo(), productionAllocations());
  const released = projectPurchaseOrderRouteResidual(partial, [], {
    force: true,
    targetRefs: [TARGET_REF]
  });
  const input = planWithTarget(released);
  input.trucks[0].loads[0].stops.push({
    id: "managed-residual",
    type: "drop",
    orderId: PO_REF,
    dropLocation: "3445",
    dropPallets: 13,
    dependencyResidualManaged: true
  });
  const reconciled = reconcileDependencyManagedPickups({
    plan: input,
    enrichedOrders: input.orders,
    affectedTargetRefs: [TARGET_REF, PO_REF]
  });
  const residual = reconciled.trucks[0].loads[0].stops.find((stop) => stop.id === "managed-residual");

  assert.equal(released.poRouteProjection.pallets, 51);
  assert.equal(released.poRouteProjection.weight, 75986.231);
  assert.equal(residual.dropPallets, 51);
  assert.equal(residual.dropWeight, 75986.231);
});

test("allocations aggregate, clamp at zero, and retain separate line destinations", () => {
  const po = productionPo();
  po.items[0].destinationLocationId = 3;
  po.items[0].destinationYard = "12441";
  po.dropoffs = [
    {
      key: "location:3",
      destinationLocationId: 3,
      destinationYard: "12441",
      address: "12441 Woodbine Avenue, Whitchurch-Stouffville, ON",
      lineRowIds: ["dusk-line"],
      pallets: 12,
      salesQty: 654,
      weight: 17945.76
    },
    {
      key: "location:1",
      destinationLocationId: 1,
      destinationYard: "3445",
      address: "3445 Kennedy Road, Toronto, ON",
      lineRowIds: ["urban-line", "pallet-line"],
      pallets: 39,
      salesQty: 2091.09,
      weight: 58040.4705
    }
  ];
  const allocations = productionAllocations({ urbanPallets: 20, urbanSalesQty: 1046.2, palletSalesQty: 20 }).concat({
    id: 144,
    dispatch_target_ref: "SOB118300-S1",
    sales_order_ref: "SOB118300",
    po_order_ref: PO_REF,
    po_line_id: "urban-line",
    allocated_pallet_qty: 25,
    allocated_layer_qty: 0,
    allocated_section_qty: 0,
    allocated_piece_qty: 0,
    allocated_sales_qty: 1307.75
  });
  const projected = projectPurchaseOrderRouteResidual(po, allocations).poRouteProjection;

  assert.equal(projected.pallets, 12, "over-allocation is clamped and cannot make a negative line");
  assert.deepEqual(projected.targetRefs, [TARGET_REF, "SOB118300-S1"]);
  assert.deepEqual(projected.dropoffs.map((dropoff) => [dropoff.destinationYard, dropoff.pallets]), [
    ["12441", 12],
    ["3445", 0]
  ]);
});

test("the Dispatch PO delivery-address override wins in the residual route", () => {
  const po = productionPo();
  po.deliveryAddressOverride = "50 Dynamic Drive, Toronto, ON";
  po.dropoffs[0].address = "3445 Kennedy Road, Toronto, ON";

  const projected = projectPurchaseOrderRouteResidual(po, productionAllocations());

  assert.equal(projected.poRouteProjection.dropoffs[0].address, "50 Dynamic Drive, Toronto, ON");
  assert.equal(projected.destinationAddress, "3445 Kennedy Road, Toronto, ON",
    "the immutable source address remains available for SCM history");
});

test("partial direct ship adds one residual yard drop after the target and remains idempotent", () => {
  const po = projectPurchaseOrderRouteResidual(productionPo(), productionAllocations());
  const input = planWithTarget(po);
  const once = reconcileDependencyManagedPickups({
    plan: input,
    enrichedOrders: input.orders,
    affectedTargetRefs: [TARGET_REF, PO_REF]
  });
  const twice = reconcileDependencyManagedPickups({
    plan: once,
    enrichedOrders: once.orders,
    affectedTargetRefs: [TARGET_REF, PO_REF]
  });
  const stops = once.trucks[0].loads[0].stops;
  const targetIndex = stops.findIndex((stop) => stop.id === "target-drop");
  const residualStops = stops.filter((stop) => stop.type === "drop" && stop.orderId === PO_REF);

  assert.equal(residualStops.length, 1);
  assert.equal(stops.indexOf(residualStops[0]), targetIndex + 1);
  assert.equal(residualStops[0].dropPallets, 13);
  assert.equal(residualStops[0].dropSalesQty, 719.31);
  assert.equal(residualStops[0].dropWeight, 19901.67);
  assert.equal(residualStops[0].dropLocation, "3445");
  assert.equal(residualStops[0].dropAddress, "3445 Kennedy Road, Toronto, ON");
  assert.equal(stops.filter((stop) => stop.type === "pick" && /Ayr Yard/u.test(stop.location)).length, 1);
  assert.deepEqual(twice, once);
});

test("one PO split across grouped and split targets on different loads is conserved once", () => {
  const po = {
    id: "PO-MULTI-LOAD",
    type: "PO",
    sourceYard: "Vendor Yard",
    sourceAddress: "1 Vendor Road, Ayr, ON",
    pickupLocations: ["Vendor Yard"],
    destinationYard: "3445",
    items: [{
      lineRowId: "multi-line",
      sku: "MULTI",
      destinationYard: "3445",
      pallets: 30,
      quantity: 300,
      itemWeight: 2
    }],
    dropoffs: [{
      key: "yard:3445",
      destinationYard: "3445",
      address: "3445 Kennedy Road, Toronto, ON",
      lineRowIds: ["multi-line"]
    }]
  };
  const allocations = [
    {
      id: 201,
      dispatch_target_ref: "GOB-MULTI",
      sales_order_ref: "SO-A",
      po_order_ref: po.id,
      po_line_id: "multi-line",
      allocated_pallet_qty: 10,
      allocated_sales_qty: 100
    },
    {
      id: 202,
      dispatch_target_ref: "SO-B-S1",
      sales_order_ref: "SO-B",
      po_order_ref: po.id,
      po_line_id: "multi-line",
      allocated_pallet_qty: 5,
      allocated_sales_qty: 50
    }
  ];
  const projectedPo = projectPurchaseOrderRouteResidual(po, allocations);
  const target = (id, pallets) => ({
    id,
    type: "SO",
    sourceYard: "3445",
    pickupLocations: ["Vendor Yard"],
    poPickupManifest: [{
      poOrderRef: po.id,
      location: "Vendor Yard",
      address: "1 Vendor Road, Ayr, ON",
      items: [{ sku: "MULTI", pallets, quantity: pallets * 10, itemWeight: 2 }]
    }]
  });
  const plan = {
    id: 300,
    planDate: "2026-08-27",
    orders: [target("GOB-MULTI", 10), target("SO-B-S1", 5), projectedPo],
    trucks: [{
      id: "T-A",
      plate: "A",
      loads: [{ id: "A-L1", stops: [{ id: "A-drop", type: "drop", orderId: "GOB-MULTI" }] }]
    }, {
      id: "T-B",
      plate: "B",
      loads: [{ id: "B-L1", stops: [{ id: "B-drop", type: "drop", orderId: "SO-B-S1" }] }]
    }]
  };

  const reconciled = reconcileDependencyManagedPickups({
    plan,
    enrichedOrders: plan.orders,
    affectedTargetRefs: ["GOB-MULTI", "SO-B-S1", po.id]
  });
  const loads = reconciled.trucks.flatMap((truck) => truck.loads.map((load) => ({ truck, load })));
  const vendorPickupPallets = loads.flatMap(({ truck, load }) =>
    dispatchPhysicalStopVisits(reconciled, truck, load)
      .filter((visit) => visit.type === "pick" && /Vendor/u.test(visit.address))
      .map((visit) => visit.pallets)
  );
  const residualStops = loads.flatMap(({ load }) => load.stops)
    .filter((stop) => stop.type === "drop" && stop.orderId === po.id);

  assert.equal(projectedPo.poRouteProjection.pallets, 15);
  assert.equal(residualStops.length, 1);
  assert.deepEqual(vendorPickupPallets.sort((left, right) => left - right), [5, 25]);
  assert.equal(vendorPickupPallets.reduce((sum, pallets) => sum + pallets, 0), 30,
    "all linked and residual PO cargo is picked exactly once across loads");
});

test("an existing PO stop is reduced in place and is not moved from its existing load", () => {
  const po = projectPurchaseOrderRouteResidual(productionPo(), productionAllocations());
  const input = planWithTarget(po, {
    extraLoads: [{
      id: "T6-L2",
      stops: [
        { id: "manual-po-pick", type: "pick", orderId: PO_REF, location: "Ayr Yard - Unilock", note: "dispatcher" },
        {
          id: "manual-po-drop",
          type: "drop",
          orderId: PO_REF,
          location: "Ayr Yard - Unilock",
          dropLocation: "3445",
          dropAddress: "3445 Kennedy Road, Toronto, ON",
          dropPallets: 51,
          dropSalesQty: 2745.09,
          dropWeight: 75986.2305,
          note: "dispatcher"
        }
      ]
    }]
  });
  const next = reconcileDependencyManagedPickups({
    plan: input,
    enrichedOrders: input.orders,
    affectedTargetRefs: [TARGET_REF, PO_REF]
  });
  const firstLoadPoStops = next.trucks[0].loads[0].stops.filter((stop) => stop.orderId === PO_REF && stop.type === "drop");
  const secondLoadStops = next.trucks[0].loads[1].stops;
  const existing = secondLoadStops.find((stop) => stop.id === "manual-po-drop");

  assert.equal(firstLoadPoStops.length, 0);
  assert.equal(existing.dropPallets, 13);
  assert.equal(existing.dropWeight, 19901.67);
  assert.equal(existing.note, "dispatcher");
  assert.equal(secondLoadStops.find((stop) => stop.id === "manual-po-pick")?.note, "dispatcher");
});

test("a full direct shipment removes only its empty residual PO stop", () => {
  const po = projectPurchaseOrderRouteResidual(productionPo(), productionAllocations({
    urbanPallets: 39,
    urbanSalesQty: 2040.09,
    palletSalesQty: 51
  }).concat({
    id: 143,
    dispatch_target_ref: TARGET_REF,
    sales_order_ref: "SOB118279",
    po_order_ref: PO_REF,
    po_line_id: "dusk-line",
    allocated_pallet_qty: 12,
    allocated_layer_qty: 0,
    allocated_section_qty: 0,
    allocated_piece_qty: 0,
    allocated_sales_qty: 654
  }));
  const input = planWithTarget(po);
  input.trucks[0].loads[0].stops.push({
    id: "managed-residual",
    type: "drop",
    orderId: PO_REF,
    dropLocation: "3445",
    dependencyResidualManaged: true
  });
  input.trucks[0].loads[0].stops.push({ id: "unrelated", type: "drop", orderId: "PO-OTHER" });
  const next = reconcileDependencyManagedPickups({
    plan: input,
    enrichedOrders: input.orders,
    affectedTargetRefs: [TARGET_REF, PO_REF]
  });
  const stops = next.trucks[0].loads[0].stops;

  assert.equal(stops.some((stop) => stop.id === "managed-residual"), false);
  assert.equal(stops.some((stop) => stop.id === "unrelated"), true);
  assert.equal(stops.some((stop) => stop.id === "target-drop"), true);
});

test("server physical visits count 38 direct pallets plus 13 residual pallets once", () => {
  const po = projectPurchaseOrderRouteResidual(productionPo(), productionAllocations());
  const reconciled = reconcileDependencyManagedPickups({
    plan: planWithTarget(po),
    enrichedOrders: [targetOrder(), po],
    affectedTargetRefs: [TARGET_REF, PO_REF]
  });
  const truck = reconciled.trucks[0];
  const load = truck.loads[0];
  const visits = dispatchPhysicalStopVisits(reconciled, truck, load);
  const vendorPickup = visits.find((visit) => visit.type === "pick" && /Ayr Yard/u.test(visit.address));
  const yardDrop = visits.find((visit) => visit.entries.some((entry) => entry.stop.orderId === PO_REF));

  assert.equal(vendorPickup.pallets, 51);
  assert.equal(yardDrop.pallets, 13);
});

test("a stale saved PO stop cannot override the authoritative route residual", () => {
  const po = projectPurchaseOrderRouteResidual(productionPo(), productionAllocations());
  const plan = planWithTarget(po);
  plan.trucks[0].loads[0].stops.push({
    id: "legacy-manual-po-drop",
    type: "drop",
    orderId: PO_REF,
    dropLocation: "3445",
    dropAddress: "3445 Kennedy Road, Toronto, ON",
    lineRowIds: ["dusk-line", "urban-line", "pallet-line"],
    dropPallets: 51,
    dropLayers: 5,
    dropSalesQty: 2745.09,
    dropWeight: 75986.2305
  });

  const truck = plan.trucks[0];
  const load = truck.loads[0];
  const yardDrop = dispatchPhysicalStopVisits(plan, truck, load)
    .find((visit) => visit.entries.some((entry) => entry.stop.id === "legacy-manual-po-drop"));

  assert.equal(yardDrop.pallets, 13,
    "route-only PO projection must win over pallet and loose-unit quantities embedded in an old saved stop");
});

test("Driver shows the full source PO at vendor pickup and only the residual at the yard drop", () => {
  const po = projectPurchaseOrderRouteResidual(productionPo(), productionAllocations());
  const pickupExpected = [
    ["UNI-WIN60S-1530-DUSK", [{ unit: "PLT", value: 12 }]],
    ["UNI-URBAN60S-1836-IB", [{ unit: "PLT", value: 39 }]],
    ["PALLET", [{ unit: "EACH", value: 51, fallback: true }]]
  ];
  const dropExpected = [
    ["UNI-WIN60S-1530-DUSK", [{ unit: "PLT", value: 12 }]],
    ["UNI-URBAN60S-1836-IB", [{ unit: "PLT", value: 1 }]],
    ["PALLET", [{ unit: "EACH", value: 13, fallback: true }]]
  ];

  for (const stopType of ["pickup", "dropoff"]) {
    const detail = driverOrderDetailsFromPlan(PO_REF, po, {
      stopType,
      pickupLocation: stopType === "pickup" ? "Ayr Yard - Unilock" : "",
      lineRowIds: ["dusk-line", "urban-line", "pallet-line"],
      plan: planWithTarget(po)
    });
    assert.deepEqual(
      detail.items.map((item) => [item.sku, item.units]),
      stopType === "pickup" ? pickupExpected : dropExpected,
      stopType === "pickup"
        ? "the vendor pickup must show every pallet physically loaded"
        : "the yard drop must show only the unallocated residual"
    );
  }
});
