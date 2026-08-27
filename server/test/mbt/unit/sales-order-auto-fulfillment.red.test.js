// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSalesOrderCompletionSnapshot,
  buildSalesOrderItemFulfillmentPayload,
  compareSalesOrderFulfillmentSnapshot,
  resolveSalesOrderFulfillmentLines,
  salesOrderAutoFulfillmentExternalId
} from "../../../src/sales-order-auto-fulfillment-domain.js";

const CANDIDATE_ID = "ca6f8ff2-1844-4cf6-98fc-1f4295683cd2";

test("L6/L10 candidate identity and conserved delivered snapshot are deterministic", () => {
  assert.equal(
    salesOrderAutoFulfillmentExternalId(CANDIDATE_ID),
    `MBBS-SOIF-${CANDIDATE_ID}`
  );
  const snapshot = buildSalesOrderCompletionSnapshot({
    candidateId: CANDIDATE_ID,
    dispatchOrderRef: "SOB118279-S1",
    sourceSalesOrderId: 951001,
    sourceSalesOrderRef: "SOB118279",
    locationId: 15,
    lines: [{
      localLineId: "split-line-1",
      sourceLineId: "291007",
      orderLine: 774411,
      itemId: 880101,
      targetQuantity: 100,
      operatorLoadedQuantity: 32,
      operatorLoadRecordId: "7011",
      completedPoQuantity: 38,
      completedDirectToQuantity: 30,
      poEvidence: [{
        allocationId: "141",
        quantity: 38,
        pickupJobId: "po-pickup-job",
        deliveryJobId: "customer-drop-job",
        pickupPlanId: 801,
        pickupLoadId: "driver-a-load-1",
        deliveryPlanId: 801,
        deliveryLoadId: "driver-a-load-1"
      }],
      toEvidence: [{
        dependencyId: "72",
        quantity: 30,
        pickupJobId: "to-pickup-job",
        deliveryJobId: "customer-drop-job"
      }]
    }]
  });
  assert.equal(snapshot.externalId, `MBBS-SOIF-${CANDIDATE_ID}`);
  assert.equal(snapshot.lines[0].deliveredQuantity, 100);
  assert.equal(snapshot.lines[0].operatorLoadedQuantity, 32);
  assert.equal(snapshot.lines[0].completedPoQuantity, 38);
  assert.equal(snapshot.lines[0].completedDirectToQuantity, 30);
  assert.equal(snapshot.lines[0].operatorLoadRecordId, "7011");
  assert.deepEqual({
    pickupPlanId: snapshot.lines[0].poEvidence[0].pickupPlanId,
    pickupLoadId: snapshot.lines[0].poEvidence[0].pickupLoadId,
    deliveryPlanId: snapshot.lines[0].poEvidence[0].deliveryPlanId,
    deliveryLoadId: snapshot.lines[0].poEvidence[0].deliveryLoadId
  }, {
    pickupPlanId: 801,
    pickupLoadId: "driver-a-load-1",
    deliveryPlanId: 801,
    deliveryLoadId: "driver-a-load-1"
  });
  assert.match(snapshot.snapshotHash, /^[0-9a-f]{64}$/u);
  assert.throws(
    () => buildSalesOrderCompletionSnapshot({
      candidateId: CANDIDATE_ID,
      dispatchOrderRef: "SOB118279-S1",
      sourceSalesOrderId: 951001,
      sourceSalesOrderRef: "SOB118279",
      locationId: 15,
      lines: [{
        localLineId: "split-line-1",
        sourceLineId: "291007",
        orderLine: 774411,
        itemId: 880101,
        targetQuantity: 100,
        operatorLoadedQuantity: 31,
        completedPoQuantity: 38,
        completedDirectToQuantity: 30
      }]
    }),
    (error) => error?.code === "SALES_ORDER_IF_CONSERVATION_FAILED"
  );
});

