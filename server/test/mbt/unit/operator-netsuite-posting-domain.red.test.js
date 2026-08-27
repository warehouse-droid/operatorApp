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

function selected({ orderLine, quantity, location = 15, localOrderKey = "SO:-1", localLineId = "-101" }) {
  return { orderLine, quantity, location, localOrderKey, localLineId };
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
