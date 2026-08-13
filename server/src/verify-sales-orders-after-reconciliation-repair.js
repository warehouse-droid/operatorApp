import { closeDb, query } from "./db.js";
import { fetchScmReconciliationOrdersFromNetSuite } from "./netsuite.js";
import { mappedAuthoritativeSalesOrderLine } from "./sales-order-reconciliation-repository.js";

const REPAIR_KEY = "so-reconciliation-canonical-repair-2026-08-11-v2";
const FETCH_BATCH_SIZE = 200;
const NUMERIC_FIELDS = [
  "quantity",
  "pallet_qty",
  "layer_qty",
  "section_qty",
  "piece_qty",
  "to_plt",
  "to_lyr",
  "to_sec",
  "to_pcs",
  "netsuite_committed_qty",
  "netsuite_backordered_qty"
];
const ZERO_WHEN_MISSING = new Set([
  "netsuite_committed_qty",
  "netsuite_backordered_qty"
]);

function normalizedNumeric(value, { missingAsZero = false } = {}) {
  if (value === null || value === undefined || value === "") {
    return missingAsZero ? 0 : null;
  }
  const result = Number(value);
  return Number.isFinite(result) ? result : Number.NaN;
}

function equalNumeric(expected, actual, { missingAsZero = false } = {}) {
  const left = normalizedNumeric(expected, { missingAsZero });
  const right = normalizedNumeric(actual, { missingAsZero });
  if (left === null || right === null) return left === right;
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  return Math.abs(left - right) <= Number.EPSILON * Math.max(1, Math.abs(left), Math.abs(right)) * 8;
}

async function repairedSalesOrders() {
  const result = await query(
    `SELECT DISTINCT audit.order_id,
            upper(trim(COALESCE(audit.details->>'orderRef', sales_order.tranid))) AS order_ref
       FROM delivery_audit_log audit
       JOIN sales_orders sales_order
         ON sales_order.netsuite_id = audit.order_id
      WHERE audit.action = 'netsuite.order.reconciliation_source_repair'
        AND audit.details->>'repairKey' = $1
      ORDER BY audit.order_id`,
    [REPAIR_KEY]
  );
  return result.rows.map((row) => ({
    id: Number(row.order_id),
    ref: String(row.order_ref || "").trim().toUpperCase()
  }));
}

async function activeLocalLines(orderIds) {
  const result = await query(
    `SELECT sales_order_id,
            line_id,
            quantity,
            pallet_qty,
            layer_qty,
            section_qty,
            piece_qty,
            to_plt,
            to_lyr,
            to_sec,
            to_pcs,
            netsuite_committed_qty,
            netsuite_backordered_qty,
            pack_quantity_source
       FROM sales_order_lines
      WHERE sales_order_id = ANY($1::bigint[])
        AND netsuite_active = true
      ORDER BY sales_order_id, line_id`,
    [orderIds]
  );
  const byOrder = new Map();
  for (const row of result.rows) {
    const orderId = Number(row.sales_order_id);
    if (!byOrder.has(orderId)) byOrder.set(orderId, new Map());
    byOrder.get(orderId).set(String(row.line_id), row);
  }
  return byOrder;
}

