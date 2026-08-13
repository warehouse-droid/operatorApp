import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import {
  cancelSalesStockRequest,
  claimStockTransferConfirmation,
  claimStockTransferPrint,
  completeStockTransferPrint,
  convertSalesStockRequestLines,
  createSalesStockRequest,
  decideSalesStockRequestLines,
  failStockTransferConfirmation,
  getSalesStockRequest,
  getScmStockRequest,
  getStockRequestItemAvailability,
  getStockTransfer,
  listScmStockRequests,
  listSalesStockRequests,
  listStockRequestFilterOptions,
  reconcileStockRequestTransferWebhook,
  recordStockRequestEvent,
  recordStockTransferApproved,
  recordStockTransferRemote,
  recordStockTransferRevisionResult,
  resubmitSalesStockRequest,
  reviseStockTransferQuantities,
  searchStockRequestItems,
  updateScmStockRequestLine,
  updateSalesStockRequest
} from "../../../src/stock-request-repository.js";
import * as stockRequestRepository from "../../../src/stock-request-repository.js";

after(closeDb);

const seed = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const baseId = 9_600_000_000_000 + Number(seed.slice(-8)) * 100;
const actor = `stock-request-${seed}`;
const itemIds = { paver: baseId + 1, loose: baseId + 2 };

function conversionLine(overrides = {}) {
  return {
    itemId: itemIds.paver,
    sourceLocationId: 28,
    pallets: 1,
    layers: 0,
    sections: 0,
    pieces: 0,
    ...overrides
  };
}

async function createConvertedTransfer(line = conversionLine({ pallets: 0, pieces: 5 })) {
  const request = await createSalesStockRequest({
    destinationLocationId: 1,
    lines: [line]
  }, { operatorId: actor, authorizedDestinationLocationIds: [1] });
  const converted = await convertSalesStockRequestLines(request.id, {
    expectedRevision: request.revision,
    lineIds: [request.lines[0].id]
  }, { operatorId: actor });
  return { request: converted.request, transfer: converted.transfers[0] };
}

before(async () => {
  await query(
    `INSERT INTO operators (
       id, username, display_name, password_hash, password_salt, role, roles, active
     ) VALUES ($1,$1,$1,'harness','harness','sales',ARRAY['sales']::text[],true)`,
    [actor]
  );
  await query(
    `INSERT INTO inventory_items (
       item_id, item_name, display_name, item_description, stock_unit,
       to_plt, to_lyr, to_sec, to_pcs
     ) VALUES
       ($1,$2,$2,'Stock request converted fixture','EA',10,5,2,1),
       ($3,$4,$4,'Stock request sales-unit fixture','SQ FT',NULL,NULL,NULL,NULL)`,
    [itemIds.paver, `STOCK-REQ-PAVER-${seed}`, itemIds.loose, `STOCK-REQ-LOOSE-${seed}`]
  );
  for (const locationId of [1, 28, 15, 26]) {
    await query(
      `INSERT INTO inventory_balances (
         item_id, location_id, location, quantity_on_hand, quantity_available, synced_at
       ) VALUES
         ($1,$2,$3,100,100,now()),
         ($4,$2,$3,100,100,now())`,
      [itemIds.paver, locationId, String(locationId), itemIds.loose]
    );
  }
  await query(
    `UPDATE inventory_items
        SET vendor = CASE WHEN item_id = $1 THEN $3 ELSE $4 END
      WHERE item_id IN ($1, $2)`,
    [itemIds.paver, itemIds.loose, `Vendor Paver ${seed}`, `Vendor Loose ${seed}`]
  );
});

test("Private Sales creates a yard-scoped multi-line request without reserving inventory", async () => {
  const created = await createSalesStockRequest({
    destinationLocationId: 1,
    lines: [
      conversionLine(),
      { itemId: itemIds.loose, sourceLocationId: 15, salesQty: 7.5 }
    ]
  }, {
    operatorId: actor,
    authorizedDestinationLocationIds: [1]
  });

  assert.match(created.requestRef, /^STREQ-\d{6,}$/);
  assert.equal(created.revision, 1);
  assert.equal(created.lines.length, 2);
  assert.deepEqual(new Set(created.lines.map((line) => line.sourceLocationId)), new Set([28, 15]));
  const reservations = await query(
    `SELECT COUNT(*)::int AS count
       FROM sales_stock_transfer_reservations reservation
       JOIN sales_stock_transfer_lines line ON line.id = reservation.transfer_line_id
       JOIN sales_stock_request_lines request_line ON request_line.id = line.request_line_id
      WHERE request_line.request_id = $1`,
    [created.id]
  );
  assert.equal(reservations.rows[0].count, 0);

  const visible = await listSalesStockRequests({ authorizedDestinationLocationIds: [1], bucket: "pending" });
  assert(visible.some((request) => request.id === created.id));
  const hidden = await listSalesStockRequests({ authorizedDestinationLocationIds: [28], bucket: "pending" });
  assert(!hidden.some((request) => request.id === created.id));
  await assert.rejects(
    () => getSalesStockRequest(created.id, { authorizedDestinationLocationIds: [28] }),
    (error) => error?.status === 403
  );
});

test("Admin policy permits Sales demand above availability and SCM converts the full demand as backorder", async () => {
  await query(
    `UPDATE inventory_balances
        SET quantity_available = 10, quantity_on_hand = 10, synced_at = now()
      WHERE item_id = $1 AND location_id = 28`,
    [itemIds.paver]
  );
  try {
    const input = {
      destinationLocationId: 1,
      lines: [conversionLine({ pallets: 0, pieces: 11 })]
    };

    await assert.rejects(
      () => createSalesStockRequest(input, {
        operatorId: actor,
        authorizedDestinationLocationIds: [1]
      }),
      (error) => error?.status === 409 && error?.code === "STOCK_REQUEST_AVAILABILITY_EXCEEDED"
    );

    const allowed = await createSalesStockRequest(input, {
      operatorId: actor,
      authorizedDestinationLocationIds: [1],
      allowOverAvailability: true
    });
    assert.equal(allowed.lines[0].salesQty, 11);
    const converted = await convertSalesStockRequestLines(allowed.id, {
      expectedRevision: allowed.revision,
      lineIds: [allowed.lines[0].id]
    }, { operatorId: actor });
    assert.equal(converted.transfers[0].lines[0].salesQty, 11);
    const conversionEvent = converted.request.events.find((event) => event.eventType === "local_transfer_created");
    assert.equal(conversionEvent.details.backorderSalesQty, 1);
    assert.deepEqual(conversionEvent.details.availability, [{
      itemId: itemIds.paver,
      sourceLocationId: 28,
      requestedSalesQty: 11,
      requestableAvailable: 10,
      backorderSalesQty: 1
    }]);
  } finally {
    await query(
      `UPDATE inventory_balances
          SET quantity_available = 100, quantity_on_hand = 100, synced_at = now()
        WHERE item_id = $1 AND location_id = 28`,
      [itemIds.paver]
    );
  }
});

