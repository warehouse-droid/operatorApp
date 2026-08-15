// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateBillingUnitAmount,
  planDriverBillingUnits,
  resolveManualBillingAmount
} from "../../../src/mbt/mbbs-driver-billing-planner.js";
import { DEFAULT_MBBS_RATE_CARD_POLICY } from "../../../src/mbt/mbbs-rate-card-policy.js";

const COMPLETED_AT = "2039-08-12T18:00:00.000Z";

function calculateBillingUnitAmountWithPolicy(input) {
  return calculateBillingUnitAmount({
    ...input,
    mbbsChargingPolicy: input.mbbsChargingPolicy ?? DEFAULT_MBBS_RATE_CARD_POLICY
  });
}

function record({
  id,
  stopType,
  address,
  orderRefs,
  orders,
  completedAt = COMPLETED_AT,
  physicalVisitStopIds = [id]
}) {
  return {
    id,
    stopType,
    orderRefs,
    completedAt,
    details: {
      address,
      orders,
      physicalVisitStopIds
    }
  };
}

function order(orderRef, orderType, source = "delivery") {
  return { orderRef, orderType, source };
}

function canonical(sourceType, rootReference, originAddress, destinationAddress, extra = {}) {
  return { sourceType, rootReference, originAddress, destinationAddress, ...extra };
}

test("mixed Driver loads become independent SO/TO charges and one later shared PO leg", () => {
  const input = {
    planId: "230",
    planDate: "2039-08-12",
    loadId: "DRIVER-LOAD-3",
    loadName: "Load 3",
    completedAt: COMPLETED_AT,
    records: [
      record({
        id: "pickup-yard",
        stopType: "pickup",
        address: "12441 Woodbine Avenue",
        orderRefs: ["SO-A", "SO-B", "TO-A"],
        orders: [order("SO-A", "SALES_ORDER"), order("SO-B", "SALES_ORDER"), order("TO-A", "TRANSFER_ORDER")]
      }),
      record({
        id: "grouped-so-drop",
        stopType: "dropoff",
        address: "GOA-GROUPED-PLACEHOLDER",
        orderRefs: ["SO-A", "SO-B"],
        orders: [order("SO-A", "SALES_ORDER"), order("SO-B", "SALES_ORDER")]
      }),
      record({
        id: "to-drop",
        stopType: "dropoff",
        address: "150 Clark Boulevard",
        orderRefs: ["TO-A"],
        orders: [order("TO-A", "TRANSFER_ORDER")]
      }),
      record({
        id: "vendor-pickup",
        stopType: "pickup",
        address: "Milton Vendor Yard",
        orderRefs: ["PO-SPLIT-1", "PO-SPLIT-2"],
        orders: [order("PO-SPLIT-1", "PURCHASE_ORDER", "receiving"), order("PO-SPLIT-2", "PURCHASE_ORDER", "receiving")]
      }),
      record({
        id: "po-drop",
        stopType: "dropoff",
        address: "3445 Kennedy Road",
        orderRefs: ["PO-SPLIT-1", "PO-SPLIT-2"],
        orders: [order("PO-SPLIT-1", "PURCHASE_ORDER", "receiving"), order("PO-SPLIT-2", "PURCHASE_ORDER", "receiving")]
      })
    ],
    canonicalOrders: [
      canonical("SO", "SO-A", "12441 Woodbine Avenue", "1 Alpha Street"),
      canonical("SO", "SO-B", "12441 Woodbine Avenue", "2 Bravo Street"),
      canonical("TO", "TO-A", "12441 Woodbine Avenue", "150 Clark Boulevard"),
      canonical("PO", "PO-SPLIT-1", "Milton Vendor Yard", "3445 Kennedy Road"),
      canonical("PO", "PO-SPLIT-2", "Milton Vendor Yard", "3445 Kennedy Road")
    ]
  };

  const units = planDriverBillingUnits(input);
  assert.deepEqual(
    units.map((unit) => ({
      rule: unit.billingRule,
      refs: unit.references.map((reference) => reference.rootReference),
      route: unit.routeStops.map((stop) => stop.addressText),
      load: unit.loadNumber
    })),
    [
      { rule: "so_order", refs: ["SO-A"], route: ["12441 Woodbine Avenue", "1 Alpha Street"], load: "Load 3" },
      { rule: "so_order", refs: ["SO-B"], route: ["12441 Woodbine Avenue", "2 Bravo Street"], load: "Load 3" },
      { rule: "to_replenishment", refs: ["TO-A"], route: ["12441 Woodbine Avenue", "150 Clark Boulevard"], load: "Load 3" },
      {
        rule: "po_shared_leg",
        refs: ["PO-SPLIT-1", "PO-SPLIT-2"],
        route: ["Milton Vendor Yard", "3445 Kennedy Road"],
        load: "Load 3"
      }
    ]
  );
  assert.ok(units.every((unit) => !unit.routeStops.some((stop) => stop.addressText.includes("PLACEHOLDER"))));
  assert.deepEqual(units.map((unit) => unit.legNumber), [1, 2, 3, 4]);
});

