import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import {
  createScmPurchaseOrderSplit,
  getScmPurchaseOrderSplitSourceLines,
  listScmPurchaseOrders,
  listScmSchedule,
  updateScmScheduleEntry,
  updateScmPurchaseOrderSplitLines
} from "../../../src/dispatch-repository.js";
import { enrichScmScheduleWithReconciliation } from "../../../src/scm-reconciliation-repository.js";
import {
  approveSmartScmPoPhase,
  getSmartScmPlanningRun,
  loadSmartScmPlanningDemandStates
} from "../../../src/smart-scm-planning-repository.js";
import { getSmartScmProposalInventorySnapshot } from "../../../src/smart-scm-proposal-editor.js";
import { buildSmartScmBlanketPlan } from "../../../src/smart-scm-blanket-repository.js";

after(closeDb);

function fixtureIdentity(label = "split-edit") {
  const token = crypto.randomUUID().replaceAll("-", "");
  const seed = Number.parseInt(token.slice(0, 10), 16);
  const baseId = 7_400_000_000_000 + (seed * 20);
  return {
    baseId,
    sourcePoId: baseId + 1,
    firstLineId: baseId + 2,
    secondLineId: baseId + 3,
    firstItemId: baseId + 4,
    secondItemId: baseId + 5,
    vendorId: baseId + 6,
    sourcePoRef: `PO-SPLIT-EDIT-${label}-${token.slice(0, 12)}`,
    splitPoRef: `PO-SPLIT-EDIT-${label}-${token.slice(0, 12)}-L1`
  };
}

async function seedSplitFixture(label = "split-edit", {
  firstSplitPallets = 5,
  destinationLocationId = 28,
  initialStatus = "Queued",
  remarkOverride = ""
} = {}) {
  const fixture = fixtureIdentity(label);
  await query(
    `INSERT INTO purchase_orders (
       netsuite_id, tranid, trandate, vendor_id, vendor, status, status_text,
       destination_location_id, destination_location, source_location_id,
       source_location, dispatch_vendor_yard, receipt_status, initial_scm_status,
       netsuite_active, synced_at
     ) VALUES (
       $1,$2,current_date,$3,$4,'pendingReceipt','Purchase Order : Pending Receipt',
       1,'3445',1,'3445',$5,'not_received','Queued',true,now()
     )`,
    [fixture.sourcePoId, fixture.sourcePoRef, fixture.vendorId,
      `Split Edit Vendor ${fixture.baseId}`, `Split Edit Vendor Yard ${fixture.baseId}`]
  );
  await query(
    `INSERT INTO purchase_order_lines (
       id, purchase_order_id, line_id, item_id, item_name, sku, item_description,
       item_type, item_type_text, quantity, unit, location_id, location,
       pallet_qty, layer_qty, section_qty, piece_qty,
       to_plt, to_lyr, to_sec, to_pcs,
       received_pallet_qty, received_layer_qty, received_section_qty,
       received_piece_qty, netsuite_received_qty, netsuite_received_baseline_qty,
       netsuite_active, synced_at, item_weight, raw
     ) VALUES
       ($1,$2,10,$3,$4,$4,'First editable split item','InvtPart','Inventory Item',
        120,'EA',1,'3445',12,0,0,0,10,0,0,1,0,0,0,0,0,0,true,now(),100,'{}'::jsonb),
       ($5,$2,20,$6,$7,$7,'Second source-only item','InvtPart','Inventory Item',
        80,'EA',1,'3445',8,0,0,0,10,0,0,1,0,0,0,0,0,0,true,now(),200,'{}'::jsonb)`,
    [fixture.firstLineId, fixture.sourcePoId, fixture.firstItemId,
      `SPLIT-EDIT-FIRST-${fixture.baseId}`, fixture.secondLineId,
      fixture.secondItemId, `SPLIT-EDIT-SECOND-${fixture.baseId}`]
  );
  const created = await createScmPurchaseOrderSplit({
    sourcePoRef: fixture.sourcePoRef,
    newPoRef: fixture.splitPoRef,
    destinationLocationId,
    status: initialStatus,
    remarkOverride,
    lines: [{ lineRowId: fixture.firstLineId, pallets: firstSplitPallets }],
    createdBy: "scm-po-split-editing-test"
  });
  return {
    ...fixture,
    splitId: Number(created.split.id),
    splitPoId: Number(created.split.splitPoId),
    firstChildLineId: Number(created.lines[0].id)
  };
}