test("Sales request remarks are normalized, bounded, and visible to SCM", async () => {
  const created = await createSalesStockRequest({
    destinationLocationId: 1,
    remarks: "  Please keep this replenishment together.\nCall Sales before changing it.  ",
    lines: [conversionLine({ pallets: 0, pieces: 2 })]
  }, { operatorId: actor, authorizedDestinationLocationIds: [1] });
  assert.equal(created.remarks, "Please keep this replenishment together. Call Sales before changing it.");
  assert.equal((await getScmStockRequest(created.id)).remarks, created.remarks);
  await assert.rejects(
    () => createSalesStockRequest({
      destinationLocationId: 1,
      remarks: "x".repeat(2001),
      lines: [conversionLine({ pallets: 0, pieces: 1 })]
    }, { operatorId: actor, authorizedDestinationLocationIds: [1] }),
    /remark.*2,000/i
  );
});

test("Sales edits and cancels only before SCM decision and stale revisions change nothing", async () => {
  const request = await createSalesStockRequest({
    destinationLocationId: 1,
    lines: [conversionLine({ pieces: 1, pallets: 0 })]
  }, { operatorId: actor, authorizedDestinationLocationIds: [1] });
  const edited = await updateSalesStockRequest(request.id, {
    expectedRevision: 1,
    destinationLocationId: 1,
    lines: [{ id: request.lines[0].id, ...conversionLine({ pallets: 0, pieces: 3 }) }]
  }, { operatorId: actor, authorizedDestinationLocationIds: [1] });
  assert.equal(edited.revision, 2);
  assert.equal(edited.lines[0].salesQty, 3);
  await assert.rejects(
    () => cancelSalesStockRequest(request.id, { expectedRevision: 1 }, {
      operatorId: actor,
      authorizedDestinationLocationIds: [1]
    }),
    (error) => error?.status === 409
  );
  assert.equal((await getSalesStockRequest(request.id, { authorizedDestinationLocationIds: [1] })).status, "submitted");
  const cancelled = await cancelSalesStockRequest(request.id, { expectedRevision: 2 }, {
    operatorId: actor,
    authorizedDestinationLocationIds: [1]
  });
  assert.equal(cancelled.status, "cancelled");
});

test("SCM Request Changes unlocks only selected lines and requires a reason", async () => {
  const request = await createSalesStockRequest({
    destinationLocationId: 1,
    lines: [conversionLine({ pieces: 1, pallets: 0 }), conversionLine({ sourceLocationId: 15, pieces: 2, pallets: 0 })]
  }, { operatorId: actor, authorizedDestinationLocationIds: [1] });
  await assert.rejects(
    () => decideSalesStockRequestLines(request.id, {
      expectedRevision: 1,
      lineIds: [request.lines[0].id],
      decision: "request_changes",
      reason: ""
    }, { operatorId: actor }),
    /reason/i
  );
  const returned = await decideSalesStockRequestLines(request.id, {
    expectedRevision: 1,
    lineIds: [request.lines[0].id],
    decision: "request_changes",
    reason: "Please use source yard 15."
  }, { operatorId: actor });
  assert.equal(returned.revision, 2);
  assert.equal(returned.lines[0].status, "changes_requested");
  assert.equal(returned.lines[1].status, "submitted");

  const edited = await updateSalesStockRequest(request.id, {
    expectedRevision: 2,
    lines: [{ id: request.lines[0].id, ...conversionLine({ sourceLocationId: 15, pallets: 0, pieces: 4 }) }]
  }, { operatorId: actor, authorizedDestinationLocationIds: [1] });
  assert.equal(edited.lines[0].sourceLocationId, 15);
  assert.equal(edited.lines[1].salesQty, 2);
  const resubmitted = await resubmitSalesStockRequest(request.id, { expectedRevision: 3 }, {
    operatorId: actor,
    authorizedDestinationLocationIds: [1]
  });
  assert.equal(resubmitted.lines[0].status, "submitted");
});

test("SCM conversion groups by route and atomically creates active reservations without NetSuite", async () => {
  const request = await createSalesStockRequest({
    destinationLocationId: 1,
    lines: [
      conversionLine({ pallets: 2 }),
      conversionLine({ sourceLocationId: 15, pallets: 1 }),
      { itemId: itemIds.loose, sourceLocationId: 15, salesQty: 7 }
    ]
  }, { operatorId: actor, authorizedDestinationLocationIds: [1] });
  const converted = await convertSalesStockRequestLines(request.id, {
    expectedRevision: 1,
    lineIds: request.lines.map((line) => line.id)
  }, { operatorId: actor });
  assert.equal(converted.transfers.length, 2);
  assert.deepEqual(
    converted.transfers.map((transfer) => `${transfer.sourceLocationId}:${transfer.destinationLocationId}`).sort(),
    ["15:1", "28:1"]
  );
  assert(converted.transfers.every((transfer) => transfer.status === "pending_local"));
  assert(converted.transfers.every((transfer) => transfer.netsuiteTransferOrderId === null));
  const reservation = await query(
    `SELECT COUNT(*)::int AS count, SUM(reserved_sales_quantity)::numeric AS quantity
       FROM sales_stock_transfer_reservations reservation
       JOIN sales_stock_transfer_lines line ON line.id = reservation.transfer_line_id
       JOIN sales_stock_request_lines request_line ON request_line.id = line.request_line_id
      WHERE request_line.request_id = $1
        AND reservation.status = 'active'`,
    [request.id]
  );
  assert.equal(reservation.rows[0].count, 3);
  assert.equal(Number(reservation.rows[0].quantity), 37);
});

