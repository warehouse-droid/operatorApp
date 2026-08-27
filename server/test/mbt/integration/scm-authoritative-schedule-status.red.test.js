import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { listScmSchedule } from "../../../src/dispatch-repository.js";

after(closeDb);

const migrationUrl = new URL(
  "../../../migrations/183_scm_authoritative_schedule_status.sql",
  import.meta.url
);

async function inRollback(operation) {
  const rollback = await beginRollbackContext();
  try {
    return await rollback.run(operation);
  } finally {
    await rollback.rollback();
  }
}

test("SAS-I1: a PO-shaped VRMA Driver drop is Completed in the kind-only schedule projection", async () => {
  await inRollback(async () => {
    const suffix = crypto.randomUUID().replaceAll("-", "").toUpperCase();
    const ref = `RP-SAS-${suffix}`;
    const inserted = await query(
      `INSERT INTO scm_vrma_orders (
         vrma_ref, vendor, local_vendor, pickup_location, dropoff_location,
         status, method, created_by, updated_by
       ) VALUES (
         $1, 'SAS Vendor', 'SAS Vendor', '3445', 'SAS Vendor Yard',
         'Queued', 'MBT', 'sas-test', 'sas-test'
       ) RETURNING id`,
      [ref]
    );
    await query(
      `INSERT INTO scm_vrma_order_lines (
         vrma_order_id, item_id, sku, item_name, quantity, unit,
         pallet_qty, weight_lbs
       ) VALUES ($1, 990001, 'SAS-PALLET', 'SAS Pallet', 1, 'EA', 1, 100)`,
      [inserted.rows[0].id]
    );
    await query(
      `INSERT INTO scm_transport_schedule (
         order_kind, source_table, source_id, order_ref, status, method,
         eta_date, created_by, updated_by
       ) VALUES ('VRMA', 'scm_vrma_orders', $1, $2, 'Planned', 'MBT', current_date, 'sas-test', 'sas-test')`,
      [inserted.rows[0].id, ref]
    );
    await query(
      `INSERT INTO driver_job_records (
         job_id, plan_date, driver_login, load_id, load_name, stop_id,
         stop_type, order_refs, status, completed_at, job_details
       ) VALUES (
         $1, current_date, 'sas-driver', 'SAS-LOAD', 'SAS Load', 'SAS Drop',
         'dropoff', $2::jsonb, 'complete', now(), $3::jsonb
       )`,
      [
        `SAS-JOB-${suffix}`,
        JSON.stringify([ref]),
        JSON.stringify({
          orderTypes: ["PO"],
          orders: [{ orderRef: ref, orderType: "PO", source: "dispatch_plan" }]
        })
      ]
    );

    const rows = await listScmSchedule({ kind: "VRMA", status: "Completed" });
    const row = rows.find((candidate) => candidate.orderRef === ref);
    assert.ok(row);
    assert.equal(row.status, "Planned");
    assert.equal(row.calculatedStatus, "Completed");
    assert.equal(row.dispatchCompletionEvidenceType, "driver_job");
  });
});

test("SAS-I2: migration replay appends one canonical VRMA event and suppresses only its PO twin", async () => {
  const suffix = crypto.randomUUID().replaceAll("-", "").toUpperCase();
  const ref = `RP-SAS-BACKFILL-${suffix}`;
  const jobId = `SAS-BACKFILL-JOB-${suffix}`;
  await query(
    `INSERT INTO scm_vrma_orders (
       vrma_ref, vendor, pickup_location, dropoff_location,
       status, method, created_by, updated_by
     ) VALUES ($1, 'SAS Backfill Vendor', '3445', 'Vendor Yard', 'Queued', 'MBT', 'sas-test', 'sas-test')`,
    [ref]
  );
  await query("ALTER TABLE driver_job_records DISABLE TRIGGER trg_driver_job_dispatch_completion");
  try {
    await query(
      `INSERT INTO driver_job_records (
         job_id, plan_date, driver_login, load_id, load_name, stop_id,
         stop_type, order_refs, status, completed_at, job_details
       ) VALUES (
         $1, current_date, 'sas-backfill-driver', 'SAS-BACKFILL-LOAD',
         'SAS Backfill Load', 'SAS Backfill Drop', 'dropoff', $2::jsonb,
         'complete', now() - interval '1 day', $3::jsonb
       )`,
      [
        jobId,
        JSON.stringify([ref]),
        JSON.stringify({ orderTypes: ["PO"], orders: [{ orderRef: ref, orderType: "PO" }] })
      ]
    );
  } finally {
    await query("ALTER TABLE driver_job_records ENABLE TRIGGER trg_driver_job_dispatch_completion");
  }
  await query(
    `SELECT dispatch_record_order_completion(
       'PO', $1, now() - interval '1 day', 'driver_job', $2,
       NULL, current_date - 1, 'SAS-BACKFILL-LOAD', 'driver',
       'sas-backfill-driver', '', '{}'::jsonb
     )`,
    [ref, jobId]
  );

  const migration = await readFile(migrationUrl, "utf8");
  await query(migration);
  await query(migration);

  const ledger = await query(
    `SELECT order_kind, count(*)::int AS count
       FROM dispatch_order_completion_events
      WHERE lower(order_ref) = lower($1)
        AND completion_evidence_type = 'driver_job'
        AND completion_evidence_id = $2
      GROUP BY order_kind
      ORDER BY order_kind`,
    [ref, jobId]
  );
  assert.deepEqual(ledger.rows, [
    { order_kind: "PO", count: 1 },
    { order_kind: "VRMA", count: 1 }
  ]);
  const projected = await query(
    `SELECT order_kind
       FROM dispatch_order_completion_status
      WHERE lower(order_ref) = lower($1)
      ORDER BY order_kind`,
    [ref]
  );
  assert.deepEqual(projected.rows, [{ order_kind: "VRMA" }]);
});