test("split creation stores initial manual status and remark atomically", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const fixture = await seedSplitFixture("create-metadata", {
        initialStatus: "Priority",
        remarkOverride: "Vendor confirmed a 07:00 pickup."
      });
      const schedule = await query(
        `SELECT status, remark_override
           FROM scm_transport_schedule
          WHERE order_kind = 'PO' AND lower(order_ref) = lower($1)`,
        [fixture.splitPoRef]
      );
      assert.deepEqual(schedule.rows, [{
        status: "Priority",
        remark_override: "Vendor confirmed a 07:00 pickup."
      }]);

      await createScmPurchaseOrderSplit({
        sourcePoRef: fixture.sourcePoRef,
        newPoRef: fixture.splitPoRef,
        destinationLocationId: 28,
        status: "Queued",
        remarkOverride: "",
        lines: [{ lineRowId: fixture.firstLineId, pallets: 1 }],
        createdBy: "scm-po-split-create-metadata-extension-test",
        extendSplitId: fixture.splitId
      });
      const afterExtension = await query(
        `SELECT status, remark_override
           FROM scm_transport_schedule
          WHERE order_kind = 'PO' AND lower(order_ref) = lower($1)`,
        [fixture.splitPoRef]
      );
      assert.deepEqual(afterExtension.rows, schedule.rows,
        "extending a Blanket split must preserve its existing status and remark");

      const invalidRef = `${fixture.splitPoRef}-INVALID`;
      await assert.rejects(
        createScmPurchaseOrderSplit({
          sourcePoRef: fixture.sourcePoRef,
          newPoRef: invalidRef,
          destinationLocationId: 28,
          status: "Completed",
          lines: [{ lineRowId: fixture.firstLineId, pallets: 1 }],
          createdBy: "scm-po-split-create-metadata-test"
        }),
        /controlled by dispatch or driver status/i
      );
      const invalidRows = await query(
        `SELECT 1 FROM purchase_orders WHERE lower(tranid) = lower($1)
         UNION ALL
         SELECT 1 FROM dispatch_scm_po_splits WHERE lower(split_po_ref) = lower($1)
         UNION ALL
         SELECT 1 FROM scm_transport_schedule WHERE lower(order_ref) = lower($1)`,
        [invalidRef]
      );
      assert.equal(invalidRows.rowCount, 0, "invalid metadata must not leave a partial split");

      const longRemarkRef = `${fixture.splitPoRef}-LONG-REMARK`;
      await assert.rejects(
        createScmPurchaseOrderSplit({
          sourcePoRef: fixture.sourcePoRef,
          newPoRef: longRemarkRef,
          destinationLocationId: 28,
          status: "Queued",
          remarkOverride: "x".repeat(2001),
          lines: [{ lineRowId: fixture.firstLineId, pallets: 1 }],
          createdBy: "scm-po-split-create-metadata-test"
        }),
        /2,000 characters or fewer/i
      );
      const longRemarkRows = await query(
        `SELECT 1 FROM purchase_orders WHERE lower(tranid) = lower($1)
         UNION ALL
         SELECT 1 FROM dispatch_scm_po_splits WHERE lower(split_po_ref) = lower($1)
         UNION ALL
         SELECT 1 FROM scm_transport_schedule WHERE lower(order_ref) = lower($1)`,
        [longRemarkRef]
      );
      assert.equal(longRemarkRows.rowCount, 0, "overlong remark must not leave a partial split");
    });
  } finally {
    await rollback.rollback();
  }
});

function desiredLine(sourceLineId, pallets) {
  return { sourceLineId, pallets, layers: 0, sections: 0, pieces: 0, salesQty: 0 };
}

