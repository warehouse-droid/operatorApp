import assert from "node:assert/strict";
import test, { after } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import {
  cancelScmPurchaseOrderSplit,
  createScmPurchaseOrderSplit,
  listDispatchOrders,
  listScmPurchaseOrders,
  updatePurchaseOrderDispatchRef,
  updateScmPurchaseOrderSplitRef
} from "../../../src/dispatch-repository.js";
import {
  getReceivingOrder,
  listReceivingOrders
} from "../../../src/receiving-repository.js";

after(closeDb);

const seed = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const baseId = 8_700_000_000_000 + Number(seed.slice(-9)) * 10;
const refPrefix = `PO-REF-REUSE-${seed}`;
const reusedRef = `${refPrefix}-SPLIT`;
const renamedRef = `${refPrefix}-RENAMED`;

async function seedSourcePurchaseOrder(suffix) {
  const purchaseOrderId = baseId + suffix;
  const purchaseOrderRef = `${refPrefix}-SOURCE-${suffix}`;
  const sourceLine = await query(
    `WITH inserted_order AS (
       INSERT INTO purchase_orders (
         netsuite_id, tranid, trandate, vendor_id, vendor, status, status_text,
         foreign_total, destination_location_id, destination_location,
         source_location_id, source_location, dispatch_vendor_yard,
         receipt_status, netsuite_active, synced_at
       ) VALUES (
         $1, $2, current_date, $3, $4, 'pendingReceipt', 'Pending Receipt',
         300, 1, '3445', 15, '12441', 'Harness Vendor Yard',
         'not_received', true, now()
       )
       RETURNING netsuite_id
     )
     INSERT INTO purchase_order_lines (
       purchase_order_id, line_id, item_id, item_name, sku, quantity, unit,
       location_id, location, pallet_qty, layer_qty, section_qty, piece_qty,
       to_plt, to_lyr, to_sec, to_pcs,
       received_pallet_qty, received_layer_qty, received_section_qty,
       received_piece_qty, netsuite_received_qty, netsuite_received_baseline_qty,
       netsuite_active, synced_at, raw
     )
     SELECT netsuite_id, $5, $6, $7, $8, 30, 'EA',
            1, '3445', 30, 0, 0, 0,
            1, 0, 0, 1,
            0, 0, 0, 0, 0, 0,
            true, now(), '{}'::jsonb
       FROM inserted_order
     RETURNING id`,
    [
      purchaseOrderId,
      purchaseOrderRef,
      baseId + 100 + suffix,
      `${refPrefix} Vendor ${suffix}`,
      baseId + 200 + suffix,
      baseId + 300 + suffix,
      `${refPrefix} Item ${suffix}`,
      `${refPrefix}-SKU-${suffix}`
    ]
  );
  return {
    purchaseOrderId,
    purchaseOrderRef,
    lineRowId: sourceLine.rows[0].id
  };
}

function createSplit(source, newPoRef, pallets = 4) {
  return createScmPurchaseOrderSplit({
    sourcePoRef: source.purchaseOrderRef,
    newPoRef,
    destinationLocationId: 1,
    lines: [{ lineRowId: source.lineRowId, pallets }],
    createdBy: "po-ref-reuse-regression"
  });
}

async function assertVisibleOnDispatchAndOperator({
  created,
  expectedRef,
  expectedOriginalRef = expectedRef,
  expectedPallets,
  sourcePoRef
}) {
  const { split, lines } = created;
  const dispatchOrders = await listDispatchOrders({
    type: "PO",
    includeHiddenScm: true,
    search: expectedRef
  });
  const dispatchOrder = dispatchOrders.find((order) =>
    String(order.netsuiteId) === String(split.splitPoId)
  );
  assert.ok(dispatchOrder, `Dispatch must return internal PO ${split.splitPoId}`);
  assert.equal(dispatchOrder.id, expectedRef);
  assert.equal(dispatchOrder.dispatchRef, expectedRef);
  assert.equal(dispatchOrder.originalPoRef, expectedOriginalRef);
  assert.equal(dispatchOrder.items.length, 1);
  assert.equal(dispatchOrder.items[0].pallets, expectedPallets);

  const scmOrders = await listScmPurchaseOrders({ search: expectedRef });
  const scmOrder = scmOrders.find((order) =>
    String(order.netsuiteId) === String(split.splitPoId)
  );
  assert.ok(scmOrder, `SCM Dispatch must return internal PO ${split.splitPoId}`);
  assert.equal(scmOrder.id, expectedRef);
  assert.equal(scmOrder.isScmSplit, true);
  assert.equal(String(scmOrder.scmSplitId), String(split.id));
  assert.equal(scmOrder.sourcePoRef, sourcePoRef);
  assert.equal(scmOrder.items[0].pallets, expectedPallets);

  const operatorOrders = await listReceivingOrders({
    orderType: "purchase_order",
    destinationLocationId: 1,
    search: expectedRef
  });
  const operatorOrder = operatorOrders.find((order) =>
    String(order.netsuite_id) === String(split.splitPoId)
  );
  assert.ok(operatorOrder, `Operator must return internal PO ${split.splitPoId}`);
  assert.equal(operatorOrder.tranid, expectedRef);
  assert.equal(operatorOrder.dispatch_ref, expectedRef);
  assert.equal(Number(operatorOrder.line_count), 1);

  const operatorDetail = await getReceivingOrder(split.splitPoId);
  assert.ok(operatorDetail, `Operator detail must resolve internal PO ${split.splitPoId}`);
  assert.equal(operatorDetail.tranid, expectedRef);
  assert.equal(operatorDetail.dispatch_ref, expectedRef);
  assert.equal(operatorDetail.lines.length, 1);
  assert.equal(String(operatorDetail.lines[0].id), String(lines[0].id));
  assert.equal(Number(operatorDetail.lines[0].pallet_qty), expectedPallets);
}

