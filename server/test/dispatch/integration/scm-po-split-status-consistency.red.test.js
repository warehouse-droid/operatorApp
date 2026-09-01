// @ts-check

import assert from "node:assert/strict";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import {
  createScmPurchaseOrderSplit,
  listScmPurchaseOrders,
  listScmSchedule
} from "../../../src/dispatch-repository.js";
import {
  enqueueScmPurchaseOrderCatalogRefresh,
  getScmPurchaseOrderCatalogOrder,
  listScmPurchaseOrderCatalog,
  replaceScmPurchaseOrderCatalog
} from "../../../src/scm-purchase-order-catalog-repository.js";
import * as serverModule from "../../../src/server.js";

after(closeDb);

async function inRollback(operation) {
  const rollback = await beginRollbackContext();
  try {
    return await rollback.run(operation);
  } finally {
    await rollback.rollback();
  }
}

function catalogOrder(ref, status = "Queued", updatedAt = "2026-08-28T01:00:00.000Z") {
  return {
    id: ref,
    type: "PO",
    customer: "PO status consistency vendor",
    sourceYard: "PO status consistency yard",
    destinationYard: "3445",
    updatedAt,
    items: [{ lineRowId: 1, sku: "STATUS-CONSISTENCY-SKU", quantity: 1 }],
    scm: {
      status,
      method: "MBT",
      pickupPoint: "PO status consistency yard",
      dropoffPoint: "3445",
      updatedAt
    }
  };
}

test("delayed purchase_order status events route a stable PO ref back to the PO Split catalog", () => {
  assert.deepEqual(
    serverModule.scmPurchaseOrderCatalogRefreshRequest({
      orderType: "purchase_order",
      orderId: 972313,
      tranid: "POB03794",
      source: "netsuite-webhook-delayed-status"
    }),
    {
      orderRef: "POB03794",
      source: "netsuite-webhook-delayed-status"
    }
  );
  assert.equal(
    serverModule.scmPurchaseOrderCatalogRefreshRequest({
      orderType: "transfer_order",
      tranid: "TO-STATUS-REFRESH"
    }),
    null
  );
});

async function insertPurchaseOrder({
  id,
  ref,
  status = "B",
  statusText = "Purchase Order : Pending Receipt",
  initialStatus = "Queued"
}) {
  await query(
    `WITH inserted AS (
       INSERT INTO purchase_orders (
         netsuite_id, tranid, trandate, vendor_id, vendor, status, status_text,
         foreign_total, destination_location_id, destination_location,
         source_location_id, source_location, dispatch_vendor_yard,
         receipt_status, initial_scm_status, netsuite_active, synced_at
       ) VALUES (
         $1::bigint, $2, current_date, $1::bigint + 1,
         'PO status consistency vendor', $3, $4, 100,
         1, '3445', 15, '12441', 'PO status consistency yard',
         'not_received', $5, true, now()
       )
       RETURNING netsuite_id
     )
     INSERT INTO purchase_order_lines (
       purchase_order_id, line_id, item_id, item_name, sku, quantity, unit,
       location_id, location, pallet_qty, layer_qty, section_qty, piece_qty,
       to_plt, to_lyr, to_sec, to_pcs, netsuite_received_qty,
       netsuite_received_baseline_qty, item_weight, netsuite_active, synced_at, raw
     )
     SELECT netsuite_id, $1::bigint + 2, $1::bigint + 3,
            'PO status consistency item', 'STATUS-CONSISTENCY-SKU', 10, 'EA',
            1, '3445', 1, 0, 0, 0, 10, 0, 0, 0, 0, 0, 5,
            true, now(), '{}'::jsonb
       FROM inserted`,
    [id, ref, status, statusText, initialStatus]
  );
}

async function insertPurchaseOrderSeries({ baseId, prefix, count }) {
  await query(
    `WITH source AS (
       SELECT value,
              ($1::bigint + value)::bigint AS purchase_order_id,
              $2 || lpad(value::text, 4, '0') AS order_ref
         FROM generate_series(1, $3::int) value
     ), inserted AS (
       INSERT INTO purchase_orders (
         netsuite_id, tranid, trandate, vendor_id, vendor, status, status_text,
         foreign_total, destination_location_id, destination_location,
         source_location_id, source_location, dispatch_vendor_yard,
         receipt_status, initial_scm_status, netsuite_active, synced_at
       )
       SELECT purchase_order_id, order_ref, date '2499-01-01',
              purchase_order_id + 1000000, 'PO discovery cap vendor',
              'B', 'Purchase Order : Pending Receipt', 100,
              1, '3445', 15, '12441', 'PO discovery cap yard',
              'not_received', 'Queued', true, now()
         FROM source
       RETURNING netsuite_id
     )
     INSERT INTO purchase_order_lines (
       purchase_order_id, line_id, item_id, item_name, sku, quantity, unit,
       location_id, location, pallet_qty, layer_qty, section_qty, piece_qty,
       to_plt, to_lyr, to_sec, to_pcs, netsuite_received_qty,
       netsuite_received_baseline_qty, item_weight, netsuite_active, synced_at, raw
     )
     SELECT netsuite_id, netsuite_id + 2000000, netsuite_id + 3000000,
            'PO discovery cap item', 'PO-DISCOVERY-CAP-SKU', 10, 'EA',
            1, '3445', 1, 0, 0, 0, 10, 0, 0, 0, 0, 0, 5,
            true, now(), '{}'::jsonb
       FROM inserted`,
    [baseId, prefix, count]
  );
}