test("an unplanned split returns reduced quantity, accepts another source item, and records exact desired state", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const fixture = await seedSplitFixture("desired-state");
      const before = await getScmPurchaseOrderSplitSourceLines(fixture.splitPoRef);
      assert.equal(before.split.revision, 1);
      assert.equal(before.split.locked, false);
      const firstBefore = before.lines.find((line) => line.sourceLineId === fixture.firstLineId);
      const secondBefore = before.lines.find((line) => line.sourceLineId === fixture.secondLineId);
      assert.deepEqual(firstBefore.current, {
        pallets: 5, layers: 0, sections: 0, pieces: 0, salesQty: 50
      });
      assert.equal(firstBefore.maximum.pallets, 12);
      assert.equal(firstBefore.availableAdditional.pallets, 7);
      assert.equal(secondBefore.inSplit, false);
      assert.equal(secondBefore.canAdd, true);

      const updated = await updateScmPurchaseOrderSplitLines({
        splitPoRef: fixture.splitPoRef,
        expectedRevision: before.split.revision,
        updatedBy: "scm-po-split-editing-test",
        lines: [
          desiredLine(fixture.firstLineId, 3),
          desiredLine(fixture.secondLineId, 2)
        ]
      });
      assert.equal(updated.revision, 2);
      assert.equal(updated.changes.length, 2);

      const ledger = await query(
        `SELECT ledger.source_line_id, ledger.split_line_id,
                ledger.pallet_qty, ledger.sales_qty,
                ledger.requested_pallet_qty, ledger.requested_sales_qty,
                child.pallet_qty AS child_pallet_qty,
                child.quantity AS child_sales_qty,
                child.netsuite_active
           FROM dispatch_scm_po_split_lines ledger
           JOIN purchase_order_lines child ON child.id = ledger.split_line_id
          WHERE ledger.split_id = $1
          ORDER BY ledger.source_line_id`,
        [fixture.splitId]
      );
      assert.deepEqual(ledger.rows.map((row) => ({
        sourceLineId: Number(row.source_line_id),
        pallets: Number(row.pallet_qty),
        salesQty: Number(row.sales_qty),
        requestedPallets: Number(row.requested_pallet_qty),
        requestedSalesQty: Number(row.requested_sales_qty),
        childPallets: Number(row.child_pallet_qty),
        childSalesQty: Number(row.child_sales_qty),
        active: row.netsuite_active
      })), [
        {
          sourceLineId: fixture.firstLineId,
          pallets: 3,
          salesQty: 30,
          requestedPallets: 3,
          requestedSalesQty: 30,
          childPallets: 3,
          childSalesQty: 30,
          active: true
        },
        {
          sourceLineId: fixture.secondLineId,
          pallets: 2,
          salesQty: 20,
          requestedPallets: 2,
          requestedSalesQty: 20,
          childPallets: 2,
          childSalesQty: 20,
          active: true
        }
      ]);
      const event = await query(
        `SELECT expected_revision, applied_revision, event_type, actor,
                before_state, after_state
           FROM dispatch_scm_po_split_change_events
          WHERE split_id = $1`,
        [fixture.splitId]
      );
      assert.equal(event.rowCount, 1);
      assert.equal(Number(event.rows[0].expected_revision), 1);
      assert.equal(Number(event.rows[0].applied_revision), 2);
      assert.equal(event.rows[0].event_type, "lines_adjusted");
      assert.equal(event.rows[0].actor, "scm-po-split-editing-test");

      await assert.rejects(
        () => updateScmPurchaseOrderSplitLines({
          splitPoRef: fixture.splitPoRef,
          expectedRevision: 1,
          updatedBy: "stale-editor",
          lines: [desiredLine(fixture.firstLineId, 4), desiredLine(fixture.secondLineId, 2)]
        }),
        (error) => error?.code === "SCM_PO_SPLIT_STALE"
      );

      await query(
        `UPDATE scm_transport_schedule
            SET status = 'Planned', updated_at = now()
          WHERE order_kind = 'PO' AND lower(order_ref) = lower($1)`,
        [fixture.splitPoRef]
      );
      const locked = await getScmPurchaseOrderSplitSourceLines(fixture.splitPoRef);
      assert.equal(locked.split.locked, true);
      assert.equal(locked.split.conflicts.planned, true);
      await assert.rejects(
        () => updateScmPurchaseOrderSplitLines({
          splitPoRef: fixture.splitPoRef,
          expectedRevision: 2,
          updatedBy: "planned-editor",
          lines: [desiredLine(fixture.firstLineId, 4), desiredLine(fixture.secondLineId, 2)]
        }),
        (error) => error?.code === "SCM_PO_SPLIT_OPERATIONAL" && error?.conflicts?.planned === true
      );
    });
  } finally {
    await rollback.rollback();
  }
});

