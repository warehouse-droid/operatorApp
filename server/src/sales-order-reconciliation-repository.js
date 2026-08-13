import crypto from "node:crypto";
import { query, withTransaction } from "./db.js";
import { reconcileSalesOrderFamilyInDispatchPlans } from "./dispatch-plan-repository.js";
import {
  isNetSuiteSalesOrderBilled,
  isNetSuiteSalesOrderFulfilled,
  isSalesOrderInventoryLine,
  mapNetSuiteSalesOrderLine
} from "./sales-order-reconciliation.js";

function text(value) {
  return String(value ?? "").trim();
}

function positiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function quantity(value) {
  const result = Number(String(value ?? 0).replaceAll(",", ""));
  return Number.isFinite(result) ? Math.abs(result) : 0;
}

function optionalQuantity(value) {
  if (value === null || value === undefined || value === "") return null;
  const result = Number(String(value).replaceAll(",", ""));
  return Number.isFinite(result) ? Math.abs(result) : null;
}

function exactBilledSql(alias = "sales_order") {
  return `(
    UPPER(BTRIM(COALESCE(${alias}.status, ''))) = 'G'
    OR UPPER(REGEXP_REPLACE(
         REGEXP_REPLACE(BTRIM(COALESCE(${alias}.status_text, '')), '\\s*:\\s*', ':', 'g'),
         '\\s+', ' ', 'g'
       ))
       IN ('BILLED', 'SALES ORDER:BILLED')
  )`;
}

export function mappedSalesOrderHeader(order = {}) {
  const firstLineLocation = (order.lines || []).find((line) => positiveId(line.locationId));
  const outboundLocationId = positiveId(order.sourceLocationId)
    || positiveId(firstLineLocation?.locationId)
    || positiveId(order.orderLocationId);
  const outboundLocation = text(order.sourceLocation)
    || text(firstLineLocation?.location)
    || text(order.orderLocation);
  return {
    id: positiveId(order.id),
    tranid: text(order.tranid).toUpperCase(),
    trandate: order.trandate || null,
    customer_id: positiveId(order.entityId),
    customer: text(order.entity),
    status: text(order.status),
    status_text: text(order.statusText),
    expected_delivery_date: order.expectedDeliveryDate || null,
    foreigntotal: order.foreignTotal,
    order_location_id: positiveId(order.orderLocationId),
    order_location: text(order.orderLocation),
    outbound_location_id: outboundLocationId,
    outbound_location: outboundLocation,
    delivery_method_id: positiveId(order.deliveryMethodId),
    delivery_method: text(order.deliveryMethod),
    memo: text(order.memo)
  };
}

export function mappedAuthoritativeSalesOrderLine(line = {}) {
  const mapped = mapNetSuiteSalesOrderLine(line);
  const palletQty = optionalQuantity(line.palletQty ?? line.pallet_qty);
  const layerQty = optionalQuantity(line.layerQty ?? line.layer_qty);
  const sectionQty = optionalQuantity(line.sectionQty ?? line.section_qty);
  const pieceQty = optionalQuantity(line.pieceQty ?? line.piece_qty);
  const toPlt = optionalQuantity(line.toPlt ?? line.to_plt);
  const toLyr = optionalQuantity(line.toLyr ?? line.to_lyr);
  const toSec = optionalQuantity(line.toSec ?? line.to_sec);
  const toPcs = optionalQuantity(line.toPcs ?? line.to_pcs);
  return {
    ...mapped,
    pallet_qty: palletQty,
    layer_qty: layerQty,
    section_qty: sectionQty,
    piece_qty: pieceQty,
    to_plt: toPlt,
    to_lyr: toLyr,
    to_sec: toSec,
    to_pcs: toPcs,
    netsuite_committed_qty: optionalQuantity(
      line.netsuiteCommittedQty ?? line.netsuite_committed_qty
    ),
    netsuite_backordered_qty: optionalQuantity(
      line.netsuiteBackorderedQty ?? line.netsuite_backordered_qty
    ),
    pack_quantity_source: [palletQty, layerQty, sectionQty, pieceQty]
      .some((value) => Number(value || 0) > 0)
      ? "netsuite_manual"
      : [toPlt, toLyr, toSec, toPcs].some((value) => Number(value || 0) > 0)
        ? "item_conversion"
        : "sales_only",
    raw: {
      ...(mapped.raw || {}),
      authoritativeSourceSync: true
    }
  };
}

