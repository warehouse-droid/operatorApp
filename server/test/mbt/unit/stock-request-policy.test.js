import assert from "node:assert/strict";
import test from "node:test";

import {
  SALES_STOCK_REQUEST_OVER_AVAILABILITY_FLAG_KEY,
  getSalesStockRequestAvailabilityPolicy
} from "../../../src/stock-request-policy.js";

test("Sales stock-request over-availability policy fails closed when the gate row is missing", async () => {
  let parameters = null;
  const policy = await getSalesStockRequestAvailabilityPolicy({
    queryFn: async (_sql, values) => {
      parameters = values;
      return { rows: [] };
    }
  });

  assert.deepEqual(parameters, [SALES_STOCK_REQUEST_OVER_AVAILABILITY_FLAG_KEY]);
  assert.deepEqual(policy, {
    allowOverAvailability: false,
    revision: null,
    updatedAt: null
  });
});

test("Sales stock-request over-availability policy exposes the audited Admin revision", async () => {
  const policy = await getSalesStockRequestAvailabilityPolicy({
    queryFn: async () => ({
      rows: [{ enabled: true, revision: "7", updated_at: new Date("2026-08-11T12:00:00.000Z") }]
    })
  });

  assert.deepEqual(policy, {
    allowOverAvailability: true,
    revision: 7,
    updatedAt: "2026-08-11T12:00:00.000Z"
  });
});