test("PO Split derives Completed from exact canonical Driver completion without contaminating a sibling", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const fixture = await seedSplitFixture("completion-status", { firstSplitPallets: 5 });
      const siblingRef = `${fixture.splitPoRef}-L2`;
      await createScmPurchaseOrderSplit({
        sourcePoRef: fixture.sourcePoRef,
        newPoRef: siblingRef,
        destinationLocationId: 1,
        lines: [{ lineRowId: fixture.firstLineId, pallets: 1 }],
        createdBy: "scm-po-split-completion-test"
      });
      await query(
        `INSERT INTO scm_transport_schedule (
           order_kind, source_table, order_ref, method, status, created_by, updated_by
         ) VALUES
           ('PO', 'purchase_orders', $1, 'MBT', 'Planned', 'completion-test', 'completion-test'),
           ('PO', 'purchase_orders', $2, 'MBT', 'Planned', 'completion-test', 'completion-test')
         ON CONFLICT (order_kind, order_ref) DO UPDATE
           SET status = EXCLUDED.status, updated_at = now()`,
        [fixture.splitPoRef, siblingRef]
      );
      const reconciliationState = await query(
        `INSERT INTO scm_reconciliation_order_state (
           order_kind, source_order_netsuite_id, source_order_ref,
           application_status, reconciliation_status, reconciliation_source,
           broad_reconciliation_skipped, broad_reconciliation_skipped_at,
           broad_reconciliation_skipped_by, broad_reconciliation_skip_note,
           quantity_summary
         ) VALUES (
           'PO', $1, $2,
           'Partially Done', 'pending', 'system',
           true, now(), 'completion-projection-test',
           'Parent quantity reconciliation is intentionally pending.',
           $3::jsonb
         )
         RETURNING id`,
        [
          fixture.sourcePoId,
          fixture.sourcePoRef,
          JSON.stringify({
            family: { applicationStatus: "Partially Done" },
            targets: {
              [fixture.splitPoRef]: { applicationStatus: "Planned" },
              [siblingRef]: { applicationStatus: "Planned" }
            }
          })
        ]
      );
      await query(
        `UPDATE scm_transport_schedule
            SET reconciliation_order_state_id = $1
          WHERE order_kind = 'PO'
            AND lower(order_ref) IN (lower($2), lower($3))`,
        [reconciliationState.rows[0].id, fixture.splitPoRef, siblingRef]
      );
      await query(
        `SELECT dispatch_record_order_completion(
           'PO', $1, now(), 'driver_job', $2, NULL, current_date, NULL,
           'driver', 'completion-test-driver', '', '{}'::jsonb
         )`,
        [fixture.splitPoRef, `completion-test:${fixture.splitPoRef}`]
      );

      const rows = await listScmPurchaseOrders({ search: fixture.sourcePoRef });
      const completed = rows.find((row) => row.id === fixture.splitPoRef);
      const sibling = rows.find((row) => row.id === siblingRef);
      assert.ok(completed);
      assert.ok(sibling);
      assert.equal(completed.scm.status, "Completed");
      assert.equal(completed.dispatchCompleted, true);
      assert.ok(completed.dispatchCompletedAt);
      assert.equal(sibling.scm.status, "Planned");
      assert.notEqual(sibling.dispatchCompleted, true);

      const scheduleRows = await listScmSchedule({
        search: fixture.sourcePoRef,
        kind: "PO",
        audience: "scm"
      });
      const rawCompletedSchedule = scheduleRows.find((row) => row.orderRef === fixture.splitPoRef);
      const rawSiblingSchedule = scheduleRows.find((row) => row.orderRef === siblingRef);
      assert.equal(rawCompletedSchedule?.calculatedStatus, "Completed");
      assert.equal(rawCompletedSchedule?.dispatchCompletionEvidenceType, "driver_job");
      assert.equal(rawSiblingSchedule?.calculatedStatus, "Planned");
      assert.equal(rawSiblingSchedule?.dispatchCompletionEvidenceType, "");
      const reconciledSchedule = await enrichScmScheduleWithReconciliation(scheduleRows);
      const completedSchedule = reconciledSchedule.find((row) => row.orderRef === fixture.splitPoRef);
      const siblingSchedule = reconciledSchedule.find((row) => row.orderRef === siblingRef);
      assert.ok(completedSchedule);
      assert.ok(siblingSchedule);
      assert.equal(completedSchedule.calculatedStatus || completedSchedule.status, "Completed");
      assert.equal(siblingSchedule.calculatedStatus || siblingSchedule.status, "Planned");

      await query(
        `SELECT dispatch_record_order_completion(
           'PO', $1, now(), 'manual_dispatch', $2, NULL, current_date, NULL,
           'operator', 'completion-test-dispatcher', 'Verified manual recovery.', '{}'::jsonb
         )`,
        [siblingRef, `completion-test:${siblingRef}`]
      );
      const manuallyCompletedRows = await listScmSchedule({
        search: fixture.sourcePoRef,
        kind: "PO",
        audience: "scm"
      });
      const manuallyCompletedSibling = manuallyCompletedRows.find((row) => row.orderRef === siblingRef);
      assert.equal(manuallyCompletedSibling?.calculatedStatus, "Completed");
      assert.equal(manuallyCompletedSibling?.dispatchCompletionEvidenceType, "manual_dispatch");

      await query(
        `UPDATE scm_transport_schedule
            SET reconciliation_blocked = true
          WHERE order_kind = 'PO'
            AND lower(order_ref) IN (lower($1), lower($2))`,
        [fixture.splitPoRef, siblingRef]
      );
      const blockedRows = await listScmSchedule({
        search: fixture.sourcePoRef,
        kind: "PO",
        audience: "scm"
      });
      const rawBlockedCompleted = blockedRows.find((row) => row.orderRef === fixture.splitPoRef);
      assert.equal(rawBlockedCompleted?.calculatedStatus, "Completed");
      const blockedSchedule = await enrichScmScheduleWithReconciliation(blockedRows);
      const blockedCompleted = blockedSchedule.find((row) => row.orderRef === fixture.splitPoRef);
      assert.ok(blockedCompleted);
      assert.equal(blockedCompleted.calculatedStatus || blockedCompleted.status, "Completed");
      assert.equal(blockedCompleted.reconciliationStatus, "review");
      const rawBlockedManual = blockedRows.find((row) => row.orderRef === siblingRef);
      assert.equal(rawBlockedManual?.calculatedStatus, "Completed",
        "Every universal local completion type must win over reconciliation review.");
      const blockedManual = blockedSchedule.find((row) => row.orderRef === siblingRef);
      assert.equal(blockedManual?.calculatedStatus || blockedManual?.status, "Completed");
      assert.equal(blockedManual?.reconciliationStatus, "review",
        "The review remains visible as metadata without downgrading local completion.");
    });
  } finally {
    await rollback.rollback();
  }
});