export async function salesOrderFamilyIdentity({ orderId = null, orderRef = "" } = {}) {
  const id = positiveId(orderId);
  const ref = text(orderRef).toUpperCase();
  const result = await query(
    `WITH canonical AS (
       SELECT sales_order.netsuite_id AS source_so_id,
              sales_order.tranid AS source_so_ref
         FROM sales_orders sales_order
        WHERE sales_order.netsuite_id > 0
          AND (
            ($1::bigint IS NOT NULL AND sales_order.netsuite_id = $1)
            OR ($2 <> '' AND upper(sales_order.tranid) = $2)
          )
       UNION ALL
       SELECT split.source_so_id, split.source_so_ref
         FROM dispatch_scm_so_splits split
        WHERE ($1::bigint IS NOT NULL AND split.split_so_id = $1)
           OR ($2 <> '' AND upper(split.split_so_ref) = $2)
       ORDER BY source_so_id DESC
       LIMIT 1
     )
     SELECT canonical.source_so_id,
            canonical.source_so_ref,
            child.split_so_id,
            child.split_so_ref,
            child.status AS split_status
       FROM canonical
       LEFT JOIN dispatch_scm_so_splits child
         ON child.source_so_id = canonical.source_so_id
      ORDER BY child.created_at, child.id`,
    [id, ref]
  );
  const first = result.rows[0];
  if (!first) return null;
  return {
    sourceOrderId: Number(first.source_so_id),
    sourceOrderRef: first.source_so_ref || ref,
    familyIds: [...new Set([
      Number(first.source_so_id),
      ...result.rows.map((row) => Number(row.split_so_id)).filter(Number.isSafeInteger)
    ])],
    familyRefs: [...new Set([
      first.source_so_ref,
      ...result.rows.map((row) => row.split_so_ref)
    ].map((value) => text(value).toUpperCase()).filter(Boolean))]
  };
}

export async function findSalesOrderReconciliationSource({ orderId = null, orderRef = "" } = {}) {
  const family = await salesOrderFamilyIdentity({ orderId, orderRef });
  if (!family?.sourceOrderId) return null;
  return {
    kind: "SO",
    id: family.sourceOrderId,
    tranid: family.sourceOrderRef
  };
}

export async function listLocalSalesOrderReconciliationSources() {
  const result = await query(
    `SELECT netsuite_id, tranid
       FROM sales_orders
      WHERE netsuite_id > 0
        AND COALESCE(is_test_fixture, false) = false
      ORDER BY netsuite_id`
  );
  return result.rows.map((row) => ({
    kind: "SO",
    id: Number(row.netsuite_id),
    tranid: row.tranid || ""
  }));
}

export async function listBilledSalesOrderFamilyRefs() {
  const result = await query(
    `SELECT sales_order.netsuite_id, sales_order.tranid
       FROM sales_orders sales_order
      WHERE ${exactBilledSql("sales_order")}
     UNION
     SELECT split_order.netsuite_id, split_order.tranid
       FROM dispatch_scm_so_splits split
       JOIN sales_orders source_order ON source_order.netsuite_id = split.source_so_id
       JOIN sales_orders split_order ON split_order.netsuite_id = split.split_so_id
      WHERE ${exactBilledSql("source_order")}
     UNION
     SELECT source_order.netsuite_id, source_order.tranid
       FROM dispatch_scm_so_splits split
       JOIN sales_orders source_order ON source_order.netsuite_id = split.source_so_id
       JOIN sales_orders split_order ON split_order.netsuite_id = split.split_so_id
      WHERE ${exactBilledSql("split_order")}
     ORDER BY tranid`
  );
  return result.rows.map((row) => ({
    id: Number(row.netsuite_id),
    ref: text(row.tranid).toUpperCase()
  }));
}