test("L7 a direct PO line requires allocation-scoped pickup and delivery evidence", () => {
  assert.throws(
    () => buildSalesOrderCompletionSnapshot({
      candidateId: CANDIDATE_ID,
      dispatchOrderRef: "SOB118279",
      sourceSalesOrderId: 951001,
      sourceSalesOrderRef: "SOB118279",
      locationId: 15,
      lines: [{
        localLineId: "291007",
        sourceLineId: "291007",
        orderLine: 774411,
        itemId: 880101,
        targetQuantity: 38,
        operatorLoadedQuantity: 0,
        completedPoQuantity: 38,
        completedDirectToQuantity: 0,
        poEvidence: [{
          allocationId: "141",
          quantity: 38,
          pickupJobId: "pickup-job",
          deliveryJobId: ""
        }]
      }]
    }),
    (error) => error?.code === "SALES_ORDER_IF_DIRECT_EVIDENCE_INCOMPLETE"
  );
});

test("L7 duplicate direct-supply identities cannot satisfy conserved evidence", () => {
  const base = {
    candidateId: CANDIDATE_ID,
    dispatchOrderRef: "SOA100",
    sourceSalesOrderId: 800100,
    sourceSalesOrderRef: "SOA100",
    locationId: 15
  };
  assert.throws(
    () => buildSalesOrderCompletionSnapshot({
      ...base,
      lines: [{
        localLineId: "line-1",
        sourceLineId: "line-1",
        orderLine: 10,
        itemId: 100,
        targetQuantity: 6,
        operatorLoadedQuantity: 0,
        completedPoQuantity: 6,
        completedDirectToQuantity: 0,
        poEvidence: [
          { allocationId: "501", quantity: 3, pickupJobId: "pick-1", deliveryJobId: "drop-1" },
          { allocationId: "501", quantity: 3, pickupJobId: "pick-1", deliveryJobId: "drop-1" }
        ]
      }]
    }),
    (error) => error?.code === "SALES_ORDER_IF_DIRECT_EVIDENCE_INCOMPLETE"
  );
  assert.throws(
    () => buildSalesOrderCompletionSnapshot({
      ...base,
      lines: [{
        localLineId: "line-1",
        sourceLineId: "line-1",
        orderLine: 10,
        itemId: 100,
        targetQuantity: 6,
        operatorLoadedQuantity: 0,
        completedPoQuantity: 0,
        completedDirectToQuantity: 6,
        toEvidence: [
          { dependencyId: "601", quantity: 3, pickupJobId: "pick-2", deliveryJobId: "drop-2" },
          { dependencyId: "601", quantity: 3, pickupJobId: "pick-2", deliveryJobId: "drop-2" }
        ]
      }]
    }),
    (error) => error?.code === "SALES_ORDER_IF_DIRECT_EVIDENCE_INCOMPLETE"
  );
});

test("L8 split snapshots preserve the positive NetSuite parent and exact source line", () => {
  const snapshot = buildSalesOrderCompletionSnapshot({
    candidateId: CANDIDATE_ID,
    dispatchOrderRef: "SOA100-S2",
    sourceSalesOrderId: 800100,
    sourceSalesOrderRef: "SOA100",
    locationId: 28,
    lines: [{
      localLineId: "-901",
      sourceLineId: "701",
      orderLine: 445566,
      itemId: 3001,
      targetQuantity: 16,
      operatorLoadedQuantity: 16,
      completedPoQuantity: 0,
      completedDirectToQuantity: 0
    }]
  });
  assert.equal(snapshot.sourceSalesOrderId, 800100);
  assert.equal(snapshot.dispatchOrderRef, "SOA100-S2");
  assert.equal(snapshot.lines[0].sourceLineId, "701");
  assert.equal(snapshot.lines[0].localLineId, "-901");
});

test("L9 live line drift, closure, and already-fulfilled replay fail safely", () => {
  const snapshotLines = [{ orderLine: 10, itemId: 100, deliveredQuantity: 8 }];
  assert.deepEqual(compareSalesOrderFulfillmentSnapshot({
    snapshotLines,
    liveOrder: { closed: true, lines: [] }
  }), { state: "closed", issues: [{ code: "SOURCE_ORDER_CLOSED" }] });
  assert.equal(compareSalesOrderFulfillmentSnapshot({
    snapshotLines,
    liveOrder: { closed: false, lines: [{ orderLine: 10, itemId: 100, remainingQuantity: 7, fulfilledQuantity: 0 }] }
  }).state, "attention");
  assert.equal(compareSalesOrderFulfillmentSnapshot({
    snapshotLines,
    liveOrder: { closed: false, lines: [{ orderLine: 10, itemId: 999, remainingQuantity: 8, fulfilledQuantity: 0 }] }
  }).state, "attention");
  assert.deepEqual(compareSalesOrderFulfillmentSnapshot({
    snapshotLines,
    liveOrder: { closed: false, lines: [{ orderLine: 10, itemId: 100, remainingQuantity: 0, fulfilledQuantity: 8 }] }
  }), { state: "reconciled", issues: [] });
});