test("concurrent SCM conversions serialize reservations and retain excess demand as backorder", async () => {
  await query(
    `UPDATE inventory_balances
        SET quantity_available = 10, quantity_on_hand = 10, synced_at = now()
      WHERE item_id = $1 AND location_id = 26`,
    [itemIds.paver]
  );
  const first = await createSalesStockRequest({
    destinationLocationId: 1,
    lines: [conversionLine({ sourceLocationId: 26, pallets: 0, pieces: 8 })]
  }, { operatorId: actor, authorizedDestinationLocationIds: [1] });
  const second = await createSalesStockRequest({
    destinationLocationId: 1,
    lines: [conversionLine({ sourceLocationId: 26, pallets: 0, pieces: 8 })]
  }, { operatorId: actor, authorizedDestinationLocationIds: [1] });
  const outcomes = await Promise.allSettled([
    convertSalesStockRequestLines(first.id, {
      expectedRevision: 1,
      lineIds: [first.lines[0].id]
    }, { operatorId: actor }),
    convertSalesStockRequestLines(second.id, {
      expectedRevision: 1,
      lineIds: [second.lines[0].id]
    }, { operatorId: actor })
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 2);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 0);
  const reservations = await query(
    `SELECT COALESCE(SUM(reserved_sales_quantity), 0)::numeric AS reserved
       FROM sales_stock_transfer_reservations
      WHERE item_id = $1 AND source_location_id = 26 AND status = 'active'`,
    [itemIds.paver]
  );
  assert.equal(Number(reservations.rows[0].reserved), 16);
  const backorders = outcomes.map((outcome) => outcome.value.request.events
    .find((event) => event.eventType === "local_transfer_created")?.details?.backorderSalesQty || 0);
  assert.equal(backorders.reduce((sum, value) => sum + Number(value), 0), 6);
});

test("pending TO revisions atomically replace reservations, reject stale screens, and require explicit PALLET quantity", async () => {
  await query(
    `UPDATE inventory_balances
        SET quantity_available = 100, quantity_on_hand = 100, synced_at = now()
      WHERE item_id = $1 AND location_id = 28`,
    [itemIds.paver]
  );
  const { transfer } = await createConvertedTransfer();
  const revised = await reviseStockTransferQuantities(transfer.id, {
    expectedRevision: transfer.revision,
    requestId: `revision-${seed}-1`,
    palletQuantity: 2,
    lines: [{ requestLineId: transfer.lines[0].id, pallets: 1, pieces: 5 }]
  }, { operatorId: actor });
  assert.equal(revised.revision, transfer.revision + 1);
  assert.equal(revised.lines[0].salesQty, 15);
  assert.equal(revised.palletQuantity, 2);
  assert.equal(revised.palletQuantityManuallyAdjusted, true);

  const reservation = await query(
    `SELECT reserved_sales_quantity
       FROM sales_stock_transfer_reservations reservation
       JOIN sales_stock_transfer_lines line ON line.id = reservation.transfer_line_id
      WHERE line.transfer_id = $1 AND reservation.status = 'active'`,
    [transfer.id]
  );
  assert.equal(Number(reservation.rows[0].reserved_sales_quantity), 15);
  await assert.rejects(
    () => reviseStockTransferQuantities(transfer.id, {
      expectedRevision: transfer.revision,
      requestId: `revision-${seed}-stale`,
      palletQuantity: 1,
      lines: [{ requestLineId: transfer.lines[0].id, pallets: 0, pieces: 1 }]
    }, { operatorId: actor }),
    (error) => error?.status === 409 && error?.code === "STOCK_TRANSFER_REVISION_CONFLICT"
  );
  assert.equal((await getStockTransfer(transfer.id)).lines[0].salesQty, 15);

  const manual = await createConvertedTransfer({
    itemId: itemIds.loose,
    sourceLocationId: 15,
    salesQty: 4
  });
  assert.equal(manual.transfer.palletQuantityRequiresManual, true);
  await assert.rejects(
    () => claimStockTransferConfirmation(manual.transfer.id, {
      expectedRevision: manual.transfer.revision,
      requestId: `confirm-${seed}-manual`
    }, { operatorId: actor }),
    (error) => error?.status === 409 && error?.code === "STOCK_TRANSFER_PALLET_REQUIRED"
  );
});

test("quantity revision invalidates a prior ticket snapshot without changing the real TO identity", async () => {
  const { transfer } = await createConvertedTransfer(conversionLine({ pallets: 1 }));
  const remoteId = baseId + 80;
  const printJob = await query(
    `INSERT INTO scm_print_jobs (
       job_key, location_id, document_type, document_name, document_path, document_sha256, status
     ) VALUES ($1,28,'transfer_dependency_picking_ticket','fixture.pdf','/tmp/fixture.pdf',$2,'printed')
     RETURNING id`,
    [`stock-request-fixture:${seed}:${transfer.id}`, "a".repeat(64)]
  );
  await query(
    `UPDATE sales_stock_transfers
        SET netsuite_transfer_order_id = $2,
            netsuite_transfer_order_ref = $3,
            status = 'pending_fulfillment',
            confirmation_status = 'complete',
            print_generation = 1,
            print_job_id = $4
      WHERE id = $1`,
    [transfer.id, remoteId, `TO${remoteId}`, printJob.rows[0].id]
  );
  const revised = await reviseStockTransferQuantities(transfer.id, {
    expectedRevision: transfer.revision,
    requestId: `revision-${seed}-printed`,
    lines: [{ requestLineId: transfer.lines[0].id, pallets: 1, pieces: 2 }]
  }, { operatorId: actor });
  assert.equal(revised.netsuiteTransferOrderId, remoteId);
  assert.equal(revised.netsuiteTransferOrderRef, `TO${remoteId}`);
  assert.equal(revised.printJobId, null);
  assert(revised.printInvalidatedAt);
  assert.equal(revised.confirmationStatus, "attention");
  assert.match(revised.confirmationError, /sync and re-print/i);
});

