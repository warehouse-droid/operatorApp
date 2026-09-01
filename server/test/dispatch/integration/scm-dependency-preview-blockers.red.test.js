import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { previewScmDependencyMutation } from "../../../src/scm-dependency-preview-service.js";
import {
  upsertInboundTransferOrderLines,
  upsertInboundTransferOrders,
  upsertOutboundTransferOrderLines,
  upsertOutboundTransferOrders
} from "../../../src/order-sync-repository.js";

after(closeDb);

async function seedTargetAndTransfer(suffix) {
  const base = 9_910_000_000 + Number.parseInt(suffix.slice(0, 5), 16);
  const itemId = base + 1;
  const targetRef = `SO-PREVIEW-${suffix}`;
  const transferRef = `TO-PREVIEW-${suffix}`;
  await query(
    `INSERT INTO inventory_items (
       item_id, item_name, item_type, item_type_text, stock_unit, item_weight, to_pcs
     ) VALUES ($1, 'Preview Item', 'InvtPart', 'Inventory Item', 'EA', 1, 1)`,
    [itemId]
  );
  await query(
    `INSERT INTO sales_orders (
       netsuite_id, tranid, trandate, customer, status, status_text,
       outbound_location_id, outbound_location, sales_order_type,
       fulfillment_status, operator_status, local_yard_order_status,
       dispatch_address, netsuite_active
     ) VALUES ($1, $2, current_date, 'Preview', 'B',
       'Sales Order : Pending Fulfillment', 15, '12441', 'Delivery',
       'open', 'open', 'Open', '100 Preview Street', true)`,
    [base + 2, targetRef]
  );
  const line = await query(
    `INSERT INTO sales_order_lines (
       sales_order_id, line_id, item_id, item_name, sku, item_type,
       item_type_text, quantity, unit, piece_qty, to_pcs,
       netsuite_backordered_qty, netsuite_active
     ) VALUES ($1, $2, $3, 'Preview Item', 'PREVIEW', 'InvtPart',
       'Inventory Item', 10, 'EA', 10, 1, 10, true)
     RETURNING id`,
    [base + 2, base + 3, itemId]
  );
  const order = {
    id: base + 4,
    tranid: transferRef,
    trandate: "2026-08-19",
    status: "B",
    status_text: "Transfer Order : Pending Fulfillment",
    source_location_id: 1,
    source_location: "3445",
    destination_location_id: 15,
    destination_location: "12441"
  };
  const transferLine = {
    line_id: base + 5,
    item_id: itemId,
    item_name: "Preview Item",
    sku: "PREVIEW",
    item_type: "InvtPart",
    item_type_text: "Inventory Item",
    quantity: 10,
    unit: "EA",
    netsuite_received_qty: 0,
    location_id: 1,
    location: "3445"
  };
  await upsertOutboundTransferOrders([order]);
  await upsertOutboundTransferOrderLines(order.id, [transferLine]);
  await upsertInboundTransferOrders([order]);
  await upsertInboundTransferOrderLines(order.id, [{ ...transferLine, location_id: 15, location: "12441" }]);
  return { targetRef, transferRef, salesLineId: line.rows[0].id };
}

async function setDriverOfflineMode(enabled) {
  await query(
    `INSERT INTO mbt_feature_flags (flag_key, enabled, description)
     VALUES ('driver_offline_mode', $1, 'Test Driver offline mode')
     ON CONFLICT (flag_key) DO UPDATE
       SET enabled = EXCLUDED.enabled,
           revision = mbt_feature_flags.revision + 1,
           updated_at = now()`,
    [enabled]
  );
}

