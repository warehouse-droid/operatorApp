import assert from "node:assert/strict";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import {
  createScmPurchaseOrderSplit,
  listScmSchedule,
  updatePurchaseOrderDispatchRef,
  updateScmScheduleEntry
} from "../../../src/dispatch-repository.js";

after(closeDb);

const seed = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const baseId = 8_820_000_000_000 + Number(seed.slice(-9)) * 10;
const refPrefix = `SCM-STATUS-${seed}`;

async function seedPurchaseOrder(suffix) {
  const purchaseOrderId = baseId + suffix;
  const purchaseOrderRef = `${refPrefix}-PO-${suffix}`;
  const line = await query(
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
    lineRowId: line.rows[0].id
  };
}

async function scheduleRevision(orderRef) {
  const result = await query(
    `SELECT status, updated_at
       FROM scm_transport_schedule
      WHERE order_kind = 'PO' AND lower(order_ref) = lower($1)`,
    [orderRef]
  );
  assert.equal(result.rowCount, 1);
  return result.rows[0];
}

function staleScheduleError(error) {
  assert.equal(error?.status, 409);
  assert.equal(error?.code, "SCM_SCHEDULE_STALE");
  return true;
}

test("a loaded schedule revision rejects stale status overwrites and allows a refreshed retry", async () => {
  const source = await seedPurchaseOrder(1);
  await updateScmScheduleEntry({
    orderKind: "PO",
    orderRef: source.purchaseOrderRef,
    patch: { status: "Queued" },
    updatedBy: "status-concurrency-initial"
  });
  await query(
    `UPDATE scm_transport_schedule
        SET updated_at = clock_timestamp() - interval '5 seconds'
      WHERE order_kind = 'PO' AND order_ref = $1`,
    [source.purchaseOrderRef]
  );
  const loaded = await scheduleRevision(source.purchaseOrderRef);

  await updateScmScheduleEntry({
    orderKind: "PO",
    orderRef: source.purchaseOrderRef,
    patch: { status: "Hold" },
    expectedUpdatedAt: loaded.updated_at,
    updatedBy: "status-concurrency-newer"
  });
  await assert.rejects(
    updateScmScheduleEntry({
      orderKind: "PO",
      orderRef: source.purchaseOrderRef,
      patch: { status: "Queued" },
      expectedUpdatedAt: loaded.updated_at,
      updatedBy: "status-concurrency-stale"
    }),
    staleScheduleError
  );
  const protectedRow = await scheduleRevision(source.purchaseOrderRef);
  assert.equal(protectedRow.status, "Hold", "the stale Queued save must not replace the newer Hold status");

  await updateScmScheduleEntry({
    orderKind: "PO",
    orderRef: source.purchaseOrderRef,
    patch: { status: "Priority" },
    expectedUpdatedAt: protectedRow.updated_at,
    updatedBy: "status-concurrency-refreshed"
  });
  const refreshed = await listScmSchedule({ exactRef: source.purchaseOrderRef });
  assert.equal(refreshed.find((row) => row.orderRef === source.purchaseOrderRef)?.status, "Priority");
});

test("an unchanged PO reference cannot regress the committed schedule revision", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const source = await seedPurchaseOrder(21);
      const visibleRef = `${refPrefix}-VISIBLE-21`;
      await updatePurchaseOrderDispatchRef({
        poRef: source.purchaseOrderRef,
        newRef: visibleRef,
        updatedBy: "schedule-revision-setup"
      });
      await updateScmScheduleEntry({
        orderKind: "PO",
        orderRef: visibleRef,
        patch: { status: "Queued", packingSlipRef: visibleRef },
        updatedBy: "schedule-revision-initial"
      });
      const loaded = await scheduleRevision(visibleRef);

      const saved = await updateScmScheduleEntry({
        orderKind: "PO",
        orderRef: visibleRef,
        patch: { status: "Priority", packingSlipRef: visibleRef },
        expectedUpdatedAt: loaded.updated_at,
        updatedBy: "schedule-revision-save"
      });
      const committed = await scheduleRevision(visibleRef);

      assert.equal(committed.status, "Priority");
      assert.equal(new Date(committed.updated_at).toISOString(), new Date(saved.updated_at).toISOString(),
        "the revision returned by Save must be the revision that actually committed");
      assert.ok(new Date(committed.updated_at).getTime() > new Date(loaded.updated_at).getTime(),
        "a successful Save must advance the stored revision");

      await updateScmScheduleEntry({
        orderKind: "PO",
        orderRef: visibleRef,
        patch: { status: "Urgent", packingSlipRef: visibleRef },
        expectedUpdatedAt: saved.updated_at,
        updatedBy: "schedule-revision-follow-up"
      });
      assert.equal((await scheduleRevision(visibleRef)).status, "Urgent",
        "the revision returned by one Save must be accepted by the next Save");
    });
  } finally {
    await rollback.rollback();
  }
});