test("L9 Admin snapshot/all-live/custom/skip choices remain bounded and reasoned", () => {
  const snapshotLines = [{ orderLine: 10, itemId: 100, deliveredQuantity: 8, location: 15 }];
  const liveLines = [
    { orderLine: 10, itemId: 100, remainingQuantity: 9, location: 15 },
    { orderLine: 11, itemId: 101, remainingQuantity: 4, location: 15 }
  ];
  assert.deepEqual(resolveSalesOrderFulfillmentLines({ action: "snapshot", snapshotLines, liveLines }), [
    { orderLine: 10, itemId: 100, quantity: 8, location: 15 }
  ]);
  assert.deepEqual(resolveSalesOrderFulfillmentLines({ action: "all_live_remaining", snapshotLines, liveLines }), [
    { orderLine: 10, itemId: 100, quantity: 9, location: 15 },
    { orderLine: 11, itemId: 101, quantity: 4, location: 15 }
  ]);
  assert.deepEqual(resolveSalesOrderFulfillmentLines({
    action: "custom",
    snapshotLines,
    liveLines,
    customLines: [{ orderLine: 10, quantity: 6 }],
    reason: "Customer accepted six units"
  }), [{ orderLine: 10, itemId: 100, quantity: 6, location: 15 }]);
  assert.throws(
    () => resolveSalesOrderFulfillmentLines({
      action: "custom",
      snapshotLines,
      liveLines,
      customLines: [{ orderLine: 10, quantity: 10 }],
      reason: "Too much"
    }),
    (error) => error?.code === "SALES_ORDER_IF_QUANTITY_OUT_OF_BOUNDS"
  );
  assert.throws(
    () => resolveSalesOrderFulfillmentLines({ action: "skip", snapshotLines, liveLines }),
    (error) => error?.code === "SALES_ORDER_IF_REASON_REQUIRED"
  );
  assert.deepEqual(resolveSalesOrderFulfillmentLines({
    action: "skip", snapshotLines, liveLines, reason: "Duplicate physical evidence"
  }), []);
});

test("L9 a snapshot omits lines that NetSuite has already fully reconciled", () => {
  assert.deepEqual(resolveSalesOrderFulfillmentLines({
    action: "snapshot",
    snapshotLines: [
      { orderLine: 10, itemId: 100, deliveredQuantity: 8, location: 15 },
      { orderLine: 11, itemId: 101, deliveredQuantity: 4, location: 15 }
    ],
    liveLines: [
      { orderLine: 10, itemId: 100, remainingQuantity: 0, fulfilledQuantity: 8, location: 15 },
      { orderLine: 11, itemId: 101, remainingQuantity: 4, fulfilledQuantity: 0, location: 15 }
    ]
  }), [
    { orderLine: 11, itemId: 101, quantity: 4, location: 15 }
  ]);
});

test("L10 payload explicitly disables every unselected open NetSuite line", () => {
  assert.deepEqual(buildSalesOrderItemFulfillmentPayload({
    selectedLines: [{ orderLine: 10, quantity: 8, location: 15 }],
    availableLines: [
      { orderLine: 10, location: 15 },
      { orderLine: 11, location: 15 }
    ],
    externalId: `MBBS-SOIF-${CANDIDATE_ID}`
  }), {
    externalId: `MBBS-SOIF-${CANDIDATE_ID}`,
    item: { items: [
      { orderLine: 10, quantity: 8, itemReceive: true, location: 15 },
      { orderLine: 11, itemReceive: false, location: 15 }
    ] }
  });
});