async function seedCancelledDependencyWithoutExecution(seeded) {
  const sales = await query(
    "SELECT netsuite_id, outbound_location_id, outbound_location FROM sales_orders WHERE tranid = $1",
    [seeded.targetRef]
  );
  const transfer = await query(
    `SELECT netsuite_id, from_location_id, from_location,
            to_location_id, to_location
       FROM transfer_orders
      WHERE tranid = $1`,
    [seeded.transferRef]
  );
  const dependency = await query(
    `INSERT INTO order_dependencies (
       sales_order_id, sales_order_ref, dispatch_target_ref, dispatch_target_kind,
       transfer_order_id, transfer_order_ref, dependency_mode, same_load_required,
       status, source_location_id, source_location,
       accounting_destination_location_id, accounting_destination_location,
       reconciliation_status
     ) VALUES (
       $1, $2, $2, 'normal', $3, $4, 'yard_replenishment', false,
       'cancelled', $5, $6, $7, $8, 'pending'
     ) RETURNING id`,
    [
      sales.rows[0].netsuite_id,
      seeded.targetRef,
      transfer.rows[0].netsuite_id,
      seeded.transferRef,
      transfer.rows[0].from_location_id,
      transfer.rows[0].from_location,
      transfer.rows[0].to_location_id || sales.rows[0].outbound_location_id,
      transfer.rows[0].to_location || sales.rows[0].outbound_location
    ]
  );
  return Number(dependency.rows[0].id);
}

async function seedReusedPurchaseSplitRef(suffix) {
  const base = 9_920_000_000 + Number.parseInt(suffix.slice(0, 5), 16);
  const sourcePoId = base + 1;
  const sourcePoRef = `PO-PREVIEW-SOURCE-${suffix}`;
  const splitPoRef = `PO-PREVIEW-REUSED-${suffix}`;
  const retiredPoIds = [base + 10, base + 20];
  const activePoId = base + 30;
  await query(
    `INSERT INTO purchase_orders (
       netsuite_id, tranid, trandate, vendor_id, vendor, status, status_text,
       destination_location_id, destination_location, source_location_id,
       source_location, dispatch_vendor_yard, receipt_status,
       netsuite_active, synced_at
     ) VALUES (
       $1, $2, current_date, $3, 'Preview Vendor', 'E',
       'Purchase Order : Pending Billing/Partially Received',
       15, '12441', 1, '3445', 'Preview Vendor Yard',
       'not_received', true, now()
     )`,
    [sourcePoId, sourcePoRef, base + 2]
  );
  await query(
    `INSERT INTO purchase_orders (
       netsuite_id, tranid, dispatch_ref, trandate, vendor_id, vendor,
       status, status_text, destination_location_id, destination_location,
       source_location_id, source_location, dispatch_vendor_yard,
       receipt_status, netsuite_active, synced_at
     )
     SELECT child_id, $2, $2, current_date, $3, 'Preview Vendor',
            'E', 'Purchase Order : Pending Billing/Partially Received' ||
              CASE WHEN active THEN '' ELSE ' (SCM unsplit)' END,
            15, '12441', 1, '3445', 'Preview Vendor Yard',
            'not_received', active, now()
       FROM unnest($1::bigint[], ARRAY[false, false, true]::boolean[])
            AS child(child_id, active)`,
    [[...retiredPoIds, activePoId], splitPoRef, base + 3]
  );
  await query(
    `INSERT INTO dispatch_scm_po_splits (
       source_po_id, source_po_ref, split_po_id, split_po_ref,
       status, created_by, cancelled_at
     )
     SELECT $1, $2, child_id, $3,
            CASE WHEN active THEN 'active' ELSE 'cancelled' END,
            'dependency-preview-regression',
            CASE WHEN active THEN NULL ELSE now() END
       FROM unnest($4::bigint[], ARRAY[false, false, true]::boolean[])
            AS child(child_id, active)`,
    [sourcePoId, sourcePoRef, splitPoRef, [...retiredPoIds, activePoId]]
  );
  return { splitPoRef, activePoId };
}

test("PO link ignores retired rows when a reused split ref has a current active lifecycle", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const target = await seedTargetAndTransfer(suffix);
      const purchase = await seedReusedPurchaseSplitRef(suffix);
      const command = {
        action: "link_po",
        targetRef: target.targetRef,
        planDate: "2026-08-25",
        payload: { poRef: purchase.splitPoRef }
      };

      const open = await previewScmDependencyMutation(command, {
        id: "dispatch",
        sessionId: "dispatch-browser"
      });
      assert.equal(open.allowed, true);
      assert.deepEqual(open.blockers, []);

      await query(
        `UPDATE purchase_orders
            SET status = 'H',
                status_text = 'Purchase Order : Closed',
                status_updated_at = now()
          WHERE netsuite_id = $1`,
        [purchase.activePoId]
      );
      const closed = await previewScmDependencyMutation(command, {
        id: "dispatch",
        sessionId: "dispatch-browser"
      });
      assert.equal(closed.allowed, false);
      assert.deepEqual(
        closed.blockers.find((blocker) => blocker.code === "ORDER_CLOSED")?.details.orders,
        [purchase.splitPoRef.toUpperCase()]
      );
    });
  } finally {
    await rollback.rollback();
  }
});