test("PO Split catalog source is not capped at 500 eligible purchase orders", async () => {
  await inRollback(async () => {
    const nonce = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
    const baseId = `81${nonce.slice(-10)}`;
    const prefix = `PO-DISCOVERY-${nonce}-`;
    await insertPurchaseOrderSeries({ baseId, prefix, count: 501 });

    const orders = await listScmPurchaseOrders({
      includeAllDiscoverable: true,
      unbounded: true
    });
    const discovered = orders.filter((order) => String(order.id || "").startsWith(prefix));

    assert.equal(discovered.length, 501);
    assert.ok(discovered.some((order) => order.id === `${prefix}0001`));
  });
});

test("PO Split discovery includes active lifecycle states and excludes both Pending Approval spellings", async () => {
  await inRollback(async () => {
    const nonce = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
    const base = Number(`82${nonce.slice(-9)}`);
    const fixtures = [
      { id: base + 10, ref: `PO-DISCOVERY-OPEN-${nonce}`, status: "B", statusText: "Purchase Order : Pending Receipt", expected: true },
      { id: base + 20, ref: `PO-DISCOVERY-BILLED-${nonce}`, status: "G", statusText: "Purchase Order : Fully Billed", expected: true },
      { id: base + 30, ref: `PO-DISCOVERY-CLOSED-${nonce}`, status: "H", statusText: "Purchase Order : Closed", expected: true },
      { id: base + 40, ref: `PO-DISCOVERY-PA-CODE-${nonce}`, status: "A", statusText: "Unexpected label", expected: false },
      { id: base + 50, ref: `PO-DISCOVERY-PA-${nonce}`, status: "B", statusText: "Purchase Order : Pending Approval", expected: false },
      { id: base + 60, ref: `PO-DISCOVERY-PSA-${nonce}`, status: "B", statusText: "Purchase Order : Pending Supervisor Approval", expected: false }
    ];
    for (const fixture of fixtures) {
      await insertPurchaseOrder(fixture);
    }

    const orders = await listScmPurchaseOrders({
      search: `PO-DISCOVERY-`,
      includeAllDiscoverable: true
    });
    const refs = new Set(orders.map((order) => order.id));

    for (const fixture of fixtures) {
      assert.equal(refs.has(fixture.ref), fixture.expected, fixture.ref);
    }
  });
});

test("background catalog rebuild indexes a POB03782-shaped Hold PO without indexing Pending Approval", async () => {
  await inRollback(async () => {
    const nonce = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
    const base = Number(`83${nonce.slice(-9)}`);
    const holdRef = `PO-HOLD-CATALOG-${nonce}`;
    const pendingRef = `PO-PENDING-CATALOG-${nonce}`;
    await insertPurchaseOrder({ id: base + 10, ref: holdRef, initialStatus: "Hold" });
    await insertPurchaseOrder({
      id: base + 20,
      ref: pendingRef,
      status: "A",
      statusText: "Purchase Order : Pending Supervisor Approval",
      initialStatus: "Hold"
    });
    await query("TRUNCATE scm_purchase_order_catalog_refresh_outbox, scm_purchase_order_catalog_entries RESTART IDENTITY");
    await enqueueScmPurchaseOrderCatalogRefresh({ source: "status-consistency-red" });

    const result = await serverModule.scmPurchaseOrderCatalogTick();
    const hold = await getScmPurchaseOrderCatalogOrder(holdRef);
    const pending = await getScmPurchaseOrderCatalogOrder(pendingRef);

    assert.equal(result.failed, 0);
    assert.ok(hold, "the active Hold PO must be indexed by the internal full refresh");
    assert.equal(hold.scm?.status, "Hold");
    assert.equal(pending, null);
  });
});

test("PO Split indexed list and detail use a newer saved Hold instead of stale catalog Queued", async () => {
  await inRollback(async () => {
    const nonce = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
    const ref = `PO-STATUS-HOLD-${nonce}`;
    await replaceScmPurchaseOrderCatalog({
      orders: [catalogOrder(ref)],
      source: "status-consistency-red"
    });
    await query(
      `INSERT INTO scm_transport_schedule (
         order_kind, order_ref, method, pickup_point, dropoff_point,
         status, updated_by, created_at, updated_at
       ) VALUES ('PO', $1, 'MBT', 'PO status consistency yard', '3445',
         'Hold', 'status-consistency-red', '2026-08-28T01:30:00.000Z',
         '2026-08-28T02:00:00.000Z')`,
      [ref]
    );

    const listed = await listScmPurchaseOrderCatalog({ search: ref });
    const detail = await getScmPurchaseOrderCatalogOrder(ref);

    assert.equal(listed.orders[0]?.scm?.status, "Hold");
    assert.equal(detail?.scm?.status, "Hold");
  });
});