test("a changed PO reference returns the final renamed monotonic schedule revision", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const source = await seedPurchaseOrder(22);
      const firstVisibleRef = `${refPrefix}-VISIBLE-22-A`;
      const nextVisibleRef = `${refPrefix}-VISIBLE-22-B`;
      await updatePurchaseOrderDispatchRef({
        poRef: source.purchaseOrderRef,
        newRef: firstVisibleRef,
        updatedBy: "schedule-rename-revision-setup"
      });
      await updateScmScheduleEntry({
        orderKind: "PO",
        orderRef: firstVisibleRef,
        patch: { status: "Queued", packingSlipRef: firstVisibleRef },
        updatedBy: "schedule-rename-revision-initial"
      });
      const loaded = await scheduleRevision(firstVisibleRef);

      const saved = await updateScmScheduleEntry({
        orderKind: "PO",
        orderRef: firstVisibleRef,
        patch: { status: "Priority", packingSlipRef: nextVisibleRef },
        expectedUpdatedAt: loaded.updated_at,
        updatedBy: "schedule-rename-revision-save"
      });
      const committed = await scheduleRevision(nextVisibleRef);

      assert.equal(saved.order_ref, nextVisibleRef,
        "Save must return the final identity after Packing Slip / Ref renames the PO");
      assert.equal(committed.status, "Priority");
      assert.equal(new Date(committed.updated_at).toISOString(), new Date(saved.updated_at).toISOString());
      assert.ok(new Date(committed.updated_at).getTime() > new Date(loaded.updated_at).getTime(),
        "the nested reference synchronization must not reset the schedule to transaction start time");

      await updateScmScheduleEntry({
        orderKind: "PO",
        orderRef: nextVisibleRef,
        patch: { status: "Urgent", packingSlipRef: nextVisibleRef },
        expectedUpdatedAt: saved.updated_at,
        updatedBy: "schedule-rename-revision-follow-up"
      });
      assert.equal((await scheduleRevision(nextVisibleRef)).status, "Urgent");
    });
  } finally {
    await rollback.rollback();
  }
});

