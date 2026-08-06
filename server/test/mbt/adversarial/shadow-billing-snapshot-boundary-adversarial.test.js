// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import pg from "pg";

import { canonicalSha256 } from "../../../src/mbt/canonical-json.js";
import { generateMbbsShadowBillingFromSnapshots } from "../../../src/mbt/shadow-billing-service.js";
import {
  billingActor,
  createBillingFixture
} from "../support/billing-fixtures.js";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });

after(async () => {
  await pool.end();
});

test("P3.10 adversarial: snapshot generation rejects caller-authored loads and retains the completed-load snapshot identity", async () => {
  const client = await pool.connect();
  let fixture;
  try {
    fixture = await createBillingFixture(client);
  } finally {
    client.release();
  }

  const identity = crypto.randomUUID();
  const completedLoadSnapshotId = crypto.randomUUID();
  const physicalLoadId = `P310-SNAPSHOT-${identity}`;
  const rootReference = `PO-P310-SNAPSHOT-${identity}`;
  const completedAt = "2038-04-02T12:00:00.000Z";
  const references = [{ sourceType: "PO", rootReference }];
  const sourceSnapshot = {
    schemaVersion: "mbbs-completed-load-snapshot-v1",
    completed: true,
    physicalLoadId,
    completedAt,
    evidenceIdentity: identity
  };
  await pool.query(
    `INSERT INTO mbt_mbbs_completed_load_snapshots (
       completed_load_snapshot_id, source_system, source_plan_id,
       source_plan_revision, plan_date, physical_load_id, completed_at,
       truck_id, driver_id, calculated_metres, shared_total_minor, currency,
       source_references, source_snapshot, source_snapshot_hash, created_by
     ) VALUES (
       $1, 'dispatch', $2, 1, '2038-04-02', $3, $4::timestamptz,
       $5, $6, 12500, 10001, 'CAD', $7::jsonb, $8::jsonb, $9, $10
     )`,
    [
      completedLoadSnapshotId,
      `P310-SNAPSHOT-PLAN-${identity}`,
      physicalLoadId,
      completedAt,
      fixture.truckId,
      fixture.driverId,
      JSON.stringify(references),
      JSON.stringify(sourceSnapshot),
      canonicalSha256(sourceSnapshot),
      `p3.10-snapshot-${identity}`
    ]
  );

  const command = {
    actor: billingActor(`snapshot-${identity}`),
    customerNetsuiteId: fixture.customerNetsuiteId,
    rateCardVersionId: fixture.rateCardVersionId,
    rateDistanceBandId: fixture.rateDistanceBandId,
    completedLoadSnapshotIds: [completedLoadSnapshotId],
    currency: "CAD",
    reason: "P3.10 immutable completed-load snapshot boundary",
    idempotencyKey: `p3.10-snapshot-${identity}`,
    correlationId: `p3.10-snapshot-correlation-${identity}`,
    requestId: `p3.10-snapshot-request-${identity}`
  };
  const callerAuthoredLoads = [{
    physicalLoadId: `CALLER-AUTHORED-${identity}`,
    planDate: "2099-12-31",
    completedAt: "2099-12-31T23:59:59.999Z",
    truckId: null,
    driverId: null,
    calculatedMetres: 1,
    sharedTotalMinor: 999_999,
    references: [{ sourceType: "PO", rootReference: `PO-CALLER-AUTHORED-${identity}` }]
  }];

  await assert.rejects(
    () => generateMbbsShadowBillingFromSnapshots({ ...command, loads: callerAuthoredLoads }),
    (error) => error?.code === "MBT_CROSS_CHARGE_SNAPSHOT_INPUT_INVALID"
  );
  const rejectedCases = await pool.query(
    `SELECT count(*)::int AS count
       FROM mbt_cross_charge_cases
      WHERE physical_load_id = $1 OR physical_load_id = $2`,
    [physicalLoadId, callerAuthoredLoads[0].physicalLoadId]
  );
  assert.equal(rejectedCases.rows[0].count, 0);

  const generated = await generateMbbsShadowBillingFromSnapshots(command);
  assert.equal(generated.status, 201);
  assert.equal(generated.body.cases.length, 1);
  assert.equal(generated.body.cases[0].physicalLoadId, physicalLoadId);
  assert.equal(generated.body.cases[0].rootReference, rootReference);
  assert.equal(generated.body.cases[0].allocatedAmountMinor, 10_001);

  const retained = await pool.query(
    `SELECT physical_load_id, calculated_metres::int,
            allocated_amount_minor::int, source_snapshot
       FROM mbt_cross_charge_cases
      WHERE cross_charge_case_id = $1`,
    [generated.body.cases[0].crossChargeCaseId]
  );
  assert.equal(retained.rowCount, 1);
  const localItem = await pool.query(
    "SELECT revision::int FROM mbt_local_item_settings WHERE item_code = 'DELIVERY_CROSS_CHARGE'"
  );
  assert.equal(localItem.rowCount, 1);
  assert.deepEqual(retained.rows[0], {
    physical_load_id: physicalLoadId,
    calculated_metres: 12_500,
    allocated_amount_minor: 10_001,
    source_snapshot: {
      schemaVersion: "mbbs-cross-charge-source-v1",
      completedLoadSnapshotId,
      physicalLoadId,
      planDate: "2038-04-02",
      completedAt,
      truckId: String(fixture.truckId),
      driverId: String(fixture.driverId),
      calculatedMetres: 12_500,
      sourceType: "PO",
      rootReference,
      rateCardVersionId: fixture.rateCardVersionId,
      rateDistanceBandId: fixture.rateDistanceBandId,
      currency: "CAD",
      localItem: {
        code: "DELIVERY_CROSS_CHARGE",
        revision: localItem.rows[0].revision,
        mappingKey: "delivery_charge"
      }
    }
  });
  assert.doesNotMatch(
    JSON.stringify(retained.rows[0]),
    new RegExp(`CALLER-AUTHORED|999999|2099-12-31`, "u")
  );
});