export async function isBilledSalesOrderIdentifier(value) {
  const raw = text(value);
  if (!raw) return false;
  const numeric = /^-?\d+$/.test(raw) ? Number(raw) : null;
  const result = await query(
    `SELECT 1
       FROM sales_orders sales_order
       LEFT JOIN dispatch_scm_so_splits own_split
         ON own_split.split_so_id = sales_order.netsuite_id
       LEFT JOIN sales_orders source_order
         ON source_order.netsuite_id = own_split.source_so_id
      WHERE (
        ($1::bigint IS NOT NULL AND sales_order.netsuite_id = $1)
        OR upper(sales_order.tranid) = upper($2)
      )
        AND (
          ${exactBilledSql("sales_order")}
          OR ${exactBilledSql("source_order")}
          OR EXISTS (
            SELECT 1
              FROM dispatch_scm_so_splits child_split
              JOIN sales_orders child_order
                ON child_order.netsuite_id = child_split.split_so_id
             WHERE child_split.source_so_id = sales_order.netsuite_id
               AND ${exactBilledSql("child_order")}
          )
        )
      LIMIT 1`,
    [Number.isSafeInteger(numeric) ? numeric : null, raw]
  );
  return result.rowCount > 0;
}

export async function activeSalesOrderFamilyDraft(family = {}) {
  const ids = (family.familyIds || []).map(Number).filter(Number.isSafeInteger);
  const refs = (family.familyRefs || []).map((ref) => text(ref).toUpperCase()).filter(Boolean);
  const result = await query(
    `SELECT sales_order.netsuite_id,
            sales_order.tranid,
            sales_order.operator_status,
            sales_order.local_yard_order_status,
            sales_order.preparing_operator_id,
            EXISTS (
              SELECT 1
                FROM sales_order_lines line
               WHERE line.sales_order_id = sales_order.netsuite_id
                 AND (
                   COALESCE(line.confirmed, false) = true
                   OR COALESCE(line.packed_pallet_qty, 0) > 0
                   OR COALESCE(line.packed_layer_qty, 0) > 0
                   OR COALESCE(line.packed_section_qty, 0) > 0
                   OR COALESCE(line.packed_piece_qty, 0) > 0
                   OR COALESCE(line.packed_sales_qty, 0) > 0
                 )
            ) AS has_unsubmitted_line_progress
       FROM sales_orders sales_order
      WHERE (
        sales_order.netsuite_id = ANY($1::bigint[])
        OR upper(sales_order.tranid) = ANY($2::text[])
      )
        AND lower(COALESCE(sales_order.local_yard_order_status, 'open'))
              NOT IN ('loaded', 'shipped', 'fulfilled')
        AND lower(COALESCE(sales_order.fulfillment_status, 'not_fulfilled')) <> 'fulfilled'
        AND (
          sales_order.preparing_operator_id IS NOT NULL
          OR lower(COALESCE(sales_order.operator_status, 'open')) IN ('preparing', 'packed')
          OR EXISTS (
            SELECT 1
              FROM sales_order_lines line
             WHERE line.sales_order_id = sales_order.netsuite_id
               AND (
                 COALESCE(line.confirmed, false) = true
                 OR COALESCE(line.packed_pallet_qty, 0) > 0
                 OR COALESCE(line.packed_layer_qty, 0) > 0
                 OR COALESCE(line.packed_section_qty, 0) > 0
                 OR COALESCE(line.packed_piece_qty, 0) > 0
                 OR COALESCE(line.packed_sales_qty, 0) > 0
               )
          )
        )
      ORDER BY sales_order.netsuite_id
      LIMIT 1`,
    [ids, refs]
  );
  const row = result.rows[0];
  return row ? {
    blocked: true,
    orderId: Number(row.netsuite_id),
    orderRef: row.tranid || "",
    operatorStatus: row.operator_status || "",
    localYardOrderStatus: row.local_yard_order_status || "",
    preparingOperatorId: row.preparing_operator_id || "",
    hasUnsubmittedLineProgress: row.has_unsubmitted_line_progress === true
  } : { blocked: false };
}

