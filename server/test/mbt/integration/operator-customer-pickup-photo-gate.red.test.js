// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import {
  recordCustomerPickupLoad,
  recordDeliveryLoad
} from "../../../src/delivery-repository.js";
import { OPERATOR_CUSTOMER_PICKUP_PHOTO_REQUIRED_FLAG_KEY } from
  "../../../src/operator-customer-pickup-photo-policy.js";

after(closeDb);

async function inRollback(operation) {
  const rollback = await beginRollbackContext();
  try {
    return await rollback.run(operation);
  } finally {
    await rollback.rollback();
  }
}

async function setPhotoGate(enabled) {
  const result = await query(
    `UPDATE mbt_feature_flags
        SET enabled = $2,
            revision = revision + 1,
            updated_by = 'operator-customer-pickup-photo-gate-test',
            updated_at = now()
      WHERE flag_key = $1
    RETURNING revision::int`,
    [OPERATOR_CUSTOMER_PICKUP_PHOTO_REQUIRED_FLAG_KEY, enabled]
  );
  assert.equal(result.rowCount, 1, "Migration 165 must provision the feature gate.");
  return Number(result.rows[0].revision);
}

async function seedOrder({ pickup = true } = {}) {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
  const orderId = 9_980_000_000 + Math.floor(Math.random() * 1_000_000);
  const lineIdentity = 8_980_000_000 + Math.floor(Math.random() * 1_000_000);
  const tranid = `${pickup ? "PICKUP" : "DELIVERY"}-PHOTO-GATE-${suffix}`;
  await query(
    `INSERT INTO sales_orders (
       netsuite_id, tranid, trandate, customer, status, status_text,
       outbound_location_id, outbound_location, sales_order_type,
       operator_status, local_yard_order_status, fulfillment_status,
       netsuite_active, is_test_fixture
     ) VALUES (
       $1, $2, current_date, 'Photo gate customer', 'B', 'Pending Fulfillment',
       1, '3445', $3,
       'packed', 'Packed', 'open', true, false
     )`,
    [orderId, tranid, pickup ? "Pick-Up" : "Delivery"]
  );
  const line = await query(
    `INSERT INTO sales_order_lines (
       sales_order_id, line_id, item_id, item_name, sku, item_type,
       quantity, unit, location_id, location,
       piece_qty, packed_piece_qty, to_pcs, loaded_qty, netsuite_active
     ) VALUES (
       $1, $2, 880001, 'Photo Gate Item', 'PHOTO-GATE-ITEM', 'InvtPart',
       1, 'PC', 1, '3445',
       1, 1, 1, 0, true
     ) RETURNING id`,
    [orderId, lineIdentity]
  );
  return { orderId, tranid, lineId: line.rows[0].id };
}

async function mutableSnapshot(orderId, lineId) {
  const result = await query(
    `SELECT
       (SELECT jsonb_build_object(
          'operatorStatus', operator_status,
          'localStatus', local_yard_order_status,
          'statusUpdatedAt', status_updated_at
        ) FROM sales_orders WHERE netsuite_id = $1) AS order_state,
       (SELECT jsonb_build_object(
          'loadedQty', loaded_qty,
          'packedPieces', packed_piece_qty,
          'confirmed', confirmed,
          'confirmedAt', confirmed_at
        ) FROM sales_order_lines WHERE id = $2) AS line_state,
       (SELECT count(*)::int FROM operator_load_records WHERE order_id = $1) AS loads,
       (SELECT count(*)::int FROM delivery_audit_log
         WHERE order_id = $1 AND action = 'customer_pickup.order.load') AS audits`,
    [orderId, lineId]
  );
  return result.rows[0];
}

test("S2: enabled gate rejects zero/invalid photos before any Customer Pickup mutation", async () => {
  await inRollback(async () => {
    await setPhotoGate(true);
    const order = await seedOrder({ pickup: true });
    const before = await mutableSnapshot(order.orderId, order.lineId);
    await assert.rejects(
      recordCustomerPickupLoad(order.orderId, null, {
        photoDataUrls: ["", "https://example.invalid/not-evidence.jpg"]
      }),
      (error) => {
        assert.match(error.message, /At least 1 photo is required/u);
        assert.equal(error.status, 400);
        assert.equal(error.code, "CUSTOMER_PICKUP_PHOTO_REQUIRED");
        return true;
      }
    );
    assert.deepEqual(await mutableSnapshot(order.orderId, order.lineId), before);
  });
});