test("an authoritative dispatch SO group is charged once while an ungrouped same-address SO remains independent", () => {
  const groupReference = "GOA-6605-6606";
  const origin = "2967 Kennedy Road";
  const destination = "37 Sunmount Road";
  const salesOrders = [
    order("SOA06605", "SALES_ORDER"),
    order("SOA06606", "SALES_ORDER"),
    order("SOA09999", "SALES_ORDER")
  ];
  const units = planDriverBillingUnits({
    planId: "213",
    planDate: "2039-08-07",
    loadId: "GROUPED-SO-LOAD",
    loadName: "Load 5",
    completedAt: COMPLETED_AT,
    records: [
      record({
        id: "group-pickup",
        stopType: "pickup",
        address: origin,
        orderRefs: salesOrders.map((entry) => entry.orderRef),
        orders: salesOrders
      }),
      record({
        id: "group-drop",
        stopType: "dropoff",
        address: groupReference,
        orderRefs: ["SOA06605", "SOA06606"],
        orders: salesOrders.slice(0, 2)
      }),
      record({
        id: "independent-drop",
        stopType: "dropoff",
        address: destination,
        orderRefs: ["SOA09999"],
        orders: salesOrders.slice(2)
      })
    ],
    canonicalOrders: [
      canonical("SO", "SOA06605", origin, destination, {
        orderGroupKey: `SO_GROUP:${groupReference}`,
        orderGroupReference: groupReference,
        orderGroupMembers: ["SOA06605", "SOA06606"],
        orderGroupPosition: 0
      }),
      canonical("SO", "SOA06606", origin, destination, {
        orderGroupKey: `SO_GROUP:${groupReference}`,
        orderGroupReference: groupReference,
        orderGroupMembers: ["SOA06605", "SOA06606"],
        orderGroupPosition: 1
      }),
      canonical("SO", "SOA09999", origin, destination)
    ]
  });

  assert.equal(units.length, 2);
  const grouped = units.find((unit) => unit.billingRule === "so_group");
  const independent = units.find((unit) => unit.billingRule === "so_order");
  assert.deepEqual(grouped?.references, [{ sourceType: "SO", rootReference: groupReference }]);
  assert.deepEqual(grouped?.memberReferences, [
    { sourceType: "SO", rootReference: "SOA06605" },
    { sourceType: "SO", rootReference: "SOA06606" }
  ]);
  assert.deepEqual(grouped?.routeStops.map((stop) => stop.addressText), [origin, destination]);
  assert.doesNotMatch(JSON.stringify(grouped?.routeStops), /GOA-6605-6606/u);
  assert.match(grouped?.relationship.summary || "", /charged once as one Sales Order group/iu);
  assert.deepEqual(independent?.references, [{ sourceType: "SO", rootReference: "SOA09999" }]);
  assert.deepEqual(independent?.routeStops.map((stop) => stop.addressText), [origin, destination]);
});