function salesOrderProgress(lines = [], { forceComplete = false } = {}) {
  const progress = (lines || []).map((line) => ({
    ordered: quantity(line.quantity),
    fulfilled: forceComplete
      ? quantity(line.quantity)
      : quantity(line.cumulativeProgressQuantity)
  }));
  const ordered = progress.reduce((sum, line) => sum + line.ordered, 0);
  const fulfilled = progress.reduce((sum, line) => sum + Math.min(line.fulfilled, line.ordered), 0);
  const hasProgress = progress.some((line) => line.fulfilled > 0.000001);
  const complete = progress.length > 0
    && progress.every((line) => line.fulfilled + 0.000001 >= line.ordered);
  return {
    ordered,
    fulfilled,
    remaining: Math.max(ordered - fulfilled, 0),
    orderedLineCount: progress.length,
    progressedLineCount: progress.filter((line) => line.fulfilled > 0.000001).length,
    complete,
    hasProgress,
    fulfillmentStatus: complete ? "fulfilled" : hasProgress ? "partial_fulfilled" : "not_fulfilled"
  };
}

function salesOrderCalculatedApplicationStatus({ billed = false, progress = {} } = {}) {
  if (billed || progress.complete) return "Completed";
  if (progress.hasProgress) return "Partially Done";
  return "Queued";
}

function reconciliationSource(value) {
  const normalized = text(value).toLowerCase();
  return ["webhook", "nightly", "manual", "backfill", "system"].includes(normalized)
    ? normalized
    : "system";
}

function salesOrderCalculationLines(lines = [], { forceComplete = false } = {}) {
  return (lines || []).map((line) => {
    const mapped = mapNetSuiteSalesOrderLine(line);
    const ordered = quantity(line.quantity);
    const fulfilled = Math.min(
      forceComplete ? ordered : quantity(line.cumulativeProgressQuantity),
      ordered
    );
    return {
      source: line,
      mapped,
      ordered,
      fulfilled,
      remaining: Math.max(ordered - fulfilled, 0),
      lineStatus: ordered > 0 && fulfilled + 0.000001 >= ordered
        ? "completed"
        : fulfilled > 0
          ? "partial"
          : "open"
    };
  });
}