test("shared preview allows untouched work but blocks once Operator line work starts", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const seeded = await seedTargetAndTransfer(crypto.randomUUID().slice(0, 8));
      const command = {
        action: "link_to",
        targetRef: seeded.targetRef,
        planDate: "2026-08-19",
        payload: { transferOrderRef: seeded.transferRef }
      };
      const untouched = await previewScmDependencyMutation(command, { id: "scm", sessionId: "scm-browser" });
      assert.equal(untouched.allowed, true);
      assert.deepEqual(untouched.blockers, []);

      await query("UPDATE sales_order_lines SET confirmed = true WHERE id = $1", [seeded.salesLineId]);
      const started = await previewScmDependencyMutation(command, { id: "scm", sessionId: "scm-browser" });
      assert.equal(started.allowed, false);
      assert.equal(started.blockers[0].code, "OPERATOR_ACTIVITY_STARTED");
      assert.ok(started.blockers[0].details.refs.includes(seeded.targetRef));
    });
  } finally {
    await rollback.rollback();
  }
});

test("cancelled dependency with zero execution and CO-only Driver activity does not block a new TO link", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const seeded = await seedTargetAndTransfer(crypto.randomUUID().slice(0, 8));
      const dependencyId = await seedCancelledDependencyWithoutExecution(seeded);
      await query(
        `INSERT INTO driver_job_records (
           job_id, plan_date, driver_login, stop_type, order_refs,
           status, started_at
         ) VALUES ($1, '2099-08-20', 'co-only-driver', 'dropoff', $2::jsonb,
                   'in_progress', now())`,
        [`co-only-${crypto.randomUUID()}`, JSON.stringify([`CO-${seeded.transferRef}`])]
      );
      const command = {
        action: "link_to",
        targetRef: seeded.targetRef,
        planDate: "2099-08-20",
        payload: { transferOrderRef: seeded.transferRef }
      };

      const untouched = await previewScmDependencyMutation(command, {
        id: "scm",
        sessionId: "scm-cancelled-preview"
      });
      assert.equal(untouched.allowed, true);
      assert.equal(
        untouched.blockers.some((blocker) => blocker.code === "DEPENDENCY_EXECUTION_STARTED"),
        false
      );
      assert.equal(
        untouched.blockers.some((blocker) => blocker.code === "DRIVER_ACTIVITY_STARTED"),
        false,
        "CO-TO activity is not exact activity for the underlying TO."
      );

      const jobId = `actual-to-${crypto.randomUUID()}`;
      await query(
        `INSERT INTO driver_job_records (
           job_id, plan_date, driver_login, stop_type, order_refs,
           status, started_at
         ) VALUES ($1, '2099-08-20', 'to-driver', 'pickup', $2::jsonb,
                   'in_progress', now())`,
        [jobId, JSON.stringify([seeded.transferRef])]
      );
      const actualToStarted = await previewScmDependencyMutation(command, {
        id: "scm",
        sessionId: "scm-cancelled-preview"
      });
      assert.equal(actualToStarted.allowed, false);
      assert.deepEqual(
        actualToStarted.blockers.find((blocker) => blocker.code === "DRIVER_ACTIVITY_STARTED")?.details.jobIds,
        [jobId]
      );
      assert.ok(Number.isInteger(dependencyId));
    });
  } finally {
    await rollback.rollback();
  }
});

