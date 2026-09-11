import assert from "node:assert/strict";
import { closeDb, query, withTransaction } from "../src/db.js";
import {
  fetchPoToLinkedTransactionsFromNetSuite,
  fetchPoToReconciliationOrdersFromNetSuite
} from "../src/netsuite.js";
import {
  reconcileScmOrderFamily,
  storeLinkedScmReconciliationTransactions
} from "../src/scm-reconciliation-repository.js";
import { resolveScmReceiptSplitReference } from "../src/scm-ir-split-reference.js";

function positiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

const values = (prefix) => process.argv.slice(2)
  .filter((argument) => argument.startsWith(prefix))
  .map((argument) => argument.slice(prefix.length));
const orderIds = [...new Set(values("--order=").map(positiveId).filter(Boolean))];
const holdSourceIds = new Set(values("--expect-hold-source=").map(positiveId).filter(Boolean));
const requireOk = process.argv.slice(2).includes("--require-ok");

if (!orderIds.length) {
  throw new Error("Pass at least one positive NetSuite PO ID with --order=<id>.");
}

async function activeSplitRows() {
  const result = await query(
    `SELECT split.source_po_id,
            split.id AS split_id,
            split.split_po_id,
            split.split_po_ref,
            split.status AS split_status,
            split.details,
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
  return result.rows;
}

function locationAuthority(rows) {
  return rows.map((row) => ({
    sourcePoId: Number(row.source_po_id),
    splitId: Number(row.split_id),
    splitPoId: Number(row.split_po_id),
    splitPoRef: row.split_po_ref,
    splitStatus: row.split_status,
    destinationLocationId: row.destination_location_id === null
      ? null
      : Number(row.destination_location_id),
    destinationLocation: row.destination_location || "",
    childLineId: row.child_line_id === null ? null : Number(row.child_line_id),
    childLineLocationId: row.child_line_location_id === null
      ? null
      : Number(row.child_line_location_id),
    childLineLocation: row.child_line_location || ""
  }));
}

function replayState(rows) {
  return rows.map((row) => ({
    ...locationAuthority([row])[0],
    scheduleId: row.schedule_id === null ? null : Number(row.schedule_id),
    scheduleStatus: row.schedule_status || ""
  }));
}

function splitTargetsBySource(rows) {
  const result = new Map();
  for (const row of rows) {
    const sourceId = Number(row.source_po_id);
    if (!result.has(sourceId)) {
      result.set(sourceId, new Map());
    }
    const targets = result.get(sourceId);
    if (targets.has(Number(row.split_id))) {
      continue;
    }
    targets.set(Number(row.split_id), {
      targetOrderRef: row.split_po_ref,
      targetOrderRefAliases: [
        row.split_po_ref,
        ...(Array.isArray(row.details?.previousRefs) ? row.details.previousRefs : [])
      ],
      targetKind: "po_split"
    });
  }
  return new Map([...result].map(([sourceId, targets]) => [sourceId, [...targets.values()]]));
}

function auditReceiptReferences(linkedRows, splitRows) {
  const targetsBySource = splitTargetsBySource(splitRows);
  const receipts = new Map();
  for (const row of linkedRows) {
    if (!/^(ItemRcpt|IR)$/i.test(String(row.transactionType || ""))) {
      continue;
    }
    const key = `${row.sourceOrderId}|${row.transactionId}`;
    if (!receipts.has(key)) {
      receipts.set(key, row);
    }
  }
  const resolutions = [...receipts.values()].map((row) => ({
    sourceOrderId: Number(row.sourceOrderId),
    transactionId: Number(row.transactionId),
    transactionRef: row.transactionRef || "",
    transactionMemo: row.transactionMemo || "",
    resolution: resolveScmReceiptSplitReference({
      transactionMemo: row.transactionMemo || "",
      targets: targetsBySource.get(Number(row.sourceOrderId)) || []
    })
  }));
  return {
    receiptCount: resolutions.length,
    matchedCount: resolutions.filter((row) => row.resolution.status === "matched").length,
    absentCount: resolutions.filter((row) => row.resolution.status === "absent").length,
    conflicts: resolutions
      .filter((row) => ["unmatched", "ambiguous"].includes(row.resolution.status))
      .map((row) => ({
        sourceOrderId: row.sourceOrderId,
        transactionRef: row.transactionRef,
        transactionMemo: row.transactionMemo,
        status: row.resolution.status
      }))
  };
}

function conciseResult(result) {
  return {
    orderRef: result.orderRef,
    reconciliationStatus: result.reconciliationStatus,
    applicationStatus: result.applicationStatus,
    reason: result.reason || "",
    quantities: result.quantities,
    targets: Object.fromEntries(Object.entries(result.targets || {}).map(([ref, target]) => [ref, {
      status: target.applicationStatus,
      ordered: target.ordered,
      received: target.received,
      allocationMethods: target.allocationMethods
    }]))
  };
}

try {
  const [orders, linkedRows, beforeRows] = await Promise.all([
    fetchPoToReconciliationOrdersFromNetSuite({
      kind: "PO",
      orderIds,
      targetOnly: true,
      includeOpen: false
    }),
    fetchPoToLinkedTransactionsFromNetSuite(orderIds),
    activeSplitRows()
  ]);
  const fetchedIds = new Set(orders.map((order) => Number(order.id)));
  assert.deepEqual(
    [...fetchedIds].sort((left, right) => left - right),
    [...orderIds].sort((left, right) => left - right),
    "NetSuite did not return every requested source PO."
  );
  const receiptAudit = auditReceiptReferences(linkedRows, beforeRows);
  if (requireOk) {
    assert.deepEqual(receiptAudit.conflicts, [], "An IR memo contains ambiguous or foreign child evidence.");
  }

  const replay = await withTransaction(async () => {
    for (const order of orders) {
      await storeLinkedScmReconciliationTransactions({
        order,
        transactions: linkedRows,
        source: "manual"
      });
    }
    const first = [];
    const second = [];
    for (const order of orders) {
      first.push(await reconcileScmOrderFamily({
        kind: "PO",
        sourceOrderId: order.id,
        source: "manual",
        authoritativeOrder: order
      }));
    }
    const afterFirstRows = await activeSplitRows();
    for (const order of orders) {
      second.push(await reconcileScmOrderFamily({
        kind: "PO",
        sourceOrderId: order.id,
        source: "manual",
        authoritativeOrder: order
      }));
    }
    const afterSecondRows = await activeSplitRows();
    assert.deepEqual(
      locationAuthority(afterFirstRows),
      locationAuthority(beforeRows),
      "Reconciliation changed a user-owned split destination."
    );
    assert.deepEqual(
      replayState(afterSecondRows),
      replayState(afterFirstRows),
      "The second reconciliation replay changed split state."
    );
    for (const sourceId of holdSourceIds) {
      const heldBefore = beforeRows.filter((row) => (
        Number(row.source_po_id) === sourceId && row.schedule_status === "Hold"
      ));
      assert.ok(heldBefore.length > 0, `Expected active HOLD splits for source PO ${sourceId}.`);
      const statusAfter = new Map(afterSecondRows.map((row) => [
        `${row.split_id}|${row.child_line_id ?? ""}`,
        row.schedule_status || ""
      ]));
      for (const row of heldBefore) {
        assert.equal(
          statusAfter.get(`${row.split_id}|${row.child_line_id ?? ""}`),
          "Hold",
          `HOLD split ${row.split_po_ref} changed operational status during reconciliation.`
        );
      }
    }
    if (requireOk) {
      assert.ok(
        first.every((result) => result.reconciliationStatus !== "review"),
        "The first replay still produced a reconciliation review."
      );
      assert.ok(
        second.every((result) => result.reconciliationStatus !== "review"),
        "The second replay recycled a reconciliation review."
      );
    }
    return {
      first: first.map(conciseResult),
      second: second.map(conciseResult),
      splitCount: new Set(afterSecondRows.map((row) => Number(row.split_id))).size
    };
  }, { rollback: true });

  process.stdout.write(`${JSON.stringify({
    mode: "production_rollback_only",
    orderIds,
    receiptAudit,
    ...replay
  }, null, 2)}\n`);
} finally {
  await closeDb();
}
