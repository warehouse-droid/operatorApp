import assert from "node:assert/strict";
import { closeDb, query, withTransaction } from "./db.js";
import { listScmNetSuitePoHistory } from "./scm-netsuite-po-history-repository.js";

const seed = Date.now() % 100000000;
const baseId = 960000000000 + (seed * 10);
const marker = `PO-HISTORY-FILTER-${seed}`;

async function seedHistory(offset, suffix, values = {}) {
  const purchaseOrderId = baseId + offset;
  const purchaseOrderRef = `${marker}-${suffix}`;
  await query(
    `INSERT INTO purchase_orders (
       netsuite_id, tranid, trandate, status, status_text, receipt_status,
       netsuite_active, netsuite_missing_at, synced_at
     ) VALUES ($1,$2,current_date,$3,$4,$5,$6,$7,now())`,
    [purchaseOrderId, purchaseOrderRef, values.status || "B",
      values.statusText || "Purchase Order : Pending Receipt",
      values.receiptStatus || "not_received",
      values.active !== false,
      values.missingAt || null]
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

    const all = await listScmNetSuitePoHistory({ search: marker, pageSize: 100 });
    assert.deepEqual(
      new Set(all.records.map((record) => record.purchaseOrderId)),
      new Set([openId, completedId, missingId, closedId, syncMissingId]),
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
  }, { rollback: true });
  console.log("NetSuite PO history lifecycle filter harness passed.");
} finally {
  await closeDb();
}