test("cancelled dependency with physical progress remains an execution blocker", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const seeded = await seedTargetAndTransfer(crypto.randomUUID().slice(0, 8));
      const dependencyId = await seedCancelledDependencyWithoutExecution(seeded);
      const salesLine = await query(
        "SELECT item_id, item_name, unit FROM sales_order_lines WHERE id = $1",
        [seeded.salesLineId]
      );
      await query(
        `INSERT INTO order_dependency_lines (
           dependency_id, sales_line_id, item_id, item_name, unit,
           allocated_quantity, piece_qty, loaded_quantity
         ) VALUES ($1, $2, $3, $4, $5, 1, 1, 1)`,
        [
          dependencyId,
          seeded.salesLineId,
          salesLine.rows[0].item_id,
          salesLine.rows[0].item_name,
          salesLine.rows[0].unit
        ]
      );

      const preview = await previewScmDependencyMutation({
        action: "link_to",
        targetRef: seeded.targetRef,
        planDate: "2099-08-20",
        payload: { transferOrderRef: seeded.transferRef }
      }, { id: "scm", sessionId: "scm-progress-preview" });
      assert.equal(preview.allowed, false);
      assert.deepEqual(
        preview.blockers.find((blocker) => blocker.code === "DEPENDENCY_EXECUTION_STARTED")?.details.dependencyIds,
        [dependencyId]
      );
    });
  } finally {
    await rollback.rollback();
  }
});

test("confirmed plan with a suspended route-bearing PWA allows an affected job that has not started", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const seeded = await seedTargetAndTransfer(crypto.randomUUID().slice(0, 8));
      const planDate = "2099-08-18";
      await setDriverOfflineMode(true);
      const plan = await query(
        `INSERT INTO dispatch_plans (plan_date, status, revision, confirmed_at)
         VALUES ($1, 'confirmed', 8, now()) RETURNING id`,
        [planDate]
      );
      const order = {
        id: seeded.targetRef,
        type: "SO",
        sourceYard: "12441",
        pickupLocations: ["12441"],
        items: []
      };
      await query(
        `INSERT INTO dispatch_plan_snapshots (plan_id, orders, trucks, summary)
         VALUES ($1, $2::jsonb, $3::jsonb, '{}'::jsonb)`,
        [plan.rows[0].id, JSON.stringify([order]), JSON.stringify([{
          id: "truck",
          loads: [{ id: "load", stops: [{ id: "drop", type: "drop", orderId: seeded.targetRef }] }]
        }])]
      );
      const manifestId = crypto.randomUUID();
      await query(
        `INSERT INTO driver_offline_manifests (
           manifest_id, driver_login, device_id, plan_id, plan_date,
           plan_revision, generated_at, expires_at
         ) VALUES ($1, 'cheng-preview', 'iphone-preview', $2, $3, 8,
                   now(), now() + interval '1 day')`,
        [manifestId, plan.rows[0].id, planDate]
      );
      await query(
        `INSERT INTO driver_job_records (
           job_id, plan_id, plan_date, driver_login, stop_type, order_refs,
           status, started_at, completed_at
         ) VALUES ($1, $2, $3, 'cheng-preview', 'dropoff', $4::jsonb,
                   'pending', NULL, NULL)`,
        [`planned-job-${crypto.randomUUID()}`, plan.rows[0].id, planDate, JSON.stringify([seeded.targetRef])]
      );
      const preview = await previewScmDependencyMutation({
        action: "link_to",
        targetRef: seeded.targetRef,
        planId: plan.rows[0].id,
        planDate,
        expectedPlanRevision: 8,
        payload: { transferOrderRef: seeded.transferRef }
      }, { id: "scm", sessionId: "scm-browser" });
      assert.equal(preview.allowed, true);
      assert.deepEqual(preview.routeReadiness, { required: false, ready: true, blockers: [] });
      assert.deepEqual(preview.affectedDriverDevices, []);
      assert.deepEqual(preview.blockers, []);
    });
  } finally {
    await rollback.rollback();
  }
});

