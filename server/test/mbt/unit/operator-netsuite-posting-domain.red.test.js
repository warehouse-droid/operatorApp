// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOperatorNetSuitePostingDraft,
  operatorNetSuiteExternalId,
  stableCanonicalJson
} from "../../../src/operator-netsuite-posting-domain.js";

const REQUEST_ID = "b5c5d3fe-8fe5-4da5-967c-68178d7aaab1";
const POLICY = Object.freeze({
  gateKey: "operator_netsuite_delivery_prep_if_12441",
  revision: 4,
  effective: true,
  functionKey: "delivery_prep",
  transactionType: "IF",
  locationId: 15,
  yardCode: "12441"
});

function selected({ orderLine, quantity, location = 15, localOrderKey = "SO:-1", localLineId = "-101", ...rest }) {
  return { orderLine, quantity, location, localOrderKey, localLineId, ...rest };
}

function target(overrides = {}) {
  return {
    sourceOrderKind: "SO",
    sourceNetSuiteId: 9001,
    sourceOrderRef: "SOA9001",
    selectedLines: [selected({ orderLine: 1, quantity: 2 })],
    availableLines: [
      { orderLine: 1, location: 15 },
      { orderLine: 3, location: 15 }
    ],
    ...overrides
  };
}

function input(overrides = {}) {
  return {
    requestId: REQUEST_ID,
    actorOperatorId: "operator-one",
    functionKey: "delivery_prep",
    transactionType: "IF",
    policy: POLICY,
    photoRefs: ["r2://operator/load/a.jpg"],
    localOrderKeys: ["SO:-1"],
    localOperation: {
      kind: "delivery_prep_load",
      orderId: "GROUP:dispatch-22",
      orderType: "group_order"
    },
    targets: [target()],
    ...overrides
  };
}

test("P5 canonical JSON sorts object keys recursively while preserving meaningful array order", () => {
  assert.equal(
    stableCanonicalJson({ z: 1, a: { y: 2, b: 3 }, lines: [{ q: 1, a: 2 }, { q: 2 }] }),
    '{"a":{"b":3,"y":2},"lines":[{"a":2,"q":1},{"q":2}],"z":1}'
  );
  assert.throws(() => stableCanonicalJson({ bad: Number.NaN }), /finite JSON number/u);
  assert.throws(() => stableCanonicalJson({ bad: undefined }), /JSON-safe/u);
});

test("P5 deterministic external IDs accept a UUID and positive step only", () => {
  assert.equal(operatorNetSuiteExternalId(REQUEST_ID, 1), `MBBS-OP-${REQUEST_ID}-1`);
  assert.equal(operatorNetSuiteExternalId(REQUEST_ID.toUpperCase(), 12), `MBBS-OP-${REQUEST_ID}-12`);
  for (const [requestId, stepIndex] of [["bad", 1], [REQUEST_ID, 0], [REQUEST_ID, 1.5]]) {
    assert.throws(
      () => operatorNetSuiteExternalId(requestId, stepIndex),
      (error) => error?.status === 400 && error?.code === "OPERATOR_NETSUITE_POSTING_INPUT_INVALID"
    );
  }
});

test("P4 one click aggregates split children by real parent and explicitly skips other parent lines", () => {
  const draft = buildOperatorNetSuitePostingDraft(input({
    localOrderKeys: ["SO:-2", "SO:-1", "SO:-1"],
    targets: [
      target({
        selectedLines: [selected({ orderLine: 1, quantity: 2, localOrderKey: "SO:-1" })]
      }),
      target({
        selectedLines: [selected({ orderLine: 1, quantity: 3, localOrderKey: "SO:-2", localLineId: "-102" })]
      })
    ]
  }));
  assert.deepEqual(draft.claims, ["SO:-1", "SO:-2"]);
  assert.deepEqual(draft.localOperation, {
    kind: "delivery_prep_load",
    orderId: "GROUP:dispatch-22",
    orderType: "group_order"
  });
  assert.deepEqual(draft.inputSnapshot.localOperation, draft.localOperation);
  assert.equal(draft.steps.length, 1);
  assert.deepEqual(draft.steps[0], {
    stepIndex: 1,
    sourceOrderKind: "SO",
    sourceNetSuiteId: 9001,
    sourceOrderRef: "SOA9001",
    transactionType: "IF",
    externalId: `MBBS-OP-${REQUEST_ID}-1`,
    payloadHash: draft.steps[0].payloadHash,
    payload: {
      externalId: `MBBS-OP-${REQUEST_ID}-1`,
      item: {
        items: [
          { orderLine: 1, quantity: 5, itemReceive: true, location: 15 },
          { orderLine: 3, itemReceive: false, location: 15 }
        ]
      }
    },
    lineSnapshot: [
      { orderLine: 1, quantity: 2, location: 15, localOrderKey: "SO:-1", localLineId: "-101" },
      { orderLine: 1, quantity: 3, location: 15, localOrderKey: "SO:-2", localLineId: "-102" }
    ]
  });
  assert.match(draft.inputHash, /^[0-9a-f]{64}$/u);
  assert.match(draft.steps[0].payloadHash, /^[0-9a-f]{64}$/u);
});

