import assert from "node:assert/strict";
import fs from "node:fs";
import { closeDb, query, withTransaction } from "./db.js";
import {
  listDispatchOrders,
  listScmPurchaseOrders,
  listScmSchedule
} from "./dispatch-repository.js";
import { upsertPurchaseOrderLines } from "./order-sync-repository.js";
import {
  listScmNetSuitePoHistory,
  persistScmNetSuitePoSnapshot
} from "./scm-netsuite-po-history-repository.js";

const seed = Date.now() % 100000000;
const baseId = 960000000000 + (seed * 10);
const marker = `PO-HISTORY-FILTER-${seed}`;
const vendorReferenceMigration = fs.readFileSync(
  new URL("../migrations/147_scm_po_vendor_reference_backfill.sql", import.meta.url),
  "utf8"
);
const lineFinancialMigration = fs.readFileSync(
  new URL("../migrations/148_scm_po_history_line_financial_backfill.sql", import.meta.url),
  "utf8"
);

async function seedHistory(offset, suffix, values = {}) {
  const purchaseOrderId = baseId + offset;
  const purchaseOrderRef = `${marker}-${suffix}`;
  await query(
    `INSERT INTO purchase_orders (
       netsuite_id, tranid, trandate, status, status_text, receipt_status,
       netsuite_active, netsuite_missing_at, dispatch_ref, vendor_reference, synced_at
     ) VALUES ($1,$2,current_date,$3,$4,$5,$6,$7,$8,$9,now())`,
    [purchaseOrderId, purchaseOrderRef, values.status || "B",
      values.statusText || "Purchase Order : Pending Receipt",
      values.receiptStatus || "not_received",
      values.active !== false,
      values.missingAt || null,
      values.dispatchRef || null,
      values.vendorReference ?? null]
  );
  await query(
    `INSERT INTO scm_netsuite_po_history (
       netsuite_purchase_order_id, netsuite_purchase_order_ref,
       creation_snapshot, archived_at, last_synced_at, last_sync_error
     ) VALUES ($1,$2,'{}'::jsonb,now(),now(),$3)`,
    [purchaseOrderId, purchaseOrderRef, values.lastSyncError || null]
  );
  await query(
    `INSERT INTO purchase_order_lines (
       purchase_order_id, line_id, item_id, item_name, sku, quantity,
       netsuite_received_qty, unit, location_id, location,
       pallet_qty, netsuite_closed, netsuite_active
     ) VALUES ($1,$2,$3,$4,$4,$5,$6,'EA',1,'Harness yard',1,$7,true)`,
    [purchaseOrderId, offset, baseId + 100 + offset, `${purchaseOrderRef}-ITEM`,
      values.quantity ?? 10, values.receivedQuantity ?? 0, values.closed === true]
  );
  return purchaseOrderId;
}