async function persistSalesOrderCalculation({
  order,
  proposal,
  inventoryLines,
  runId,
  source,
  dryRun
}) {
  const calculatedStatus = proposal.calculatedApplicationStatus;
  const normalizedSource = reconciliationSource(source);
  const terminalState = proposal.fulfilledByHeader ? "closed" : "open";
  const familyQuantities = {
    ordered: proposal.quantities.ordered,
    fulfilled: proposal.quantities.fulfilled,
    received: 0,
    abandoned: 0,
    remaining: proposal.quantities.remaining,
    destinationRemaining: 0
  };
  const quantitySummary = {
    family: familyQuantities,
    targets: {
      [proposal.sourceOrderRef]: {
        orderRef: proposal.sourceOrderRef,
        applicationStatus: calculatedStatus,
        ...familyQuantities
      }
    }
  };
  const params = [
    order.id,
    proposal.sourceOrderRef,
    text(order.status),
    text(order.statusText),
    terminalState,
    calculatedStatus,
    proposal.reconciliationStatus,
    proposal.reason,
    normalizedSource,
    positiveId(order.sourceLocationId),
    text(order.sourceLocation),
    proposal.quantities.ordered,
    proposal.quantities.fulfilled,
    proposal.quantities.remaining,
    order.lastModifiedAt || null,
    positiveId(runId),
    JSON.stringify(quantitySummary),
    JSON.stringify(order),
    JSON.stringify(proposal)
  ];
  const dryRunParams = [
    order.id,
    proposal.sourceOrderRef,
    text(order.status),
    text(order.statusText),
    terminalState,
    normalizedSource,
    positiveId(order.sourceLocationId),
    text(order.sourceLocation),
    order.lastModifiedAt || null,
    positiveId(runId),
    JSON.stringify(order),
    JSON.stringify(proposal)
  ];
  const state = dryRun
    ? await query(
      `INSERT INTO scm_reconciliation_order_state (
         order_kind, source_order_netsuite_id, source_order_ref,
         netsuite_status_code, netsuite_status_text, netsuite_terminal_state,
         application_status, reconciliation_status, reconciliation_source,
         source_location_id, source_location, exact_allocation,
         last_netsuite_modified_at, last_run_id, order_snapshot,
         proposed_state, created_at, updated_at
       ) VALUES (
         'SO', $1, $2, NULLIF($3, ''), NULLIF($4, ''), $5,
         'Queued', 'pending', $6,
         $7, NULLIF($8, ''), true,
         $9, $10, $11::jsonb, $12::jsonb, now(), now()
       )
       ON CONFLICT (order_kind, source_order_netsuite_id) DO UPDATE SET
         source_order_ref = EXCLUDED.source_order_ref,
         netsuite_status_code = EXCLUDED.netsuite_status_code,
         netsuite_status_text = EXCLUDED.netsuite_status_text,
         netsuite_terminal_state = EXCLUDED.netsuite_terminal_state,
         reconciliation_source = EXCLUDED.reconciliation_source,
         source_location_id = EXCLUDED.source_location_id,
         source_location = EXCLUDED.source_location,
         last_netsuite_modified_at = EXCLUDED.last_netsuite_modified_at,
         last_run_id = COALESCE(EXCLUDED.last_run_id, scm_reconciliation_order_state.last_run_id),
         order_snapshot = EXCLUDED.order_snapshot,
         proposed_state = EXCLUDED.proposed_state,
         updated_at = now()
       RETURNING *`,
      dryRunParams
    )
    : await query(
      `INSERT INTO scm_reconciliation_order_state (
         order_kind, source_order_netsuite_id, source_order_ref,
         netsuite_status_code, netsuite_status_text, netsuite_terminal_state,
         application_status, reconciliation_status, reconciliation_reason,
         reconciliation_source, source_location_id, source_location,
         ordered_qty, fulfilled_qty, received_qty, abandoned_qty,
         remaining_qty, destination_remaining_qty, exact_allocation,
         last_netsuite_modified_at, last_run_id, quantity_summary,
         order_snapshot, proposed_state, reconciled_at, completed_at,
         status_changed_at, created_at, updated_at
       ) VALUES (
         'SO', $1, $2, NULLIF($3, ''), NULLIF($4, ''), $5,
         $6, $7, NULLIF($8, ''), $9, $10, NULLIF($11, ''),
         $12, $13, 0, 0, $14, 0, true,
         $15, $16, $17::jsonb, $18::jsonb, $19::jsonb, now(),
         CASE WHEN $6 = 'Completed' THEN now() ELSE NULL END,
         now(), now(), now()
       )
       ON CONFLICT (order_kind, source_order_netsuite_id) DO UPDATE SET
         source_order_ref = EXCLUDED.source_order_ref,
         netsuite_status_code = EXCLUDED.netsuite_status_code,
         netsuite_status_text = EXCLUDED.netsuite_status_text,
         netsuite_terminal_state = EXCLUDED.netsuite_terminal_state,
         application_status = EXCLUDED.application_status,
         reconciliation_status = EXCLUDED.reconciliation_status,
         reconciliation_reason = EXCLUDED.reconciliation_reason,
         reconciliation_source = EXCLUDED.reconciliation_source,
         source_location_id = EXCLUDED.source_location_id,
         source_location = EXCLUDED.source_location,
         ordered_qty = EXCLUDED.ordered_qty,
         fulfilled_qty = EXCLUDED.fulfilled_qty,
         received_qty = 0,
         abandoned_qty = 0,
         remaining_qty = EXCLUDED.remaining_qty,
         destination_remaining_qty = 0,
         exact_allocation = true,
         last_netsuite_modified_at = EXCLUDED.last_netsuite_modified_at,
         last_run_id = COALESCE(EXCLUDED.last_run_id, scm_reconciliation_order_state.last_run_id),
         quantity_summary = EXCLUDED.quantity_summary,
         order_snapshot = EXCLUDED.order_snapshot,
         proposed_state = EXCLUDED.proposed_state,
         reconciled_at = now(),
         completed_at = CASE
           WHEN EXCLUDED.application_status = 'Completed'
           THEN COALESCE(scm_reconciliation_order_state.completed_at, now())
           ELSE NULL
         END,
         cancelled_at = NULL,
         status_changed_at = CASE
           WHEN scm_reconciliation_order_state.application_status IS DISTINCT FROM EXCLUDED.application_status
           THEN now()
           ELSE scm_reconciliation_order_state.status_changed_at
         END,
         updated_at = now()
       RETURNING *`,
      params
    );
  const stateRow = state.rows[0];
  if (dryRun) return stateRow;

  const calculatedLines = salesOrderCalculationLines(inventoryLines, {
    forceComplete: proposal.fulfilledByHeader
  });
  for (const line of calculatedLines) {
    await query(
      `INSERT INTO scm_reconciliation_order_line_state (
         order_state_id, netsuite_line_key, local_line_id, local_line_stage,
         item_id, item_name, sku, unit, source_location_id,
         current_ordered_qty, fulfilled_qty, received_qty, abandoned_qty,
         remaining_qty, line_status, identity_status, allocation_quality,
         netsuite_active, last_run_id, line_snapshot, created_at, updated_at
       ) VALUES (
         $1, $2, $3, 'outbound', $4, NULLIF($5, ''), NULLIF($6, ''),
         NULLIF($7, ''), $8, $9, $10, 0, 0, $11, $12,
         'exact', 'exact', true, $13, $14::jsonb, now(), now()
       )
       ON CONFLICT (order_state_id, netsuite_line_key) DO UPDATE SET
         local_line_id = EXCLUDED.local_line_id,
         local_line_stage = EXCLUDED.local_line_stage,
         item_id = EXCLUDED.item_id,
         item_name = EXCLUDED.item_name,
         sku = EXCLUDED.sku,
         unit = EXCLUDED.unit,
         source_location_id = EXCLUDED.source_location_id,
         current_ordered_qty = EXCLUDED.current_ordered_qty,
         fulfilled_qty = EXCLUDED.fulfilled_qty,
         received_qty = 0,
         abandoned_qty = 0,
         remaining_qty = EXCLUDED.remaining_qty,
         line_status = EXCLUDED.line_status,
         identity_status = 'exact',
         allocation_quality = 'exact',
         netsuite_active = true,
         last_run_id = COALESCE(EXCLUDED.last_run_id, scm_reconciliation_order_line_state.last_run_id),
         line_snapshot = EXCLUDED.line_snapshot,
         updated_at = now()`,
      [
        stateRow.id,
        String(line.mapped.line_id),
        Number(line.mapped.line_id),
        line.mapped.item_id,
        line.mapped.item_name,
        line.mapped.sku,
        line.mapped.unit,
        positiveId(order.sourceLocationId),
        line.ordered,
        line.fulfilled,
        line.remaining,
        line.lineStatus,
        positiveId(runId),
        JSON.stringify({
          ...line.source,
          includedInCalculation: true
        })
      ]
    );
  }
  await query(
    `UPDATE scm_reconciliation_order_line_state
        SET netsuite_active = false,
            updated_at = now()
      WHERE order_state_id = $1
        AND netsuite_active = true
        AND netsuite_line_key <> ALL($2::text[])`,
    [stateRow.id, calculatedLines.map((line) => String(line.mapped.line_id))]
  );
  return stateRow;
}

