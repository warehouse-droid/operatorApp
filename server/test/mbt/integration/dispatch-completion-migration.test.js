// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";

import { closeDb, query } from "../../../src/db.js";

after(closeDb);

const migrationUrl = new URL("../../../migrations/159_dispatch_order_completion_status.sql", import.meta.url);

test("U8: migration backfills every retained completion source once and is replay-safe", async () => {
  const suffix = crypto.randomUUID().replaceAll("-", "").toUpperCase();
  const base = 9_997_000_000 + Math.floor(Math.random() * 10_000);
  const completedAt = "2040-01-20T17:30:00.000Z";
  const references = {
    driver: `PO-U8-DRIVER-${suffix}`,
    dependencySales: `SO-U8-DIRECT-${suffix}`,
    dependencyTransfer: `TO-U8-DIRECT-${suffix}`,
    reconciliation: `PO-U8-RECON-${suffix}`,
    fulfillment: `SO-U8-FULFILLED-${suffix}`,
    vrma: `VRMA-U8-${suffix}`,
    custom: `CUSTOM-U8-${suffix}`
  };
  const projectedReferences = [
    references.driver,
    references.dependencyTransfer,
    references.reconciliation,
    references.fulfillment,
    references.vrma,
    references.custom
  ];

  const disabledTriggers = [
    ["driver_job_records", "trg_driver_job_dispatch_completion"],
    ["order_dependencies", "trg_direct_dependency_dispatch_completion"],
    ["scm_reconciliation_order_state", "trg_reconciliation_dispatch_completion"],
    ["sales_orders", "trg_sales_fulfillment_dispatch_completion"],
    ["scm_vrma_orders", "trg_vrma_dispatch_completion"],
    ["dispatch_custom_orders", "trg_custom_order_dispatch_completion"]
  ];
  for (const [table, trigger] of disabledTriggers) {
    await query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
  }
  try {
    await query(
      `INSERT INTO driver_job_records (
         job_id, plan_date, driver_login, load_id, load_name, stop_id,
         stop_type, order_refs, status, completed_at, job_details
       ) VALUES (
         $1, '2040-01-20', 'u8-driver', $2, 'U8 Load', 'U8 Driver Drop',
         'dropoff', $3::jsonb, 'complete', $4::timestamptz, $5::jsonb
       )`,
      [
        `U8-DRIVER-${suffix}`,
        `U8-LOAD-${suffix}`,
        JSON.stringify([references.driver]),
        completedAt,
        JSON.stringify({
          address: "8 Driver Backfill Road, Toronto, ON",
          orderTypes: ["PO"],
          orders: [{ orderType: "PO", orderRef: references.driver, source: "dispatch" }]
        })
      ]
    );
    await query(
      `INSERT INTO sales_orders (
         netsuite_id, tranid, customer, fulfillment_status,
         outbound_location_id, outbound_location, sales_order_type,
         dispatch_address, netsuite_active, synced_at
       ) VALUES (
         $1, $2, 'U8 direct customer', 'not_fulfilled',
         28, '2967', 'Delivery', '8 Direct Road, Toronto, ON', true, now()
       )`,
      [base + 1, references.dependencySales]
    );
    await query(
      `INSERT INTO transfer_orders (
         netsuite_id, tranid, from_location_id, from_location,
         to_location_id, to_location, fulfillment_status, netsuite_active, synced_at
       ) VALUES ($1, $2, 28, '2967', 15, '12441', 'not_fulfilled', true, now())`,
      [base + 2, references.dependencyTransfer]
    );
    await query(
      `INSERT INTO order_dependencies (
         sales_order_id, sales_order_ref, transfer_order_id, transfer_order_ref,
         dependency_mode, same_load_required, status,
         source_location_id, source_location,
         accounting_destination_location_id, accounting_destination_location,
         planned_date, planned_load_id, planned_load_name,
         local_completed_at, direct_received_at, direct_receipt_job_id,
         reconciliation_status, dispatch_target_ref, dispatch_target_kind
       ) VALUES (
         $1, $2, $3, $4, 'direct_to_customer', true, 'received_local',
         28, '2967', 15, '12441', '2040-01-20', $5, 'U8 Load',
         $6::timestamptz, $6::timestamptz, $7, 'required', $2, 'normal'
       )`,
      [
        base + 1,
        references.dependencySales,
        base + 2,
        references.dependencyTransfer,
        `U8-LOAD-${suffix}`,
        completedAt,
        `U8-DIRECT-RECEIPT-${suffix}`
      ]
    );
    await query(
      `INSERT INTO scm_reconciliation_order_state (
         order_kind, source_order_netsuite_id, source_order_ref,
         application_status, reconciliation_status, reconciliation_source,
         source_location, destination_location, order_snapshot, completed_at
       ) VALUES (
         'PO', $1, $2, 'Completed', 'ok', 'manual',
         'Vendor yard', '12441', '{"dispatchPlanDate":"2040-01-20"}'::jsonb,
         $3::timestamptz
       )`,
      [base + 3, references.reconciliation, completedAt]
    );
    await query(
      `INSERT INTO sales_orders (
         netsuite_id, tranid, customer, fulfillment_status, fulfilled_at,
         outbound_location_id, outbound_location, sales_order_type,
         dispatch_address, netsuite_active, synced_at
       ) VALUES (
         $1, $2, 'U8 fulfilled customer', 'fulfilled', $3::timestamptz,
         28, '2967', 'Delivery', '8 Fulfilled Road, Toronto, ON', true, $3::timestamptz
       )`,
      [base + 4, references.fulfillment, completedAt]
    );
    await query(
      `INSERT INTO scm_vrma_orders (
         vrma_ref, vendor, local_vendor, pickup_location, dropoff_location,
         status, method, notes, created_by, updated_by,
         completed_at, completed_by, completion_note, completion_source
       ) VALUES (
         $1, 'U8 Vendor', 'U8 Vendor', '3445', 'U8 Vendor Yard',
         'completed', 'MBT', 'U8 migration fixture', 'u8', 'u8',
         $2::timestamptz, 'u8', 'Retained VRMA completion', 'manual'
       )`,
      [references.vrma, completedAt]
    );
    await query(
      `INSERT INTO dispatch_custom_orders (
         ref_number, pickup_location, dropoff_location, order_details,
         weight_lbs, status, created_by, updated_by, completed_at
       ) VALUES (
         $1, 'U8 custom pickup', 'U8 custom drop', 'U8 migration fixture',
         1000, 'completed', 'u8', 'u8', $2::timestamptz
       )`,
      [references.custom, completedAt]
    );
  } finally {
    for (const [table, trigger] of disabledTriggers) {
      await query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
    }
  }

  const before = await query(
    `SELECT count(*)::int AS count
       FROM dispatch_order_completion_events
      WHERE order_ref = ANY($1::text[])`,
    [projectedReferences]
  );
  assert.equal(before.rows[0].count, 0, "fixtures must represent retained pre-migration source state");

  const migration = await readFile(migrationUrl, "utf8");
  await query(migration);

  const first = await query(
    `SELECT order_kind, order_ref, completion_evidence_type,
            dispatch_completion_status, dispatch_completed_at
       FROM dispatch_order_completion_status
      WHERE order_ref = ANY($1::text[])
      ORDER BY order_ref`,
    [projectedReferences]
  );
  assert.equal(first.rowCount, projectedReferences.length);
  assert.deepEqual(
    Object.fromEntries(first.rows.map((row) => [row.order_ref, row.completion_evidence_type])),
    {
      [references.driver]: "driver_job",
      [references.dependencyTransfer]: "direct_dependency",
      [references.reconciliation]: "reconciliation",
      [references.fulfillment]: "netsuite_fulfillment",
      [references.vrma]: "vrma_completion",
      [references.custom]: "custom_order"
    }
  );
  for (const row of first.rows) {
    assert.equal(row.dispatch_completion_status, "completed");
    assert.equal(new Date(row.dispatch_completed_at).toISOString(), completedAt);
  }

  const sourceStates = await query(
    `SELECT
       (SELECT status FROM driver_job_records WHERE job_id = $1) AS driver_status,
       (SELECT status FROM order_dependencies WHERE transfer_order_ref = $2) AS dependency_status,
       (SELECT application_status FROM scm_reconciliation_order_state WHERE source_order_ref = $3) AS reconciliation_status,
       (SELECT fulfillment_status FROM sales_orders WHERE tranid = $4) AS fulfillment_status,
       (SELECT status FROM scm_vrma_orders WHERE vrma_ref = $5) AS vrma_status,
       (SELECT status FROM dispatch_custom_orders WHERE ref_number = $6) AS custom_status`,
    [
      `U8-DRIVER-${suffix}`,
      references.dependencyTransfer,
      references.reconciliation,
      references.fulfillment,
      references.vrma,
      references.custom
    ]
  );
  assert.deepEqual(sourceStates.rows[0], {
    driver_status: "complete",
    dependency_status: "received_local",
    reconciliation_status: "Completed",
    fulfillment_status: "fulfilled",
    vrma_status: "completed",
    custom_status: "completed"
  });

  await query(migration);
  const replayed = await query(
    `SELECT count(*)::int AS count
       FROM dispatch_order_completion_events
      WHERE order_ref = ANY($1::text[])`,
    [projectedReferences]
  );
  assert.equal(replayed.rows[0].count, projectedReferences.length);
});
