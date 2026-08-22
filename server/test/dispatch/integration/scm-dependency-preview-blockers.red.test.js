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

test("confirmed plan with a suspended route-bearing PWA creates a pending-only preview", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const seeded = await seedTargetAndTransfer(crypto.randomUUID().slice(0, 8));
      const plan = await query(
        `INSERT INTO dispatch_plans (plan_date, status, revision, confirmed_at)
         VALUES ('2026-08-19', 'confirmed', 8, now()) RETURNING id`
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
         ) VALUES ($1, 'cheng-preview', 'iphone-preview', $2, '2026-08-19', 8,
                   now(), now() + interval '1 day')`,
        [manifestId, plan.rows[0].id]
      );
      const preview = await previewScmDependencyMutation({
        action: "link_to",
        targetRef: seeded.targetRef,
        planId: plan.rows[0].id,
        planDate: "2026-08-19",
        expectedPlanRevision: 8,
        payload: { transferOrderRef: seeded.transferRef }
      }, { id: "scm", sessionId: "scm-browser" });
      assert.equal(preview.allowed, false);
      assert.equal(preview.routeReadiness.ready, false);
      assert.equal(preview.routeReadiness.pendingRequestRequired, true);
      assert.equal(preview.blockers[0].code, "DRIVER_ROUTE_OFFLINE");
      assert.equal(preview.affectedDriverDevices[0].manifestId, manifestId);
    });
  } finally {
    await rollback.rollback();
  }
});
