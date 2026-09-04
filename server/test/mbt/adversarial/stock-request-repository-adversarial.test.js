import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import {
  cancelSalesStockRequest,
  claimStockTransferConfirmation,
  claimStockTransferPrint,
  convertSalesStockRequestLines,
  createSalesStockRequest,
  decideSalesStockRequestLines,
  getSalesStockRequest,
  getStockTransfer,
  listScmStockRequests,
  resubmitSalesStockRequest,
  reviseStockTransferQuantities,
  updateSalesStockRequest
} from "../../../src/stock-request-repository.js";

after(closeDb);

const seed = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const baseId = 9_700_000_000_000 + Number(seed.slice(-8)) * 100;
const actor = `stock-request-adversarial-${seed}`;
const itemId = baseId + 1;

function line(overrides = {}) {
  return {
    itemId,
    sourceLocationId: 28,
    pallets: 0,
    pieces: 1,
    ...overrides
  };
}

async function create(lines = [line()]) {
  return createSalesStockRequest({ destinationLocationId: 1, lines }, {
    operatorId: actor,
    authorizedDestinationLocationIds: [1]
  });
}

async function convert(request) {
  const converted = await convertSalesStockRequestLines(request.id, {
    expectedRevision: request.revision,
    lineIds: request.lines.map((candidate) => candidate.id)
  }, { operatorId: actor });
  return converted.transfers[0];
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
     ) VALUES ($1,$2,$2,'Adversarial stock request fixture','EA',10,5,2,1)`,
    [itemId, `STOCK-REQ-ADVERSARIAL-${seed}`]
  );
  for (const locationId of [1, 28, 15, 26]) {
    await query(
      `INSERT INTO inventory_balances (
         item_id, location_id, location, quantity_on_hand, quantity_available, synced_at
       ) VALUES ($1,$2,$3,100,100,now())`,
      [itemId, locationId, String(locationId)]
    );
  }
});

test("invalid IDs, revisions, routes, line counts, and cached over-allocation fail without creating a request", async () => {
  const beforeCount = await query("SELECT COUNT(*)::int AS count FROM sales_stock_requests WHERE requested_by = $1", [actor]);
  await assert.rejects(() => getSalesStockRequest(0, { authorizedDestinationLocationIds: [1] }), /valid stock request ID/i);
  await assert.rejects(() => create([]), /between 1 and 100 lines/i);
  await assert.rejects(() => create([line({ sourceLocationId: 999 })]), /supported source yard/i);
  await assert.rejects(() => create([line({ sourceLocationId: 1 })]), /must be different/i);
  await assert.rejects(
    () => create([line({ pieces: 101 })]),
    (error) => error?.status === 409 && error?.code === "STOCK_REQUEST_AVAILABILITY_EXCEEDED"
  );
  const request = await create();
  await assert.rejects(
    () => updateSalesStockRequest(request.id, {
      expectedRevision: 0,
      destinationLocationId: 1,
      lines: [{ id: request.lines[0].id, ...line() }]
    }, { operatorId: actor, authorizedDestinationLocationIds: [1] }),
    /positive expectedRevision/i
  );
  const afterCount = await query("SELECT COUNT(*)::int AS count FROM sales_stock_requests WHERE requested_by = $1", [actor]);
  assert.equal(afterCount.rows[0].count, beforeCount.rows[0].count + 1);
});

test("Sales edits and cancellation reject stale, terminal, and post-decision mutations", async () => {
  const stale = await create();
  await assert.rejects(
    () => updateSalesStockRequest(stale.id, {
      expectedRevision: stale.revision + 1,
      destinationLocationId: 1,
      lines: [{ id: stale.lines[0].id, ...line() }]
    }, { operatorId: actor, authorizedDestinationLocationIds: [1] }),
    (error) => error?.code === "STOCK_REQUEST_REVISION_CONFLICT"
  );
  await assert.rejects(
    () => cancelSalesStockRequest(stale.id, { expectedRevision: stale.revision + 1 }, {
      operatorId: actor,
      authorizedDestinationLocationIds: [1]
    }),
    (error) => error?.code === "STOCK_REQUEST_REVISION_CONFLICT"
  );
  const cancelled = await cancelSalesStockRequest(stale.id, { expectedRevision: stale.revision }, {
    operatorId: actor,
    authorizedDestinationLocationIds: [1]
  });
  await assert.rejects(
    () => updateSalesStockRequest(cancelled.id, {
      expectedRevision: cancelled.revision,
      destinationLocationId: 1,
      lines: [{ id: cancelled.lines[0].id, ...line() }]
    }, { operatorId: actor, authorizedDestinationLocationIds: [1] }),
    (error) => error?.code === "STOCK_REQUEST_LOCKED"
  );

  const decided = await create([line({ pieces: 1 }), line({ sourceLocationId: 15, pieces: 2 })]);
  const returned = await decideSalesStockRequestLines(decided.id, {
    expectedRevision: decided.revision,
    lineIds: [decided.lines[0].id],
    decision: "request_changes",
    reason: "Use a different source."
  }, { operatorId: actor });
  await assert.rejects(
    () => updateSalesStockRequest(returned.id, {
      expectedRevision: returned.revision,
      lines: [{ id: returned.lines[1].id, ...line({ sourceLocationId: 15, pieces: 3 }) }]
    }, { operatorId: actor, authorizedDestinationLocationIds: [1] }),
    (error) => error?.code === "STOCK_REQUEST_LINE_LOCKED"
  );
  await assert.rejects(
    () => resubmitSalesStockRequest(returned.id, { expectedRevision: returned.revision + 1 }, {
      operatorId: actor,
      authorizedDestinationLocationIds: [1]
    }),
    (error) => error?.code === "STOCK_REQUEST_REVISION_CONFLICT"
  );
  await assert.rejects(
    () => cancelSalesStockRequest(returned.id, { expectedRevision: returned.revision }, {
      operatorId: actor,
      authorizedDestinationLocationIds: [1]
    }),
    (error) => error?.code === "STOCK_REQUEST_LOCKED"
  );
});

test("a pre-decision Sales edit can append a new line while preserving the first line", async () => {
  const request = await create();
  const edited = await updateSalesStockRequest(request.id, {
    expectedRevision: request.revision,
    destinationLocationId: 1,
    lines: [
      { id: request.lines[0].id, ...line({ pieces: 2 }) },
      line({ sourceLocationId: 15, pieces: 3 })
    ]
  }, { operatorId: actor, authorizedDestinationLocationIds: [1] });
  assert.equal(edited.lines.length, 2);
  assert.deepEqual(edited.lines.map((candidate) => candidate.salesQty), [2, 3]);
});

test("invalid, empty, repeated, and stale SCM decisions or conversions fail closed", async () => {
  const request = await create();
  await assert.rejects(
    () => decideSalesStockRequestLines(request.id, {
      expectedRevision: request.revision + 1,
      lineIds: [request.lines[0].id],
      decision: "reject",
      reason: "Stale screen."
    }, { operatorId: actor }),
    (error) => error?.code === "STOCK_REQUEST_REVISION_CONFLICT"
  );
  await assert.rejects(
    () => decideSalesStockRequestLines(request.id, {
      expectedRevision: request.revision,
      lineIds: [request.lines[0].id],
      decision: "accept",
      reason: "invalid operation"
    }, { operatorId: actor }),
    /Reject or Request Changes/i
  );
  await assert.rejects(
    () => decideSalesStockRequestLines(request.id, {
      expectedRevision: request.revision,
      lineIds: [],
      decision: "reject",
      reason: "No lines selected."
    }, { operatorId: actor }),
    /select at least one/i
  );
  await assert.rejects(
    () => convertSalesStockRequestLines(request.id, {
      expectedRevision: request.revision + 1,
      lineIds: [request.lines[0].id]
    }, { operatorId: actor }),
    (error) => error?.code === "STOCK_REQUEST_REVISION_CONFLICT"
  );
  const rejected = await decideSalesStockRequestLines(request.id, {
    expectedRevision: request.revision,
    lineIds: [request.lines[0].id],
    decision: "reject",
    reason: "Use another purchasing method."
  }, { operatorId: actor });
  await assert.rejects(
    () => decideSalesStockRequestLines(request.id, {
      expectedRevision: rejected.revision,
      lineIds: [request.lines[0].id],
      decision: "reject",
      reason: "Repeated decision."
    }, { operatorId: actor }),
    (error) => error?.code === "STOCK_REQUEST_LINE_LOCKED"
  );
  await assert.rejects(
    () => convertSalesStockRequestLines(request.id, {
      expectedRevision: rejected.revision,
      lineIds: [request.lines[0].id]
    }, { operatorId: actor }),
    (error) => error?.code === "STOCK_REQUEST_LINE_LOCKED"
  );
});

test("Pending TO list branch and confirmation/print guards expose no half-owned remote work", async () => {
  const request = await create();
  const transfer = await convert(request);
  const pending = await listScmStockRequests({ queue: "pending_to", search: request.requestRef });
  assert.equal(pending[0].id, request.id);
  await assert.rejects(
    () => claimStockTransferConfirmation(transfer.id, {
      expectedRevision: transfer.revision + 1,
      requestId: `stale-${seed}-${transfer.id}`
    }, { operatorId: actor }),
    (error) => error?.code === "STOCK_TRANSFER_REVISION_CONFLICT"
  );
  await assert.rejects(
    () => claimStockTransferPrint(transfer.id, { operatorId: actor }),
    /real NetSuite Transfer Order/i
  );
  await query(
    `UPDATE sales_stock_transfers
        SET status = 'pending_fulfillment',
            netsuite_transfer_order_id = $2,
            netsuite_transfer_order_ref = $3
      WHERE id = $1`,
    [transfer.id, baseId + transfer.id + 10, `TO${baseId + transfer.id + 10}`]
  );
  await assert.rejects(
    () => claimStockTransferConfirmation(transfer.id, {
      expectedRevision: transfer.revision,
      requestId: `confirmed-${seed}-${transfer.id}`
    }, { operatorId: actor }),
    (error) => error?.code === "STOCK_TRANSFER_ALREADY_CONFIRMED"
  );
});

test("TO revisions require every line, allow an explicit backorder, and reject malformed PALLET values", async () => {
  const request = await create([line({ sourceLocationId: 26, pieces: 5 })]);
  const transfer = await convert(request);
  await assert.rejects(
    () => reviseStockTransferQuantities(transfer.id, {
      expectedRevision: transfer.revision,
      requestId: `missing-lines-${seed}-${transfer.id}`,
      lines: []
    }, { operatorId: actor }),
    /include every material line/i
  );
  await query(
    `UPDATE inventory_balances SET quantity_available = 5
      WHERE item_id = $1 AND location_id = 26`,
    [itemId]
  );
  const revised = await reviseStockTransferQuantities(transfer.id, {
    expectedRevision: transfer.revision,
    requestId: `backorder-${seed}-${transfer.id}`,
    lines: [{ requestLineId: transfer.lines[0].id, pieces: 6 }]
  }, { operatorId: actor });
  assert.equal(revised.lines[0].salesQty, 6);
  await assert.rejects(
    () => reviseStockTransferQuantities(transfer.id, {
      expectedRevision: revised.revision,
      requestId: `pallet-${seed}-${transfer.id}`,
      palletQuantity: -1,
      lines: [{ requestLineId: transfer.lines[0].id, pieces: 6 }]
    }, { operatorId: actor }),
    /PALLET item quantity/i
  );
});

test("TO structural revisions fail atomically when a database guard refuses a line removal or move", async () => {
  const removableRequest = await create([line({ sourceLocationId: 15, pieces: 2 })]);
  const removableTransfer = await convert(removableRequest);
  const removableLineId = removableTransfer.lines[0].id;
  const deleteFunction = `stock_request_skip_delete_${seed}`;
  const deleteTrigger = `stock_request_skip_delete_trigger_${seed}`;
  await query(
    `CREATE FUNCTION ${deleteFunction}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF OLD.request_line_id = ${removableLineId} THEN RETURN NULL; END IF;
         RETURN OLD;
       END;
     $$`
  );
  await query(
    `CREATE TRIGGER ${deleteTrigger}
       BEFORE DELETE ON sales_stock_transfer_lines
       FOR EACH ROW EXECUTE FUNCTION ${deleteFunction}()`
  );
  try {
    await assert.rejects(
      () => reviseStockTransferQuantities(removableTransfer.id, {
        expectedRevision: removableTransfer.revision,
        requestId: `guarded-delete-${seed}-${removableTransfer.id}`,
        palletQuantity: 0,
        lines: [{ requestLineId: removableLineId, remove: true }]
      }, { operatorId: actor }),
      /material line was not found/i
    );
  } finally {
    await query(`DROP TRIGGER ${deleteTrigger} ON sales_stock_transfer_lines`);
    await query(`DROP FUNCTION ${deleteFunction}()`);
  }
  const afterDeleteGuard = await getStockTransfer(removableTransfer.id);
  assert.equal(afterDeleteGuard.status, "pending_local");
  assert.deepEqual(afterDeleteGuard.lines.map((candidate) => candidate.id), [removableLineId]);

  const movableRequest = await create([line({ pieces: 2 }), line({ pieces: 3 })]);
  const movableTransfer = await convert(movableRequest);
  const movedLineId = movableTransfer.lines[0].id;
  const moveFunction = `stock_request_skip_move_${seed}`;
  const moveTrigger = `stock_request_skip_move_trigger_${seed}`;
  await query(
    `CREATE FUNCTION ${moveFunction}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.request_line_id = ${movedLineId} AND NEW.transfer_id <> OLD.transfer_id THEN RETURN NULL; END IF;
         RETURN NEW;
       END;
     $$`
  );
  await query(
    `CREATE TRIGGER ${moveTrigger}
       BEFORE UPDATE OF transfer_id ON sales_stock_transfer_lines
       FOR EACH ROW EXECUTE FUNCTION ${moveFunction}()`
  );
  try {
    await assert.rejects(
      () => reviseStockTransferQuantities(movableTransfer.id, {
        expectedRevision: movableTransfer.revision,
        requestId: `guarded-move-${seed}-${movableTransfer.id}`,
        palletQuantity: 1,
        lines: [
          { requestLineId: movedLineId, sourceLocationId: 15, pallets: 0, pieces: 2 },
          { requestLineId: movableTransfer.lines[1].id, sourceLocationId: 28, pallets: 0, pieces: 3 }
        ]
      }, { operatorId: actor }),
      /not every selected line could be moved/i
    );
  } finally {
    await query(`DROP TRIGGER ${moveTrigger} ON sales_stock_transfer_lines`);
    await query(`DROP FUNCTION ${moveFunction}()`);
  }
  const afterMoveGuard = await getStockTransfer(movableTransfer.id);
  assert.equal(afterMoveGuard.revision, movableTransfer.revision);
  assert.deepEqual(afterMoveGuard.lines.map((candidate) => candidate.sourceLocationId), [28, 28]);
  const transferCount = await query(
    "SELECT COUNT(*)::int AS count FROM sales_stock_transfers WHERE request_id = $1",
    [movableRequest.id]
  );
  assert.equal(transferCount.rows[0].count, 1);
});