test("P6 restart-safe input requires one allowlisted local finalization operation", () => {
  assert.throws(
    () => buildOperatorNetSuitePostingDraft(input({ localOperation: undefined })),
    (error) => error?.status === 400 && error?.code === "OPERATOR_NETSUITE_POSTING_INPUT_INVALID"
  );
  assert.throws(
    () => buildOperatorNetSuitePostingDraft(input({
      localOperation: { kind: "arbitrary_callback", orderId: "22", orderType: "sales_order" }
    })),
    (error) => error?.status === 400 && error?.code === "OPERATOR_NETSUITE_POSTING_INPUT_INVALID"
  );
});

test("P4 distinct real parents receive stable separate steps regardless of input ordering", () => {
  const first = buildOperatorNetSuitePostingDraft(input({
    localOrderKeys: ["TO:8002", "SO:9001"],
    targets: [
      target({ sourceOrderKind: "TO", sourceNetSuiteId: 8002, sourceOrderRef: "TOB8002" }),
      target()
    ]
  }));
  const reversed = buildOperatorNetSuitePostingDraft(input({
    localOrderKeys: ["SO:9001", "TO:8002"],
    targets: [target(), target({ sourceOrderKind: "TO", sourceNetSuiteId: 8002, sourceOrderRef: "TOB8002" })]
  }));
  assert.equal(first.inputHash, reversed.inputHash);
  assert.deepEqual(
    first.steps.map(({ sourceOrderKind, sourceNetSuiteId, externalId }) => ({ sourceOrderKind, sourceNetSuiteId, externalId })),
    [
      { sourceOrderKind: "SO", sourceNetSuiteId: 9001, externalId: `MBBS-OP-${REQUEST_ID}-1` },
      { sourceOrderKind: "TO", sourceNetSuiteId: 8002, externalId: `MBBS-OP-${REQUEST_ID}-2` }
    ]
  );
  assert.deepEqual(first, reversed);
});

test("P5 semantic line reordering yields one input hash and exact duplicate quantities are retained", () => {
  const base = input({
    targets: [target({
      selectedLines: [
        selected({ orderLine: 3, quantity: 1, localLineId: "-103" }),
        selected({ orderLine: 1, quantity: 2 })
      ]
    })]
  });
  const reversed = structuredClone(base);
  reversed.targets[0].selectedLines.reverse();
  reversed.targets[0].availableLines.reverse();
  assert.equal(
    buildOperatorNetSuitePostingDraft(base).inputHash,
    buildOperatorNetSuitePostingDraft(reversed).inputHash
  );
});

test("P4/P7 invalid or conflicting source data fails before a command can be claimed", () => {
  const invalidInputs = [
    input({ requestId: "bad" }),
    input({ policy: { ...POLICY, effective: false } }),
    input({ localOrderKeys: [] }),
    input({ targets: [] }),
    input({ targets: [target({ sourceNetSuiteId: -1 })] }),
    input({ targets: [target({ selectedLines: [selected({ orderLine: 1, quantity: 0 })] })] }),
    input({ targets: [target({
      selectedLines: [selected({ orderLine: 1, quantity: 1, sourceLineKey: "wrong-stable-key" })],
      availableLines: [{ orderLine: 1, location: 15, sourceLineKey: "stable-key" }]
    })] }),
    input({ targets: [target({
      selectedLines: [selected({ orderLine: 1, quantity: 3, sourceLineKey: "stable-key" })],
      availableLines: [{
        orderLine: 1,
        location: 15,
        sourceLineKey: "stable-key",
        orderedQuantity: 2,
        remainingQuantity: 2
      }]
    })] }),
    input({ targets: [target({
      availableLines: [{
        orderLine: 1,
        location: 15,
        linkedTransactions: [{ id: 1, ref: "CM1", type: "CM", quantity: 1 }]
      }]
    })] }),
    input({ targets: [target({
      availableLines: [{ orderLine: 1, location: 15, orderedQuantity: 10 }]
    }), target({
      availableLines: [{ orderLine: 1, location: 15, orderedQuantity: 11 }]
    })] }),
    input({ targets: [target({
      selectedLines: [
        selected({ orderLine: 1, quantity: 1, location: 15 }),
        selected({ orderLine: 1, quantity: 1, location: 28 })
      ]
    })] })
  ];
  for (const candidate of invalidInputs) {
    assert.throws(
      () => buildOperatorNetSuitePostingDraft(candidate),
      (error) => error?.status === 400 && error?.code === "OPERATOR_NETSUITE_POSTING_INPUT_INVALID"
    );
  }
});