async function recordSalesOrderReconciliationAudit({ order, runId, source, dryRun, result }) {
  await query(
    `INSERT INTO scm_reconciliation_audit_events (
       event_key, run_id, source, event_type, record_type, action,
       validation_status, netsuite_transaction_id, transaction_ref,
       parent_order_kind, parent_order_netsuite_id, parent_order_ref,
       occurred_at, payload, actor
     ) VALUES (
       $1, $2, $3, $4, 'SO', $5, 'accepted', $6, NULLIF($7, ''),
       'SO', $6, NULLIF($7, ''), now(), $8::jsonb, $9
     )`,
    [
      `reconcile:${runId || "targeted"}:SO:${order.id}:${dryRun ? "proposal" : "apply"}:${crypto.randomUUID()}`,
      positiveId(runId),
      ["nightly", "manual", "backfill", "system"].includes(source) ? source : "system",
      dryRun ? "order.proposed" : "order.applied",
      dryRun ? "propose" : "apply",
      positiveId(order.id),
      text(order.tranid).toUpperCase(),
      JSON.stringify(result || {}),
      source || "system"
    ]
  );
}

export async function reconcileSalesOrderFromNetSuite({
  order,
  runId = null,
  source = "manual",
  dryRun = true
} = {}) {
  const orderId = positiveId(order?.id);
  if (!orderId || text(order?.kind).toUpperCase() !== "SO") {
    throw new Error("A valid authoritative Sales Order is required.");
  }
  const orderRef = text(order.tranid).toUpperCase();
  const family = await salesOrderFamilyIdentity({ orderId, orderRef });
  if (!family?.sourceOrderId) {
    throw Object.assign(
      new Error(`${orderRef || `SO ${orderId}`} is not available in the local Sales Order database.`),
      { code: "SO_RECONCILIATION_LOCAL_SOURCE_MISSING", status: 404 }
    );
  }
  const draft = await activeSalesOrderFamilyDraft(family);
  const sourceLines = Array.isArray(order.lines) ? order.lines : [];
  if (!sourceLines.length) {
    throw new Error("Sales Order calculation requires a complete authoritative order with item lines.");
  }
  const sourceLineIds = sourceLines.map((line) => positiveId(mapNetSuiteSalesOrderLine(line).line_id));
  if (
    sourceLineIds.some((lineId) => !lineId)
    || new Set(sourceLineIds).size !== sourceLineIds.length
  ) {
    throw new Error("Sales Order calculation requires unique positive NetSuite line identities.");
  }
  const inventoryLines = sourceLines.filter(isSalesOrderInventoryLine);
  const excludedLines = sourceLines.filter((line) => !isSalesOrderInventoryLine(line));
  const billed = isNetSuiteSalesOrderBilled(order);
  const fulfilledByHeader = isNetSuiteSalesOrderFulfilled(order);
  const progress = salesOrderProgress(inventoryLines, {
    forceComplete: fulfilledByHeader
  });
  const calculatedApplicationStatus = salesOrderCalculatedApplicationStatus({
    billed,
    progress
  });
  const proposal = {
    orderKind: "SO",
    sourceOrderId: orderId,
    sourceOrderRef: orderRef,
    familyOrderRefs: family.familyRefs,
    dryRun: Boolean(dryRun),
    billed,
    fulfilledByHeader,
    reconciliationStatus: draft.blocked ? "review" : "current",
    applicationStatus: billed ? "Billed" : calculatedApplicationStatus,
    calculatedApplicationStatus,
    reason: draft.blocked
      ? `Sales Order family reconciliation is blocked by an active operator packing draft on ${draft.orderRef || orderRef}.`
      : "",
    blockedByActiveDraft: draft.blocked,
    draft,
    quantities: progress,
    inventoryLineCount: inventoryLines.length,
    excludedNonInventoryLineCount: excludedLines.length,
    excludedNonInventoryLines: excludedLines.map((line) => ({
      lineKey: text(line.sourceLineKey),
      itemName: text(line.itemName),
      itemType: text(line.itemType)
    }))
  };
  if (draft.blocked || dryRun) {
    return withTransaction(async () => {
      await persistSalesOrderCalculation({
        order,
        proposal,
        inventoryLines,
        runId,
        source,
        dryRun: true
      });
      await recordSalesOrderReconciliationAudit({ order, runId, source, dryRun: true, result: proposal });
      if (!dryRun && draft.blocked) {
        return {
          ...proposal,
          planCleanup: await reconcileSalesOrderFamilyInDispatchPlans({
            canonicalRef: family.sourceOrderRef || orderRef,
            familyRefs: family.familyRefs,
          billed: false,
          reconciliationStatus: "review",
          reconciliationReason: proposal.reason,
          reconciliationApplicationStatus: "Reconcile Review",
          actor: source
          })
        };
      }
      return proposal;
    });
  }

  return withTransaction(async () => {
    // Re-check under the mutation transaction so an operator cannot acquire a
    // draft between preflight and the first operational write.
    const lockedFamilyRows = await query(
      `SELECT netsuite_id
         FROM sales_orders
        WHERE netsuite_id = ANY($1::bigint[])
           OR upper(tranid) = ANY($2::text[])
        FOR UPDATE`,
      [family.familyIds, family.familyRefs]
    );
    void lockedFamilyRows;
    const liveDraft = await activeSalesOrderFamilyDraft(family);
    if (liveDraft.blocked) {
      const blocked = {
        ...proposal,
        reconciliationStatus: "review",
        blockedByActiveDraft: true,
        draft: liveDraft,
        reason: `Sales Order family reconciliation is blocked by an active operator packing draft on ${liveDraft.orderRef || orderRef}.`
      };
      await recordSalesOrderReconciliationAudit({ order, runId, source, dryRun: false, result: blocked });
      return {
        ...blocked,
        planCleanup: await reconcileSalesOrderFamilyInDispatchPlans({
          canonicalRef: family.sourceOrderRef || orderRef,
          familyRefs: family.familyRefs,
          billed: false,
          reconciliationStatus: "review",
          reconciliationReason: blocked.reason,
          reconciliationApplicationStatus: "Reconcile Review",
          actor: source
        })
      };
    }

    // Reconciliation consumes the authoritative snapshot but never mutates
    // canonical Sales Order headers or lines. Normal NetSuite order sync owns
    // those tables; this path writes only the separate calculation state.

    let planCleanup = { changedPlans: [], deferred: false, familyRefs: family.familyRefs };
    if (fulfilledByHeader) {
      await query(
        `DELETE FROM operator_saved_delivery_orders saved
          WHERE upper(saved.order_ref) = ANY($1::text[])
             OR saved.order_key = ANY($2::text[])`,
        [family.familyRefs, family.familyIds.map(String)]
      );
    }
    planCleanup = await reconcileSalesOrderFamilyInDispatchPlans({
      canonicalRef: family.sourceOrderRef || orderRef,
      familyRefs: family.familyRefs,
      // Fulfilled/Pending Billing is terminal evidence, but it is not a reason
      // to delete that child from an existing group. Keep it in the snapshot
      // so the group can roll up to Partially Done/Completed; only an actual
      // Billed header uses the destructive dispatch-plan scrub.
      billed,
      reconciliationStatus: "current",
      reconciliationReason: "",
      reconciliationApplicationStatus: proposal.calculatedApplicationStatus,
      actor: source
    });
    const result = {
      ...proposal,
      dryRun: false,
      planCleanup,
      reconciliationStatus: planCleanup.deferred ? "current" : "current",
      reason: planCleanup.deferred
        ? "Completed order is hidden from planning; dispatch-plan cleanup is deferred until the in-progress driver job finishes."
        : ""
    };
    await persistSalesOrderCalculation({
      order,
      proposal: result,
      inventoryLines,
      runId,
      source,
      dryRun: false
    });
    await recordSalesOrderReconciliationAudit({ order, runId, source, dryRun: false, result });
    return result;
  });
}
