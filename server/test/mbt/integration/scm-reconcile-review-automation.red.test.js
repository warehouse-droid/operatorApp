import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import {
  loadLocalScmReconciliationOrder,
  reconcileScmOrderFamily
} from "../../../src/scm-reconciliation-repository.js";

after(closeDb);

async function inRollback(operation) {
  const rollback = await beginRollbackContext();
  try {
    return await rollback.run(operation);
  } finally {
    await rollback.rollback();
  }
}

function fixtureIdentity() {
  const suffix = crypto.randomUUID().replaceAll("-", "").toUpperCase();
  const numeric = Number.parseInt(suffix.slice(0, 10), 16);
  return {
    suffix,
    sourceId: 8_700_000_000 + numeric,
    lineKey: 7_700_000_000 + numeric
  };
}

async function insertTransferOrder({
  sourceId,
  sourceRef,
  lineKey,
  quantity = 10,
  fulfilled = 0,
  received = 0,
  dispatchPlanned = false,
  dispatchPlanDate = null
}) {
  await query(
    `INSERT INTO transfer_orders (
       netsuite_id, tranid, trandate, status, status_text,
       from_location_id, from_location, to_location_id, to_location,
       fulfillment_status, receiving_status, netsuite_active, synced_at,
       dispatch_planned, dispatch_plan_date, dispatch_planned_at
     ) VALUES (
       $1, $2, DATE '2026-08-29', $3, $4,
       15, 'Source Yard', 1, 'Destination Yard',
       $5, $6, true, now(), $7, $8,
       CASE WHEN $7 THEN now() ELSE NULL END
     )`,
    [
      sourceId,
      sourceRef,
      fulfilled > 0 ? "F" : "B",
      fulfilled > 0
        ? "Transfer Order : Pending Receipt"
        : "Transfer Order : Pending Fulfillment",
      fulfilled > 0 ? "fulfilled" : "not_fulfilled",
      received > 0 ? "received" : "not_received",
      dispatchPlanned,
      dispatchPlanDate
    ]
  );
  const raw = JSON.stringify({
    sourceLineAliases: [String(lineKey)],
    orderLine: String(lineKey),
    orderLineAliases: [String(lineKey)],
    logicalLineIdentity: `reconcile-review:${lineKey}`,
    identityStatus: "exact"
  });
  const inserted = await query(
    `INSERT INTO transfer_order_lines (
       line_stage, transfer_order_id, line_id, item_id, item_name, sku,
       quantity, unit, location_id, location, loaded_qty,
       netsuite_received_qty, netsuite_active, raw
     ) VALUES
       ('outbound', $1, $2, 820001, 'Review automation item', 'REVIEW-AUTO',
        $3, 'EA', 15, 'Source Yard', $4, 0, true, $6::jsonb),
       ('receiving', $1, $2, 820001, 'Review automation item', 'REVIEW-AUTO',
        $3, 'EA', 1, 'Destination Yard', 0, $5, true, $6::jsonb)
     RETURNING id, line_stage`,
    [sourceId, lineKey, quantity, fulfilled, received, raw]
  );
  return {
    outboundLineId: Number(inserted.rows.find((row) => row.line_stage === "outbound").id),
    receivingLineId: Number(inserted.rows.find((row) => row.line_stage === "receiving").id)
  };
}

function authoritativeTransfer({
  sourceId,
  sourceRef,
  lineKey,
  quantity,
  fulfilled = 0,
  received = 0
}) {
  const line = (stage, progress, locationId, location) => ({
    stage,
    sourceLineKey: String(lineKey),
    sourceLineAliases: [String(lineKey)],
    orderLine: String(lineKey),
    orderLineAliases: [String(lineKey)],
    logicalLineIdentity: `reconcile-review:${lineKey}`,
    identityStatus: "exact",
    itemId: 820001,
    itemName: "Review automation item",
    sku: "REVIEW-AUTO",
    quantity,
    cumulativeProgressQuantity: progress,
    unit: "EA",
    locationId,
    location
  });
  return {
    kind: "TO",
    id: sourceId,
    tranid: sourceRef,
    status: fulfilled > 0 ? "F" : "B",
    statusText: fulfilled > 0
      ? "Transfer Order : Pending Receipt"
      : "Transfer Order : Pending Fulfillment",
    sourceLocationId: 15,
    sourceLocation: "Source Yard",
    destinationLocationId: 1,
    destinationLocation: "Destination Yard",
    lines: [
      line("outbound", fulfilled, 15, "Source Yard"),
      line("receiving", received, 1, "Destination Yard")
    ]
  };
}