test("online-only mode applies an upcoming confirmed-route change without holding Driver jobs", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const seeded = await seedTargetAndTransfer(crypto.randomUUID().slice(0, 8));
      const planDate = "2099-08-17";
      await setDriverOfflineMode(false);
      const plan = await query(
        `INSERT INTO dispatch_plans (plan_date, status, revision, confirmed_at)
         VALUES ($1, 'confirmed', 7, now()) RETURNING id`,
        [planDate]
      );
      const order = {
        id: seeded.targetRef,
        type: "SO",
        sourceYard: "12441",
        pickupLocations: ["12441"],
        items: []
      };
      await query(
        `INSERT INTO dispatch_plan_snapshots (plan_id, orders, trucks, summary)
         VALUES ($1, $2::jsonb, $3::jsonb, '{}'::jsonb)`,
        [plan.rows[0].id, JSON.stringify([order]), JSON.stringify([{
          id: "truck",
          loads: [{ id: "load", stops: [{ id: "drop", type: "drop", orderId: seeded.targetRef }] }]
        }])]
      );
      await query(
        `INSERT INTO driver_job_records (
           job_id, plan_id, plan_date, driver_login, stop_type, order_refs,
           status, started_at, completed_at
         ) VALUES ($1, $2, $3, 'other-driver', 'dropoff', $4::jsonb,
                   'in_progress', now(), NULL)`,
        [`unrelated-job-${crypto.randomUUID()}`, plan.rows[0].id, planDate, JSON.stringify(["SO-UNRELATED"])]
      );

      const command = {
        action: "link_to",
        targetRef: seeded.targetRef,
        planId: plan.rows[0].id,
        planDate,
        expectedPlanRevision: 7,
        payload: { transferOrderRef: seeded.transferRef }
      };
      const preview = await previewScmDependencyMutation(command, { id: "scm", sessionId: "scm-browser" });

      assert.equal(preview.allowed, true);
      assert.equal(Number(preview.affectedPlan.id), Number(plan.rows[0].id));
      assert.deepEqual(preview.routeReadiness, { required: false, ready: true, blockers: [] });
      assert.deepEqual(preview.affectedDriverDevices, []);
      assert.deepEqual(preview.blockers, []);

      const affectedJobId = `affected-job-${crypto.randomUUID()}`;
      await query(
        `INSERT INTO driver_job_records (
           job_id, plan_id, plan_date, driver_login, stop_type, order_refs,
           status, started_at, completed_at
         ) VALUES ($1, $2, $3, 'affected-driver', 'dropoff', $4::jsonb,
                   'in_progress', now(), NULL)`,
        [affectedJobId, plan.rows[0].id, planDate, JSON.stringify([seeded.targetRef])]
      );
      const started = await previewScmDependencyMutation(command, { id: "scm", sessionId: "scm-browser" });
      assert.equal(started.allowed, false);
      assert.equal(started.blockers.find((blocker) => blocker.code === "DRIVER_ACTIVITY_STARTED")?.details.jobIds[0], affectedJobId);
    });
  } finally {
    await rollback.rollback();
  }
});

test("an unassigned order-pool entry does not turn a PO link into a confirmed route change", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const seeded = await seedTargetAndTransfer(crypto.randomUUID().slice(0, 8));
      const planDate = "2099-08-19";
      const plan = await query(
        `INSERT INTO dispatch_plans (plan_date, status, revision, confirmed_at)
         VALUES ($1, 'confirmed', 9, now()) RETURNING id`,
        [planDate]
      );
      const order = {
        id: seeded.targetRef,
        type: "SO",
        sourceYard: "12441",
        pickupLocations: ["12441"],
        items: []
      };
      await query(
        `INSERT INTO dispatch_plan_snapshots (plan_id, orders, trucks, summary)
         VALUES ($1, $2::jsonb, $3::jsonb, '{}'::jsonb)`,
        [plan.rows[0].id, JSON.stringify([order]), JSON.stringify([{
          id: "truck",
          loads: [{ id: "load", stops: [] }]
        }])]
      );

      const preview = await previewScmDependencyMutation({
        action: "link_to",
        targetRef: seeded.targetRef,
        planId: plan.rows[0].id,
        planDate,
        expectedPlanRevision: 9,
        payload: { transferOrderRef: seeded.transferRef }
      }, { id: "scm", sessionId: "scm-browser" });

      assert.equal(preview.allowed, true);
      assert.equal(preview.affectedPlan, null);
      assert.deepEqual(preview.routeReadiness, { required: false, ready: true, blockers: [] });
      assert.deepEqual(preview.blockers, []);
    });
  } finally {
    await rollback.rollback();
  }
});