test("driver completion remains Accepted; only a current NetSuite receipt completes the request", async () => {
  const { request, transfer } = await createConvertedTransfer(conversionLine({ pallets: 1 }));
  const remoteId = baseId + 90;
  const remoteRef = `TO${remoteId}`;
  await query(
    `UPDATE sales_stock_transfers
        SET netsuite_transfer_order_id = $2,
            netsuite_transfer_order_ref = $3,
            status = 'pending_fulfillment',
            netsuite_updated_at = now() - interval '5 minutes'
      WHERE id = $1`,
    [transfer.id, remoteId, remoteRef]
  );
  await query(
    `INSERT INTO transfer_orders (
       netsuite_id, tranid, status, status_text,
       from_location_id, from_location, to_location_id, to_location,
       fulfillment_status, receiving_status, synced_at, status_updated_at
     ) VALUES ($1,$2,'B','Pending Fulfillment',28,'2967',1,'3445','Pending Fulfillment',NULL,now(),now())`,
    [remoteId, remoteRef]
  );
  await query(
    `INSERT INTO driver_job_records (
       job_id, driver_login, stop_type, order_refs, status, completed_at
     ) VALUES ($1,$2,'transfer_order',$3::jsonb,'complete',now())`,
    [`stock-request-driver-${seed}-${transfer.id}`, actor, JSON.stringify([remoteRef])]
  );

  const driverMilestone = await getSalesStockRequest(request.id, { authorizedDestinationLocationIds: [1] });
  assert.equal(driverMilestone.transfers[0].driverCompleted, true);
  assert.equal(driverMilestone.bucket, "accepted");
  assert.equal(driverMilestone.lines[0].status, "converted");

  await query(
    `UPDATE transfer_orders
        SET status = 'F', status_text = 'Received', receiving_status = 'Received',
            received_at = now(), status_updated_at = now() + interval '1 second'
      WHERE netsuite_id = $1`,
    [remoteId]
  );
  const received = await reconcileStockRequestTransferWebhook({ id: remoteId });
  assert.equal(received.status, "received");
  const completed = await getSalesStockRequest(request.id, { authorizedDestinationLocationIds: [1] });
  assert.equal(completed.bucket, "completed");
  assert.equal(completed.lines[0].status, "received");
  assert.equal(completed.transfers[0].status, "received");
  const reservation = await query(
    `SELECT status FROM sales_stock_transfer_reservations reservation
       JOIN sales_stock_transfer_lines line ON line.id = reservation.transfer_line_id
      WHERE line.transfer_id = $1`,
    [transfer.id]
  );
  assert.equal(reservation.rows[0].status, "executed");

  await query(
    `UPDATE transfer_orders
        SET status = 'B', status_text = 'Pending Fulfillment', receiving_status = NULL,
            received_at = NULL, status_updated_at = '2000-01-01T00:00:00.000Z'
      WHERE netsuite_id = $1`,
    [remoteId]
  );
  const stale = await reconcileStockRequestTransferWebhook({
    id: remoteId,
    status_updated_at: "2000-01-01T00:00:00.000Z"
  });
  assert.equal(stale.stale, true);
  assert.equal((await getStockTransfer(transfer.id)).status, "received");
});

test("item lookup, all-yard availability, and bounded Sales/SCM queues expose the same local inventory", async () => {
  assert.deepEqual(await searchStockRequestItems({ search: "S" }), []);
  const found = await searchStockRequestItems({ search: `PAVER-${seed}`, limit: 500 });
  assert.equal(found[0].itemId, itemIds.paver);
  assert.equal(found.length, 1);
  const availability = await getStockRequestItemAvailability(itemIds.paver);
  assert.equal(availability.yards.length, 4);
  assert(availability.yards.every((yard) => [1, 28, 15, 26].includes(yard.locationId)));
  assert(availability.yards.find((yard) => yard.locationId === 28).activeReserved > 0);

  const request = await createSalesStockRequest({
    destinationLocationId: 1,
    lines: [conversionLine({ sourceLocationId: 15, pallets: 0, pieces: 2 })]
  }, { operatorId: actor, authorizedDestinationLocationIds: [1] });
  const sales = await listSalesStockRequests({
    authorizedDestinationLocationIds: [1],
    bucket: "pending",
    search: request.requestRef,
    limit: 500,
    offset: -10
  });
  assert.equal(sales[0].id, request.id);
  const scm = await listScmStockRequests({ queue: "request", search: request.requestRef, limit: 500, offset: 20_000 });
  assert.deepEqual(scm, []);
  const scmFirstPage = await listScmStockRequests({ queue: "request", search: request.requestRef, limit: 500 });
  assert.equal(scmFirstPage[0].id, request.id);
  assert.equal((await getScmStockRequest(request.id)).availability.length, 1);
  await assert.rejects(() => listSalesStockRequests({
    authorizedDestinationLocationIds: [1],
    bucket: "mystery"
  }), /Pending, Accepted, or Completed/i);
  await assert.rejects(() => listScmStockRequests({ queue: "mystery" }), /Request, Pending TO, Rejected, or Closed/i);
});