test("splitting an authoritative SO group across Driver loads does not change its billing identity or amount", () => {
  const groupReference = "GOA-7001-7002";
  const canonicalOrders = ["SOA07001", "SOA07002"].map((reference, index) => canonical(
    "SO",
    reference,
    "2967 Kennedy Road",
    "10 Grouped Customer Road",
    {
      orderGroupKey: `SO_GROUP:${groupReference}`,
      orderGroupReference: groupReference,
      orderGroupMembers: ["SOA07001", "SOA07002"],
      orderGroupPosition: index
    }
  ));
  const groupedLoad = (loadId, loadName, reference) => ({
    loadId,
    loadName,
    completedAt: COMPLETED_AT,
    records: [
      record({
        id: `${loadId}-pickup`,
        stopType: "pickup",
        address: "2967 Kennedy Road",
        orderRefs: [reference],
        orders: [order(reference, "SALES_ORDER")]
      }),
      record({
        id: `${loadId}-drop`,
        stopType: "dropoff",
        address: groupReference,
        orderRefs: [reference],
        orders: [order(reference, "SALES_ORDER")]
      })
    ]
  });
  const oneLoad = planDriverBillingUnits({
    planId: "999",
    planDate: "2039-08-07",
    loads: [{
      loadId: "ONE",
      loadName: "Load 1",
      completedAt: COMPLETED_AT,
      records: [
        record({
          id: "one-pickup",
          stopType: "pickup",
          address: "2967 Kennedy Road",
          orderRefs: ["SOA07001", "SOA07002"],
          orders: [order("SOA07001", "SALES_ORDER"), order("SOA07002", "SALES_ORDER")]
        }),
        record({
          id: "one-drop",
          stopType: "dropoff",
          address: groupReference,
          orderRefs: ["SOA07001", "SOA07002"],
          orders: [order("SOA07001", "SALES_ORDER"), order("SOA07002", "SALES_ORDER")]
        })
      ]
    }],
    canonicalOrders
  });
  const twoLoads = planDriverBillingUnits({
    planId: "999",
    planDate: "2039-08-07",
    loads: [
      groupedLoad("SPLIT-A", "Load 1", "SOA07001"),
      groupedLoad("SPLIT-B", "Load 2", "SOA07002")
    ],
    canonicalOrders
  });
  const billableShape = (unit) => ({
    unitKey: unit.unitKey,
    billingRule: unit.billingRule,
    references: unit.references,
    memberReferences: unit.memberReferences,
    routeStops: unit.routeStops,
    dropCount: unit.dropCount
  });
  assert.equal(oneLoad.length, 1);
  assert.equal(twoLoads.length, 1);
  assert.deepEqual(billableShape(twoLoads[0]), billableShape(oneLoad[0]));
  assert.deepEqual(oneLoad[0].driverLoadNumbers, ["Load 1"]);
  assert.deepEqual(twoLoads[0].driverLoadNumbers, ["Load 1", "Load 2"]);
  assert.deepEqual(
    calculateBillingUnitAmountWithPolicy({ billingRule: twoLoads[0].billingRule, distanceBandAmountMinor: 25_000, dropCount: 1 }),
    calculateBillingUnitAmountWithPolicy({ billingRule: oneLoad[0].billingRule, distanceBandAmountMinor: 25_000, dropCount: 1 })
  );
});