test("PO Split indexed list and detail overlay the complete exact live schedule state", async () => {
  await inRollback(async () => {
    const nonce = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
    const ref = `PO-LIVE-SCHEDULE-${nonce}`;
    await replaceScmPurchaseOrderCatalog({
      orders: [{
        ...catalogOrder(ref),
        scm: {
          status: "Queued",
          method: "MBT",
          pickupPoint: "Stale catalog yard",
          dropoffPoint: "3445",
          isSpecialOrder: false,
          packingSlipRef: "STALE-PACKING",
          groupRef: "STALE-GROUP",
          etaDate: "2026-08-01",
          etaTime: "01:00",
          driver: "Stale driver",
          notes: "Stale notes",
          remarkOverride: "Stale remark",
          updatedAt: "2026-08-28T01:00:00.000000Z"
        }
      }],
      source: "live-schedule-parity-red"
    });
    await query(
      `INSERT INTO scm_transport_schedule (
         order_kind, order_ref, method, pickup_point, dropoff_point,
         is_special_order, packing_slip_ref, group_ref, status,
         eta_date, eta_time, driver, notes, remark_override,
         updated_by, created_at, updated_at
       ) VALUES (
         'PO', $1, 'Vendor', 'Live schedule yard', '12441',
         true, 'LIVE-PACKING', 'LIVE-GROUP', 'Priority',
         '2026-09-03', '14:45', 'Live driver', 'Live notes', 'Live remark',
         'live-schedule-parity-red', '2026-08-31T02:29:00.000000Z',
         '2026-08-31T02:29:33.265579Z'
       )`,
      [ref]
    );

    const listed = await listScmPurchaseOrderCatalog({ search: ref });
    const detail = await getScmPurchaseOrderCatalogOrder(ref);
    const expected = {
      status: "Priority",
      method: "Vendor",
      pickupPoint: "Live schedule yard",
      dropoffPoint: "12441",
      isSpecialOrder: true,
      packingSlipRef: "LIVE-PACKING",
      groupRef: "LIVE-GROUP",
      etaDate: "2026-09-03",
      etaTime: "14:45",
      driver: "Live driver",
      notes: "Live notes",
      remarkOverride: "Live remark",
      updatedAt: "2026-08-31T02:29:33.265579Z"
    };
    for (const [surface, order] of [["list", listed.orders[0]], ["detail", detail]]) {
      assert.ok(order, `${surface} must return the indexed PO`);
      for (const [field, value] of Object.entries(expected)) {
        assert.deepEqual(order.scm?.[field], value, `${surface} ${field} must come from the live schedule`);
      }
    }
  });
});

test("PO Split indexed list and detail resolve a saved Hold through a linked source ref", async () => {
  await inRollback(async () => {
    const nonce = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
    const sourceRef = `PO-STATUS-LINKED-SOURCE-${nonce}`;
    const displayRef = `PO# STATUS LINKED (${nonce})`;
    await replaceScmPurchaseOrderCatalog({
      orders: [{
        ...catalogOrder(displayRef),
        originalPoRef: sourceRef,
        dispatchRef: displayRef
      }],
      source: "status-consistency-red"
    });
    await query(
      `INSERT INTO scm_transport_schedule (
         order_kind, order_ref, method, pickup_point, dropoff_point,
         status, updated_by, created_at, updated_at
       ) VALUES ('PO', $1, 'MBT', 'PO status consistency yard', '3445',
         'Hold', 'status-consistency-red', '2026-08-28T01:30:00.000Z',
         '2026-08-28T02:00:00.000Z')`,
      [sourceRef]
    );

    const listed = await listScmPurchaseOrderCatalog({ search: sourceRef });
    const detail = await getScmPurchaseOrderCatalogOrder(displayRef);

    assert.equal(listed.orders[0]?.scm?.status, "Hold");
    assert.equal(detail?.scm?.status, "Hold");
  });
});

test("linked status precedence never borrows another PO identity's editable schedule revision", async () => {
  await inRollback(async () => {
    const nonce = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
    const sourceRef = `PO-LINKED-LIVE-SOURCE-${nonce}`;
    const displayRef = `PO-LINKED-LIVE-DISPLAY-${nonce}`;
    await replaceScmPurchaseOrderCatalog({
      orders: [{
        ...catalogOrder(displayRef),
        originalPoRef: sourceRef,
        dispatchRef: displayRef
      }],
      source: "live-schedule-parity-linked"
    });
    await query(
      `INSERT INTO scm_transport_schedule (
         order_kind, order_ref, method, pickup_point, dropoff_point,
         status, updated_by, created_at, updated_at
       ) VALUES
         ('PO', $1, 'Vendor', 'Display live yard', '12441', 'Queued',
          'live-schedule-parity-linked', '2026-08-31T02:30:00.000000Z',
          '2026-08-31T02:30:01.111111Z'),
         ('PO', $2, 'MBT', 'Source live yard', '3445', 'Hold',
          'live-schedule-parity-linked', '2026-08-31T02:30:00.000000Z',
          '2026-08-31T02:30:02.222222Z')`,
      [displayRef, sourceRef]
    );

    const listed = await listScmPurchaseOrderCatalog({ search: sourceRef });
    const detail = await getScmPurchaseOrderCatalogOrder(displayRef);
    for (const [surface, order] of [["list", listed.orders[0]], ["detail", detail]]) {
      assert.equal(order?.scm?.status, "Hold", `${surface} retains linked status precedence`);
      assert.equal(order?.scm?.method, "Vendor", `${surface} edits the display PO's live method`);
      assert.equal(order?.scm?.pickupPoint, "Display live yard", `${surface} edits the display PO's live route`);
      assert.equal(order?.scm?.updatedAt, "2026-08-31T02:30:01.111111Z",
        `${surface} protects the exact display PO revision, not its linked source revision`);
    }
  });
});