test("SCM line adjustment permits explicit backorder, stays auditable, and locks after conversion", async () => {
  const request = await createSalesStockRequest({
    destinationLocationId: 1,
    lines: [conversionLine({ pallets: 0, pieces: 2 })]
  }, { operatorId: actor, authorizedDestinationLocationIds: [1] });
  const activeReservations = await query(
    `SELECT COALESCE(SUM(quantity), 0)::numeric AS reserved
       FROM (
         SELECT reserved_sales_quantity AS quantity
           FROM sales_stock_transfer_reservations
          WHERE status = 'active' AND item_id = $1 AND source_location_id = 15
         UNION ALL
         SELECT reserved_sales_quantity AS quantity
           FROM scm_smart_inventory_reservations
          WHERE status = 'active' AND item_id = $1 AND source_location_id = 15
       ) reservation`,
    [itemIds.paver]
  );
  const liveQuantityForOneRequestable = Number(activeReservations.rows[0].reserved) + 1;
  await query(
    `UPDATE inventory_balances
        SET quantity_available = $2, quantity_on_hand = $2, synced_at = now()
      WHERE item_id = $1 AND location_id = 15`,
    [itemIds.paver, liveQuantityForOneRequestable]
  );
  try {
    const adjusted = await updateScmStockRequestLine(request.id, request.lines[0].id, {
      expectedRevision: request.revision,
      itemId: itemIds.paver,
      sourceLocationId: 15,
      pallets: 0,
      pieces: 10
    }, { operatorId: actor });
    assert.equal(adjusted.revision, request.revision + 1);
    assert.equal(adjusted.lines[0].sourceLocationId, 15);
    assert.equal(adjusted.lines[0].salesQty, 10);
    assert(adjusted.events.some((event) => event.eventType === "line_adjusted_by_scm"));
    await assert.rejects(
      () => updateScmStockRequestLine(request.id, request.lines[0].id, {
        expectedRevision: request.revision,
        itemId: itemIds.paver,
        sourceLocationId: 15,
        pieces: 1
      }, { operatorId: actor }),
      (error) => error?.status === 409 && error?.code === "STOCK_REQUEST_REVISION_CONFLICT"
    );
    const converted = await convertSalesStockRequestLines(request.id, {
      expectedRevision: adjusted.revision,
      lineIds: [request.lines[0].id]
    }, { operatorId: actor });
    const conversionEvent = converted.request.events.find((event) => event.eventType === "local_transfer_created");
    assert.equal(conversionEvent.details.backorderSalesQty, 9);
    await assert.rejects(
      () => updateScmStockRequestLine(request.id, request.lines[0].id, {
        expectedRevision: converted.request.revision,
        itemId: itemIds.paver,
        sourceLocationId: 15,
        pieces: 1
      }, { operatorId: actor }),
      (error) => error?.status === 409 && error?.code === "STOCK_REQUEST_LINE_LOCKED"
    );
  } finally {
    await query(
      `UPDATE inventory_balances
          SET quantity_available = 100, quantity_on_hand = 100, synced_at = now()
        WHERE item_id = $1 AND location_id = 15`,
      [itemIds.paver]
    );
  }
});

test("a full rejection is terminal and cannot be resubmitted", async () => {
  const request = await createSalesStockRequest({
    destinationLocationId: 1,
    lines: [conversionLine({ sourceLocationId: 15, pallets: 0, pieces: 1 })]
  }, { operatorId: actor, authorizedDestinationLocationIds: [1] });
  const rejected = await decideSalesStockRequestLines(request.id, {
    expectedRevision: request.revision,
    lineIds: [request.lines[0].id],
    decision: "reject",
    reason: "SCM will source this by another purchasing method."
  }, { operatorId: actor });
  assert.equal(rejected.status, "completed");
  assert.equal(rejected.bucket, "completed");
  assert.equal(rejected.lines[0].status, "rejected");
  await assert.rejects(
    () => resubmitSalesStockRequest(request.id, { expectedRevision: rejected.revision }, {
      operatorId: actor,
      authorizedDestinationLocationIds: [1]
    }),
    (error) => error?.status === 409
  );
});

test("confirm/approve/print persistence is retry-safe and failed attempts can be deliberately recovered", async () => {
  const { request, transfer } = await createConvertedTransfer(conversionLine({ pallets: 1 }));
  const confirmationRequestId = `confirm-${seed}-${transfer.id}`;
  const claimed = await claimStockTransferConfirmation(transfer.id, {
    expectedRevision: transfer.revision,
    requestId: confirmationRequestId
  }, { operatorId: actor });
  assert.equal(claimed.confirmationStatus, "creating");
  assert.equal(claimed.status, "creating");
  await assert.rejects(
    () => claimStockTransferConfirmation(transfer.id, {
      expectedRevision: transfer.revision,
      requestId: `${confirmationRequestId}-concurrent`
    }, { operatorId: actor }),
    (error) => error?.status === 409 && error?.code === "STOCK_TRANSFER_CONFIRMATION_IN_PROGRESS"
  );

  const failed = await failStockTransferConfirmation(transfer.id, {
    error: new Error("temporary NetSuite outage")
  }, { operatorId: actor });
  assert.equal(failed.status, "attention");
  assert.match(failed.confirmationError, /temporary NetSuite outage/);
  const retryRequestId = `${confirmationRequestId}-retry`;
  const retried = await claimStockTransferConfirmation(transfer.id, {
    expectedRevision: transfer.revision,
    requestId: retryRequestId
  }, { operatorId: actor });
  assert.equal(retried.confirmationRequestId, retryRequestId);

  const remoteId = baseId + 100 + transfer.id;
  const linked = await recordStockTransferRemote(transfer.id, {
    id: remoteId,
    tranid: `TO${remoteId}`,
    status: "A",
    statusText: "Pending Approval",
    recovered: true
  }, { operatorId: actor });
  assert.equal(linked.netsuiteTransferOrderId, remoteId);
  assert.equal(linked.confirmationStatus, "approving");
  const approved = await recordStockTransferApproved(transfer.id, {
    tranid: `TO${remoteId}`,
    status: "B",
    statusText: "Pending Fulfillment"
  }, { operatorId: actor });
  assert.equal(approved.status, "pending_fulfillment");
  assert.equal(approved.confirmationStatus, "hydrating");

  const printClaim = await claimStockTransferPrint(transfer.id, { operatorId: actor });
  assert.equal(printClaim.generation, 1);
  const printJob = await query(
    `INSERT INTO scm_print_jobs (
       job_key, location_id, document_type, document_name, document_path, document_sha256, status
     ) VALUES ($1,28,'transfer_dependency_picking_ticket','confirmed.pdf','/tmp/confirmed.pdf',$2,'queued')
     RETURNING id`,
    [`stock-request-confirmed:${seed}:${transfer.id}`, "b".repeat(64)]
  );
  const completed = await completeStockTransferPrint(transfer.id, {
    printJobId: printJob.rows[0].id,
    operatorId: actor
  });
  assert.equal(completed.confirmationStatus, "complete");
  assert.equal(completed.printJobId, Number(printJob.rows[0].id));
  await recordStockRequestEvent({
    requestId: request.id,
    transferId: transfer.id,
    eventType: "integration_evidence",
    actorId: actor,
    details: { remoteId }
  });
  assert((await getSalesStockRequest(request.id, { authorizedDestinationLocationIds: [1] })).events
    .some((event) => event.eventType === "integration_evidence"));
});