test("an authoritative PO group is one order while retaining every child PO as evidence", () => {
  const groupReference = "PGOB-3022094354-3022094357";
  const origin = "Milton Vendor Yard";
  const destinations = ["150 Clark Boulevard", "12441 Woodbine Avenue"];
  const members = ["3022094354", "3022094357"];
  const purchaseOrders = members.map((reference) => order(reference, "PURCHASE_ORDER", "receiving"));
  const units = planDriverBillingUnits({
    planId: "410",
    planDate: "2039-08-13",
    loads: [
      {
        loadId: "PO-GROUP-A",
        loadName: "Load 1",
        completedAt: COMPLETED_AT,
        records: [
          record({
            id: "po-group-pick-a",
            stopType: "pickup",
            address: origin,
            orderRefs: [members[0]],
            orders: [purchaseOrders[0]]
          }),
          record({
            id: "po-group-drop-a",
            stopType: "dropoff",
            address: destinations[0],
            orderRefs: [members[0]],
            orders: [purchaseOrders[0]]
          })
        ]
      },
      {
        loadId: "PO-GROUP-B",
        loadName: "Load 2",
        completedAt: COMPLETED_AT,
        records: [
          record({
            id: "po-group-pick-b",
            stopType: "pickup",
            address: origin,
            orderRefs: [members[1]],
            orders: [purchaseOrders[1]]
          }),
          record({
            id: "po-group-drop-b",
            stopType: "dropoff",
            address: destinations[1],
            orderRefs: [members[1]],
            orders: [purchaseOrders[1]]
          })
        ]
      }
    ],
    canonicalOrders: members.map((reference, index) => canonical(
      "PO",
      reference,
      origin,
      destinations[index],
      {
        orderGroupKey: `PO_GROUP:${groupReference}`,
        orderGroupReference: groupReference,
        orderGroupMembers: members,
        orderGroupPosition: index
      }
    ))
  });

  assert.equal(units.length, 1);
  assert.equal(units[0].billingRule, "po_group");
  assert.deepEqual(units[0].references, [{ sourceType: "PO", rootReference: groupReference }]);
  assert.deepEqual(units[0].memberReferences, members.map((rootReference) => ({ sourceType: "PO", rootReference })));
  assert.deepEqual(units[0].routeStops.map((stop) => stop.addressText), [origin, ...destinations]);
  assert.deepEqual(units[0].driverLoadNumbers, ["Load 1", "Load 2"]);
  assert.match(units[0].relationship.summary, /charged once as one Purchase Order group/iu);
  assert.deepEqual(calculateBillingUnitAmountWithPolicy({
    billingRule: units[0].billingRule,
    distanceBandAmountMinor: 25_000,
    dropCount: units[0].dropCount
  }), {
    distanceBandAmountMinor: 25_000,
    additionalDropCount: 1,
    additionalDropUnitAmountMinor: 10_000,
    additionalDropFeeMinor: 10_000,
    calculatedAmountMinor: 35_000
  });
});

test("one consolidated physical visit is collapsed and split PO refs retain one shared charge", () => {
  const sharedVisitIds = ["drop-po-a", "drop-po-b"];
  const units = planDriverBillingUnits({
    planId: "301",
    planDate: "2039-08-13",
    loadId: "PO-LOAD",
    loadName: "Load 8",
    completedAt: COMPLETED_AT,
    records: [
      record({
        id: "pickup-po",
        stopType: "pickup",
        address: "Vendor Yard",
        orderRefs: ["PO-REF-A", "PO-REF-B"],
        orders: [order("PO-REF-A", "PURCHASE_ORDER"), order("PO-REF-B", "PURCHASE_ORDER")]
      }),
      record({
        id: "drop-po-a",
        stopType: "dropoff",
        address: "MBBS Yard",
        orderRefs: ["PO-REF-A"],
        orders: [order("PO-REF-A", "PURCHASE_ORDER"), order("PO-REF-B", "PURCHASE_ORDER")],
        physicalVisitStopIds: sharedVisitIds
      }),
      record({
        id: "drop-po-b",
        stopType: "dropoff",
        address: "MBBS Yard",
        orderRefs: ["PO-REF-B"],
        orders: [order("PO-REF-A", "PURCHASE_ORDER"), order("PO-REF-B", "PURCHASE_ORDER")],
        physicalVisitStopIds: sharedVisitIds
      })
    ],
    canonicalOrders: []
  });
  assert.equal(units.length, 1);
  assert.equal(units[0].billingRule, "po_shared_leg");
  assert.deepEqual(units[0].references.map((reference) => reference.rootReference), ["PO-REF-A", "PO-REF-B"]);
  assert.deepEqual(units[0].routeStops.map((stop) => stop.addressText), ["Vendor Yard", "MBBS Yard"]);
  assert.equal(units[0].dropCount, 1);
});

