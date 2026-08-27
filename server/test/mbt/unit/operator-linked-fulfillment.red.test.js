// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import {
  applyOperatorLinkedQuantityProjection,
  projectOperatorLinkedQuantities,
  sumActiveLinkedQuantities
} from "../../../src/operator-linked-quantity-domain.js";
import { createOperatorNetSuitePostingAdmission } from "../../../src/operator-netsuite-posting-admission.js";
import { createOperatorNetSuitePostingTargetResolver } from "../../../src/operator-netsuite-posting-targets.js";

const ZERO = Object.freeze({ pallets: 0, layers: 0, sections: 0, pieces: 0, sales: 0 });

function quantities(sales, pallets = 0) {
  return { ...ZERO, sales, pallets };
}

test("L1-L3 Operator subtracts active Link PO and direct Link TO separately", () => {
  const linked = sumActiveLinkedQuantities({
    poAllocations: [
      { status: "active", sales: 25, pallets: 2 },
      { status: "cancelled", sales: 70, pallets: 7 }
    ],
    toAllocations: [
      { status: "active", dependencyMode: "direct_to_customer", sales: 15, pallets: 1 },
      { status: "active", dependencyMode: "yard_replenishment", sales: 50, pallets: 5 },
      { status: "cancelled", dependencyMode: "direct_to_customer", sales: 10, pallets: 1 }
    ]
  });
  assert.deepEqual(linked, {
    linkedPo: quantities(25, 2),
    linkedDirectTo: quantities(15, 1)
  });

  const projection = projectOperatorLinkedQuantities({
    required: quantities(100, 10),
    ...linked
  });
  assert.deepEqual(projection, {
    original: quantities(100, 10),
    linkedPo: quantities(25, 2),
    linkedDirectTo: quantities(15, 1),
    linkedTotal: quantities(40, 3),
    operatorRequired: quantities(60, 7),
    noYardLoadRequired: false,
    blocked: false,
    errors: []
  });
});

test("L3 flattened Operator fields retain original, separate links, residual, and compatibility aliases", () => {
  const line = {
    id: 101,
    pallet_qty: 10,
    layer_qty: 2,
    section_qty: 3,
    piece_qty: 4,
    quantity: 100
  };
  const projected = applyOperatorLinkedQuantityProjection(line, {
    linkedPo: { pallets: 2, layers: 1, sections: 0, pieces: 1, sales: 25 },
    linkedDirectTo: { pallets: 1, layers: 0, sections: 1, pieces: 0, sales: 15 }
  });
  assert.equal(projected.original_pallet_qty, 10);
  assert.equal(projected.linked_po_pallet_qty, 2);
  assert.equal(projected.linked_direct_to_pallet_qty, 1);
  assert.equal(projected.linked_allocated_pallet_qty, 3);
  assert.equal(projected.po_allocated_pallet_qty, 3, "legacy combined alias remains available");
  assert.equal(projected.pallet_qty, 7, "Operator sees only the yard residual");
  assert.equal(projected.quantity, 60);
  assert.deepEqual(projected.quantity_breakdown.sales, {
    original: 100,
    linkedPo: 25,
    linkedDirectTo: 15,
    linkedTotal: 40,
    operatorRequired: 60
  });
});

test("L3 a fully linked line remains auditable but requires no Operator yard load", () => {
  const projected = applyOperatorLinkedQuantityProjection({
    id: 102,
    pallet_qty: 10,
    layer_qty: 0,
    section_qty: 0,
    piece_qty: 0,
    quantity: 100
  }, {
    linkedPo: quantities(60, 6),
    linkedDirectTo: quantities(40, 4)
  });
  assert.equal(projected.pallet_qty, 0);
  assert.equal(projected.quantity, 0);
  assert.equal(projected.no_yard_load_required, true);
  assert.equal(projected.linked_supply_label, "No yard load required—direct supply");
  assert.equal(projected.linked_quantity_blocked, false);
});

test("L4 linked over-allocation blocks instead of silently clamping", () => {
  const projection = projectOperatorLinkedQuantities({
    required: quantities(100, 10),
    linkedPo: quantities(80, 8),
    linkedDirectTo: quantities(21, 3)
  });
  assert.equal(projection.blocked, true);
  assert.deepEqual(projection.errors.map(({ code, unit, required, linked }) => ({ code, unit, required, linked })), [
    { code: "LINKED_QUANTITY_EXCEEDS_TARGET", unit: "pallets", required: 10, linked: 11 },
    { code: "LINKED_QUANTITY_EXCEEDS_TARGET", unit: "sales", required: 100, linked: 101 }
  ]);
  assert.equal(projection.operatorRequired.pallets, 0);
  assert.equal(projection.operatorRequired.sales, 0);
});

test("L4 hostile and non-finite quantities fail closed", () => {
  assert.throws(
    () => projectOperatorLinkedQuantities({
      required: quantities(100),
      linkedPo: { ...ZERO, sales: Number.NaN },
      linkedDirectTo: ZERO
    }),
    (error) => error?.code === "LINKED_QUANTITY_INVALID"
  );
  assert.throws(
    () => projectOperatorLinkedQuantities({
      required: quantities(100),
      linkedPo: { ...ZERO, sales: -1 },
      linkedDirectTo: ZERO
    }),
    (error) => error?.code === "LINKED_QUANTITY_INVALID"
  );
});