test("revision sync results and unmatched, ignored, and cancelled webhooks preserve reservation rules", async () => {
  const success = await createConvertedTransfer(conversionLine({ sourceLocationId: 15, pallets: 0, pieces: 3 }));
  const successResult = await recordStockTransferRevisionResult(success.transfer.id, {
    succeeded: true,
    remote: { status: "B", statusText: "Pending Fulfillment" },
    operatorId: actor
  });
  assert.equal(successResult.revisionError, null);
  assert.equal(successResult.confirmationStatus, "complete");
  const failureResult = await recordStockTransferRevisionResult(success.transfer.id, {
    succeeded: false,
    error: new Error("remote revision rejected"),
    operatorId: actor
  });
  assert.equal(failureResult.confirmationStatus, "attention");
  assert.match(failureResult.revisionError, /remote revision rejected/);

  assert.deepEqual(await reconcileStockRequestTransferWebhook({ id: baseId + 999_999 }), { matched: false });
  assert.deepEqual(await reconcileStockRequestTransferWebhook({ id: "invalid" }), { matched: false });

  const cancelled = await createConvertedTransfer(conversionLine({ sourceLocationId: 15, pallets: 0, pieces: 2 }));
  const remoteId = baseId + 200 + cancelled.transfer.id;
  await query(
    `UPDATE sales_stock_transfers
        SET netsuite_transfer_order_id = $2,
            netsuite_transfer_order_ref = $3,
            netsuite_updated_at = now() - interval '1 hour'
      WHERE id = $1`,
    [cancelled.transfer.id, remoteId, `TO${remoteId}`]
  );
  await query(
    `INSERT INTO transfer_orders (
       netsuite_id, tranid, status, status_text, from_location_id, to_location_id,
       synced_at, status_updated_at
     ) VALUES ($1,$2,'C','Cancelled',15,1,now(),now())`,
    [remoteId, `TO${remoteId}`]
  );
  const projected = await reconcileStockRequestTransferWebhook({ id: remoteId });
  assert.equal(projected.status, "cancelled");
  const released = await query(
    `SELECT status FROM sales_stock_transfer_reservations reservation
       JOIN sales_stock_transfer_lines line ON line.id = reservation.transfer_line_id
      WHERE line.transfer_id = $1`,
    [cancelled.transfer.id]
  );
  assert.equal(released.rows[0].status, "released");
  const detail = await getSalesStockRequest(cancelled.request.id, { authorizedDestinationLocationIds: [1] });
  assert.equal(detail.lines[0].status, "cancelled");
  assert.equal(detail.bucket, "completed");
  assert((await listSalesStockRequests({
    authorizedDestinationLocationIds: [1],
    bucket: "accepted",
    search: cancelled.request.requestRef
  })).some((request) => request.id === cancelled.request.id));
  assert((await listSalesStockRequests({
    authorizedDestinationLocationIds: [1],
    bucket: "completed",
    search: cancelled.request.requestRef
  })).some((request) => request.id === cancelled.request.id));

  const ignored = await createConvertedTransfer(conversionLine({ sourceLocationId: 15, pallets: 0, pieces: 2 }));
  const ignoredRemoteId = baseId + 300 + ignored.transfer.id;
  await query(
    `UPDATE sales_stock_transfers
        SET netsuite_transfer_order_id = $2,
            netsuite_transfer_order_ref = $3
      WHERE id = $1`,
    [ignored.transfer.id, ignoredRemoteId, `TO${ignoredRemoteId}`]
  );
  await query(
    `INSERT INTO transfer_orders (netsuite_id, tranid, status, status_text, synced_at, status_updated_at)
     VALUES ($1,$2,'Z','Unknown',now(),now())`,
    [ignoredRemoteId, `TO${ignoredRemoteId}`]
  );
  const ignoredResult = await reconcileStockRequestTransferWebhook({ id: ignoredRemoteId });
  assert.equal(ignoredResult.ignored, true);
  assert.equal((await getStockTransfer(ignored.transfer.id)).status, "pending_local");
});

test("SCM can convert or reject a returned line until Sales wins with a newer revision", async () => {
  await query(
    `UPDATE inventory_balances
        SET quantity_available = 100, quantity_on_hand = 100, synced_at = now()
      WHERE item_id = $1 AND location_id = 26`,
    [itemIds.paver]
  );
  const convertible = await createSalesStockRequest({
    destinationLocationId: 1,
    lines: [conversionLine({ sourceLocationId: 26, pallets: 0, pieces: 2 })]
  }, { operatorId: actor, authorizedDestinationLocationIds: [1] });
  const returnedForConversion = await decideSalesStockRequestLines(convertible.id, {
    expectedRevision: convertible.revision,
    lineIds: [convertible.lines[0].id],
    decision: "request_changes",
    reason: "Please confirm the source."
  }, { operatorId: actor });
  const converted = await convertSalesStockRequestLines(convertible.id, {
    expectedRevision: returnedForConversion.revision,
    lineIds: [convertible.lines[0].id]
  }, { operatorId: actor });
  assert.equal(converted.request.lines[0].status, "converted");

  const rejectable = await createSalesStockRequest({
    destinationLocationId: 1,
    lines: [conversionLine({ sourceLocationId: 26, pallets: 0, pieces: 2 })]
  }, { operatorId: actor, authorizedDestinationLocationIds: [1] });
  const returnedForRejection = await decideSalesStockRequestLines(rejectable.id, {
    expectedRevision: rejectable.revision,
    lineIds: [rejectable.lines[0].id],
    decision: "request_changes",
    reason: "Please confirm the quantity."
  }, { operatorId: actor });
  const rejected = await decideSalesStockRequestLines(rejectable.id, {
    expectedRevision: returnedForRejection.revision,
    lineIds: [rejectable.lines[0].id],
    decision: "reject",
    reason: "SCM will use another method."
  }, { operatorId: actor });
  assert.equal(rejected.lines[0].status, "rejected");
  await assert.rejects(
    () => updateSalesStockRequest(rejectable.id, {
      expectedRevision: returnedForRejection.revision,
      lines: [{ id: rejectable.lines[0].id, ...conversionLine({ sourceLocationId: 15, pallets: 0, pieces: 1 }) }]
    }, { operatorId: actor, authorizedDestinationLocationIds: [1] }),
    (error) => error?.code === "STOCK_REQUEST_REVISION_CONFLICT"
  );
});