test("Smart SCM Blanket planning counts same-yard and cross-yard split children exactly once", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const fixture = await seedSplitFixture("blanket-expected", {
        firstSplitPallets: 5,
        destinationLocationId: 1
      });
      const siblingRef = `${fixture.splitPoRef}-12441`;
      await createScmPurchaseOrderSplit({
        sourcePoRef: fixture.sourcePoRef,
        newPoRef: siblingRef,
        destinationLocationId: 15,
        lines: [{ lineRowId: fixture.firstLineId, pallets: 2 }],
        createdBy: "blanket-expected-inventory-test"
      });
      await query(
        `UPDATE purchase_orders SET is_blanket_po = true WHERE netsuite_id = $1`,
        [fixture.sourcePoId]
      );
      await query(
        `INSERT INTO inventory_items (
           item_id, item_name, display_name, item_description, stock_unit,
           to_plt, to_lyr, to_sec, to_pcs, item_weight, vendor_id, vendor
         ) VALUES ($1,$2,$2,'POB03669-style Blanket expected-inventory fixture',
                   'EA',10,0,0,1,100,$3,$4)`,
        [fixture.firstItemId, `BLANKET-EXPECTED-${fixture.baseId}`, fixture.vendorId,
          `Split Edit Vendor ${fixture.baseId}`]
      );
      await query(
        `INSERT INTO scm_smart_item_policies (
           item_id, item_name, item_description, vendor, vendor_code, stock_unit,
           to_plt, to_lyr, to_sec, to_pcs, lead_time_days, pallet_weight_lbs,
           inactive, discontinued, planning_enabled, updated_by
         ) VALUES ($1,$2,'POB03669-style Blanket expected-inventory fixture',$3,$4,
                   'EA',10,0,0,1,7,1000,false,false,true,'blanket-expected-test')`,
        [fixture.firstItemId, `BLANKET-EXPECTED-${fixture.baseId}`,
          `Split Edit Vendor ${fixture.baseId}`, String(fixture.vendorId)]
      );
      await query(
        `INSERT INTO scm_smart_item_yard_policies (
           item_id, location_id, yard_code, eligible, capacity_pallets,
           service_quantile, minimum_safety_pallets, updated_by
         ) VALUES
           ($1,1,'3445',true,80,0.90,10,'blanket-expected-test'),
           ($1,15,'12441',true,80,0.90,1,'blanket-expected-test')`,
        [fixture.firstItemId]
      );
      await query(
        `INSERT INTO inventory_balances (
           item_id, location_id, location, quantity_on_hand, quantity_available,
           quantity_on_order, quantity_backordered
         ) VALUES
           ($1,1,'3445',0,0,90,0),
           ($1,15,'12441',0,0,0,0)`,
        [fixture.firstItemId]
      );
      await query(
        `UPDATE scm_smart_settings
            SET inventory_planning_mode = 'po_then_transfer'
          WHERE id = 1`
      );

      const planning = await loadSmartScmPlanningDemandStates({
        includeTemporarilyExcluded: true
      });
      const sameYard = planning.states.find((state) =>
        Number(state.policy.item_id) === fixture.firstItemId
        && Number(state.policy.location_id) === 1);
      const crossYard = planning.states.find((state) =>
        Number(state.policy.item_id) === fixture.firstItemId
        && Number(state.policy.location_id) === 15);
      assert.ok(sameYard);
      assert.ok(crossYard);
      assert.equal(sameYard.authoritativeOnOrderSales, 90);
      assert.equal(sameYard.blanketExcludedSales, 120);
      assert.equal(sameYard.releasedSplitInboundSales, 50);
      assert.equal(sameYard.onOrderSales, 50);
      assert.equal(sameYard.positionPallets, 5);
      assert.equal(crossYard.releasedSplitInboundSales, 20);
      assert.equal(crossYard.onOrderSales, 20);
      assert.equal(crossYard.positionPallets, 2);
      assert.deepEqual(
        planning.splitInboundEvidence
          .filter((row) => Number(row.itemId) === fixture.firstItemId)
          .map((row) => [row.splitRef, Number(row.destinationLocationId), Number(row.quantity)])
          .sort((left, right) => left[0].localeCompare(right[0])),
        [
          [fixture.splitPoRef, 1, 50],
          [siblingRef, 15, 20]
        ].sort((left, right) => left[0].localeCompare(right[0]))
      );

      const liveSnapshot = await getSmartScmProposalInventorySnapshot(
        fixture.firstItemId,
        1,
        10
      );
      assert.equal(liveSnapshot.quantityOnOrderAuthoritative, 90);
      assert.equal(liveSnapshot.quantityBlanketExcluded, 120);
      assert.equal(liveSnapshot.quantityReleasedSplitInbound, 50);
      assert.equal(liveSnapshot.quantityOnOrder, 50);
      assert.equal(liveSnapshot.expectedAvailablePallets, 5);

      const blanketPlan = await buildSmartScmBlanketPlan(null);
      const stored = await query(
        `SELECT line.destination_location_id, line.proposed_pallets,
                line.reason->>'quantityOnOrderAuthoritative' AS authoritative,
                line.reason->>'quantityBlanketExcluded' AS blanket_excluded,
                line.reason->>'quantityReleasedSplitInbound' AS released_split,
                line.reason->>'quantityOnOrder' AS effective_on_order,
                line.reason->>'expectedAvailablePallets' AS expected_pallets
           FROM scm_smart_proposal_lines line
           JOIN scm_smart_proposals proposal ON proposal.id = line.proposal_id
          WHERE proposal.run_id = $1
            AND line.item_id = $2
            AND line.destination_location_id = 1`,
        [blanketPlan.id, fixture.firstItemId]
      );
      assert.equal(stored.rowCount, 1,
        "the actual Blanket-plan builder must retain the same-yard child in its saved calculation");
      assert.deepEqual({
        destination: Number(stored.rows[0].destination_location_id),
        proposedPallets: Number(stored.rows[0].proposed_pallets),
        authoritative: Number(stored.rows[0].authoritative),
        blanketExcluded: Number(stored.rows[0].blanket_excluded),
        releasedSplit: Number(stored.rows[0].released_split),
        effectiveOnOrder: Number(stored.rows[0].effective_on_order),
        expectedPallets: Number(stored.rows[0].expected_pallets)
      }, {
        destination: 1,
        proposedPallets: 5,
        authoritative: 90,
        blanketExcluded: 120,
        releasedSplit: 50,
        effectiveOnOrder: 50,
        expectedPallets: 5
      });
    });
  } finally {
    await rollback.rollback();
  }
});