async function insertPriorState({ sourceId, sourceRef, ordered = 10 }) {
  await query(
    `INSERT INTO scm_reconciliation_order_state (
       order_kind, source_order_netsuite_id, source_order_ref,
       application_status, reconciliation_status, reconciliation_source,
       ordered_qty, remaining_qty, destination_remaining_qty,
       exact_allocation, quantity_summary, reconciled_at
     ) VALUES (
       'TO', $1, $2, 'Queued', 'ok', 'system',
       $3::numeric, $3::numeric, $3::numeric, true,
       jsonb_build_object('family', jsonb_build_object(
         'ordered', $3::numeric, 'fulfilled', 0, 'received', 0,
         'remaining', $3::numeric, 'destinationRemaining', $3::numeric
       )), now() - interval '1 minute'
     )`,
    [sourceId, sourceRef, ordered]
  );
}

test("RAR-I1: a reconciliation-created Queued schedule is not dispatch planning evidence", async () => {
  await inRollback(async () => {
    const { suffix, sourceId, lineKey } = fixtureIdentity();
    const sourceRef = `TO-RAR-QUEUED-${suffix}`;
    await insertTransferOrder({ sourceId, sourceRef, lineKey });
    await query(
      `INSERT INTO scm_transport_schedule (
         order_kind, source_table, source_id, order_ref, status,
         created_by, updated_by
       ) VALUES (
         'TO', 'transfer_orders', $1, $2, 'Queued',
         'reconciliation', 'reconciliation'
       )`,
      [sourceId, sourceRef]
    );

    const loaded = await loadLocalScmReconciliationOrder("TO", sourceId);
    assert.equal(
      loaded.dispatchPlanned,
      false,
      "A plain schedule projection must not turn an unplanned TO into an operational order."
    );
  });
});

test("RAR-I2: an exact unsplit decrease auto-reconciles even when the TO is planned", async () => {
  await inRollback(async () => {
    const { suffix, sourceId, lineKey } = fixtureIdentity();
    const sourceRef = `TO-RAR-DECREASE-${suffix}`;
    await insertTransferOrder({
      sourceId,
      sourceRef,
      lineKey,
      quantity: 10,
      dispatchPlanned: true,
      dispatchPlanDate: "2026-08-29"
    });
    await query(
      `INSERT INTO scm_transport_schedule (
         order_kind, source_table, source_id, order_ref, status, eta_date,
         created_by, updated_by
       ) VALUES (
         'TO', 'transfer_orders', $1, $2, 'Planned', DATE '2026-08-29',
         'dispatch-test', 'dispatch-test'
       )`,
      [sourceId, sourceRef]
    );
    await insertPriorState({ sourceId, sourceRef, ordered: 10 });

    const result = await reconcileScmOrderFamily({
      kind: "TO",
      sourceOrderId: sourceId,
      source: "manual",
      dryRun: true,
      authoritativeOrder: authoritativeTransfer({
        sourceId,
        sourceRef,
        lineKey,
        quantity: 8
      })
    });

    assert.equal(result.reconciliationStatus, "ok");
    assert.equal(result.applicationStatus, "Planned");
    assert.equal(result.quantities.ordered, 8);
    assert.equal(result.reason, "");
  });
});

test("RAR-I3: an active split greater than the amended source quantity stays in review", async () => {
  await inRollback(async () => {
    const { suffix, sourceId, lineKey } = fixtureIdentity();
    const sourceRef = `TO-RAR-SOURCE-${suffix}`;
    const childId = -sourceId;
    const childRef = `${sourceRef}-S1`;
    const source = await insertTransferOrder({ sourceId, sourceRef, lineKey, quantity: 10 });
    const child = await insertTransferOrder({
      sourceId: childId,
      sourceRef: childRef,
      lineKey: -lineKey,
      quantity: 6
    });
    const split = await query(
      `INSERT INTO dispatch_scm_to_splits (
         source_to_id, source_to_ref, split_to_id, split_to_ref,
         status, created_by
       ) VALUES ($1, $2, $3, $4, 'active', 'reconcile-review-test')
       RETURNING id`,
      [sourceId, sourceRef, childId, childRef]
    );
    await query(
      `INSERT INTO dispatch_scm_to_split_lines (
         split_id, source_line_stage, source_line_id,
         split_line_stage, split_line_id, netsuite_source_line_key,
         item_id, sku, item_name, sales_qty, requested_sales_qty, unit
       ) VALUES (
         $1, 'outbound', $2, 'outbound', $3, $4,
         820001, 'REVIEW-AUTO', 'Review automation item', 6, 6, 'EA'
       )`,
      [split.rows[0].id, source.outboundLineId, child.outboundLineId, String(lineKey)]
    );

    const result = await reconcileScmOrderFamily({
      kind: "TO",
      sourceOrderId: sourceId,
      source: "manual",
      dryRun: true,
      authoritativeOrder: authoritativeTransfer({
        sourceId,
        sourceRef,
        lineKey,
        quantity: 4
      })
    });

    assert.equal(result.reconciliationStatus, "review");
    assert.match(result.reason, /active split|split quantity|current capacity/i);
  });
});

