// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import { verifyOperatorNetSuitePostingRecord } from "../../../src/operator-netsuite-posting-adapter.js";
import { stableCanonicalJson } from "../../../src/operator-netsuite-posting-domain.js";

const step = Object.freeze({
  transactionType: "IF",
  sourceNetSuiteId: 44001,
  externalId: "MBBS-OP-4b20bf14-950c-4b02-8018-18fc1ed22b9d-1",
  payload: {
    item: {
      items: [
        { orderLine: 1, quantity: 4, itemReceive: true, location: 15 },
        { orderLine: 2, itemReceive: false, location: 15 }
      ]
    }
  }
});

function remote(overrides = {}) {
  return {
    id: 991,
    transactionType: "IF",
    createdFromId: 44001,
    externalId: step.externalId,
    item: { items: [{ orderLine: 1, quantity: 4, itemReceive: true, location: { value: 15 } }] },
    ...overrides
  };
}

test("P6/P8 adversarial recovery refuses missing location, duplicate line identity, and non-positive IDs", () => {
  for (const record of [
    remote({ item: { items: [{ orderLine: 1, quantity: 4, itemReceive: true }] } }),
    remote({ item: { items: [
      { orderLine: 1, quantity: 2, itemReceive: true, location: 15 },
      { orderLine: 1, quantity: 2, itemReceive: true, location: 15 }
    ] } }),
    remote({ id: 0 }),
    remote({ createdFromId: "44001 OR 1=1" })
  ]) {
    assert.throws(
      () => verifyOperatorNetSuitePostingRecord(step, record),
      (error) => error?.code === "OPERATOR_NETSUITE_POSTING_REMOTE_MISMATCH"
    );
  }
});

test("P5 adversarial canonical input rejects prototype, bigint, symbol, function, and infinity values", () => {
  const hostile = [
    Object.create({ inherited: true }),
    { value: 1n },
    { value: Symbol("hostile") },
    { value: () => true },
    { value: Number.POSITIVE_INFINITY }
  ];
  for (const value of hostile) {
    assert.throws(() => stableCanonicalJson(value), /JSON-safe|finite JSON number/u);
  }
});