test("billing identities and totals do not change when Dispatch splits the same work across loads", () => {
  const pickupOrders = [order("PO-REF-A", "PURCHASE_ORDER"), order("PO-REF-B", "PURCHASE_ORDER")];
  const canonicalOrders = [
    canonical("PO", "PO-REF-A", "Common Vendor Yard", "MBBS Yard"),
    canonical("PO", "PO-REF-B", "Common Vendor Yard", "MBBS Yard")
  ];
  const oneLoad = planDriverBillingUnits({
    planId: "303",
    planDate: "2039-08-13",
    loads: [{
      loadId: "ONE-LOAD",
      loadName: "Load 1",
      completedAt: COMPLETED_AT,
      records: [
        record({ id: "one-pick", stopType: "pickup", address: "Common Vendor Yard", orderRefs: ["PO-REF-A", "PO-REF-B"], orders: pickupOrders }),
        record({ id: "one-drop", stopType: "dropoff", address: "MBBS Yard", orderRefs: ["PO-REF-A", "PO-REF-B"], orders: pickupOrders })
      ]
    }],
    canonicalOrders
  });
  const twoLoads = planDriverBillingUnits({
    planId: "303",
    planDate: "2039-08-13",
    loads: [
      {
        loadId: "SPLIT-A",
        loadName: "Load 1",
        completedAt: COMPLETED_AT,
        records: [
          record({ id: "a-pick", stopType: "pickup", address: "Common Vendor Yard", orderRefs: ["PO-REF-A"], orders: [pickupOrders[0]] }),
          record({ id: "a-drop", stopType: "dropoff", address: "MBBS Yard", orderRefs: ["PO-REF-A"], orders: [pickupOrders[0]] })
        ]
      },
      {
        loadId: "SPLIT-B",
        loadName: "Load 2",
        completedAt: COMPLETED_AT,
        records: [
          record({ id: "b-pick", stopType: "pickup", address: "Common Vendor Yard", orderRefs: ["PO-REF-B"], orders: [pickupOrders[1]] }),
          record({ id: "b-drop", stopType: "dropoff", address: "MBBS Yard", orderRefs: ["PO-REF-B"], orders: [pickupOrders[1]] })
        ]
      }
    ],
    canonicalOrders
  });
  const billableShape = (units) => units.map((unit) => ({
    unitKey: unit.unitKey,
    billingRule: unit.billingRule,
    references: unit.references,
    routeStops: unit.routeStops,
    dropCount: unit.dropCount
  }));
  assert.deepEqual(billableShape(twoLoads), billableShape(oneLoad));
  assert.deepEqual(oneLoad[0].driverLoadNumbers, ["Load 1"]);
  assert.deepEqual(twoLoads[0].driverLoadNumbers, ["Load 1", "Load 2"]);

  const oneLoadAmount = calculateBillingUnitAmountWithPolicy({
    billingRule: oneLoad[0].billingRule,
    distanceBandAmountMinor: 25_000,
    dropCount: oneLoad[0].dropCount
  });
  const twoLoadAmount = calculateBillingUnitAmountWithPolicy({
    billingRule: twoLoads[0].billingRule,
    distanceBandAmountMinor: 25_000,
    dropCount: twoLoads[0].dropCount
  });
  assert.deepEqual(twoLoadAmount, oneLoadAmount);
});