test("PO Split linked source Hold wins a queued display alias in shared reconciliation", async () => {
  await inRollback(async () => {
    const nonce = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
    const sourceRef = `PO-STATUS-LINKED-SOURCE-HOLD-${nonce}`;
    const displayRef = `PO# STATUS LINKED QUEUED (${nonce})`;
    const sourceId = Number(`90${nonce.slice(-10)}`);
    await replaceScmPurchaseOrderCatalog({
      orders: [{
        ...catalogOrder(displayRef),
        originalPoRef: sourceRef,
        dispatchRef: displayRef
      }],
      source: "status-consistency-red"
    });
    const reconciliation = await query(
      `INSERT INTO scm_reconciliation_order_state (
         order_kind, source_order_netsuite_id, source_order_ref,
         application_status, reconciliation_status, reconciliation_source,
         ordered_qty, remaining_qty, quantity_summary, reconciled_at
       ) VALUES (
         'PO', $1, $2, 'Partially Done', 'ok', 'manual',
         10, 10, $3::jsonb, '2026-08-28T03:00:00.000Z'
       )
       RETURNING id`,
      [
        sourceId,
        sourceRef,
        JSON.stringify({
          targets: {
            [sourceRef]: { applicationStatus: "Hold" },
            [displayRef]: { applicationStatus: "Queued" }
          }
        })
      ]
    );
    await query(
      `INSERT INTO scm_transport_schedule (
         order_kind, order_ref, method, pickup_point, dropoff_point,
         status, reconciliation_order_state_id, updated_by,
         created_at, updated_at
       ) VALUES
         ('PO', $1, 'MBT', 'PO status consistency yard', '3445',
          'Hold', $3, 'status-consistency-red',
          '2026-08-28T01:30:00.000Z', '2026-08-28T02:00:00.000Z'),
         ('PO', $2, 'MBT', 'PO status consistency yard', '3445',
          'Queued', $3, 'status-consistency-red',
          '2026-08-28T01:30:00.000Z', '2026-08-28T02:30:00.000Z')`,
      [sourceRef, displayRef, reconciliation.rows[0].id]
    );

    const listed = await listScmPurchaseOrderCatalog({ search: sourceRef });
    const detail = await getScmPurchaseOrderCatalogOrder(displayRef);

    assert.equal(listed.orders[0]?.scm?.status, "Hold");
    assert.equal(detail?.scm?.status, "Hold");
  });
});

test("PO Split new display alias inherits a linked source's nonqueued reconciliation status", async () => {
  await inRollback(async () => {
    const nonce = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
    const sourceRef = `PO-STATUS-LINKED-SOURCE-PARTIAL-${nonce}`;
    const displayRef = `PO# STATUS LINKED NEW (${nonce})`;
    const sourceId = Number(`91${nonce.slice(-10)}`);
    await replaceScmPurchaseOrderCatalog({
      orders: [{
        ...catalogOrder(displayRef),
        originalPoRef: displayRef,
        dispatchRef: displayRef,
        sourcePoRef: sourceRef
      }],
      source: "status-consistency-red"
    });
    const reconciliation = await query(
      `INSERT INTO scm_reconciliation_order_state (
         order_kind, source_order_netsuite_id, source_order_ref,
         application_status, reconciliation_status, reconciliation_source,
         ordered_qty, remaining_qty, quantity_summary, reconciled_at
       ) VALUES (
         'PO', $1, $2, 'Partially Done', 'ok', 'manual',
         10, 5, $3::jsonb, '2026-08-28T03:00:00.000Z'
       )
       RETURNING id`,
      [
        sourceId,
        sourceRef,
        JSON.stringify({
          targets: {
            [sourceRef]: { applicationStatus: "Partially Done" }
          }
        })
      ]
    );
    await query(
      `INSERT INTO scm_transport_schedule (
         order_kind, order_ref, method, pickup_point, dropoff_point,
         status, reconciliation_order_state_id, updated_by,
         created_at, updated_at
       ) VALUES
         ('PO', $1, 'MBT', 'PO status consistency yard', '3445',
          'Hold', $3, 'status-consistency-red',
          '2026-08-28T01:30:00.000Z', '2026-08-28T02:00:00.000Z'),
         ('PO', $2, 'MBT', 'PO status consistency yard', '3445',
          'Queued', NULL, 'status-consistency-red',
          '2026-08-28T01:30:00.000Z', '2026-08-28T02:30:00.000Z')`,
      [sourceRef, displayRef, reconciliation.rows[0].id]
    );

    const listed = await listScmPurchaseOrderCatalog({ search: sourceRef });
    const detail = await getScmPurchaseOrderCatalogOrder(displayRef);

    assert.equal(listed.orders[0]?.scm?.status, "Partially Done");
    assert.equal(detail?.scm?.status, "Partially Done");
  });
});