test("an unsplit or renamed PO ref is reusable while every active ref remains exclusive", async () => {
  const firstSource = await seedSourcePurchaseOrder(1);
  const secondSource = await seedSourcePurchaseOrder(2);

  const firstLifecycle = await createSplit(firstSource, reusedRef);
  await assert.rejects(
    createSplit(secondSource, reusedRef),
    new RegExp(`PO ref ${reusedRef} already exists`, "i"),
    "a currently active split must reserve its visible PO ref"
  );

  await cancelScmPurchaseOrderSplit({
    splitPoRef: reusedRef,
    cancelledBy: "po-ref-reuse-regression"
  });

  const secondLifecycle = await createSplit(firstSource, reusedRef, 5);
  assert.notEqual(secondLifecycle.split.id, firstLifecycle.split.id,
    "reusing a ref must create a new split ledger lifecycle");
  assert.notEqual(secondLifecycle.split.splitPoId, firstLifecycle.split.splitPoId,
    "reusing a ref must not reactivate or overwrite the retired child PO");
  assert.notEqual(secondLifecycle.lines[0].id, firstLifecycle.lines[0].id,
    "reusing a ref must create independent child PO lines");
  await assertVisibleOnDispatchAndOperator({
    created: secondLifecycle,
    expectedRef: reusedRef,
    expectedPallets: 5,
    sourcePoRef: firstSource.purchaseOrderRef
  });

  const retiredInDispatch = (await listDispatchOrders({
    type: "PO",
    includeHiddenScm: true,
    search: reusedRef
  })).some((order) => String(order.netsuiteId) === String(firstLifecycle.split.splitPoId));
  assert.equal(retiredInDispatch, false, "Dispatch must hide the retired internal PO lifecycle");
  const retiredForOperator = (await listReceivingOrders({
    orderType: "purchase_order",
    destinationLocationId: 1,
    search: reusedRef
  })).some((order) => String(order.netsuite_id) === String(firstLifecycle.split.splitPoId));
  assert.equal(retiredForOperator, false, "Operator must hide the retired internal PO lifecycle");

  await assert.rejects(
    createSplit(secondSource, reusedRef),
    new RegExp(`PO ref ${reusedRef} already exists`, "i"),
    "the replacement active lifecycle must reserve the ref again"
  );

  await updateScmPurchaseOrderSplitRef({
    splitPoRef: reusedRef,
    newPoRef: renamedRef,
    updatedBy: "po-ref-reuse-regression"
  });
  const reusedAfterRename = await createSplit(secondSource, reusedRef, 6);
  assert.equal(reusedAfterRename.split.splitPoRef, reusedRef,
    "renaming an active split must release its previous visible ref");
  await assertVisibleOnDispatchAndOperator({
    created: secondLifecycle,
    expectedRef: renamedRef,
    expectedOriginalRef: reusedRef,
    expectedPallets: 5,
    sourcePoRef: firstSource.purchaseOrderRef
  });
  await assertVisibleOnDispatchAndOperator({
    created: reusedAfterRename,
    expectedRef: reusedRef,
    expectedPallets: 6,
    sourcePoRef: secondSource.purchaseOrderRef
  });

  await assert.rejects(
    createSplit(secondSource, renamedRef),
    new RegExp(`PO ref ${renamedRef} already exists`, "i"),
    "the renamed active ref must remain protected"
  );

  const history = await query(
    `SELECT split.id, split.split_po_ref, split.status, split.cancelled_at,
            child.netsuite_id AS child_id, child.netsuite_active,
            COALESCE(NULLIF(child.dispatch_ref, ''), child.tranid) AS visible_ref,
            COUNT(line.id)::int AS line_count,
            BOOL_AND(COALESCE(child_line.netsuite_active, false)) AS all_lines_active
       FROM dispatch_scm_po_splits split
       JOIN purchase_orders child ON child.netsuite_id = split.split_po_id
       LEFT JOIN dispatch_scm_po_split_lines line ON line.split_id = split.id
       LEFT JOIN purchase_order_lines child_line ON child_line.id = line.split_line_id
      WHERE split.source_po_ref IN ($1, $2)
      GROUP BY split.id, child.netsuite_id
      ORDER BY split.created_at, split.id`,
    [firstSource.purchaseOrderRef, secondSource.purchaseOrderRef]
  );
  assert.equal(history.rowCount, 3);
  assert.deepEqual(
    history.rows.map((row) => ({
      ref: row.split_po_ref,
      status: row.status,
      active: row.netsuite_active,
      visibleRef: row.visible_ref,
      lineCount: row.line_count,
      allLinesActive: row.all_lines_active
    })),
    [
      {
        ref: reusedRef,
        status: "cancelled",
        active: false,
        visibleRef: reusedRef,
        lineCount: 1,
        allLinesActive: false
      },
      {
        ref: renamedRef,
        status: "active",
        active: true,
        visibleRef: renamedRef,
        lineCount: 1,
        allLinesActive: true
      },
      {
        ref: reusedRef,
        status: "active",
        active: true,
        visibleRef: reusedRef,
        lineCount: 1,
        allLinesActive: true
      }
    ]
  );
  assert.ok(history.rows[0].cancelled_at, "the retired lifecycle must remain auditable");

  const uniqueness = await query(
    `SELECT indexdef
       FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = 'uq_dispatch_scm_po_splits_active_ref'`
  );
  assert.equal(uniqueness.rowCount, 1);
  assert.match(uniqueness.rows[0].indexdef, /UNIQUE INDEX/i);
  assert.match(uniqueness.rows[0].indexdef, /lower\(split_po_ref\)/i);
  assert.match(uniqueness.rows[0].indexdef, /status = 'active'/i);
});