test("concurrent editors with one revision produce one winner and one stale rejection", async () => {
  // This fixture is intentionally committed: two independent repository
  // transactions are required to prove row-lock/OCC behavior. The gauntlet
  // discards the entire isolated database after the suite.
  const fixture = await seedSplitFixture("concurrency", { firstSplitPallets: 4 });
  const initial = await getScmPurchaseOrderSplitSourceLines(fixture.splitPoRef);
  const outcomes = await Promise.allSettled([
    updateScmPurchaseOrderSplitLines({
      splitPoRef: fixture.splitPoRef,
      expectedRevision: initial.split.revision,
      updatedBy: "concurrent-a",
      lines: [desiredLine(fixture.firstLineId, 6)]
    }),
    updateScmPurchaseOrderSplitLines({
      splitPoRef: fixture.splitPoRef,
      expectedRevision: initial.split.revision,
      updatedBy: "concurrent-b",
      lines: [desiredLine(fixture.firstLineId, 7)]
    })
  ]);
  const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
  const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason?.code, "SCM_PO_SPLIT_STALE");
  assert.equal(fulfilled[0].value.revision, 2);
  const persisted = await getScmPurchaseOrderSplitSourceLines(fixture.splitPoRef);
  assert.equal(persisted.split.revision, 2);
  assert.equal(
    persisted.lines.find((line) => line.sourceLineId === fixture.firstLineId).current.pallets,
    fulfilled[0].value.changes[0].after.pallets
  );
  const events = await query(
    `SELECT count(*)::integer AS count
       FROM dispatch_scm_po_split_change_events
      WHERE split_id = $1 AND event_type = 'lines_adjusted'`,
    [fixture.splitId]
  );
  assert.equal(events.rows[0].count, 1);
});

