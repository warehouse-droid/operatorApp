import assert from "node:assert/strict";
import { beginRollbackContext, closeDb, query } from "./db.js";
import {
  enrichScmScheduleWithReconciliation,
  reconcileScmOrderFamily
} from "./scm-reconciliation-repository.js";

const rollback = await beginRollbackContext();

function authoritativePurchaseOrder({ id, ref, lineKey, received, reviewReason = "" }) {
  return {
    kind: "PO",
    id,
    tranid: ref,
    status: "B",
    statusText: "Purchase Order : Pending Receipt",
    destinationLocationId: 15,
    destinationLocation: "12441",
    lines: [{
      stage: "receiving",
      sourceLineKey: String(lineKey),
      sourceLineAliases: [String(lineKey)],
      orderLine: String(lineKey),
      orderLineAliases: [String(lineKey)],
      identityStatus: "exact",
      itemId: 8_810_001,
      itemName: "Grouped PO reconciliation item",
      sku: "GROUPED-PO-ITEM",
      quantity: 10,
      cumulativeProgressQuantity: received,
      cumulativeProgressObserved: true,
      unit: "EA",
      locationId: 15,
      location: "12441"
    }],
    explicitReviewReason: reviewReason
  };
}

try {
  await rollback.run(async () => {
    const seed = 9_881_000_000 + Math.floor(Math.random() * 100_000);
    const poIds = [seed + 1, seed + 2];
    const poRefs = [`TST-PO-GROUP-${seed + 1}`, `TST-PO-GROUP-${seed + 2}`];
    const lineKeys = [seed + 101, seed + 102];
    const groupRef = `PGOB-${poRefs.join("-")}`;

    for (let index = 0; index < poIds.length; index += 1) {
      await query(
        `INSERT INTO purchase_orders (
           netsuite_id, tranid, trandate, status, status_text, vendor_id, vendor,
           destination_location_id, destination_location, receipt_status,
           netsuite_active, synced_at
         ) VALUES (
           $1, $2, DATE '2099-11-20', 'B', 'Purchase Order : Pending Receipt',
           881001, 'Grouped PO Test Vendor', 15, '12441', 'not_received', true, now()
         )`,
        [poIds[index], poRefs[index]]
      );
      await query(
        `INSERT INTO purchase_order_lines (
           purchase_order_id, line_id, item_id, item_name, sku, quantity,
           netsuite_received_qty, unit, location_id, location, netsuite_active, raw
         ) VALUES (
           $1, $2, 8810001, 'Grouped PO reconciliation item', 'GROUPED-PO-ITEM', 10,
           0, 'EA', 15, '12441', true, $3::jsonb
         )`,
        [
          poIds[index],
          lineKeys[index],
          JSON.stringify({
            sourceLineAliases: [String(lineKeys[index])],
            orderLine: String(lineKeys[index]),
            orderLineAliases: [String(lineKeys[index])],
            identityStatus: "exact"
          })
        ]
      );
    }

    const group = await query(
      `INSERT INTO scm_schedule_groups (group_ref, status, created_by)
       VALUES ($1, 'active', 'grouped-po-reconciliation-harness')
       RETURNING id`,
      [groupRef]
    );
    await query(
      `INSERT INTO scm_transport_schedule (
         order_kind, order_ref, group_ref, status, created_by, updated_by
       ) VALUES
         ('PO', $1, $3, 'Queued', 'grouped-po-reconciliation-harness', 'grouped-po-reconciliation-harness'),
         ('PO', $2, $3, 'Queued', 'grouped-po-reconciliation-harness', 'grouped-po-reconciliation-harness'),
         ('PO', $3, $3, 'Queued', 'grouped-po-reconciliation-harness', 'grouped-po-reconciliation-harness')`,
      [poRefs[0], poRefs[1], groupRef]
    );
    for (const ref of poRefs) {
      await query(
        `INSERT INTO scm_schedule_group_members (group_id, order_kind, order_ref)
         VALUES ($1, 'PO', $2)`,
        [group.rows[0].id, ref]
      );
    }

    await query(
      `UPDATE scm_transport_schedule
          SET status = 'In Transit'
        WHERE order_kind = 'PO' AND order_ref = $1`,
      [groupRef]
    );
    await reconcileScmOrderFamily({
      kind: "PO",
      sourceOrderId: poIds[0],
      source: "manual",
      dryRun: false,
      authoritativeOrder: authoritativePurchaseOrder({
        id: poIds[0],
        ref: poRefs[0],
        lineKey: lineKeys[0],
        received: 0
      })
    });
    let parent = (await query(
      `SELECT status, reconciliation_blocked
         FROM scm_transport_schedule
        WHERE order_kind = 'PO' AND order_ref = $1`,
      [groupRef]
    )).rows[0];
    assert.equal(parent.status, "In Transit",
      "A no-progress child reconciliation must not roll an operational grouped PO back to Queued.");
    assert.equal(parent.reconciliation_blocked, false);

    await reconcileScmOrderFamily({
      kind: "PO",
      sourceOrderId: poIds[0],
      source: "manual",
      dryRun: false,
      authoritativeOrder: authoritativePurchaseOrder({
        id: poIds[0],
        ref: poRefs[0],
        lineKey: lineKeys[0],
        received: 10
      })
    });
    parent = (await query(
      `SELECT status, reconciliation_blocked
         FROM scm_transport_schedule
        WHERE order_kind = 'PO' AND order_ref = $1`,
      [groupRef]
    )).rows[0];
    assert.equal(parent.status, "Partially Done",
      "One completed grouped PO child must roll the parent to Partially Done.");
    assert.equal(parent.reconciliation_blocked, false);

    await reconcileScmOrderFamily({
      kind: "PO",
      sourceOrderId: poIds[1],
      source: "manual",
      dryRun: false,
      authoritativeOrder: authoritativePurchaseOrder({
        id: poIds[1],
        ref: poRefs[1],
        lineKey: lineKeys[1],
        received: 10
      })
    });
    parent = (await query(
      `SELECT status, reconciliation_blocked
         FROM scm_transport_schedule
        WHERE order_kind = 'PO' AND order_ref = $1`,
      [groupRef]
    )).rows[0];
    assert.equal(parent.status, "Completed",
      "Every active grouped PO child completed must roll the parent to Completed.");
    assert.equal(parent.reconciliation_blocked, false);

    const completedProjection = await enrichScmScheduleWithReconciliation([{
      orderKind: "PO",
      orderRef: groupRef,
      sourceRef: groupRef,
      sourceId: null,
      status: "In Transit",
      scheduleId: 9_999_999,
      updatedAt: "2099-12-31T23:59:59.000Z"
    }]);
    assert.equal(completedProjection[0].status, "Completed",
      "The reconciliation projection must derive a grouped PO from its children, not its stale row status.");

    await reconcileScmOrderFamily({
      kind: "PO",
      sourceOrderId: poIds[0],
      source: "manual",
      dryRun: false,
      explicitReviewReason: "Grouped PO child requires review.",
      authoritativeOrder: authoritativePurchaseOrder({
        id: poIds[0],
        ref: poRefs[0],
        lineKey: lineKeys[0],
        received: 10
      })
    });
    parent = (await query(
      `SELECT status, reconciliation_blocked
         FROM scm_transport_schedule
        WHERE order_kind = 'PO' AND order_ref = $1`,
      [groupRef]
    )).rows[0];
    assert.equal(parent.status, "Reconcile Review",
      "A blocking child review must take precedence over completed grouped PO children.");
    assert.equal(parent.reconciliation_blocked, true);

    await reconcileScmOrderFamily({
      kind: "PO",
      sourceOrderId: poIds[0],
      source: "manual",
      dryRun: false,
      authoritativeOrder: authoritativePurchaseOrder({
        id: poIds[0],
        ref: poRefs[0],
        lineKey: lineKeys[0],
        received: 10
      })
    });
    parent = (await query(
      `SELECT status, reconciliation_blocked, ctid::text AS row_version
         FROM scm_transport_schedule
        WHERE order_kind = 'PO' AND order_ref = $1`,
      [groupRef]
    )).rows[0];
    assert.equal(parent.status, "Completed",
      "Resolving the child review must return an all-completed grouped PO to Completed.");
    assert.equal(parent.reconciliation_blocked, false);

    const stableParentVersion = parent.row_version;
    await reconcileScmOrderFamily({
      kind: "PO",
      sourceOrderId: poIds[0],
      source: "manual",
      dryRun: false,
      authoritativeOrder: authoritativePurchaseOrder({
        id: poIds[0],
        ref: poRefs[0],
        lineKey: lineKeys[0],
        received: 10
      })
    });
    parent = (await query(
      `SELECT status, reconciliation_blocked, ctid::text AS row_version
         FROM scm_transport_schedule
        WHERE order_kind = 'PO' AND order_ref = $1`,
      [groupRef]
    )).rows[0];
    assert.equal(parent.row_version, stableParentVersion,
      "An exact grouped PO retry must not rewrite an unchanged parent schedule row.");
  });
  console.log("Grouped PO reconciliation integration harness passed.");
} finally {
  await rollback.rollback();
  await closeDb();
}