test("two status saves from one revision cannot both commit", async () => {
  const source = await seedPurchaseOrder(2);
  await updateScmScheduleEntry({
    orderKind: "PO",
    orderRef: source.purchaseOrderRef,
    patch: { status: "Queued" },
    updatedBy: "status-race-initial"
  });
  await query(
    `UPDATE scm_transport_schedule
        SET updated_at = clock_timestamp() - interval '5 seconds'
      WHERE order_kind = 'PO' AND order_ref = $1`,
    [source.purchaseOrderRef]
  );
  const loaded = await scheduleRevision(source.purchaseOrderRef);
  const outcomes = await Promise.allSettled([
    updateScmScheduleEntry({
      orderKind: "PO",
      orderRef: source.purchaseOrderRef,
      patch: { status: "Urgent" },
      expectedUpdatedAt: loaded.updated_at,
      updatedBy: "status-race-urgent"
    }),
    updateScmScheduleEntry({
      orderKind: "PO",
      orderRef: source.purchaseOrderRef,
      patch: { status: "Hold" },
      expectedUpdatedAt: loaded.updated_at,
      updatedBy: "status-race-hold"
    })
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
  const rejected = outcomes.find((outcome) => outcome.status === "rejected");
  assert.ok(rejected && staleScheduleError(rejected.reason));
  const stored = await scheduleRevision(source.purchaseOrderRef);
  assert.ok(["Urgent", "Hold"].includes(stored.status));
});

test("only one browser can create a previously absent schedule revision", async () => {
  const source = await seedPurchaseOrder(3);
  const outcomes = await Promise.allSettled([
    updateScmScheduleEntry({
      orderKind: "PO",
      orderRef: source.purchaseOrderRef,
      patch: { status: "Priority" },
      expectedUpdatedAt: null,
      updatedBy: "status-create-priority"
    }),
    updateScmScheduleEntry({
      orderKind: "PO",
      orderRef: source.purchaseOrderRef,
      patch: { status: "Hold" },
      expectedUpdatedAt: null,
      updatedBy: "status-create-hold"
    })
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
  const rejected = outcomes.find((outcome) => outcome.status === "rejected");
  assert.ok(rejected && staleScheduleError(rejected.reason));
  const rows = await query(
    `SELECT status FROM scm_transport_schedule
      WHERE order_kind = 'PO' AND lower(order_ref) = lower($1)`,
    [source.purchaseOrderRef]
  );
  assert.equal(rows.rowCount, 1);
  assert.ok(["Priority", "Hold"].includes(rows.rows[0].status));
});

test("an active split ref fills only a blank packing-slip value", async () => {
  const source = await seedPurchaseOrder(4);
  const splitRef = `${refPrefix}-SPLIT-4`;
  const created = await createScmPurchaseOrderSplit({
    sourcePoRef: source.purchaseOrderRef,
    newPoRef: splitRef,
    destinationLocationId: 1,
    lines: [{ lineRowId: source.lineRowId, pallets: 4 }],
    createdBy: "packing-slip-fallback"
  });
  await updatePurchaseOrderDispatchRef({
    poRef: splitRef,
    newRef: splitRef,
    updatedBy: "packing-slip-fallback"
  });

  let rows = await listScmSchedule({ exactRef: splitRef });
  const splitRow = rows.find((row) => String(row.sourceId) === String(created.split.splitPoId));
  assert.ok(splitRow);
  assert.equal(splitRow.sourceRef, source.purchaseOrderRef);
  assert.equal(splitRow.orderRef, splitRef);
  assert.equal(splitRow.dispatchRef, "");
  assert.equal(splitRow.packingSlipRef, splitRef,
    "the active split identity shown under Order Number must also fill a blank Packing Slip / Ref");

  await query(
    `UPDATE scm_transport_schedule
        SET packing_slip_ref = 'VENDOR-PACKING-OVERRIDE', updated_at = now()
      WHERE order_kind = 'PO' AND lower(order_ref) = lower($1)`,
    [splitRef]
  );
  rows = await listScmSchedule({ exactRef: splitRef });
  assert.equal(rows.find((row) => String(row.sourceId) === String(created.split.splitPoId))?.packingSlipRef,
    "VENDOR-PACKING-OVERRIDE", "a real entered packing slip must win over the split fallback");

  const ordinary = await listScmSchedule({ exactRef: source.purchaseOrderRef });
  assert.equal(ordinary.find((row) => String(row.sourceId) === String(source.purchaseOrderId))?.packingSlipRef, "",
    "an ordinary PO must not invent its order number as a packing slip");
});

test("every manual schedule status round-trips under a fresh revision", async () => {
  const source = await seedPurchaseOrder(5);
  await updateScmScheduleEntry({
    orderKind: "PO",
    orderRef: source.purchaseOrderRef,
    patch: { status: "Queued" },
    updatedBy: "status-roundtrip-initial"
  });
  const statuses = ["Queued", "Urgent", "Cancelled", "Hold", "Priority", "Surplus Only", "Book Appt"];
  for (const status of statuses) {
    const revision = await scheduleRevision(source.purchaseOrderRef);
    await updateScmScheduleEntry({
      orderKind: "PO",
      orderRef: source.purchaseOrderRef,
      patch: { status },
      expectedUpdatedAt: revision.updated_at,
      updatedBy: `status-roundtrip-${status}`
    });
    assert.equal((await scheduleRevision(source.purchaseOrderRef)).status, status);
  }
});

test("null or malformed existing revisions fail closed without changing any column", async () => {
  const source = await seedPurchaseOrder(6);
  await updateScmScheduleEntry({
    orderKind: "PO",
    orderRef: source.purchaseOrderRef,
    patch: { status: "Priority", method: "Vendor", notes: "protected" },
    updatedBy: "status-hostile-initial"
  });
  const before = await query(
    `SELECT status, method, notes, updated_by, updated_at
       FROM scm_transport_schedule
      WHERE order_kind = 'PO' AND order_ref = $1`,
    [source.purchaseOrderRef]
  );
  for (const expectedUpdatedAt of [null, "not-a-timestamp", "999999999999999999999999"] ) {
    await assert.rejects(
      updateScmScheduleEntry({
        orderKind: "PO",
        orderRef: source.purchaseOrderRef,
        patch: { status: "Queued", method: "MBT", notes: "hostile overwrite" },
        expectedUpdatedAt,
        updatedBy: "status-hostile-stale"
      }),
      staleScheduleError
    );
  }
  const afterAttempt = await query(
    `SELECT status, method, notes, updated_by, updated_at
       FROM scm_transport_schedule
      WHERE order_kind = 'PO' AND order_ref = $1`,
    [source.purchaseOrderRef]
  );
  assert.deepEqual(afterAttempt.rows[0], before.rows[0]);
});