test("a released Blanket split edit preserves held stock and conserves released/cancelled quantities", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const fixture = await seedSplitFixture("blanket-ledger", { firstSplitPallets: 3 });
      const actor = "scm-po-split-blanket-test";
      const run = await query(
        `INSERT INTO scm_smart_planning_runs (
           status, trigger_source, revision, settings_snapshot, totals,
           created_by, completed_at, plan_kind
         ) VALUES ('ready','blanket_manual',1,'{}'::jsonb,'{}'::jsonb,$1,now(),'blanket')
         RETURNING id`,
        [actor]
      );
      const proposal = await query(
        `INSERT INTO scm_smart_proposals (
           run_id, proposal_key, proposal_type, phase, source_kind, source_name,
           destination_location_id, destination_name, vendor, status, urgent,
           provisional, total_pallets, total_weight_lbs, utilization, memo,
           proposal_origin, blanket_source_po_id, blanket_source_po_ref,
           vendor_response_status
         ) VALUES (
           $1,$2,'PO','direct_vendor','vendor',$3,28,'2967',$4,'completed',false,
           false,5,5000,0,$2,'blanket',$5,$6,'confirmed'
         ) RETURNING id`,
        [run.rows[0].id, `blanket-split-edit:${fixture.baseId}`,
          `Split Edit Vendor Yard ${fixture.baseId}`, `Split Edit Vendor ${fixture.baseId}`,
          fixture.sourcePoId, fixture.sourcePoRef]
      );
      const proposalLine = await query(
        `INSERT INTO scm_smart_proposal_lines (
           proposal_id, item_id, item_name, item_description, unit,
           required_pallets, proposed_pallets, confirmed_pallets, residual_pallets,
           sales_quantity, pallet_weight_lbs, line_weight_lbs,
           to_plt, to_lyr, to_sec, to_pcs, manual_planning_required, reason,
           destination_location_id, destination_name, urgent, urgency_level,
           urgency_score, provisional, vendor_decision
         ) VALUES (
           $1,$2,$3,'Blanket split edit fixture','EA',5,5,3,2,30,1000,3000,
           10,0,0,1,false,'{}'::jsonb,28,'2967',false,'normal',0,false,'hold'
         ) RETURNING id`,
        [proposal.rows[0].id, fixture.firstItemId, `SPLIT-EDIT-FIRST-${fixture.baseId}`]
      );
      const release = await query(
        `INSERT INTO scm_smart_blanket_releases (
           proposal_id, run_id, source_po_id, source_po_ref, idempotency_key,
           status, split_id, split_po_id, split_po_ref, reserved_by,
           finalized_at, finalized_by
         ) VALUES ($1,$2,$3,$4,$5,'partially_released',$6,$7,$8,$9,now(),$9)
         RETURNING id`,
        [proposal.rows[0].id, run.rows[0].id, fixture.sourcePoId, fixture.sourcePoRef,
          `blanket-split-edit:${fixture.baseId}`, fixture.splitId, fixture.splitPoId,
          fixture.splitPoRef, actor]
      );
      await query(
        `INSERT INTO scm_smart_blanket_allocations (
           proposal_id, proposal_line_id, release_id, source_po_id, source_po_ref,
           source_line_id, item_id, destination_location_id, destination_name,
           planned_pallets, planned_sales_qty,
           released_pallets, released_sales_qty,
           held_pallets, held_sales_qty, status, split_line_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,28,'2967',5,50,3,30,2,20,'held',$8)`,
        [proposal.rows[0].id, proposalLine.rows[0].id, release.rows[0].id,
          fixture.sourcePoId, fixture.sourcePoRef, fixture.firstLineId,
          fixture.firstItemId, fixture.firstChildLineId]
      );

      const initial = await getScmPurchaseOrderSplitSourceLines(fixture.splitPoRef);
      const reduced = await updateScmPurchaseOrderSplitLines({
        splitPoRef: fixture.splitPoRef,
        expectedRevision: initial.split.revision,
        updatedBy: actor,
        lines: [
          desiredLine(fixture.firstLineId, 2),
          desiredLine(fixture.secondLineId, 2)
        ]
      });
      assert.equal(reduced.revision, 2);
      let allocations = await query(
        `SELECT source_line_id, planned_pallets, released_pallets,
                held_pallets, cancelled_pallets, status, split_line_id
           FROM scm_smart_blanket_allocations
          WHERE release_id = $1
          ORDER BY source_line_id`,
        [release.rows[0].id]
      );
      assert.deepEqual(allocations.rows.map((row) => ({
        sourceLineId: Number(row.source_line_id),
        planned: Number(row.planned_pallets),
        released: Number(row.released_pallets),
        held: Number(row.held_pallets),
        cancelled: Number(row.cancelled_pallets),
        status: row.status,
        hasChild: row.split_line_id !== null
      })), [
        {
          sourceLineId: fixture.firstLineId,
          planned: 5,
          released: 2,
          held: 2,
          cancelled: 1,
          status: "held",
          hasChild: true
        },
        {
          sourceLineId: fixture.secondLineId,
          planned: 2,
          released: 2,
          held: 0,
          cancelled: 0,
          status: "released",
          hasChild: true
        }
      ]);

      const expanded = await updateScmPurchaseOrderSplitLines({
        splitPoRef: fixture.splitPoRef,
        expectedRevision: reduced.revision,
        updatedBy: actor,
        lines: [
          desiredLine(fixture.firstLineId, 4),
          desiredLine(fixture.secondLineId, 2)
        ]
      });
      assert.equal(expanded.revision, 3);
      allocations = await query(
        `SELECT source_line_id, planned_pallets, released_pallets,
                held_pallets, cancelled_pallets
           FROM scm_smart_blanket_allocations
          WHERE release_id = $1
          ORDER BY source_line_id`,
        [release.rows[0].id]
      );
      assert.deepEqual(allocations.rows.map((row) => ({
        sourceLineId: Number(row.source_line_id),
        planned: Number(row.planned_pallets),
        released: Number(row.released_pallets),
        held: Number(row.held_pallets),
        cancelled: Number(row.cancelled_pallets)
      })), [
        {
          sourceLineId: fixture.firstLineId,
          planned: 6,
          released: 4,
          held: 2,
          cancelled: 0
        },
        {
          sourceLineId: fixture.secondLineId,
          planned: 2,
          released: 2,
          held: 0,
          cancelled: 0
        }
      ]);
      const releaseState = await query(
        `SELECT status FROM scm_smart_blanket_releases WHERE id = $1`,
        [release.rows[0].id]
      );
      assert.equal(releaseState.rows[0].status, "partially_released");
      const audit = await query(
        `SELECT count(*)::integer AS count
           FROM scm_smart_blanket_release_events
          WHERE release_id = $1 AND event_type = 'split_adjusted'`,
        [release.rows[0].id]
      );
      assert.equal(audit.rows[0].count, 2);
    });
  } finally {
    await rollback.rollback();
  }
});