test("R2/M2 live progress caps the remote IR while the stable local receipt payload is retained", () => {
  const localPayload = {
    item: {
      items: [{ orderLine: 4850690, quantity: 5, itemReceive: true, location: 1 }]
    }
  };
  const draft = buildOperatorNetSuitePostingDraft(input({
    functionKey: "receiving",
    transactionType: "IR",
    policy: {
      ...POLICY,
      gateKey: "operator_netsuite_receiving_ir_3445",
      functionKey: "receiving",
      transactionType: "IR",
      locationId: 1,
      yardCode: "3445"
    },
    localOperation: { kind: "receiving_receipt", orderId: "968798", orderType: "purchase_order" },
    localPayload,
    localOrderKeys: ["receiving:purchase_order:968798"],
    targets: [target({
      sourceOrderKind: "PO",
      sourceNetSuiteId: 968798,
      sourceOrderRef: "POB03782",
      selectedLines: [selected({
        orderLine: 1,
        quantity: 5,
        location: 1,
        sourceLineKey: "4850690",
        localOrderKey: "receiving:purchase_order:968798",
        localLineId: "po-line-1"
      })],
      availableLines: [{
        orderLine: 1,
        sourceLineKey: "4850690",
        location: 1,
        orderedQuantity: 10,
        completedQuantity: 7,
        remainingQuantity: 3,
        linkedTransactions: [{ id: 991, ref: "IR991", type: "IR", quantity: 7 }]
      }]
    })]
  }));

  assert.equal(draft.steps.length, 1);
  assert.equal(draft.steps[0].payload.item.items[0].orderLine, 1);
  assert.equal(draft.steps[0].payload.item.items[0].quantity, 3);
  assert.deepEqual(draft.inputSnapshot.localPayload, localPayload);
  assert.deepEqual(draft.lineReconciliation.lines.map((line) => ({
    sourceLineKey: line.sourceLineKey,
    requestedQuantity: line.requestedQuantity,
    postedQuantity: line.postedQuantity,
    reconciledQuantity: line.reconciledQuantity
  })), [{
    sourceLineKey: "4850690",
    requestedQuantity: 5,
    postedQuantity: 3,
    reconciledQuantity: 2
  }]);
});

test("R1 a fully completed source creates no transform step but retains linked evidence", () => {
  const localPayload = {
    item: { items: [{ orderLine: 4866005, quantity: 5, itemReceive: true, location: 15 }] }
  };
  const draft = buildOperatorNetSuitePostingDraft(input({
    localPayload,
    targets: [target({
      sourceNetSuiteId: 972607,
      sourceOrderRef: "SOB119026",
      selectedLines: [selected({
        orderLine: 1,
        quantity: 5,
        sourceLineKey: "4866005",
        localOrderKey: "customer_pickup:sales_order:972607",
        localLineId: "391614"
      })],
      availableLines: [{
        orderLine: 1,
        sourceLineKey: "4866005",
        location: 15,
        orderedQuantity: 5,
        completedQuantity: 5,
        remainingQuantity: 0,
        linkedTransactions: [{ id: 881, ref: "IF881", type: "IF", quantity: 5 }]
      }]
    })]
  }));

  assert.equal(draft.steps.length, 0);
  assert.equal(draft.lineReconciliation.lines[0].postedQuantity, 0);
  assert.equal(draft.lineReconciliation.lines[0].reconciledQuantity, 5);
  assert.deepEqual(draft.lineReconciliation.lines[0].linkedTransactions, [
    { id: 881, ref: "IF881", type: "IF", quantity: 5 }
  ]);
  assert.deepEqual(draft.inputSnapshot.localPayload, localPayload);
});

test("R3 split children share one authoritative remaining-quantity cap", () => {
  const sharedAvailable = [{
    orderLine: 1,
    sourceLineKey: "parent-key",
    location: 15,
    orderedQuantity: 10,
    completedQuantity: 5,
    remainingQuantity: 5
  }];
  const draft = buildOperatorNetSuitePostingDraft(input({
    localOrderKeys: ["SO:-1", "SO:-2"],
    targets: [
      target({
        selectedLines: [selected({ orderLine: 1, quantity: 4, sourceLineKey: "parent-key", localOrderKey: "SO:-1" })],
        availableLines: sharedAvailable
      }),
      target({
        selectedLines: [selected({ orderLine: 1, quantity: 4, sourceLineKey: "parent-key", localOrderKey: "SO:-2", localLineId: "-102" })],
        availableLines: sharedAvailable
      })
    ]
  }));

  assert.equal(draft.steps.length, 1);
  assert.equal(draft.steps[0].payload.item.items[0].quantity, 5);
  assert.equal(draft.lineReconciliation.lines[0].requestedQuantity, 8);
  assert.equal(draft.lineReconciliation.lines[0].postedQuantity, 5);
  assert.equal(draft.lineReconciliation.lines[0].reconciledQuantity, 3);
});
