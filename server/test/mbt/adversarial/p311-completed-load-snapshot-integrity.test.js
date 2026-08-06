// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import { generateMbbsShadowBillingFromSnapshots } from "../../../src/mbt/shadow-billing-service.js";
import { billingActor, createBillingFixture } from "../support/billing-fixtures.js";

after(async () => {
  await closeDb();
});

test("P3.11 adversarial: a tampered completed-load snapshot hash is rejected without durable or external work", async () => {
  const fixture = await createBillingFixture({ query });
  const identity = crypto.randomUUID();
  const snapshotId = crypto.randomUUID();
  const physicalLoadId = `P311-TAMPERED-${identity}`;
  const completedAt = "2038-07-01T12:00:00.000Z";
  const sourceSnapshot = {
    schemaVersion: "mbbs-completed-load-snapshot-v1",
    completed: true,
    physicalLoadId,
    completedAt,
    evidenceIdentity: identity
  };
  await query(
    `INSERT INTO mbt_mbbs_completed_load_snapshots (
       completed_load_snapshot_id, source_system, source_plan_id,
       source_plan_revision, plan_date, physical_load_id, completed_at,
       truck_id, driver_id, calculated_metres, shared_total_minor, currency,
       source_references, source_snapshot, source_snapshot_hash, created_by
     ) VALUES (
       $1, 'dispatch', $2, 1, '2038-07-01', $3, $4::timestamptz,
       $5, $6, 12500, 10001, 'CAD', $7::jsonb, $8::jsonb, $9, $10
     )`,
    [
      snapshotId,
      `P311-TAMPERED-PLAN-${identity}`,
      physicalLoadId,
      completedAt,
      fixture.truckId,
      fixture.driverId,
      JSON.stringify([{ sourceType: "PO", rootReference: `PO-P311-TAMPERED-${identity}` }]),
      JSON.stringify(sourceSnapshot),
      "0".repeat(64),
      `p311-tamper-test-${identity}`
    ]
  );
  let transportCalls = 0;
  const command = {
    actor: billingActor(`p311-tamper-${identity}`),
    customerNetsuiteId: fixture.customerNetsuiteId,
    rateCardVersionId: fixture.rateCardVersionId,
    rateDistanceBandId: fixture.rateDistanceBandId,
    completedLoadSnapshotIds: [snapshotId],
    currency: "CAD",
    reason: "Reject an invented snapshot with a deliberately wrong source hash",
    idempotencyKey: `p311-tamper-${identity}`,
    correlationId: `p311-tamper-correlation-${identity}`,
    requestId: `p311-tamper-request-${identity}`
  };
  await assert.rejects(
    () => generateMbbsShadowBillingFromSnapshots(command, {
      transport: async () => {
        transportCalls += 1;
        throw new Error("A rejected P3.11 snapshot must not call transport.");
      }
    }),
    (error) => error?.code === "MBT_CROSS_CHARGE_SOURCE_INVALID"
  );
  const durable = await query(
    "SELECT count(*)::int AS count FROM mbt_cross_charge_cases WHERE physical_load_id = $1",
    [physicalLoadId]
  );
  assert.equal(durable.rows[0].count, 0);
  assert.equal(transportCalls, 0);
});
