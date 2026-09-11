import assert from "node:assert/strict";
import { closeDb, query } from "../src/db.js";
import { retryScmReconciliationOrder } from "../src/scm-reconciliation-service.js";

function positiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

const values = (prefix) => process.argv.slice(2)
  .filter((argument) => argument.startsWith(prefix))
  .map((argument) => argument.slice(prefix.length));
const orderIds = [...new Set(values("--order=").map(positiveId).filter(Boolean))];
const apply = process.argv.slice(2).includes("--apply");

if (!apply) {
  throw new Error("Production repair is disabled unless --apply is explicitly present.");
}
if (!orderIds.length) {
  throw new Error("Pass at least one positive NetSuite PO ID with --order=<id>.");
}

async function activeSplitAuthority() {
  const result = await query(
    `SELECT split.source_po_id,
            split.id AS split_id,
            split.split_po_ref,
            child.destination_location_id,
            child.destination_location,
            child_line.id AS child_line_id,
            child_line.location_id AS child_line_location_id,
            child_line.location AS child_line_location,
            schedule.id AS schedule_id,
            schedule.status AS schedule_status
       FROM dispatch_scm_po_splits split
       JOIN purchase_orders child
         ON child.netsuite_id = split.split_po_id
       LEFT JOIN dispatch_scm_po_split_lines ledger
         ON ledger.split_id = split.id
       LEFT JOIN purchase_order_lines child_line
         ON child_line.id = ledger.split_line_id
       LEFT JOIN LATERAL (
         SELECT candidate.id, candidate.status
           FROM scm_transport_schedule candidate
          WHERE candidate.order_kind = 'PO'
            AND (
              candidate.source_id = split.split_po_id
              OR lower(candidate.order_ref) = lower(split.split_po_ref)
            )
          ORDER BY CASE WHEN candidate.source_id = split.split_po_id THEN 0 ELSE 1 END,
                   candidate.updated_at DESC,
                   candidate.id DESC
          LIMIT 1
       ) schedule ON true
      WHERE split.source_po_id = ANY($1::bigint[])
        AND split.status = 'active'
      ORDER BY split.source_po_id, split.id, child_line.id NULLS LAST`,
    [orderIds]
  );
  return result.rows.map((row) => ({
    sourcePoId: Number(row.source_po_id),
    splitId: Number(row.split_id),
    splitPoRef: row.split_po_ref,
    childLineId: row.child_line_id === null ? null : Number(row.child_line_id),
    destinationLocationId: row.destination_location_id === null
      ? null
      : Number(row.destination_location_id),
    destinationLocation: row.destination_location || "",
    childLineLocationId: row.child_line_location_id === null
      ? null
      : Number(row.child_line_location_id),
    childLineLocation: row.child_line_location || "",
    scheduleId: row.schedule_id === null ? null : Number(row.schedule_id),
    scheduleStatus: row.schedule_status || ""
  }));
}

async function repairedOrderStates() {
  const result = await query(
    `SELECT state.source_order_netsuite_id,
            state.source_order_ref,
            state.application_status,
            state.reconciliation_status,
            state.reconciliation_reason,
            COUNT(DISTINCT review.id) FILTER (WHERE review.status = 'open')::int AS open_review_count,
            COUNT(DISTINCT snapshot.id) FILTER (
              WHERE snapshot.transaction_type = 'IR'
                AND NULLIF(BTRIM(snapshot.transaction_memo), '') IS NOT NULL
            )::int AS receipt_memo_count
       FROM scm_reconciliation_order_state state
       LEFT JOIN scm_reconciliation_review_cases review
         ON review.order_state_id = state.id
       LEFT JOIN scm_reconciliation_transaction_snapshots snapshot
         ON snapshot.source_order_kind = state.order_kind
        AND snapshot.source_order_netsuite_id = state.source_order_netsuite_id
        AND snapshot.is_deleted = false
      WHERE state.order_kind = 'PO'
        AND state.source_order_netsuite_id = ANY($1::bigint[])
      GROUP BY state.id
      ORDER BY state.source_order_netsuite_id`,
    [orderIds]
  );
  return result.rows.map((row) => ({
    sourceOrderId: Number(row.source_order_netsuite_id),
    sourceOrderRef: row.source_order_ref,
    applicationStatus: row.application_status,
    reconciliationStatus: row.reconciliation_status,
    reconciliationReason: row.reconciliation_reason || "",
    openReviewCount: Number(row.open_review_count),
    receiptMemoCount: Number(row.receipt_memo_count)
  }));
}

try {
  const before = await activeSplitAuthority();
  const runs = [];
  for (const orderId of orderIds) {
    const run = await retryScmReconciliationOrder({
      kind: "PO",
      orderId,
      actor: "scm-ir-split-reference-production-repair",
      includeTerminalOrders: true
    });
    runs.push({
      orderId,
      runId: Number(run?.id || 0) || null,
      status: run?.status || "",
      error: run?.error_message || ""
    });
  }
  const [after, states] = await Promise.all([
    activeSplitAuthority(),
    repairedOrderStates()
  ]);
  assert.deepEqual(
    after,
    before,
    "Targeted reconciliation changed a user-owned split status or destination."
  );
  assert.deepEqual(
    states.map((state) => state.sourceOrderId),
    [...orderIds].sort((left, right) => left - right),
    "A requested source PO has no reconciliation state after repair."
  );
  assert.ok(
    states.every((state) => (
      state.openReviewCount === 0
      && state.reconciliationStatus !== "review"
      && !state.reconciliationReason
    )),
    "At least one requested source PO still has an open reconciliation review."
  );
  process.stdout.write(`${JSON.stringify({
    mode: "production_apply",
    orderIds,
    runs,
    states,
    preservedSplitRows: after.length
  }, null, 2)}\n`);
} finally {
  await closeDb();
}