test("manual split exact Queued status does not inherit its linked parent's Partially Done status", async () => {
  await inRollback(async () => {
    const nonce = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
    const sourceRef = `PO-MANUAL-SPLIT-SOURCE-PARTIAL-${nonce}`;
    const childRef = `SN-MANUAL-SPLIT-QUEUED-${nonce}`;
    const sourceId = Number(`94${nonce.slice(-10)}`);
    await insertPurchaseOrder({
      id: sourceId,
      ref: sourceRef,
      initialStatus: "Hold"
    });
    const sourceLine = await query(
      "SELECT id FROM purchase_order_lines WHERE purchase_order_id = $1",
      [sourceId]
    );
    await createScmPurchaseOrderSplit({
      sourcePoRef: sourceRef,
      newPoRef: childRef,
      destinationLocationId: 15,
      status: "Queued",
      lines: [{ lineRowId: sourceLine.rows[0].id, pallets: 1 }],
      createdBy: "status-consistency-red"
    });
    await replaceScmPurchaseOrderCatalog({
      orders: [{
        ...catalogOrder(childRef),
        isScmSplit: true,
        originalPoRef: childRef,
        dispatchRef: childRef,
        sourcePoRef: sourceRef
      }],
      source: "status-consistency-red"
    });
    const reconciliation = await query(
      `INSERT INTO scm_reconciliation_order_state (
         order_kind, source_order_netsuite_id, source_order_ref,
         application_status, reconciliation_status, reconciliation_source,
         ordered_qty, remaining_qty, quantity_summary, reconciled_at
       ) VALUES (
         'PO', $1, $2, 'Partially Done', 'ok', 'manual',
         10, 5, $3::jsonb, '2026-08-31T20:58:49.455323Z'
       ) RETURNING id`,
      [
        sourceId,
        sourceRef,
        JSON.stringify({
          targets: {
            [sourceRef]: { applicationStatus: "Partially Done" },
            [childRef]: { applicationStatus: "Queued" }
          }
        })
      ]
    );
    await query(
      `INSERT INTO scm_transport_schedule (
         order_kind, order_ref, method, pickup_point, dropoff_point,
         status, reconciliation_order_state_id, updated_by, created_at, updated_at
       ) VALUES (
         'PO', $1, 'MBT', 'PO status consistency yard', '3445',
         'Planned', $2, 'status-consistency-red',
         '2026-08-31T20:54:31.000000Z', '2026-08-31T20:54:32.000000Z'
       )`,
      [sourceRef, reconciliation.rows[0].id]
    );
    const listed = await listScmPurchaseOrderCatalog({ search: sourceRef });
    const detail = await getScmPurchaseOrderCatalogOrder(childRef);
    const [schedule] = await listScmSchedule({ kind: "PO", exactRef: childRef });

    assert.equal(schedule?.calculatedStatus, "Queued");
    assert.equal(listed.orders[0]?.isScmSplit, true);
    assert.equal(listed.orders[0]?.scm?.status, schedule?.calculatedStatus);
    assert.equal(detail?.scm?.status, schedule?.calculatedStatus);
  });
});