try {
  await withTransaction(async () => {
    const openId = await seedHistory(1, "OPEN", {
      statusText: "Purchase Order : Partially Received",
      receiptStatus: "partial_received",
      receivedQuantity: 4
    });
    const completedId = await seedHistory(2, "COMPLETED", {
      status: "G",
      statusText: "Purchase Order : Fully Billed",
      receiptStatus: "received",
      receivedQuantity: 10
    });
    const missingId = await seedHistory(3, "MISSING", {
      active: false,
      missingAt: new Date().toISOString()
    });
    const closedId = await seedHistory(4, "CLOSED-LINE", { closed: true });
    const syncMissingId = await seedHistory(5, "SYNC-MISSING", {
      lastSyncError: "The purchase order no longer exists in NetSuite."
    });
    const legacyVendorReference = `#${seed}-LEGACY-PACKING`;
    const legacyReferenceId = await seedHistory(6, "LEGACY-REFERENCE", {
      dispatchRef: legacyVendorReference,
      vendorReference: "",
      closed: true
    });
    const migratedVendorReference = `#${seed}-MIGRATED-PACKING`;
    const migratedReferenceId = await seedHistory(7, "MIGRATED-REFERENCE", {
      dispatchRef: migratedVendorReference,
      vendorReference: "",
      closed: true
    });
    await query(
      `INSERT INTO scm_transport_schedule (
         order_kind, order_ref, display_ref, method, status,
         pickup_point, dropoff_point, packing_slip_ref, created_by, updated_by
       ) VALUES (
         'PO', $1, $1, 'Vendor', 'Hold',
         'Migration vendor yard', 'Harness yard', NULL, 'history-harness', 'history-harness'
       )`,
      [migratedVendorReference]
    );
    await query(vendorReferenceMigration);
    await query(
      `UPDATE purchase_order_lines
          SET rate = NULL,
              amount = NULL,
              raw = COALESCE(raw, '{}'::jsonb) || $2::jsonb
        WHERE purchase_order_id = $1`,
      [migratedReferenceId, JSON.stringify({ rate: 13, amount: 130 })]
    );
    await query(lineFinancialMigration);
    const migratedReference = await query(
      `SELECT po.vendor_reference, schedule.packing_slip_ref,
              schedule.method, schedule.status, schedule.source_table, schedule.source_id
         FROM purchase_orders po
         JOIN scm_transport_schedule schedule
           ON schedule.order_kind = 'PO'
          AND schedule.source_table = 'purchase_orders'
          AND schedule.source_id = po.netsuite_id
        WHERE po.netsuite_id = $1`,
      [migratedReferenceId]
    );
    assert.deepEqual(migratedReference.rows, [{
      vendor_reference: migratedVendorReference,
      packing_slip_ref: migratedVendorReference,
      method: "Vendor",
      status: "Hold",
      source_table: "purchase_orders",
      source_id: String(migratedReferenceId)
    }], "Migration 147 must backfill an established non-split Packing Slip / Ref without changing route state.");
    const migratedFinancials = await query(
      "SELECT rate, amount FROM purchase_order_lines WHERE purchase_order_id = $1",
      [migratedReferenceId]
    );
    assert.deepEqual(migratedFinancials.rows, [{ rate: "13", amount: "130" }],
      "Migration 148 must promote authoritative OAuth line rate and amount values already stored in raw JSON.");

    const all = await listScmNetSuitePoHistory({ search: marker, pageSize: 100 });
    assert.deepEqual(
      new Set(all.records.map((record) => record.purchaseOrderId)),
      new Set([openId, completedId, missingId, closedId, syncMissingId, legacyReferenceId, migratedReferenceId]),
      "The default lifecycle must retain all archived PO history records."
    );

    const completed = await listScmNetSuitePoHistory({
      search: marker,
      lifecycle: "completed",
      pageSize: 100
    });
    assert.deepEqual(completed.records.map((record) => record.purchaseOrderId), [completedId]);
    assert.equal(completed.records[0].lifecycle, "completed");

    const pendingReceive = await listScmNetSuitePoHistory({
      search: marker,
      lifecycle: "pending_receive",
      pageSize: 100
    });
    assert.deepEqual(pendingReceive.records.map((record) => record.purchaseOrderId), [openId]);
    assert.equal(pendingReceive.records[0].lifecycle, "pending_receive");
    assert.equal(pendingReceive.records[0].current.lines[0].quantity, 10);
    assert.equal(pendingReceive.records[0].current.lines[0].receivedQuantity, 4);

    const missing = await listScmNetSuitePoHistory({
      search: marker,
      lifecycle: "missing",
      pageSize: 100
    });
    assert.deepEqual(
      missing.records.map((record) => record.purchaseOrderId).sort((left, right) => left - right),
      [missingId, syncMissingId].sort((left, right) => left - right)
    );
    assert(missing.records.every((record) => record.lifecycle === "missing"));
    assert.equal(missing.records.find((record) => record.purchaseOrderId === missingId).current.active, false);
    assert.equal(missing.records.find((record) => record.purchaseOrderId === syncMissingId).current.active, true,
      "A successful NetSuite not-found response must classify the PO as missing without rewriting canonical order activity.");

    const legacyBeforeRefresh = all.records.find((record) => record.purchaseOrderId === legacyReferenceId);
    assert.equal(legacyBeforeRefresh?.current.vendorReference, legacyVendorReference,
      "A pre-existing non-split Packing Slip / Ref must appear as the PO History Vendor reference even before backfill.");
    const legacyHistory = await query(
      "SELECT id FROM scm_netsuite_po_history WHERE netsuite_purchase_order_id = $1",
      [legacyReferenceId]
    );
    await persistScmNetSuitePoSnapshot(legacyHistory.rows[0].id, {
      lastModifiedAt: new Date(Date.now() + 2000).toISOString(),
      vendorReference: "",
      lines: []
    }, { source: "reconciliation" });
    const legacyAfterRefresh = await listScmNetSuitePoHistory({
      search: `${marker}-LEGACY-REFERENCE`,
      pageSize: 10
    });
    assert.equal(legacyAfterRefresh.records[0]?.current.vendorReference, legacyVendorReference,
      "An automatic OAuth readback with an empty remote Vendor reference must preserve the established local reference.");
    const legacyCanonical = await query(
      `SELECT po.vendor_reference, schedule.packing_slip_ref
         FROM purchase_orders po
         LEFT JOIN scm_transport_schedule schedule
           ON schedule.order_kind = 'PO'
          AND schedule.source_table = 'purchase_orders'
          AND schedule.source_id = po.netsuite_id
        WHERE po.netsuite_id = $1`,
      [legacyReferenceId]
    );
    assert.equal(legacyCanonical.rows[0]?.vendor_reference, legacyVendorReference);
    assert.equal(legacyCanonical.rows[0]?.packing_slip_ref, legacyVendorReference,
      "Lazy legacy-reference backfill must synchronize Dispatch, PO Split, and PO/TO Schedule.");
    await persistScmNetSuitePoSnapshot(legacyHistory.rows[0].id, {
      lastModifiedAt: new Date(Date.now() + 4000).toISOString(),
      vendorReference: "",
      lines: []
    }, {
      source: "application",
      operatorId: "history-harness",
      requestedChanges: { header: { vendorReference: "" } }
    });
    const explicitlyCleared = await listScmNetSuitePoHistory({
      search: `${marker}-LEGACY-REFERENCE`,
      pageSize: 10
    });
    const clearedCanonical = await query(
      `SELECT po.vendor_reference, schedule.packing_slip_ref
         FROM purchase_orders po
         LEFT JOIN scm_transport_schedule schedule
           ON schedule.order_kind = 'PO'
          AND schedule.source_table = 'purchase_orders'
          AND schedule.source_id = po.netsuite_id
        WHERE po.netsuite_id = $1`,
      [legacyReferenceId]
    );
    assert.equal(explicitlyCleared.records[0]?.current.vendorReference, "",
      "An explicit blank save must not resurrect the legacy dispatch reference in PO History.");
    assert.equal(clearedCanonical.rows[0]?.vendor_reference, "");
    assert.equal(clearedCanonical.rows[0]?.packing_slip_ref, null,
      "An explicit blank save must clear the shared Packing Slip / Ref.");

    const openHistory = await query(
      "SELECT id FROM scm_netsuite_po_history WHERE netsuite_purchase_order_id = $1",
      [openId]
    );
    await upsertPurchaseOrderLines(openId, [{
      line_id: 1,
      item_id: baseId + 101,
      item_name: `${marker}-OPEN-ITEM`,
      quantity: 10,
      netsuite_received_qty: 4,
      unit: "EA",
      location_id: 1,
      location: "Harness yard",
      pallet_qty: 1,
      rate: 1.64,
      amount: 16.4,
      netsuite_closed: false,
      raw: { rate: 1.64, amount: 16.4 }
    }]);
    const canonicalFinancials = await query(
      "SELECT rate, amount, netsuite_closed FROM purchase_order_lines WHERE purchase_order_id = $1 AND line_id = 1",
      [openId]
    );
    assert.deepEqual(canonicalFinancials.rows, [{ rate: "1.64", amount: "16.4", netsuite_closed: false }],
      "Canonical OAuth line upsert must persist Rate and Amount in the columns consumed by PO History.");
    const financialTimestamp = new Date().toISOString();
    const financialSnapshot = {
      lastModifiedAt: financialTimestamp,
      vendorReference: "",
      lines: [{ lineId: 1, rate: 1.64, amount: 16.4, closed: false }]
    };
    await persistScmNetSuitePoSnapshot(openHistory.rows[0].id, financialSnapshot, { source: "reconciliation" });
    await query(
      "UPDATE purchase_order_lines SET rate = NULL, amount = NULL WHERE purchase_order_id = $1 AND line_id = 1",
      [openId]
    );
    await persistScmNetSuitePoSnapshot(openHistory.rows[0].id, financialSnapshot, { source: "reconciliation" });
    const heartbeatFinancials = await query(
      "SELECT rate, amount FROM purchase_order_lines WHERE purchase_order_id = $1 AND line_id = 1",
      [openId]
    );
    assert.deepEqual(heartbeatFinancials.rows, [{ rate: "1.64", amount: "16.4" }],
      "An unchanged NetSuite timestamp must still repair missing Rate and Amount columns.");
    const financialHistory = await listScmNetSuitePoHistory({ search: `${marker}-OPEN`, pageSize: 10 });
    assert.equal(financialHistory.records[0]?.current.lines[0]?.rate, 1.64);
    assert.equal(financialHistory.records[0]?.current.lines[0]?.amount, 16.4);
    await query(
      `INSERT INTO scm_transport_schedule (
         order_kind, order_ref, display_ref, method, status,
         pickup_point, dropoff_point, packing_slip_ref, created_by, updated_by
       ) VALUES (
         'PO', $1, $1, 'Vendor', 'Hold',
         'Vendor yard', 'Harness yard', 'OLD-PACKING-REF', 'history-harness', 'history-harness'
       )`,
      [`${marker}-OPEN`]
    );
    const vendorReference = `${marker}-VENDOR-REF`;
    await persistScmNetSuitePoSnapshot(openHistory.rows[0].id, {
      createdAt: new Date(Date.now() - 60000).toISOString(),
      lastModifiedAt: new Date().toISOString(),
      vendorReference,
      lines: []
    }, {
      source: "application",
      operatorId: "history-harness",
      requestedChanges: { header: { vendorReference } }
    });
    const synchronized = await query(
      `SELECT po.vendor_reference, po.dispatch_ref,
              schedule.packing_slip_ref, schedule.method, schedule.status,
              schedule.pickup_point, schedule.dropoff_point,
              schedule.source_table, schedule.source_id
         FROM purchase_orders po
         JOIN scm_transport_schedule schedule
           ON schedule.order_kind = 'PO'
          AND lower(schedule.order_ref) = lower(po.tranid)
        WHERE po.netsuite_id = $1`,
      [openId]
    );
    assert.equal(synchronized.rows[0]?.vendor_reference, vendorReference,
      "NetSuite Vendor reference must remain mirrored on the canonical purchase order.");
    assert.equal(synchronized.rows[0]?.packing_slip_ref, vendorReference,
      "Vendor reference must update the Packing Slip / Ref shared by Dispatch, PO Split, and PO/TO Schedule.");
    assert.equal(synchronized.rows[0]?.dispatch_ref, null,
      "Saving a packing-slip reference must not replace the stable PO identity.");
    assert.deepEqual(
      {
        method: synchronized.rows[0]?.method,
        status: synchronized.rows[0]?.status,
        pickup: synchronized.rows[0]?.pickup_point,
        dropoff: synchronized.rows[0]?.dropoff_point
      },
      { method: "Vendor", status: "Hold", pickup: "Vendor yard", dropoff: "Harness yard" },
      "Reference synchronization must preserve the existing schedule and route."
    );
    assert.equal(synchronized.rows[0]?.source_table, "purchase_orders");
    assert.equal(Number(synchronized.rows[0]?.source_id), openId);

    const dispatchOrders = await listDispatchOrders({
      type: "PO",
      includeHiddenScm: true,
      search: `${marker}-OPEN`
    });
    const poSplitOrders = await listScmPurchaseOrders({ search: `${marker}-OPEN` });
    const poToSchedule = await listScmSchedule({ search: `${marker}-OPEN` });
    assert.equal(
      dispatchOrders.find((order) => Number(order.netsuiteId) === openId)?.scm?.packingSlipRef,
      vendorReference,
      "Dispatch must read the synchronized Vendor reference as its PO Packing Slip / Ref."
    );
    assert.equal(
      poSplitOrders.find((order) => Number(order.netsuiteId) === openId)?.scm?.packingSlipRef,
      vendorReference,
      "PO Split must read the same synchronized Packing Slip / Ref."
    );
    assert.equal(
      poToSchedule.find((order) => Number(order.sourceId) === openId)?.packingSlipRef,
      vendorReference,
      "PO/TO Schedule must read the same synchronized Packing Slip / Ref."
    );

    const completedHistory = await query(
      "SELECT id FROM scm_netsuite_po_history WHERE netsuite_purchase_order_id = $1",
      [completedId]
    );
    const createdReference = `${marker}-CREATED-REF`;
    await persistScmNetSuitePoSnapshot(completedHistory.rows[0].id, {
      lastModifiedAt: new Date(Date.now() + 1000).toISOString(),
      vendorReference: createdReference,
      lines: []
    }, { source: "netsuite_webhook" });
    const createdSchedule = await query(
      `SELECT packing_slip_ref, status, source_table, source_id
         FROM scm_transport_schedule
        WHERE order_kind = 'PO' AND source_id = $1`,
      [completedId]
    );
    assert.equal(createdSchedule.rowCount, 1,
      "Reference synchronization must create the local PO schedule mirror when one does not exist yet.");
    assert.equal(createdSchedule.rows[0].packing_slip_ref, createdReference);
    assert.equal(createdSchedule.rows[0].status, "Queued",
      "Creating the reference mirror must preserve the PO's initial SCM status.");
    assert.equal(createdSchedule.rows[0].source_table, "purchase_orders");
  }, { rollback: true });
  console.log("NetSuite PO history lifecycle filter harness passed.");
} finally {
  await closeDb();
}