test("direct-dependency TO is an additional drop while its linked SO remains an order charge", () => {
  const units = planDriverBillingUnits({
    planId: "302",
    planDate: "2039-08-13",
    loadId: "DIRECT-LOAD",
    loadName: "Load 2",
    completedAt: COMPLETED_AT,
    records: [
      record({
        id: "direct-pickup",
        stopType: "pickup",
        address: "2967 Kennedy Road",
        orderRefs: ["SO-DIRECT", "TO-DIRECT"],
        orders: [
          order("SO-DIRECT", "SALES_ORDER"),
          order("TO-DIRECT", "TRANSFER_ORDER", "direct_dependency")
        ]
      }),
      record({
        id: "direct-drop",
        stopType: "dropoff",
        address: "Customer Address",
        orderRefs: ["SO-DIRECT", "TO-DIRECT"],
        orders: [order("SO-DIRECT", "SALES_ORDER"), order("TO-DIRECT", "TRANSFER_ORDER")]
      })
    ],
    canonicalOrders: [
      canonical("SO", "SO-DIRECT", "2967 Kennedy Road", "Customer Address"),
      canonical("TO", "TO-DIRECT", "2967 Kennedy Road", "Customer Address")
    ]
  });
  assert.deepEqual(units.map((unit) => unit.billingRule), ["so_order", "to_direct_additional_drop"]);
  assert.match(units[1].relationship.summary, /additional drop/i);
});

test("billing unit arithmetic applies the full, multi-drop, and direct-TO policies in integer cents", () => {
  assert.deepEqual(calculateBillingUnitAmountWithPolicy({
    billingRule: "so_order",
    distanceBandAmountMinor: 20_000,
    dropCount: 1
  }), {
    distanceBandAmountMinor: 20_000,
    additionalDropCount: 0,
    additionalDropUnitAmountMinor: 0,
    additionalDropFeeMinor: 0,
    calculatedAmountMinor: 20_000
  });
  assert.deepEqual(calculateBillingUnitAmountWithPolicy({
    billingRule: "po_shared_leg",
    distanceBandAmountMinor: 25_000,
    dropCount: 3
  }), {
    distanceBandAmountMinor: 25_000,
    additionalDropCount: 2,
    additionalDropUnitAmountMinor: 10_000,
    additionalDropFeeMinor: 20_000,
    calculatedAmountMinor: 45_000
  });
  assert.deepEqual(calculateBillingUnitAmountWithPolicy({
    billingRule: "to_direct_additional_drop",
    distanceBandAmountMinor: 35_000,
    dropCount: 1
  }), {
    distanceBandAmountMinor: 0,
    additionalDropCount: 1,
    additionalDropUnitAmountMinor: 10_000,
    additionalDropFeeMinor: 10_000,
    calculatedAmountMinor: 10_000
  });
});

test("two editable money fields are exact, synchronized, bounded, and reject stale/tampered values", () => {
  assert.deepEqual(resolveManualBillingAmount({
    calculatedAmountMinor: 25_000,
    adjustmentMinor: -2_501,
    finalAmountMinor: 22_499
  }), {
    calculatedAmountMinor: 25_000,
    adjustmentMinor: -2_501,
    finalAmountMinor: 22_499
  });
  assert.deepEqual(resolveManualBillingAmount({
    calculatedAmountMinor: 25_000,
    finalAmountMinor: 30_001
  }), {
    calculatedAmountMinor: 25_000,
    adjustmentMinor: 5_001,
    finalAmountMinor: 30_001
  });
  assert.throws(
    () => resolveManualBillingAmount({ calculatedAmountMinor: 25_000, adjustmentMinor: 1, finalAmountMinor: 25_000 }),
    (error) => error?.code === "MBT_BILLING_MANUAL_AMOUNT_MISMATCH"
  );
  assert.throws(
    () => resolveManualBillingAmount({ calculatedAmountMinor: 25_000, adjustmentMinor: -25_001 }),
    (error) => error?.code === "MBT_BILLING_FINAL_AMOUNT_INVALID"
  );
});

