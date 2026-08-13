import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { closeDb, query, withTransaction } from "./db.js";
import {
  listDispatchOrders,
  listScmSchedule,
  listScmViewPresets,
  setPurchaseOrderBlanketFlag
} from "./dispatch-repository.js";
import { upsertPurchaseOrders } from "./order-sync-repository.js";

const migrationUrl = new URL("../migrations/059_scm_blanket_purchase_orders.sql", import.meta.url);
const workflowMigrationUrl = new URL("../migrations/097_smart_scm_blanket_orders.sql", import.meta.url);
const scheduleUiUrl = new URL("../public/scm-schedule.js", import.meta.url);
const dispatchRepositoryUrl = new URL("./dispatch-repository.js", import.meta.url);
const orderSyncRepositoryUrl = new URL("./order-sync-repository.js", import.meta.url);

const [migrationSource, workflowMigrationSource, scheduleUiSource, dispatchRepositorySource, orderSyncRepositorySource] = await Promise.all([
  fs.readFile(migrationUrl, "utf8"),
  fs.readFile(workflowMigrationUrl, "utf8"),
  fs.readFile(scheduleUiUrl, "utf8"),
  fs.readFile(dispatchRepositoryUrl, "utf8"),
  fs.readFile(orderSyncRepositoryUrl, "utf8")
]);

assert.match(migrationSource, /is_blanket_po\s+boolean\s+NOT NULL\s+DEFAULT false/i,
  "Blanket migration must use a false default so split/local PO children never inherit the parent flag.");
assert.match(migrationSource, /initial_scm_status[\s\S]*DEFAULT 'Queued'/i,
  "The database default must remain Queued for local PO creation paths.");
assert.match(migrationSource, /'Blanket'[\s\S]*blanketManagement/i,
  "Migration must install the Blanket schedule preset.");
assert.match(scheduleUiSource, /isBlanket/,
  "PO/TO Schedule must expose the Blanket flag in its frontend state and save payload.");
assert.match(scheduleUiSource, /blanket/i,
  "PO/TO Schedule must render and permit its Blanket management view.");
assert.match(dispatchRepositorySource, /blanket_flagged_at/i,
  "Blanket writes must record flag provenance.");
assert.match(dispatchRepositorySource, /NOT COALESCE\([^\n]*is_blanket_po[^\n]*false\)/i,
  "Normal dispatch/schedule queries must explicitly exclude flagged blanket parents.");
assert.match(orderSyncRepositorySource, /'not_received',\s*'Hold'/i,
  "New NetSuite PO inserts must explicitly start at Hold.");
assert.match(dispatchRepositorySource, /COALESCE\(scm\.status,\s*o\.initial_scm_status,\s*'Hold'\) AS scm_status/i,
  "A NetSuite PO with no schedule row must surface its Hold arrival status.");
assert.match(dispatchRepositorySource, /scm\.id AS scm_schedule_id/i,
  "PO response rows must retain the schedule identity used for status freshness.");
assert.match(dispatchRepositorySource, /scm\.updated_at AS scm_updated_at/i,
  "PO response rows must retain the schedule update time used for status freshness.");

const seed = Date.now() % 100000000;
const baseId = 800000000000 + (seed * 20);
const parentId = -(baseId + 1);
const childId = -(baseId + 2);
const existingSyncId = baseId + 3;
const newSyncId = baseId + 4;
const transferId = -(baseId + 5);
const splitHeaderId = -(baseId + 6);
const parentLineId = -(baseId + 11);
const childLineId = -(baseId + 12);
const newSyncLineId = -(baseId + 13);
const transferLineId = -(baseId + 14);
const prefix = `BLANKET-HARNESS-${seed}`;
const parentRef = `${prefix}-PARENT`;
const childRef = `${prefix}-CHILD`;
const existingSyncRef = `${prefix}-EXISTING`;
const newSyncRef = `${prefix}-NEW`;
const transferRef = `${prefix}-TO`;
const actor = `blanket-harness-${seed}`;

