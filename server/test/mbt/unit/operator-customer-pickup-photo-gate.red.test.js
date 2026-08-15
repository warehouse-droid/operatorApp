// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import {
  getOperatorCustomerPickupPhotoRequirement,
  materializeOperatorCustomerPickupPhotoRequirement,
  OPERATOR_CUSTOMER_PICKUP_PHOTO_REQUIRED_FLAG_KEY,
  OPERATOR_CUSTOMER_PICKUP_REQUIRED_PHOTO_COUNT
} from "../../../src/operator-customer-pickup-photo-policy.js";

test("S5: only an explicit boolean false disables Customer Pickup photo evidence", () => {
  assert.equal(
    OPERATOR_CUSTOMER_PICKUP_PHOTO_REQUIRED_FLAG_KEY,
    "operator_customer_pickup_photo_required"
  );
  assert.equal(OPERATOR_CUSTOMER_PICKUP_REQUIRED_PHOTO_COUNT, 1);

  for (const row of [undefined, null, {}, { enabled: true }, { enabled: "false" }, { enabled: 0 }]) {
    const policy = materializeOperatorCustomerPickupPhotoRequirement(row);
    assert.equal(policy.required, true, JSON.stringify(row));
    assert.equal(policy.requiredPhotoCount, 1, JSON.stringify(row));
  }

  assert.deepEqual(
    materializeOperatorCustomerPickupPhotoRequirement({
      enabled: false,
      revision: "7",
      updated_at: "2026-08-15T12:00:00.000Z"
    }),
    {
      flagKey: OPERATOR_CUSTOMER_PICKUP_PHOTO_REQUIRED_FLAG_KEY,
      required: false,
      requiredPhotoCount: 0,
      revision: 7,
      updatedAt: "2026-08-15T12:00:00.000Z"
    }
  );
});

test("S5: repository lookup fails safe when the migration row is absent", async () => {
  const calls = [];
  const policy = await getOperatorCustomerPickupPhotoRequirement({
    queryFn: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      return { rowCount: 0, rows: [] };
    }
  });
  assert.equal(policy.required, true);
  assert.equal(policy.requiredPhotoCount, 1);
  assert.equal(policy.revision, null);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /FROM mbt_feature_flags/u);
  assert.deepEqual(calls[0].params, [OPERATOR_CUSTOMER_PICKUP_PHOTO_REQUIRED_FLAG_KEY]);
});

test("S2/S3: repository lookup returns one required photo when on and zero when off", async () => {
  for (const [enabled, expected] of [[true, 1], [false, 0]]) {
    const policy = await getOperatorCustomerPickupPhotoRequirement({
      queryFn: async () => ({
        rowCount: 1,
        rows: [{ enabled, revision: "11", updated_at: new Date("2026-08-15T12:30:00.000Z") }]
      })
    });
    assert.equal(policy.required, enabled);
    assert.equal(policy.requiredPhotoCount, expected);
    assert.equal(policy.revision, 11);
    assert.equal(policy.updatedAt, "2026-08-15T12:30:00.000Z");
  }
});

test("S5: database errors propagate instead of silently disabling evidence", async () => {
  await assert.rejects(
    getOperatorCustomerPickupPhotoRequirement({
      queryFn: async () => {
        throw new Error("database unavailable");
      }
    }),
    /database unavailable/u
  );
});