test("RAR-I4: safe apply auto-resolves the old case and unblocks only its schedule idempotently", async () => {
  await inRollback(async () => {
    const { suffix, sourceId, lineKey } = fixtureIdentity();
    const sourceRef = `TO-RAR-RESOLVE-${suffix}`;
    await insertTransferOrder({ sourceId, sourceRef, lineKey, quantity: 8 });
    const state = await query(
      `INSERT INTO scm_reconciliation_order_state (
         order_kind, source_order_netsuite_id, source_order_ref,
         application_status, reconciliation_status, reconciliation_reason,
         reconciliation_source, ordered_qty, remaining_qty,
         destination_remaining_qty, exact_allocation, reconciled_at
       ) VALUES (
         'TO', $1, $2, 'Queued', 'review',
         'The NetSuite quantity decrease would alter a split that is already planned or operational.',
         'system', 8, 8, 8, true, now() - interval '1 minute'
       ) RETURNING id`,
      [sourceId, sourceRef]
    );
    await query(
      `INSERT INTO scm_transport_schedule (
         order_kind, source_table, source_id, order_ref, status,
         reconciliation_order_state_id, reconciliation_blocked,
         created_by, updated_by
       ) VALUES (
         'TO', 'transfer_orders', $1, $2, 'Queued', $3, true,
         'reconciliation', 'reconciliation'
       )`,
      [sourceId, sourceRef, state.rows[0].id]
    );
    const review = await query(
      `INSERT INTO scm_reconciliation_review_cases (
         case_key, order_state_id, review_code, severity, dismissible,
         status, reason
       ) VALUES (
         $1, $2, 'reconciliation_conflict', 'blocking', false,
         'open', 'The NetSuite quantity decrease would alter a split that is already planned or operational.'
       ) RETURNING id`,
      [`TO:${sourceId}:reconciliation_conflict`, state.rows[0].id]
    );
    const authoritativeOrder = authoritativeTransfer({
      sourceId,
      sourceRef,
      lineKey,
      quantity: 8
    });

    const first = await reconcileScmOrderFamily({
      kind: "TO",
      sourceOrderId: sourceId,
      source: "system",
      authoritativeOrder
    });
    const second = await reconcileScmOrderFamily({
      kind: "TO",
      sourceOrderId: sourceId,
      source: "system",
      authoritativeOrder
    });
    assert.equal(first.reconciliationStatus, "ok");
    assert.equal(second.reconciliationStatus, "ok");

    const persisted = await query(
      `SELECT state.reconciliation_status, state.reconciliation_reason,
              schedule.reconciliation_blocked,
              review.status AS review_status,
              review.resolution_action,
              COUNT(resolution.id)::int AS resolution_count
         FROM scm_reconciliation_order_state state
         JOIN scm_transport_schedule schedule
           ON schedule.reconciliation_order_state_id = state.id
         JOIN scm_reconciliation_review_cases review
           ON review.order_state_id = state.id
         LEFT JOIN scm_reconciliation_review_resolutions resolution
           ON resolution.review_case_id = review.id
        WHERE state.id = $1 AND review.id = $2
        GROUP BY state.reconciliation_status, state.reconciliation_reason,
                 schedule.reconciliation_blocked, review.status,
                 review.resolution_action`,
      [state.rows[0].id, review.rows[0].id]
    );
    assert.deepEqual(persisted.rows, [{
      reconciliation_status: "ok",
      reconciliation_reason: null,
      reconciliation_blocked: false,
      review_status: "resolved",
      resolution_action: "auto_resolve",
      resolution_count: 1
    }]);
  });
});

test("RAR-I5: a planned TO quantity increase still requires capacity review", async () => {
  await inRollback(async () => {
    const { suffix, sourceId, lineKey } = fixtureIdentity();
    const sourceRef = `TO-RAR-INCREASE-${suffix}`;
    await insertTransferOrder({
      sourceId,
      sourceRef,
      lineKey,
      quantity: 8,
      dispatchPlanned: true,
      dispatchPlanDate: "2026-08-29"
    });
    const result = await reconcileScmOrderFamily({
      kind: "TO",
      sourceOrderId: sourceId,
      source: "manual",
      dryRun: true,
      authoritativeOrder: authoritativeTransfer({
        sourceId,
        sourceRef,
        lineKey,
        quantity: 10
      })
    });
    assert.equal(result.reconciliationStatus, "review");
    assert.match(result.reason, /changed planned source line/i);
  });
});
