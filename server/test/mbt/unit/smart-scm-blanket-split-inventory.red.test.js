import assert from "node:assert/strict";
import test from "node:test";

import {
  smartScmEffectiveInboundSales
} from "../../../src/smart-scm-planning-repository.js";
import {
  smartScmSplitInboundOverlay
} from "../../../src/smart-scm-phased-planning.js";

test("same-yard Blanket split remains protected inbound after Blanket exclusion", () => {
  const overlay = smartScmSplitInboundOverlay({
    lines: [{
      splitRef: "SN1399039",
      itemId: 1158,
      sourceLocationId: 1,
      destinationLocationId: 1,
      quantity: 198,
      receivedQuantity: 0,
      active: true,
      sourceAlreadyExcluded: true
    }]
  });

  assert.deepEqual(overlay.authoritativeDeltas, []);
  assert.deepEqual(overlay.releasedSplitInboundDeltas, [
    { itemId: 1158, locationId: 1, quantity: 198 }
  ]);
  assert.deepEqual(overlay.evidence, [{
    splitRef: "SN1399039",
    itemId: 1158,
    sourceLocationId: 1,
    destinationLocationId: 1,
    quantity: 198,
    sourceAlreadyExcluded: true
  }]);

  const inbound = smartScmEffectiveInboundSales({
    authoritativeOnOrderSales: 495,
    blanketExcludedSales: 594,
    releasedSplitInboundSales: overlay.releasedSplitInboundDeltas[0].quantity
  });
  assert.equal(inbound.effectiveOnOrderSales, 198);
  assert.equal(inbound.releasedSplitInboundSales, 198);
  assert.equal(inbound.effectiveOnOrderSales / 9, 22);
});

test("cross-yard Blanket split is protected while an ordinary split moves authority", () => {
  const overlay = smartScmSplitInboundOverlay({
    lines: [
      {
        splitRef: "SN1398130",
        itemId: 1158,
        sourceLocationId: 1,
        destinationLocationId: 15,
        quantity: 198,
        active: true,
        sourceAlreadyExcluded: true
      },
      {
        splitRef: "REGULAR-L1",
        itemId: 2000,
        sourceLocationId: 15,
        destinationLocationId: 28,
        quantity: 40,
        receivedQuantity: 10,
        active: true,
        sourceAlreadyExcluded: false
      }
    ]
  });

  assert.deepEqual(overlay.authoritativeDeltas, [
    { itemId: 2000, locationId: 15, quantity: -30 },
    { itemId: 2000, locationId: 28, quantity: 30 }
  ]);
  assert.deepEqual(overlay.releasedSplitInboundDeltas, [
    { itemId: 1158, locationId: 15, quantity: 198 }
  ]);
});

test("terminal Blanket children add no protected inbound", () => {
  const common = {
    itemId: 1158,
    sourceLocationId: 1,
    destinationLocationId: 1,
    quantity: 198,
    sourceAlreadyExcluded: true
  };
  const overlay = smartScmSplitInboundOverlay({
    lines: [
      { ...common, splitRef: "INACTIVE", active: false },
      { ...common, splitRef: "CLOSED", active: true, closed: true },
      { ...common, splitRef: "CANCELLED", active: true, status: "Cancelled" },
      { ...common, splitRef: "RECEIVED", active: true, receivedQuantity: 198 },
      { ...common, splitRef: "ZERO", active: true, quantity: 0 }
    ]
  });

  assert.deepEqual(overlay.authoritativeDeltas, []);
  assert.deepEqual(overlay.releasedSplitInboundDeltas, []);
  assert.deepEqual(overlay.evidence, []);
});