test("money policy rejects malformed, negative, missing-route, and overflowing inputs", () => {
  assert.deepEqual(resolveManualBillingAmount({ calculatedAmountMinor: 25_000 }), {
    calculatedAmountMinor: 25_000,
    adjustmentMinor: 0,
    finalAmountMinor: 25_000
  });
  for (const [input, code] of [
    [{}, "MBT_BILLING_MANUAL_AMOUNT_INVALID"],
    [{ calculatedAmountMinor: -1 }, "MBT_BILLING_FINAL_AMOUNT_INVALID"],
    [{ calculatedAmountMinor: 1, adjustmentMinor: 0.5 }, "MBT_BILLING_MANUAL_AMOUNT_INVALID"],
    [{ calculatedAmountMinor: 1, finalAmountMinor: -1 }, "MBT_BILLING_FINAL_AMOUNT_INVALID"],
    [{ calculatedAmountMinor: Number.MAX_SAFE_INTEGER, adjustmentMinor: 1 }, "MBT_BILLING_MANUAL_AMOUNT_INVALID"]
  ]) {
    assert.throws(() => resolveManualBillingAmount(input), (error) => error?.code === code);
  }

  for (const [input, code] of [
    [{ billingRule: "per_driver_load", distanceBandAmountMinor: 1, dropCount: 1 }, "MBT_BILLING_RULE_INVALID"],
    [{ billingRule: "so_order", distanceBandAmountMinor: -1, dropCount: 1 }, "MBT_BILLING_FINAL_AMOUNT_INVALID"],
    [{ billingRule: "so_order", distanceBandAmountMinor: 1, dropCount: 0 }, "MBT_BILLING_ROUTE_INVALID"],
    [{ billingRule: "so_order", distanceBandAmountMinor: 1, dropCount: 1.5 }, "MBT_BILLING_ROUTE_INVALID"],
    [{
      billingRule: "po_shared_leg",
      distanceBandAmountMinor: 1,
      dropCount: 2,
      mbbsChargingPolicy: {
        ...DEFAULT_MBBS_RATE_CARD_POLICY,
        poAdditionalDropUnitAmountMinor: -1
      }
    }, "MBT_RATE_CARD_POLICY_INVALID"],
    [{
      billingRule: "po_shared_leg",
      distanceBandAmountMinor: Number.MAX_SAFE_INTEGER,
      dropCount: 2,
      mbbsChargingPolicy: {
        ...DEFAULT_MBBS_RATE_CARD_POLICY,
        poAdditionalDropUnitAmountMinor: 1
      }
    }, "MBT_BILLING_MANUAL_AMOUNT_INVALID"]
  ]) {
    assert.throws(() => calculateBillingUnitAmountWithPolicy(input), (error) => error?.code === code);
  }

  for (const billingRule of ["to_replenishment", "custom_order", "reconciliation"]) {
    assert.equal(calculateBillingUnitAmountWithPolicy({
      billingRule,
      distanceBandAmountMinor: 123,
      dropCount: 1
    }).calculatedAmountMinor, 123);
  }
  assert.equal(calculateBillingUnitAmountWithPolicy({
    billingRule: "po_shared_leg",
    distanceBandAmountMinor: 123,
    dropCount: 1
  }).calculatedAmountMinor, 123);
});