function verifyBatch(batch, fetched, localByOrder, reportMismatch, counters) {
  const requestedIds = new Set(batch.map((order) => order.id));
  const fetchedById = new Map();
  for (const order of fetched || []) {
    const orderId = Number(order.id);
    if (!requestedIds.has(orderId)) {
      reportMismatch({ orderId, field: "order_identity", expected: "requested order", actual: order.tranid });
      continue;
    }
    if (fetchedById.has(orderId)) {
      reportMismatch({ orderId, field: "order_identity", expected: "one source order", actual: "duplicate" });
      continue;
    }
    fetchedById.set(orderId, order);
  }

  for (const requested of batch) {
    const sourceOrder = fetchedById.get(requested.id);
    if (!sourceOrder) {
      reportMismatch({ orderId: requested.id, orderRef: requested.ref, field: "order_identity", expected: "present", actual: "missing" });
      continue;
    }
    const sourceRef = String(sourceOrder.tranid || "").trim().toUpperCase();
    if (sourceRef !== requested.ref) {
      reportMismatch({ orderId: requested.id, orderRef: requested.ref, field: "order_ref", expected: requested.ref, actual: sourceRef });
    }

    const sourceLines = new Map();
    for (const rawLine of sourceOrder.lines || []) {
      const line = mappedAuthoritativeSalesOrderLine(rawLine);
      const lineId = String(line.line_id);
      if (sourceLines.has(lineId)) {
        reportMismatch({ orderId: requested.id, orderRef: requested.ref, lineId, field: "line_identity", expected: "unique", actual: "duplicate" });
        continue;
      }
      sourceLines.set(lineId, line);
    }
    if (!sourceLines.size) {
      reportMismatch({ orderId: requested.id, orderRef: requested.ref, field: "active_lines", expected: "at least one", actual: 0 });
      continue;
    }

    const localLines = localByOrder.get(requested.id) || new Map();
    for (const [lineId, expected] of sourceLines) {
      counters.sourceLines += 1;
      for (const field of ["pallet_qty", "layer_qty", "section_qty", "piece_qty"]) {
        if (Number(expected[field] || 0) !== 0) counters.nonzero[field] += 1;
      }
      const actual = localLines.get(lineId);
      if (!actual) {
        reportMismatch({ orderId: requested.id, orderRef: requested.ref, lineId, field: "netsuite_active", expected: true, actual: "missing" });
        continue;
      }
      for (const field of NUMERIC_FIELDS) {
        const missingAsZero = ZERO_WHEN_MISSING.has(field);
        if (!equalNumeric(expected[field], actual[field], { missingAsZero })) {
          reportMismatch({ orderId: requested.id, orderRef: requested.ref, lineId, field, expected: normalizedNumeric(expected[field], { missingAsZero }), actual: normalizedNumeric(actual[field], { missingAsZero }) });
        }
      }
      if (String(actual.pack_quantity_source || "") !== String(expected.pack_quantity_source || "")) {
        reportMismatch({ orderId: requested.id, orderRef: requested.ref, lineId, field: "pack_quantity_source", expected: expected.pack_quantity_source, actual: actual.pack_quantity_source });
      }
    }
    for (const lineId of localLines.keys()) {
      if (!sourceLines.has(lineId)) {
        reportMismatch({ orderId: requested.id, orderRef: requested.ref, lineId, field: "netsuite_active", expected: false, actual: true });
      }
    }
    counters.verifiedOrders += 1;
  }
}

async function run() {
  const repaired = await repairedSalesOrders();
  const counters = {
    verifiedOrders: 0,
    sourceLines: 0,
    nonzero: {
      pallet_qty: 0,
      layer_qty: 0,
      section_qty: 0,
      piece_qty: 0
    }
  };
  let mismatchCount = 0;
  const mismatches = [];
  const reportMismatch = (mismatch) => {
    mismatchCount += 1;
    if (mismatches.length < 100) mismatches.push(mismatch);
  };

  for (let offset = 0; offset < repaired.length; offset += FETCH_BATCH_SIZE) {
    const batch = repaired.slice(offset, offset + FETCH_BATCH_SIZE);
    const fetched = await fetchScmReconciliationOrdersFromNetSuite({
      orderIds: batch.map((order) => order.id),
      kind: "SO",
      includeOpen: false,
      targetOnly: true
    });
    const localByOrder = await activeLocalLines(batch.map((order) => order.id));
    verifyBatch(batch, fetched, localByOrder, reportMismatch, counters);
    console.log(JSON.stringify({
      batch: Math.floor(offset / FETCH_BATCH_SIZE) + 1,
      batches: Math.ceil(repaired.length / FETCH_BATCH_SIZE),
      requestedOrders: Math.min(offset + batch.length, repaired.length),
      verifiedOrders: counters.verifiedOrders,
      sourceLines: counters.sourceLines,
      mismatches: mismatchCount
    }));
  }

  console.log(JSON.stringify({
    repairKey: REPAIR_KEY,
    repairedOrders: repaired.length,
    ...counters,
    mismatches: mismatchCount,
    mismatchSamples: mismatches
  }));
  if (mismatchCount) process.exitCode = 1;
}

try {
  await run();
} finally {
  await closeDb();
}
