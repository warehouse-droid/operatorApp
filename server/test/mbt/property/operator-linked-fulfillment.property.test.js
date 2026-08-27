// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import fc from "fast-check";

import { projectOperatorLinkedQuantities } from "../../../src/operator-linked-quantity-domain.js";
import { buildSalesOrderCompletionSnapshot } from "../../../src/sales-order-auto-fulfillment-domain.js";

const CANDIDATE_ID = "1f772431-d01b-42cb-a2a3-c8910f0cda3c";

const conservedQuantities = fc.integer({ min: 1, max: 1_000_000 }).chain((targetUnits) => (
  fc.integer({ min: 0, max: targetUnits }).chain((poUnits) => (
    fc.integer({ min: 0, max: targetUnits - poUnits }).map((directToUnits) => ({
      target: targetUnits / 100,
      po: poUnits / 100,
      directTo: directToUnits / 100
    }))
  ))
));

test("L1-L7 conserved linked quantities always produce the exact Operator residual and IF snapshot", () => {
  fc.assert(fc.property(conservedQuantities, ({ target, po, directTo }) => {
    const projection = projectOperatorLinkedQuantities({
      required: { sales: target },
      linkedPo: { sales: po },
      linkedDirectTo: { sales: directTo }
    });
    const expectedResidual = Number(Math.max(target - po - directTo, 0).toFixed(6));
    assert.equal(projection.blocked, false);
    assert.equal(projection.operatorRequired.sales, expectedResidual);
    assert.equal(Number((projection.operatorRequired.sales + projection.linkedTotal.sales).toFixed(6)), target);

    const snapshot = buildSalesOrderCompletionSnapshot({
      candidateId: CANDIDATE_ID,
      dispatchOrderRef: "SO-PROPERTY",
      sourceSalesOrderId: 700001,
      sourceSalesOrderRef: "SO-PROPERTY",
      locationId: 15,
      lines: [{
        localLineId: "701",
        sourceLineId: "701",
        orderLine: 10,
        itemId: 9001,
        targetQuantity: target,
        operatorLoadedQuantity: expectedResidual,
        completedPoQuantity: po,
        completedDirectToQuantity: directTo,
        poEvidence: po > 0 ? [{
          allocationId: "801",
          quantity: po,
          pickupJobId: "po-pickup",
          deliveryJobId: "customer-drop",
          pickupPlanId: 10,
          pickupLoadId: "driver-one-load-one",
          deliveryPlanId: 10,
          deliveryLoadId: "driver-one-load-one"
        }] : [],
        toEvidence: directTo > 0 ? [{
          dependencyId: "901",
          quantity: directTo,
          pickupJobId: "to-pickup",
          deliveryJobId: "customer-drop"
        }] : []
      }]
    });
    assert.equal(snapshot.lines[0].deliveredQuantity, target);
  }), { numRuns: 1_000 });
});

test("L4 every positive linked over-allocation remains blocked", () => {
  fc.assert(fc.property(
    fc.integer({ min: 1, max: 1_000_000 }),
    fc.integer({ min: 1, max: 100_000 }),
    (targetUnits, excessUnits) => {
      const target = targetUnits / 100;
      const projection = projectOperatorLinkedQuantities({
        required: { sales: target },
        linkedPo: { sales: (targetUnits + excessUnits) / 100 },
        linkedDirectTo: { sales: 0 }
      });
      assert.equal(projection.blocked, true);
      assert.equal(projection.operatorRequired.sales, 0);
      assert.ok(projection.errors.some((error) => error.code === "LINKED_QUANTITY_EXCEEDS_TARGET" && error.unit === "sales"));
    }
  ), { numRuns: 1_000 });
});