test("active planned manual split does not inherit its reconciliation Partially Done status", async () => {
  await inRollback(async () => {
    const nonce = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
    const sourceRef = `PO-MANUAL-SPLIT-SOURCE-PLANNED-${nonce}`;
    const childRef = `SN-MANUAL-SPLIT-PLANNED-${nonce}`;
    const sourceId = Number(`93${nonce.slice(-10)}`);
    await insertPurchaseOrder({ id: sourceId, ref: sourceRef, initialStatus: "Hold" });
    const sourceLine = await query(
      "SELECT id FROM purchase_order_lines WHERE purchase_order_id = $1",
      [sourceId]
    );
    await createScmPurchaseOrderSplit({
      sourcePoRef: sourceRef,
      newPoRef: childRef,
      destinationLocationId: 15,
      status: "Hold",
      lines: [{ lineRowId: sourceLine.rows[0].id, pallets: 1 }],
      createdBy: "status-consistency-red"
    });
    await replaceScmPurchaseOrderCatalog({
      orders: [{
        ...catalogOrder(childRef),
        isScmSplit: true,
        originalPoRef: childRef,
        dispatchRef: childRef,
        sourcePoRef: sourceRef
      }],
      source: "status-consistency-red"
    });
    const reconciliation = await query(
      `INSERT INTO scm_reconciliation_order_state (
         order_kind, source_order_netsuite_id, source_order_ref,
         application_status, reconciliation_status, reconciliation_source,
         ordered_qty, received_qty, remaining_qty, quantity_summary, reconciled_at
       ) VALUES (
         'PO', $1, $2, 'Partially Done', 'current', 'backfill',
         10, 5, 5, $3::jsonb, now()
       ) RETURNING id`,
      [
        sourceId,
        sourceRef,
        JSON.stringify({
          targets: {
            [sourceRef]: { applicationStatus: "Partially Done" },
            [childRef]: {
              targetKind: "po_split",
              applicationStatus: "Partially Done",
              hasActivePlan: true
            }
          }
        })
      ]
    );
    await query(
      `UPDATE scm_transport_schedule
          SET status = 'Planned',
              reconciliation_order_state_id = $2,
              updated_at = now() - interval '1 minute'
        WHERE order_kind = 'PO' AND lower(order_ref) = lower($1)`,
      [childRef, reconciliation.rows[0].id]
    );
    const plan = await query(
      `INSERT INTO dispatch_plans (plan_date, status, note, revision)
       VALUES ('2399-12-30', 'draft', 'Planned split projection fixture', 1)
       RETURNING id`
    );
    await query(
      `INSERT INTO dispatch_plan_order_assignments (
         plan_id, plan_date, order_ref, planned_order_ref, assignment_kind,
         load_id, stop_id, assignment
       ) VALUES (
         $1, '2399-12-30', $2, $2, 'direct',
         'PLANNED-SPLIT-PROJECTION-LOAD', 'PLANNED-SPLIT-PROJECTION-STOP', $3::jsonb
       )`,
      [
        plan.rows[0].id,
        childRef,
        JSON.stringify({ dispatchPlanned: true, dispatchOrderKind: "PO" })
      ]
    );

    const listed = await listScmPurchaseOrderCatalog({ search: childRef });
    const detail = await getScmPurchaseOrderCatalogOrder(childRef);
    const [schedule] = await listScmSchedule({ kind: "PO", exactRef: childRef });
    assert.equal(schedule?.calculatedStatus, "Planned");
    assert.equal(listed.orders[0]?.scm?.status, "Planned");
    assert.equal(detail?.scm?.status, "Planned");
  });
});

test("PO Split new display alias inherits a linked source's initial Hold when the alias is only Queued", async () => {
  await inRollback(async () => {
    const nonce = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
    const sourceRef = `PO-STATUS-LINKED-SOURCE-INITIAL-HOLD-${nonce}`;
    const displayRef = `PO-STATUS-LINKED-INITIAL-HOLD-${nonce}`;
    const sourceId = Number(`92${nonce.slice(-10)}`);
    await insertPurchaseOrder({
      id: sourceId,
      ref: sourceRef,
      initialStatus: "Hold"
    });
    await query(
      "UPDATE purchase_orders SET dispatch_ref = $2 WHERE netsuite_id = $1",
      [sourceId, displayRef]
    );
    await replaceScmPurchaseOrderCatalog({
      orders: [{
        ...catalogOrder(displayRef),
        originalPoRef: sourceRef,
        dispatchRef: displayRef
      }],
      source: "status-consistency-red"
    });
    await query(
      `INSERT INTO scm_transport_schedule (
         order_kind, order_ref, method, pickup_point, dropoff_point,
         status, updated_by, created_at, updated_at
       ) VALUES (
         'PO', $1, 'MBT', 'PO status consistency yard', '3445',
         'Queued', 'status-consistency-red',
         '2026-08-28T01:30:00.000Z', '2026-08-28T02:30:00.000Z'
       )`,
      [displayRef]
    );

    const listed = await listScmPurchaseOrderCatalog({ search: sourceRef });
    const detail = await getScmPurchaseOrderCatalogOrder(displayRef);

    assert.equal(listed.orders[0]?.scm?.status, "Hold");
    assert.equal(detail?.scm?.status, "Hold");
  });
});

test("PO Split uses an exact Planned schedule instead of a linked source's initial Hold", async () => {
  await inRollback(async () => {
    const nonce = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
    const sourceRef = `PO-STATUS-LINKED-SOURCE-PLANNED-${nonce}`;
    const displayRef = `PO-STATUS-LINKED-PLANNED-${nonce}`;
    const sourceId = Number(`93${nonce.slice(-10)}`);
    await insertPurchaseOrder({
      id: sourceId,
      ref: sourceRef,
      initialStatus: "Hold"
    });
    await query(
      "UPDATE purchase_orders SET dispatch_ref = $2 WHERE netsuite_id = $1",
      [sourceId, displayRef]
    );
    await replaceScmPurchaseOrderCatalog({
      orders: [{
        ...catalogOrder(displayRef),
        originalPoRef: sourceRef,
        dispatchRef: displayRef
      }],
      source: "status-consistency-red"
    });
    await query(
      `INSERT INTO scm_transport_schedule (
         order_kind, order_ref, method, pickup_point, dropoff_point,
         status, updated_by, created_at, updated_at
       ) VALUES (
         'PO', $1, 'MBT', 'PO status consistency yard', '3445',
         'Planned', 'status-consistency-red',
         '2026-08-31T02:29:00.000000Z', '2026-08-31T02:29:33.265579Z'
       )`,
      [displayRef]
    );

    const listed = await listScmPurchaseOrderCatalog({ search: sourceRef });
    const detail = await getScmPurchaseOrderCatalogOrder(displayRef);
    const [schedule] = await listScmSchedule({ kind: "PO", exactRef: displayRef });

    assert.equal(schedule?.calculatedStatus, "Planned");
    assert.equal(listed.orders[0]?.scm?.status, schedule?.calculatedStatus);
    assert.equal(detail?.scm?.status, schedule?.calculatedStatus);
  });
});