function hasRef(rows, ref) {
  return rows.some((row) => String(row.orderRef ?? row.id ?? "").toLowerCase() === ref.toLowerCase());
}

function rowFor(rows, ref) {
  return rows.find((row) => String(row.orderRef ?? row.id ?? "").toLowerCase() === ref.toLowerCase());
}

function syncedPo(id, tranid, memo = "") {
  return {
    id,
    tranid,
    trandate: "2026-07-23",
    vendor_id: baseId + 100,
    vendor: `Blanket Harness Vendor ${seed}`,
    vendor_address: "",
    status: "pendingReceipt",
    status_text: "Pending Receipt",
    foreigntotal: 100,
    memo,
    source_location_id: null,
    source_location: "Harness Vendor",
    destination_location_id: 26,
    destination_location: "150"
  };
}

try {
  await withTransaction(async () => {
    // Migrations are transactional in PostgreSQL. Applying this idempotent migration here lets
    // the harness run before deployment and guarantees the live schema is restored by rollback.
    await query(migrationSource);
    await query(workflowMigrationSource);

    const blanketPreset = (await listScmViewPresets())
      .find((preset) => String(preset.name || "").toLowerCase() === "blanket");
    assert(blanketPreset, "Blanket view preset must be available after migration 059.");
    assert.equal(blanketPreset.config?.filters?.kind, "PO");
    assert.equal(blanketPreset.config?.filters?.blanketManagement, true);

    await query(
      `INSERT INTO purchase_orders (
         netsuite_id, tranid, trandate, vendor_id, vendor, status, status_text,
         destination_location_id, destination_location, receipt_status,
         initial_scm_status, is_blanket_po, netsuite_active, synced_at
       ) VALUES ($1, $2, current_date, $3, $4, 'pendingReceipt', 'Pending Receipt',
         26, '150', 'not_received', 'Queued', false, true, now())`,
      [parentId, parentRef, baseId + 101, `Blanket Parent Vendor ${seed}`]
    );
    await query(
      `INSERT INTO purchase_order_lines (
         id, purchase_order_id, line_id, item_id, item_name, sku, quantity, unit,
         item_weight, pallet_qty, to_plt, location_id, location,
         netsuite_received_qty, netsuite_received_baseline_qty, netsuite_active, synced_at, raw
       ) VALUES ($1, $2, $3, $4, 'Blanket Parent Item', 'BLANKET-PARENT', 10, 'EA',
         10, 1, 10, 26, '150', 0, 0, true, now(), '{}'::jsonb)`,
      [parentLineId, parentId, baseId + 201, baseId + 301]
    );

    // This matches the local SCM split insert: initial_scm_status and is_blanket_po are omitted.
    await query(
      `INSERT INTO purchase_orders (
         netsuite_id, tranid, trandate, vendor_id, vendor, status, status_text,
         destination_location_id, destination_location, receipt_status,
         netsuite_active, synced_at, dispatch_ref
       ) VALUES ($1, $2, current_date, $3, $4, 'pendingReceipt', 'Pending Receipt',
         26, '150', 'not_received', true, now(), $2)`,
      [childId, childRef, baseId + 101, `Blanket Parent Vendor ${seed}`]
    );
    await query(
      `INSERT INTO purchase_order_lines (
         id, purchase_order_id, line_id, item_id, item_name, sku, quantity, unit,
         item_weight, pallet_qty, to_plt, location_id, location,
         netsuite_received_qty, netsuite_received_baseline_qty, netsuite_active, synced_at, raw
       ) VALUES ($1, $2, $3, $4, 'Blanket Child Item', 'BLANKET-CHILD', 10, 'EA',
         10, 1, 10, 26, '150', 0, 0, true, now(), '{"scmSplit":true}'::jsonb)`,
      [childLineId, childId, baseId + 202, baseId + 302]
    );
    await query(
      `INSERT INTO dispatch_scm_po_splits (
         id, source_po_id, source_po_ref, split_po_id, split_po_ref, status, created_by
       ) VALUES ($1, $2, $3, $4, $5, 'active', $6)`,
      [splitHeaderId, parentId, parentRef, childId, childRef, actor]
    );

    const childDefaults = await query(
      "SELECT initial_scm_status, is_blanket_po FROM purchase_orders WHERE netsuite_id = $1",
      [childId]
    );
    assert.equal(childDefaults.rows[0]?.initial_scm_status, "Queued",
      "Local/split PO creation must retain the Queued database default.");
    assert.equal(childDefaults.rows[0]?.is_blanket_po, false,
      "A split child must start unflagged even when its source is later flagged.");

    await query(
      `INSERT INTO purchase_orders (
         netsuite_id, tranid, trandate, vendor_id, vendor, status, status_text,
         destination_location_id, destination_location, receipt_status,
         initial_scm_status, is_blanket_po, netsuite_active, synced_at
       ) VALUES ($1, $2, current_date, $3, $4, 'pendingReceipt', 'Pending Receipt',
         26, '150', 'not_received', 'Queued', true, true, now())`,
      [existingSyncId, existingSyncRef, baseId + 102, `Existing Sync Vendor ${seed}`]
    );
    await upsertPurchaseOrders([syncedPo(existingSyncId, existingSyncRef, "existing PO refresh")]);
    const existingAfterSync = await query(
      "SELECT initial_scm_status, is_blanket_po FROM purchase_orders WHERE netsuite_id = $1",
      [existingSyncId]
    );
    assert.equal(existingAfterSync.rows[0]?.initial_scm_status, "Queued",
      "Refreshing an existing NetSuite PO must preserve its existing SCM status.");
    assert.equal(existingAfterSync.rows[0]?.is_blanket_po, true,
      "Refreshing an existing NetSuite PO must preserve its user-owned Blanket flag.");

    await upsertPurchaseOrders([syncedPo(newSyncId, newSyncRef, "new PO discovery")]);
    const newAfterSync = await query(
      "SELECT initial_scm_status, is_blanket_po FROM purchase_orders WHERE netsuite_id = $1",
      [newSyncId]
    );
    assert.equal(newAfterSync.rows[0]?.initial_scm_status, "Hold",
      "A newly discovered NetSuite PO must default to Hold.");
    assert.equal(newAfterSync.rows[0]?.is_blanket_po, false,
      "NetSuite discovery must not infer a Blanket flag.");
    await query(
      `INSERT INTO purchase_order_lines (
         id, purchase_order_id, line_id, item_id, item_name, sku, quantity, unit,
         item_weight, pallet_qty, to_plt, location_id, location,
         netsuite_received_qty, netsuite_received_baseline_qty, netsuite_active, synced_at, raw
       ) VALUES ($1, $2, $3, $4, 'New Sync Item', 'NEW-SYNC', 10, 'EA',
         10, 1, 10, 26, '150', 0, 0, true, now(), '{}'::jsonb)`,
      [newSyncLineId, newSyncId, baseId + 203, baseId + 303]
    );

    await query(
      `INSERT INTO transfer_orders (
         netsuite_id, tranid, trandate, status, status_text, from_location_id,
         from_location, to_location_id, to_location, outbound_operator_status,
         receiving_status, fulfillment_status, netsuite_active, synced_at
       ) VALUES ($1, $2, current_date, 'B', 'Pending Receipt', 1,
         '3445', 26, '150', 'Open', 'Open', 'open', true, now())`,
      [transferId, transferRef]
    );
    await query(
      `INSERT INTO transfer_order_lines (
         id, line_stage, transfer_order_id, line_id, item_id, item_name, sku,
         quantity, unit, item_weight, pallet_qty, to_plt, location_id, location,
         netsuite_received_qty, netsuite_active, synced_at, raw
       ) VALUES ($1, 'outbound', $2, $3, $4, 'Transfer Harness Item', 'TRANSFER-HARNESS',
         10, 'EA', 10, 1, 10, 1, '3445', 0, true, now(), '{}'::jsonb)`,
      [transferLineId, transferId, baseId + 204, baseId + 304]
    );

    await setPurchaseOrderBlanketFlag(parentRef, {
      isBlanket: true,
      updatedBy: actor
    });
    const flaggedParent = await query(
      `SELECT initial_scm_status, is_blanket_po, blanket_flagged_at, blanket_flagged_by
         FROM purchase_orders WHERE netsuite_id = $1`,
      [parentId]
    );
    assert.equal(flaggedParent.rows[0]?.initial_scm_status, "Queued",
      "Flagging must not rewrite the parent PO's schedule status.");
    assert.equal(flaggedParent.rows[0]?.is_blanket_po, true,
      "The user Blanket flag must persist on the exact PO parent.");
    assert(flaggedParent.rows[0]?.blanket_flagged_at,
      "Flagging a Blanket parent must record a timestamp.");
    assert.equal(flaggedParent.rows[0]?.blanket_flagged_by, actor,
      "Flagging a Blanket parent must record the user/session identifier.");

    const blanketRows = await listScmSchedule({ search: prefix, view: "blanket" });
    const normalRows = await listScmSchedule({ search: prefix, view: "scm working" });
    const blanketParent = rowFor(blanketRows, parentRef);
    const blanketChild = rowFor(blanketRows, childRef);
    assert(blanketParent?.isBlanket, "Blanket view must show the flagged parent as flagged.");
    assert(blanketChild && blanketChild.isBlanket === false,
      "Blanket view must show its split child independently and unflagged.");
    assert.equal(blanketChild.sourceRef, parentRef,
      "The regression child must remain linked to the flagged parent while keeping its own flag.");
    assert(!blanketRows.some((row) => row.orderKind !== "PO"),
      "Blanket management view must contain purchase orders only.");
    assert(!hasRef(normalRows, parentRef),
      "A flagged parent must be hidden from normal PO/TO schedule views.");
    assert(hasRef(normalRows, childRef),
      "A split child must remain visible in normal PO/TO schedule views.");
    assert.equal(rowFor(normalRows, childRef)?.status, "Queued",
      "The local split child must keep its normal Queued status.");
    assert.equal(rowFor(normalRows, newSyncRef)?.status, "Hold",
      "The newly synced NetSuite PO must surface as Hold in schedule review.");
    assert.equal(rowFor(normalRows, transferRef)?.status, "Queued",
      "TO schedule defaults must remain unchanged.");

    const blanketReviewState = await query(
      `INSERT INTO scm_reconciliation_order_state (
         order_kind, source_order_netsuite_id, source_order_ref,
         netsuite_terminal_state, application_status, reconciliation_status,
         reconciliation_reason, ordered_qty, received_qty, remaining_qty,
         destination_remaining_qty, exact_allocation, reconciled_at, completed_at
       ) VALUES (
         'PO', $1, $2, 'open', 'Completed', 'review',
         'Blanket reconciliation visibility harness', 10, 10, 0, 0, false, now(), now()
       )
       RETURNING id`,
      [existingSyncId, existingSyncRef]
    );
    await query(
      `INSERT INTO scm_transport_schedule (
         order_kind, order_ref, status, reconciliation_order_state_id,
         reconciliation_blocked, last_reconciled_at, method, created_by, updated_by
       ) VALUES ('PO', $1, 'Reconcile Review', $2, true, now(), 'MBT', $3, $3)`,
      [existingSyncRef, blanketReviewState.rows[0].id, actor]
    );
    const visibleBlanketReview = await listScmSchedule({
      search: existingSyncRef,
      status: "Reconcile Review",
      view: "scm working"
    });
    assert(hasRef(visibleBlanketReview, existingSyncRef),
      "A blocking Blanket PO review must surface in SCM Working and its review filter.");
    assert.equal(rowFor(visibleBlanketReview, existingSyncRef)?.status, "Reconcile Review",
      "Completed quantities must not hide a blocking Blanket PO review behind Completed.");
    await query(
      "DELETE FROM scm_transport_schedule WHERE order_kind = 'PO' AND order_ref = $1",
      [existingSyncRef]
    );
    await query(
      "DELETE FROM scm_reconciliation_order_state WHERE id = $1",
      [blanketReviewState.rows[0].id]
    );

    const normalParentDispatch = await listDispatchOrders({
      type: "PO", search: parentRef, includeHiddenScm: false
    });
    const diagnosticParentDispatch = await listDispatchOrders({
      type: "PO", search: parentRef, includeHiddenScm: true
    });
    assert(!hasRef(normalParentDispatch, parentRef),
      "A flagged Blanket parent must be excluded from dispatch planning.");
    assert(hasRef(diagnosticParentDispatch, parentRef),
      "The flagged parent fixture must otherwise be dispatch-eligible; filtering cannot pass vacuously.");

    const normalChildDispatch = await listDispatchOrders({
      type: "PO", search: childRef, includeHiddenScm: false
    });
    assert(hasRef(normalChildDispatch, childRef),
      "A split child of a Blanket parent must remain visible to dispatch planning.");

    const normalNewSyncDispatch = await listDispatchOrders({
      type: "PO", search: newSyncRef, includeHiddenScm: false
    });
    const diagnosticNewSyncDispatch = await listDispatchOrders({
      type: "PO", search: newSyncRef, includeHiddenScm: true
    });
    assert(!hasRef(normalNewSyncDispatch, newSyncRef),
      "A newly synced Hold PO must stay out of dispatch planning.");
    assert(hasRef(diagnosticNewSyncDispatch, newSyncRef),
      "The new PO fixture must otherwise be dispatch-eligible; Hold filtering cannot pass vacuously.");

    await assert.rejects(
      setPurchaseOrderBlanketFlag(parentRef, { isBlanket: false, updatedBy: actor }),
      (error) => error.code === "SCM_BLANKET_UNFLAG_UNSAFE",
      "A Blanket parent with an active split must not be unflagged."
    );
    await assert.rejects(
      setPurchaseOrderBlanketFlag(childRef, { isBlanket: true, updatedBy: actor }),
      (error) => error.code === "SCM_BLANKET_SOURCE_REQUIRED",
      "A local split child must never become a Blanket source parent."
    );
    await query(
      "UPDATE purchase_orders SET status_text = 'Purchase Order : Fully Billed' WHERE netsuite_id = $1",
      [newSyncId]
    );
    await assert.rejects(
      setPurchaseOrderBlanketFlag(newSyncRef, { isBlanket: true, updatedBy: actor }),
      (error) => error.code === "SCM_BLANKET_SOURCE_NOT_OPEN",
      "A completed/non-open source PO must not be flaggable as Blanket."
    );
    await query("UPDATE dispatch_scm_po_splits SET status = 'cancelled' WHERE id = $1", [splitHeaderId]);
    await setPurchaseOrderBlanketFlag(parentRef, { isBlanket: false, updatedBy: actor });
    const unflagged = await query(
      "SELECT is_blanket_po FROM purchase_orders WHERE netsuite_id = $1",
      [parentId]
    );
    assert.equal(unflagged.rows[0]?.is_blanket_po, false,
      "Users must be able to remove an incorrect Blanket flag.");
    assert(hasRef(await listScmSchedule({ search: parentRef, view: "scm working" }), parentRef),
      "Unflagged parent must return to normal schedule views.");
    assert(hasRef(await listDispatchOrders({ type: "PO", search: parentRef }), parentRef),
      "Unflagged queued parent must return to dispatch planning.");

    console.log(JSON.stringify({
      blanketPreset: true,
      exactParentFiltering: true,
      splitChildIndependent: true,
      newNetSuitePoHold: true,
      existingPoPreserved: true,
      localPoQueued: true,
      transferOrderQueued: true,
      rolledBack: true
    }, null, 2));
  }, { rollback: true });
} finally {
  await closeDb();
}