test("legacy-shaped Driver evidence falls back safely without inventing a per-load charge", () => {
  const units = planDriverBillingUnits({
    planId: 404,
    planDate: "2039-08-14",
    loadId: "",
    loadName: "",
    completedAt: COMPLETED_AT,
    records: [
      { id: "ignored", stop_type: "break", orderRefs: ["SO-LEGACY-S1"] },
      {
        id: "legacy-pick",
        stop_type: "pickup",
        orderRefs: ["SO-LEGACY-S1", "", "UNKNOWN"],
        completed_at: "not-a-date",
        job_details: {
          pickupLocation: "Legacy Origin",
          orderTypes: ["sales order"],
          physicalVisitStopIds: []
        }
      },
      {
        id: "legacy-drop",
        stop_type: "dropoff",
        orderRefs: ["SO-LEGACY-S2"],
        job_details: {
          dropAddress: "Legacy Destination",
          orderTypes: ["SALESORDER"]
        }
      },
      {
        id: "po-pick-only",
        stop_type: "pickup",
        orderRefs: ["PO-LEGACY"],
        job_details: { location: "Vendor fallback" }
      }
    ],
    canonicalOrders: [
      null,
      { sourceType: "not-an-order", rootReference: "INVALID" },
      { sourceType: "PO", rootReference: "PO-LEGACY", destinationAddress: "MBBS Yard" }
    ]
  });
  const sales = units.find((unit) => unit.billingRule === "so_order");
  const purchase = units.find((unit) => unit.billingRule === "po_shared_leg");
  assert.deepEqual(sales?.references, [{ sourceType: "SO", rootReference: "SO-LEGACY" }]);
  assert.deepEqual(sales?.routeStops.map((stop) => stop.addressText), ["Legacy Origin", "Legacy Destination"]);
  assert.deepEqual(sales?.driverLoadIds, []);
  assert.equal(sales?.completedAt, COMPLETED_AT);
  assert.deepEqual(purchase?.routeStops.map((stop) => stop.addressText), ["Vendor fallback", "MBBS Yard"]);
  assert.equal(purchase?.chargeable, true);
});

test("PO source grouping retains split refs, unique physical drops, and incomplete-route evidence", () => {
  const sharedOrders = [
    order("PO-A", "PURCHASEORDER"),
    order("PO-B", "purchase order"),
    order("VRMA-C", "vendor return authorization")
  ];
  const units = planDriverBillingUnits({
    planId: "405",
    planDate: "2039-08-14",
    loads: [{
      loadId: "PO-MULTI",
      completedAt: COMPLETED_AT,
      records: [
        record({
          id: "multi-pick",
          stopType: "pickup",
          address: "One Vendor",
          orderRefs: ["PO-A", "PO-B"],
          orders: sharedOrders.slice(0, 2)
        }),
        record({
          id: "multi-drop-one",
          stopType: "dropoff",
          address: "First Drop",
          orderRefs: ["PO-A"],
          orders: [sharedOrders[0]]
        }),
        record({
          id: "multi-drop-one-duplicate",
          stopType: "dropoff",
          address: " first-drop ",
          orderRefs: ["PO-B"],
          orders: [sharedOrders[1]]
        }),
        record({
          id: "multi-drop-two",
          stopType: "dropoff",
          address: "Second Drop",
          orderRefs: ["PO-B"],
          orders: [sharedOrders[1]]
        }),
        record({
          id: "vrma-drop-only",
          stopType: "dropoff",
          address: "Return Destination",
          orderRefs: ["VRMA-C"],
          orders: [sharedOrders[2]]
        })
      ]
    }],
    canonicalOrders: [
      {
        sourceType: "PO",
        rootReference: "PO-A",
        billingReference: "PO-A-SPLIT",
        billingGroupKey: "SOURCE-PO-1",
        originAddress: "One Vendor"
      },
      {
        sourceType: "PO",
        rootReference: "PO-B",
        billingReference: "PO-B-SPLIT",
        billingGroupKey: "SOURCE-PO-1",
        originAddress: "One Vendor"
      }
    ]
  });
  const shared = units.find((unit) => unit.references.length === 2);
  const incomplete = units.find((unit) => unit.references[0]?.sourceType === "VRMA");
  assert.deepEqual(shared?.references.map((reference) => reference.rootReference), ["PO-A-SPLIT", "PO-B-SPLIT"]);
  assert.deepEqual(shared?.routeStops.map((stop) => stop.addressText), ["One Vendor", "First Drop", "Second Drop"]);
  assert.equal(shared?.dropCount, 2);
  assert.equal(incomplete?.chargeable, false);
  assert.match(incomplete?.reason || "", /origin and one destination/iu);
});