test("SCM rejects a local Pending TO atomically, but cannot reject after NetSuite confirmation", async () => {
  assert.equal(typeof stockRequestRepository.rejectPendingStockTransfer, "function");
  const local = await createConvertedTransfer(conversionLine({ sourceLocationId: 15, pallets: 0, pieces: 3 }));
  await assert.rejects(
    () => stockRequestRepository.rejectPendingStockTransfer(local.transfer.id, {
      expectedRevision: local.transfer.revision + 1,
      expectedRequestRevision: local.request.revision,
      reason: "Stale transfer screen."
    }, { operatorId: actor }),
    (error) => error?.code === "STOCK_TRANSFER_REVISION_CONFLICT"
  );
  await assert.rejects(
    () => stockRequestRepository.rejectPendingStockTransfer(local.transfer.id, {
      expectedRevision: local.transfer.revision,
      expectedRequestRevision: local.request.revision + 1,
      reason: "Stale request screen."
    }, { operatorId: actor }),
    (error) => error?.code === "STOCK_REQUEST_REVISION_CONFLICT"
  );
  const result = await stockRequestRepository.rejectPendingStockTransfer(local.transfer.id, {
    expectedRevision: local.transfer.revision,
    expectedRequestRevision: local.request.revision,
    reason: "Use a different replenishment method."
  }, { operatorId: actor });
  assert.equal(result.transfer.status, "cancelled");
  assert.equal(result.request.lines[0].status, "rejected");
  const reservation = await query(
    `SELECT status FROM sales_stock_transfer_reservations reservation
       JOIN sales_stock_transfer_lines line ON line.id = reservation.transfer_line_id
      WHERE line.transfer_id = $1`,
    [local.transfer.id]
  );
  assert.equal(reservation.rows[0].status, "released");
  assert((await listScmStockRequests({ queue: "rejected", search: local.request.requestRef }))
    .some((request) => request.id === local.request.id));
  assert(!(await listScmStockRequests({ queue: "pending_to", search: local.request.requestRef }))
    .some((request) => request.id === local.request.id));
  assert(!(await listSalesStockRequests({
    authorizedDestinationLocationIds: [1],
    bucket: "accepted",
    search: local.request.requestRef
  })).some((request) => request.id === local.request.id));
  assert((await listSalesStockRequests({
    authorizedDestinationLocationIds: [1],
    bucket: "completed",
    search: local.request.requestRef
  })).some((request) => request.id === local.request.id));

  const confirmed = await createConvertedTransfer(conversionLine({ sourceLocationId: 15, pallets: 0, pieces: 2 }));
  await query(
    `UPDATE sales_stock_transfers
        SET netsuite_transfer_order_id = $2,
            netsuite_transfer_order_ref = $3,
            status = 'pending_fulfillment'
      WHERE id = $1`,
    [confirmed.transfer.id, baseId + 900 + confirmed.transfer.id, `TO${baseId + 900 + confirmed.transfer.id}`]
  );
  await assert.rejects(
    () => stockRequestRepository.rejectPendingStockTransfer(confirmed.transfer.id, {
      expectedRevision: confirmed.transfer.revision,
      expectedRequestRevision: confirmed.request.revision,
      reason: "Too late to reject locally."
    }, { operatorId: actor }),
    (error) => error?.status === 409 && error?.code === "STOCK_TRANSFER_ALREADY_CONFIRMED"
  );
  const stillActive = await query(
    `SELECT status FROM sales_stock_transfer_reservations reservation
       JOIN sales_stock_transfer_lines line ON line.id = reservation.transfer_line_id
      WHERE line.transfer_id = $1`,
    [confirmed.transfer.id]
  );
  assert.equal(stillActive.rows[0].status, "active");

  const printed = await createConvertedTransfer(conversionLine({ sourceLocationId: 15, pallets: 0, pieces: 1 }));
  const printJob = await query(
    `INSERT INTO scm_print_jobs (
       job_key, location_id, document_type, document_name, document_path, document_sha256, status
     ) VALUES ($1,15,'transfer_dependency_picking_ticket','reject-guard.pdf','/tmp/reject-guard.pdf',$2,'queued')
     RETURNING id`,
    [`stock-request-reject-guard:${seed}:${printed.transfer.id}`, "c".repeat(64)]
  );
  await query("UPDATE sales_stock_transfers SET print_job_id = $2 WHERE id = $1", [printed.transfer.id, printJob.rows[0].id]);
  await assert.rejects(
    () => stockRequestRepository.rejectPendingStockTransfer(printed.transfer.id, {
      expectedRevision: printed.transfer.revision,
      expectedRequestRevision: printed.request.revision,
      reason: "Printed transfer must not be rejected."
    }, { operatorId: actor }),
    (error) => error?.code === "STOCK_TRANSFER_ALREADY_CONFIRMED"
  );

  const noLongerConverted = await createConvertedTransfer(conversionLine({ sourceLocationId: 15, pallets: 0, pieces: 1 }));
  await query(
    `UPDATE sales_stock_request_lines SET status = 'rejected' WHERE request_id = $1`,
    [noLongerConverted.request.id]
  );
  await assert.rejects(
    () => stockRequestRepository.rejectPendingStockTransfer(noLongerConverted.transfer.id, {
      expectedRevision: noLongerConverted.transfer.revision,
      expectedRequestRevision: noLongerConverted.request.revision,
      reason: "No converted lines remain."
    }, { operatorId: actor }),
    (error) => error?.code === "STOCK_TRANSFER_NOT_REJECTABLE"
  );
  assert.equal((await getStockTransfer(noLongerConverted.transfer.id)).status, "pending_local");
});