test("PO Split uses PO/TO Schedule assignment fallbacks for live planning details", async () => {
  await inRollback(async () => {
    const nonce = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
    const id = `94${nonce.slice(-11)}`;
    const ref = `PO-SCHEDULE-ASSIGNMENT-${nonce}`;
    await insertPurchaseOrder({ id, ref });
    await replaceScmPurchaseOrderCatalog({
      orders: [catalogOrder(ref)],
      source: "status-consistency-red"
    });
    await query(
      `INSERT INTO scm_transport_schedule (
         order_kind, order_ref, method, pickup_point, dropoff_point,
         status, eta_date, eta_time, driver, notes, updated_by,
         created_at, updated_at
       ) VALUES (
         'PO', $1, 'MBT', 'PO status consistency yard', '3445',
         'Planned', NULL, '', '', '', 'status-consistency-red',
         '2026-08-31T03:00:00.000000Z', '2026-08-31T03:00:01.123456Z'
       )`,
      [ref]
    );
    const plan = await query(
      `INSERT INTO dispatch_plans (plan_date, status, note, revision)
       VALUES ('2399-12-30', 'draft', 'PO Split schedule parity fixture', 1)
       RETURNING id`
    );
    await query(
      `INSERT INTO dispatch_plan_order_assignments (
         plan_id, plan_date, order_ref, planned_order_ref, assignment_kind,
         load_id, stop_id, assignment
       ) VALUES (
         $1, '2399-12-30', $2, $2, 'direct',
         'PO-SCHEDULE-ASSIGNMENT-LOAD', 'PO-SCHEDULE-ASSIGNMENT-DROP', $3::jsonb
       )`,
      [
        plan.rows[0].id,
        ref,
        JSON.stringify({
          dispatchPlanned: true,
          dispatchOrderKind: "PO",
          dispatchEtaTime: "13:57",
          dispatchDriverName: "Projection Driver",
          dispatchTruckPlate: "LIVE-302",
          dispatchLoadName: "Load 2",
          dispatchParkingSpot: "P7"
        })
      ]
    );

    const listed = await listScmPurchaseOrderCatalog({ search: ref });
    const detail = await getScmPurchaseOrderCatalogOrder(ref);
    const [schedule] = await listScmSchedule({ kind: "PO", exactRef: ref });

    for (const [surface, order] of [["list", listed.orders[0]], ["detail", detail]]) {
      assert.equal(order?.scm?.status, schedule?.calculatedStatus, `${surface} status`);
      assert.equal(order?.scm?.etaDate, schedule?.etaDate, `${surface} ETA date`);
      assert.equal(order?.scm?.etaTime, schedule?.etaTime, `${surface} ETA time`);
      assert.equal(order?.scm?.driver, schedule?.driver, `${surface} driver`);
      assert.equal(order?.scm?.notes, schedule?.notes, `${surface} planning notes`);
    }
  });
});

test("PO Split status agrees with PO/TO Schedule after a saved Queued-to-Hold change", async () => {
  await inRollback(async () => {
    const nonce = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
    const id = `87${nonce.slice(-11)}`;
    const ref = `PO-STATUS-AGREE-${nonce}`;
    await insertPurchaseOrder({ id, ref });
    await replaceScmPurchaseOrderCatalog({
      orders: [catalogOrder(ref)],
      source: "status-consistency-red"
    });
    await query(
      `INSERT INTO scm_transport_schedule (
         order_kind, order_ref, method, pickup_point, dropoff_point,
         status, updated_by, created_at, updated_at
       ) VALUES ('PO', $1, 'MBT', 'PO status consistency yard', '3445',
         'Hold', 'status-consistency-red', now() - interval '2 minutes', now())`,
      [ref]
    );

    const catalog = await listScmPurchaseOrderCatalog({ search: ref });
    const schedule = await listScmSchedule({ exactRef: ref, status: ["Hold"] });

    assert.equal(schedule[0]?.calculatedStatus, "Hold");
    assert.equal(catalog.orders[0]?.scm?.status, schedule[0]?.calculatedStatus);
  });
});

