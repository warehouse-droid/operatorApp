import crypto from "node:crypto";
import { query, withTransaction } from "./db.js";
import {
  markMissingOutboundOrderLines,
  upsertSalesOrderLines,
  upsertSalesOrders
} from "./order-sync-repository.js";
import { cleanupBilledSalesOrderFamilyFromDispatchPlans } from "./dispatch-plan-repository.js";
import {
  isNetSuiteSalesOrderBilled,
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

function mappedSalesOrderHeader(order = {}) {
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
    order_location_id: positiveId(order.orderLocationId) || outboundLocationId,
    order_location: text(order.orderLocation) || outboundLocation,
    outbound_location_id: outboundLocationId,
    outbound_location: outboundLocation,
    delivery_method_id: positiveId(order.deliveryMethodId),
    delivery_method: text(order.deliveryMethod),
    memo: text(order.memo)
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

function salesOrderProgress(lines = []) {
  const progress = (lines || []).map((line) => ({
    ordered: quantity(line.quantity),
    fulfilled: quantity(line.cumulativeProgressQuantity)
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
  const inventoryLines = sourceLines.filter(isSalesOrderInventoryLine);
  const excludedLines = sourceLines.filter((line) => !isSalesOrderInventoryLine(line));
  const billed = isNetSuiteSalesOrderBilled(order);
  const progress = salesOrderProgress(inventoryLines);
  const proposal = {
    orderKind: "SO",
    sourceOrderId: orderId,
    sourceOrderRef: orderRef,
    familyOrderRefs: family.familyRefs,
    dryRun: Boolean(dryRun),
    billed,
    reconciliationStatus: draft.blocked ? "review" : "current",
    applicationStatus: billed ? "Billed" : progress.complete ? "Completed" : "Queued",
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
    await recordSalesOrderReconciliationAudit({ order, runId, source, dryRun: true, result: proposal });
    return proposal;
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
      return blocked;
    }

    const mappedLines = inventoryLines.map(mapNetSuiteSalesOrderLine);
    await upsertSalesOrders([mappedSalesOrderHeader(order)]);
    await upsertSalesOrderLines(orderId, mappedLines);
    await markMissingOutboundOrderLines(orderId, mappedLines.map((line) => Number(line.line_id)));
    await query(
      `UPDATE sales_orders
          SET fulfillment_status = $2,
              synced_at = now()
        WHERE netsuite_id = $1`,
      [orderId, progress.fulfillmentStatus]
    );

    let planCleanup = { changedPlans: [], deferred: false, familyRefs: family.familyRefs };
    if (billed) {
      await query(
        `UPDATE sales_orders
            SET status = 'G',
                status_text = 'Sales Order : Billed',
                netsuite_active = false,
                fulfillment_status = 'fulfilled',
                operator_status = 'fulfilled',
                local_yard_order_status = 'Shipped',
                dispatch_planned = false,
                dispatch_plan_date = NULL,
                dispatch_truck_plate = NULL,
                dispatch_load_name = NULL,
                dispatch_parking_spot = NULL,
                preparing_operator_id = NULL,
                preparing_started_at = NULL,
                status_updated_at = now(),
                synced_at = now()
          WHERE netsuite_id = ANY($1::bigint[])
             OR upper(tranid) = ANY($2::text[])`,
        [family.familyIds, family.familyRefs]
      );
      await query(
        `UPDATE sales_order_lines
            SET netsuite_active = false,
                synced_at = now()
          WHERE sales_order_id = ANY($1::bigint[])`,
        [family.familyIds]
      );
      await query(
        `DELETE FROM operator_saved_delivery_orders saved
          WHERE upper(saved.order_ref) = ANY($1::text[])
             OR saved.order_key = ANY($2::text[])`,
        [family.familyRefs, family.familyIds.map(String)]
      );
      planCleanup = await cleanupBilledSalesOrderFamilyFromDispatchPlans({
        canonicalRef: family.sourceOrderRef || orderRef,
        familyRefs: family.familyRefs,
        actor: source
      });
    }
    const result = {
      ...proposal,
      dryRun: false,
      planCleanup,
      reconciliationStatus: planCleanup.deferred ? "current" : "current",
      reason: planCleanup.deferred
        ? "Billed order is hidden from planning; dispatch-plan cleanup is deferred until the in-progress driver job finishes."
        : ""
    };
    await recordSalesOrderReconciliationAudit({ order, runId, source, dryRun: false, result });
    return result;
  });
}