test("a newer NetSuite Closed status is terminal, visible, and cannot be reopened by an older webhook", async () => {
  const { request, transfer } = await createConvertedTransfer(conversionLine({ sourceLocationId: 15, pallets: 0, pieces: 2 }));
  const remoteId = baseId + 1_000 + transfer.id;
  await query(
    `UPDATE sales_stock_transfers
        SET netsuite_transfer_order_id = $2,
            netsuite_transfer_order_ref = $3,
            status = 'pending_fulfillment',
            netsuite_updated_at = now() - interval '1 hour'
      WHERE id = $1`,
    [transfer.id, remoteId, `TO${remoteId}`]
  );
  await query(
    `INSERT INTO transfer_orders (
       netsuite_id, tranid, status, status_text, from_location_id, to_location_id,
       synced_at, status_updated_at
     ) VALUES ($1,$2,'H','Closed',15,1,now(),now())`,
    [remoteId, `TO${remoteId}`]
  );
  const closed = await reconcileStockRequestTransferWebhook({ id: remoteId });
  assert.equal(closed.status, "closed");
  const detail = await getSalesStockRequest(request.id, { authorizedDestinationLocationIds: [1] });
  assert.equal(detail.bucket, "completed");
  assert.equal(detail.lines[0].status, "closed");
  assert.equal(detail.transfers[0].status, "closed");
  assert((await listScmStockRequests({ queue: "closed", search: request.requestRef }))
    .some((candidate) => candidate.id === request.id));
  assert((await listSalesStockRequests({
    authorizedDestinationLocationIds: [1],
    bucket: "accepted",
    search: request.requestRef
  })).some((candidate) => candidate.id === request.id));
  assert((await listSalesStockRequests({
    authorizedDestinationLocationIds: [1],
    bucket: "completed",
    search: request.requestRef
  })).some((candidate) => candidate.id === request.id));
  const reservation = await query(
    `SELECT status FROM sales_stock_transfer_reservations reservation
       JOIN sales_stock_transfer_lines line ON line.id = reservation.transfer_line_id
      WHERE line.transfer_id = $1`,
    [transfer.id]
  );
  assert.equal(reservation.rows[0].status, "released");

  await query(
    `UPDATE transfer_orders
        SET status = 'B', status_text = 'Pending Fulfillment',
            status_updated_at = '2000-01-01T00:00:00.000Z'
      WHERE netsuite_id = $1`,
    [remoteId]
  );
  const stale = await reconcileStockRequestTransferWebhook({ id: remoteId });
  assert.equal(stale.stale, true);
  assert.equal((await getStockTransfer(transfer.id)).status, "closed");
  await query(
    `UPDATE transfer_orders
        SET status_updated_at = now() + interval '1 hour'
      WHERE netsuite_id = $1`,
    [remoteId]
  );
  const terminal = await reconcileStockRequestTransferWebhook({ id: remoteId });
  assert.equal(terminal.terminal, true);
  assert.equal((await getStockTransfer(transfer.id)).status, "closed");
});

test("Sales and SCM list filters are combined server-side and returned requests sort first", async () => {
  const ordinary = await createSalesStockRequest({
    destinationLocationId: 1,
    lines: [conversionLine({ sourceLocationId: 28, pallets: 0, pieces: 1 })]
  }, { operatorId: actor, authorizedDestinationLocationIds: [1] });
  const attentionBase = await createSalesStockRequest({
    destinationLocationId: 1,
    lines: [conversionLine({ sourceLocationId: 15, pallets: 0, pieces: 1 })]
  }, { operatorId: actor, authorizedDestinationLocationIds: [1] });
  const attention = await decideSalesStockRequestLines(attentionBase.id, {
    expectedRevision: attentionBase.revision,
    lineIds: [attentionBase.lines[0].id],
    decision: "request_changes",
    reason: "Please review."
  }, { operatorId: actor });
  await query(
    `UPDATE sales_stock_requests
        SET created_at = CASE WHEN id = $1 THEN '2040-01-01T17:00:00Z'::timestamptz ELSE '2040-01-02T17:00:00Z'::timestamptz END,
            updated_at = CASE WHEN id = $1 THEN '2040-01-01T17:00:00Z'::timestamptz ELSE '2040-01-03T17:00:00Z'::timestamptz END
      WHERE id IN ($1, $2)`,
    [attention.id, ordinary.id]
  );

  const prioritized = await listSalesStockRequests({
    authorizedDestinationLocationIds: [1],
    bucket: "pending",
    vendor: `Vendor Paver ${seed}`,
    limit: 200
  });
  assert.equal(prioritized[0].id, attention.id);
  const salesFiltered = await listSalesStockRequests({
    authorizedDestinationLocationIds: [1],
    bucket: "pending",
    vendor: `Vendor Paver ${seed}`,
    requestDate: "2040-01-01",
    sourceLocationId: 15,
    limit: 200
  });
  assert.deepEqual(salesFiltered.map((candidate) => candidate.id), [attention.id]);
  const scmFiltered = await listScmStockRequests({
    queue: "request",
    vendor: `Vendor Paver ${seed}`,
    requestDate: "2040-01-01",
    sourceLocationId: 15,
    destinationLocationId: 1,
    limit: 200
  });
  assert.deepEqual(scmFiltered.map((candidate) => candidate.id), [attention.id]);
  const allOptions = await listStockRequestFilterOptions();
  assert(allOptions.vendors.includes(`Vendor Paver ${seed}`));
  assert.deepEqual(allOptions.sourceYards.map((yard) => yard.locationId), [1, 28, 15, 26]);
  assert.deepEqual(allOptions.destinationYards.map((yard) => yard.locationId), [1, 28, 15, 26]);
  const salesOptions = await listStockRequestFilterOptions({ authorizedDestinationLocationIds: [1] });
  assert(salesOptions.vendors.includes(`Vendor Paver ${seed}`));
  assert.deepEqual(salesOptions.destinationYards.map((yard) => yard.locationId), [1]);
  const noYardOptions = await listStockRequestFilterOptions({ authorizedDestinationLocationIds: [] });
  assert.deepEqual(noYardOptions.vendors, []);
  assert.deepEqual(noYardOptions.sourceYards.map((yard) => yard.locationId), [1, 28, 15, 26]);
  assert.deepEqual(noYardOptions.destinationYards, []);
  await assert.rejects(
    () => listScmStockRequests({ queue: "request", requestDate: "2040-99-99" }),
    /valid request date/i
  );
  await assert.rejects(
    () => listScmStockRequests({ queue: "request", requestDate: "August 11, 2040" }),
    /valid request date/i
  );
  await assert.rejects(
    () => listSalesStockRequests({ authorizedDestinationLocationIds: [1], sourceLocationId: 999 }),
    /supported source yard/i
  );
});
