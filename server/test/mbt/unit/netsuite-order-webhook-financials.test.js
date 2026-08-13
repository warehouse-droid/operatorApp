import assert from "node:assert/strict";
import test from "node:test";

import { netSuiteOrderWebhookLineFinancials } from "../../../src/netsuite-order-webhook-financials.js";

test("the NetSuite webhook receiver forwards purchase-order rate, amount, and closed state", () => {
  assert.deepEqual(netSuiteOrderWebhookLineFinancials({
    rate: 12.6,
    amount: 2520,
    closed: false
  }), {
    rate: 12.6,
    amount: 2520,
    netsuite_closed: false
  });
});

test("supported aliases retain zero values instead of falling through", () => {
  assert.deepEqual(netSuiteOrderWebhookLineFinancials({
    rate: 0,
    unitPrice: 99,
    foreignAmount: 0,
    foreign_amount: 100,
    netsuite_closed: false,
    closed: true
  }), {
    rate: 0,
    amount: 0,
    netsuite_closed: false
  });
  assert.deepEqual(netSuiteOrderWebhookLineFinancials({
    unit_price: 3.25,
    foreign_amount: 65,
    closed: true
  }), {
    rate: 3.25,
    amount: 65,
    netsuite_closed: true
  });
});

test("missing and malformed webhook lines remain explicit rather than inventing money", () => {
  const blank = { rate: undefined, amount: undefined, netsuite_closed: undefined };
  assert.deepEqual(netSuiteOrderWebhookLineFinancials(), blank);
  assert.deepEqual(netSuiteOrderWebhookLineFinancials(null), blank);
  assert.deepEqual(netSuiteOrderWebhookLineFinancials([]), blank);
});