test("S2: enabled gate completes with exactly one valid photo", async () => {
  await inRollback(async () => {
    const revision = await setPhotoGate(true);
    const order = await seedOrder({ pickup: true });
    const photo = "data:image/png;base64,b25lLXBpY2t1cC1waG90bw==";
    const result = await recordCustomerPickupLoad(order.orderId, null, {
      photoDataUrls: [photo]
    });
    assert.equal(result.photoRequirementEnabled, true);
    assert.equal(result.requiredPhotoCount, 1);
    assert.equal(result.photoRequirementRevision, revision);
    assert.equal(result.photoEvidenceCount, 1);
    const load = await query(
      `SELECT photo_data_url, photo_data_urls, response
         FROM operator_load_records
        WHERE id = $1`,
      [result.id]
    );
    assert.equal(load.rows[0].photo_data_url, photo);
    assert.deepEqual(load.rows[0].photo_data_urls, [photo]);
    assert.equal(load.rows[0].response.photoEvidenceCount, 1);
  });
});

test("S3: disabled gate completes with no photo and records the exact policy snapshot", async () => {
  await inRollback(async () => {
    const revision = await setPhotoGate(false);
    const order = await seedOrder({ pickup: true });
    const result = await recordCustomerPickupLoad(order.orderId, null, {
      photoDataUrls: []
    });
    assert.equal(result.photoRequirementEnabled, false);
    assert.equal(result.requiredPhotoCount, 0);
    assert.equal(result.photoRequirementRevision, revision);
    assert.equal(result.photoEvidenceCount, 0);

    const load = await query(
      `SELECT photo_data_url, photo_data_urls, response
         FROM operator_load_records
        WHERE id = $1`,
      [result.id]
    );
    assert.equal(load.rows[0].photo_data_url, "");
    assert.deepEqual(load.rows[0].photo_data_urls, []);
    assert.deepEqual(
      {
        enabled: load.rows[0].response.photoRequirementEnabled,
        required: load.rows[0].response.requiredPhotoCount,
        revision: load.rows[0].response.photoRequirementRevision,
        evidence: load.rows[0].response.photoEvidenceCount
      },
      { enabled: false, required: 0, revision, evidence: 0 }
    );

    const audit = await query(
      `SELECT details
         FROM delivery_audit_log
        WHERE order_id = $1
          AND action = 'customer_pickup.order.load'
        ORDER BY id DESC
        LIMIT 1`,
      [order.orderId]
    );
    assert.deepEqual(
      {
        enabled: audit.rows[0].details.photoRequirementEnabled,
        required: audit.rows[0].details.requiredPhotoCount,
        revision: audit.rows[0].details.photoRequirementRevision,
        evidence: audit.rows[0].details.photoEvidenceCount
      },
      { enabled: false, required: 0, revision, evidence: 0 }
    );
  });
});

test("S4: disabled gate still preserves optional supplied evidence", async () => {
  await inRollback(async () => {
    await setPhotoGate(false);
    const order = await seedOrder({ pickup: true });
    const photos = [
      "r2://operator-test/optional-1.jpg",
      "data:image/jpeg;base64,b3B0aW9uYWwtMg=="
    ];
    const result = await recordCustomerPickupLoad(order.orderId, null, { photoDataUrls: photos });
    assert.equal(result.photoEvidenceCount, 2);
    const load = await query(
      "SELECT photo_data_urls FROM operator_load_records WHERE id = $1",
      [result.id]
    );
    assert.deepEqual(load.rows[0].photo_data_urls, photos);
  });
});

test("S5: a missing gate row fails safe to one required photo", async () => {
  await inRollback(async () => {
    await query(
      "DELETE FROM mbt_feature_flags WHERE flag_key = $1",
      [OPERATOR_CUSTOMER_PICKUP_PHOTO_REQUIRED_FLAG_KEY]
    );
    const order = await seedOrder({ pickup: true });
    await assert.rejects(
      recordCustomerPickupLoad(order.orderId, null, { photoDataUrls: [] }),
      (error) => {
        assert.match(error.message, /At least 1 photo is required/u);
        assert.equal(error.status, 400);
        return true;
      }
    );
  });
});

test("S8: ordinary Delivery retains its independent two-photo requirement", async () => {
  await inRollback(async () => {
    await setPhotoGate(false);
    const order = await seedOrder({ pickup: false });
    await assert.rejects(
      recordDeliveryLoad(order.orderId, null, {
        photoDataUrls: ["data:image/png;base64,b25lLWRlbGl2ZXJ5LXBob3Rv"]
      }),
      /At least 2 photos are required/u
    );
  });
});