test("role-filtered PO Split search uses live status in both Hold transition directions", async () => {
  await inRollback(async () => {
    const nonce = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
    const releasedRef = `PO-STATUS-RELEASED-${nonce}`;
    const heldRef = `PO-STATUS-HELD-${nonce}`;
    await replaceScmPurchaseOrderCatalog({
      orders: [
        catalogOrder(releasedRef, "Hold"),
        catalogOrder(heldRef, "Queued")
      ],
      source: "status-consistency-red"
    });
    await query(
      `INSERT INTO scm_transport_schedule (
         order_kind, order_ref, method, pickup_point, dropoff_point,
         status, updated_by, created_at, updated_at
       ) VALUES
         ('PO', $1, 'MBT', 'PO status consistency yard', '3445',
          'Queued', 'status-consistency-red', now() - interval '2 minutes', now()),
         ('PO', $2, 'MBT', 'PO status consistency yard', '3445',
          'Hold', 'status-consistency-red', now() - interval '2 minutes', now())`,
      [releasedRef, heldRef]
    );

    const releasedList = await listScmPurchaseOrderCatalog({
      search: releasedRef,
      includeRestricted: false
    });
    const releasedDetail = await getScmPurchaseOrderCatalogOrder(releasedRef, {
      includeRestricted: false
    });
    const heldList = await listScmPurchaseOrderCatalog({
      search: heldRef,
      includeRestricted: false
    });
    const heldDetail = await getScmPurchaseOrderCatalogOrder(heldRef, {
      includeRestricted: false
    });

    assert.equal(releasedList.orders[0]?.scm?.status, "Queued");
    assert.equal(releasedDetail?.scm?.status, "Queued");
    assert.deepEqual(heldList.orders, []);
    assert.equal(heldDetail, null);
  });
});

test("PO Split live status finds terminal and review reconciliation evidence without a schedule pointer", async () => {
  await inRollback(async () => {
    const nonce = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
    const completedRef = `PO-STATUS-RECON-COMPLETE-${nonce}`;
    const reviewRef = `PO-STATUS-RECON-REVIEW-${nonce}`;
    const baseId = Number(`89${nonce.slice(-10)}`);
    await replaceScmPurchaseOrderCatalog({
      orders: [catalogOrder(completedRef), catalogOrder(reviewRef)],
      source: "status-consistency-red"
    });
    await query(
      `INSERT INTO scm_transport_schedule (
         order_kind, order_ref, method, pickup_point, dropoff_point,
         status, updated_by, created_at, updated_at
       ) VALUES
         ('PO', $1, 'MBT', 'PO status consistency yard', '3445',
          'Queued', 'status-consistency-red', now() - interval '2 minutes', now()),
         ('PO', $2, 'MBT', 'PO status consistency yard', '3445',
          'Queued', 'status-consistency-red', now() - interval '2 minutes', now())`,
      [completedRef, reviewRef]
    );
    await query(
      `INSERT INTO scm_reconciliation_order_state (
         order_kind, source_order_netsuite_id, source_order_ref,
         application_status, reconciliation_status, reconciliation_source,
         ordered_qty, remaining_qty, quantity_summary, reconciled_at
       ) VALUES
         ('PO', $1, $2, 'Completed', 'ok', 'manual',
          10, 0, $3::jsonb, now() - interval '10 minutes'),
         ('PO', $4, $5, 'Queued', 'review', 'manual',
          10, 10, $6::jsonb, now() - interval '10 minutes')`,
      [
        baseId + 1,
        completedRef,
        JSON.stringify({ targets: { [completedRef]: { applicationStatus: "Completed" } } }),
        baseId + 2,
        reviewRef,
        JSON.stringify({ targets: { [reviewRef]: { applicationStatus: "Reconcile Review" } } })
      ]
    );

    const completed = await getScmPurchaseOrderCatalogOrder(completedRef);
    const review = await getScmPurchaseOrderCatalogOrder(reviewRef);

    assert.equal(completed?.scm?.status, "Completed");
    assert.equal(review?.scm?.status, "Reconcile Review");
  });
});

test("role filtering scans past restricted catalog rows without starving visible pagination", async () => {
  await inRollback(async () => {
    const nonce = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
    const restricted = Array.from({ length: 60 }, (_, index) => catalogOrder(
      `PO-PAGE-HOLD-${nonce}-${index}`,
      "Hold",
      new Date(Date.UTC(2026, 8, 2, 0, index)).toISOString()
    ));
    const visible = Array.from({ length: 55 }, (_, index) => catalogOrder(
      `PO-PAGE-QUEUED-${nonce}-${index}`,
      "Queued",
      new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString()
    ));
    await replaceScmPurchaseOrderCatalog({
      orders: [...restricted, ...visible],
      source: "status-consistency-red"
    });

    const first = await listScmPurchaseOrderCatalog({
      includeRestricted: false,
      limit: 50
    });
    const second = await listScmPurchaseOrderCatalog({
      includeRestricted: false,
      limit: 50,
      cursor: first.nextCursor
    });
    const orders = [...first.orders, ...second.orders];

    assert.equal(first.orders.length, 50);
    assert.ok(first.nextCursor);
    assert.equal(second.orders.length, 5);
    assert.equal(second.nextCursor, "");
    assert.equal(new Set(orders.map((order) => order.id)).size, 55);
    assert.ok(orders.every((order) => order.scm?.status === "Queued"));
  });
});