test("a schedule save racing a quantity edit cannot cross the split operational boundary", async () => {
  // Like the split concurrency proof above, this uses two independent durable
  // transactions and relies on disposal of the isolated test database.
  const fixture = await seedSplitFixture("schedule-race", { firstSplitPallets: 4 });
  const initial = await getScmPurchaseOrderSplitSourceLines(fixture.splitPoRef);
  const schedule = await query(
    `SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
       FROM scm_transport_schedule
      WHERE order_kind = 'PO' AND lower(order_ref) = lower($1)`,
    [fixture.splitPoRef]
  );
  const outcomes = await Promise.allSettled([
    updateScmPurchaseOrderSplitLines({
      splitPoRef: fixture.splitPoRef,
      expectedRevision: initial.split.revision,
      updatedBy: "schedule-race-line-editor",
      lines: [desiredLine(fixture.firstLineId, 6)]
    }),
    updateScmScheduleEntry({
      orderKind: "PO",
      orderRef: fixture.splitPoRef,
      patch: { status: "Planned" },
      updatedBy: "schedule-race-planner",
      expectedUpdatedAt: schedule.rows[0].updated_at,
      expectedSplitRevision: initial.split.revision
    })
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  const rejected = outcomes.find((outcome) => outcome.status === "rejected");
  assert.equal(rejected?.reason?.status, 409);
  assert.ok(
    ["SCM_PO_SPLIT_STALE", "SCM_PO_SPLIT_OPERATIONAL", "SCM_SCHEDULE_STALE"].includes(rejected?.reason?.code),
    `unexpected race rejection: ${rejected?.reason?.code || "no code"} ${rejected?.reason?.message || ""}`
  );
  const persisted = await query(
    `SELECT split.revision, schedule.status
       FROM dispatch_scm_po_splits split
       JOIN scm_transport_schedule schedule
         ON schedule.order_kind = 'PO'
        AND lower(schedule.order_ref) = lower(split.split_po_ref)
      WHERE split.id = $1`,
    [fixture.splitId]
  );
  const state = persisted.rows[0];
  assert.ok(
    (Number(state.revision) === 2 && state.status === "Queued")
      || (Number(state.revision) === 1 && state.status === "Planned"),
    "the stale schedule and stale quantity mutation must never both commit"
  );
});

test("PO-phase approval freezes real PO and local-split evidence exactly once", async () => {
  const ordinarySplit = await seedSplitFixture("phase-ordinary", { firstSplitPallets: 4 });
  const blanketSplit = await seedSplitFixture("phase-blanket", { firstSplitPallets: 3 });
  await query(
    `UPDATE purchase_orders SET is_blanket_po = true WHERE netsuite_id = $1`,
    [blanketSplit.sourcePoId]
  );
  const run = await query(
    `INSERT INTO scm_smart_planning_runs (
       status, trigger_source, revision, settings_snapshot, totals,
       created_by, completed_at, plan_kind, planning_phase
     ) VALUES (
       'ready','phase_integration',1,$1::jsonb,'{}'::jsonb,
       'phase-integration-test',now(),'inventory','po_pending_approval'
     ) RETURNING id`,
    [JSON.stringify({
      inventory_planning_mode: "po_then_transfer",
      skip_12441_enabled: false,
      truck_capacity_lbs: 78000,
      hold_load_ratio: 0.5
    })]
  );
  const runId = Number(run.rows[0].id);
  const approvals = await Promise.all([
    approveSmartScmPoPhase(runId, null),
    approveSmartScmPoPhase(runId, null)
  ]);
  assert.deepEqual(approvals.map((approval) => approval.phaseApprovalReused).sort(), [false, true]);
  const approved = approvals[0].planningPhase === "transfer_ready" ? approvals[0] : approvals[1];
  assert.equal(approved.planningPhase, "transfer_ready");
  assert.equal(approved.phaseTwoBasis.frozen, true);

  const evidence = approved.phaseTwoBasis.expectedPurchaseOrderLines;
  const ordinarySource = evidence.find((line) =>
    line.orderRef === ordinarySplit.sourcePoRef && line.lineId === ordinarySplit.firstLineId);
  const ordinaryChild = evidence.find((line) => line.orderRef === ordinarySplit.splitPoRef);
  const blanketSource = evidence.find((line) => line.orderRef === blanketSplit.sourcePoRef);
  const blanketChild = evidence.find((line) => line.orderRef === blanketSplit.splitPoRef);
  assert.equal(ordinarySource?.remainingQuantity, 80,
    "the active child allocation must be removed from the ordinary source PO evidence");
  assert.equal(ordinaryChild?.remainingQuantity, 40);
  assert.equal(ordinaryChild?.source, "local_split");
  assert.equal(blanketSource, undefined,
    "the Blanket parent is a pool, not expected inbound in addition to its released split");
  assert.equal(blanketChild?.remainingQuantity, 30);
  assert.equal(blanketChild?.blanketSplit, true);
  assert.ok(approved.phaseTwoBasis.splitInboundEvidence.some((line) =>
    line.splitRef === ordinarySplit.splitPoRef && line.quantity === 40));
  assert.ok(approved.phaseTwoBasis.splitInboundEvidence.some((line) =>
    line.splitRef === blanketSplit.splitPoRef && line.quantity === 30));

  const frozenBasis = structuredClone(approved.phaseTwoBasis);
  await query(
    `UPDATE purchase_order_lines SET quantity = 10 WHERE id = $1`,
    [ordinarySplit.firstChildLineId]
  );
  const loadedAgain = await getSmartScmPlanningRun(runId);
  assert.deepEqual(loadedAgain.phaseTwoBasis, frozenBasis,
    "later PO synchronization must not rewrite an approved run's calculation basis");
  const audit = await query(
    `SELECT count(*)::integer AS count
       FROM delivery_audit_log
      WHERE action = 'smart_scm.plan.po_phase_approved'
        AND details @> $1::jsonb`,
    [JSON.stringify({ runId })]
  );
  assert.equal(audit.rows[0].count, 1,
    "concurrent approval retries must not duplicate the phase transition audit");
});