test("L5 Delivery SO loading is local-only even when the old Delivery Prep IF gate is on", async () => {
  let policyReads = 0;
  let commandCreates = 0;
  const admit = createOperatorNetSuitePostingAdmission({
    resolveTargets: async () => ({
      functionKey: "delivery_prep",
      transactionType: "IF",
      canonicalLocationId: 15,
      localOnly: false,
      netSuitePostingOwner: "driver_completion",
      localOrderKeys: ["delivery_prep:sales_order:101"],
      localOperation: { kind: "delivery_prep_load", orderId: "101", orderType: "sales_order" }
    }),
    getPolicy: async () => { policyReads += 1; return { effective: true }; },
    createCommand: async () => { commandCreates += 1; return {}; },
    onAccepted: async () => {},
    assertLocalCompletionAllowed: async () => {}
  });
  const result = await admit({ functionKey: "delivery_prep", orderId: "101" });
  assert.equal(result.mode, "local_only");
  assert.equal(result.reason, "driver_completion_owned");
  assert.equal(policyReads, 0);
  assert.equal(commandCreates, 0);
});

test("L5/L12 target ownership is Driver completion only for Delivery SOs", async () => {
  const orders = new Map([
    ["101", {
      netsuite_id: 101,
      tranid: "SOA101",
      order_type: "sales_order",
      delivery_method: "Delivery",
      outbound_location_id: 15,
      lines: []
    }],
    ["102", {
      netsuite_id: 102,
      tranid: "SOA102",
      order_type: "sales_order",
      delivery_method: "Pick-Up",
      outbound_location_id: 15,
      lines: []
    }],
    ["201", {
      netsuite_id: 201,
      tranid: "TOB201",
      order_type: "transfer_order",
      outbound_location_id: 15,
      lines: []
    }]
  ]);
  const resolve = createOperatorNetSuitePostingTargetResolver({
    getDeliveryOrder: async (id) => orders.get(String(id)) || null,
    getReceivableReceivingOrder: async () => null,
    resolveRealSource: async () => null
  });
  const delivery = await resolve({ functionKey: "delivery_prep", orderId: 101, deferTargets: true });
  const pickup = await resolve({ functionKey: "customer_pickup", orderId: 102, deferTargets: true });
  const transfer = await resolve({ functionKey: "delivery_prep", orderId: 201, deferTargets: true });
  assert.equal(delivery.netSuitePostingOwner, "driver_completion");
  assert.equal(pickup.netSuitePostingOwner, "operator");
  assert.equal(transfer.netSuitePostingOwner, "operator");
});

test("L12 Customer Pickup SO and native TO Delivery Prep keep Operator NetSuite ownership", async () => {
  const seen = [];
  const admit = createOperatorNetSuitePostingAdmission({
    resolveTargets: async (input) => ({
      functionKey: input.functionKey,
      transactionType: "IF",
      canonicalLocationId: 15,
      localOnly: false,
      netSuitePostingOwner: "operator",
      localOrderKeys: [`${input.functionKey}:order:1`],
      localOperation: {
        kind: input.functionKey === "customer_pickup" ? "customer_pickup_load" : "delivery_prep_load",
        orderId: "1",
        orderType: input.orderType
      },
      targets: [{
        sourceOrderKind: input.orderType === "transfer_order" ? "TO" : "SO",
        sourceNetSuiteId: 1,
        sourceOrderRef: input.orderType === "transfer_order" ? "TOB00001" : "SOA00001",
        availableLines: [{ orderLine: 1, location: input.orderType === "transfer_order" ? null : 15 }],
        selectedLines: [{
          orderLine: 1,
          quantity: 1,
          location: input.orderType === "transfer_order" ? null : 15,
          localOrderKey: `${input.functionKey}:order:1`,
          localLineId: "line-1"
        }]
      }],
      materializeTargets: async function materializeTargets() { return this; }
    }),
    getPolicy: async (input) => ({
      effective: true,
      configured: true,
      functionKey: input.functionKey,
      transactionType: "IF",
      gateKey: "test_gate",
      revision: 1,
      locationId: 15,
      yardCode: "12441"
    }),
    createCommand: async (draft) => { seen.push(draft); return { replayed: false, command: { id: "one" } }; },
    onAccepted: async () => {},
    preflight: async () => {}
  });
  for (const [requestId, functionKey, orderType] of [
    ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "delivery_prep", "transfer_order"],
    ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "customer_pickup", "sales_order"]
  ]) {
    await admit({
      requestId,
      actorOperatorId: "operator-one",
      functionKey,
      orderId: "1",
      orderType,
      photoRefs: [],
      expectedPolicy: { gateKey: "test_gate", revision: 1, effective: true }
    });
  }
  assert.equal(seen.length, 2);
});