test("concurrent split creation cannot claim the same active ref twice", async () => {
  const firstSource = await seedSourcePurchaseOrder(3);
  const secondSource = await seedSourcePurchaseOrder(4);
  const raceRef = `${refPrefix}-RACE`;
  const outcomes = await Promise.allSettled([
    createSplit(firstSource, raceRef, 3),
    createSplit(secondSource, raceRef, 3)
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);

  const active = await query(
    `SELECT COUNT(*)::int AS count
       FROM dispatch_scm_po_splits
      WHERE lower(split_po_ref) = lower($1)
        AND status = 'active'`,
    [raceRef]
  );
  assert.equal(active.rows[0].count, 1);
});

test("renaming an ordinary PO display ref releases its original ref without hiding either active order", async () => {
  const renamedSource = await seedSourcePurchaseOrder(5);
  const splitSource = await seedSourcePurchaseOrder(6);
  const renamedSourceRef = `${refPrefix}-SOURCE-DISPLAY-RENAMED`;

  const renamed = await updatePurchaseOrderDispatchRef({
    poRef: renamedSource.purchaseOrderRef,
    newRef: renamedSourceRef,
    updatedBy: "po-ref-reuse-regression"
  });
  assert.equal(renamed.displayRef, renamedSourceRef);

  await assert.rejects(
    createSplit(splitSource, renamedSourceRef, 2),
    new RegExp(`PO ref ${renamedSourceRef} already exists`, "i"),
    "the ordinary PO's new visible ref must remain reserved"
  );

  const reusedOriginal = await createSplit(splitSource, renamedSource.purchaseOrderRef, 2);
  await assertVisibleOnDispatchAndOperator({
    created: reusedOriginal,
    expectedRef: renamedSource.purchaseOrderRef,
    expectedPallets: 2,
    sourcePoRef: splitSource.purchaseOrderRef
  });

  const renamedDispatchOrder = (await listDispatchOrders({
    type: "PO",
    includeHiddenScm: true,
    search: renamedSourceRef
  })).find((order) => String(order.netsuiteId) === String(renamedSource.purchaseOrderId));
  assert.ok(renamedDispatchOrder);
  assert.equal(renamedDispatchOrder.id, renamedSourceRef);
  assert.equal(renamedDispatchOrder.originalPoRef, renamedSource.purchaseOrderRef);

  const renamedOperatorOrder = (await listReceivingOrders({
    orderType: "purchase_order",
    destinationLocationId: 1,
    search: renamedSourceRef
  })).find((order) => String(order.netsuite_id) === String(renamedSource.purchaseOrderId));
  assert.ok(renamedOperatorOrder);
  assert.equal(renamedOperatorOrder.tranid, renamedSourceRef);
  assert.equal(renamedOperatorOrder.original_tranid, renamedSource.purchaseOrderRef);
});
