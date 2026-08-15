import { writeAudit } from "./auth-repository.js";
import { query, withTransaction } from "./db.js";
import {
  buildSalesOrderReattemptPreview,
  normalizeReloadReason,
  normalizeReloadRequestId,
  reloadPackedQuantities
} from "./sales-order-reload.js";

export const ACTIVE_RELOAD_STATUSES = Object.freeze(["authorized", "preparing", "packed", "in_progress"]);
const QUANTITY_TOLERANCE = 0.000001;

function reloadRepositoryError(message, code, status = 409) {
  return Object.assign(new Error(message), { code, status });
}

function quantity(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function rounded(value) {
  return Number(quantity(value).toFixed(6));
}

function positiveId(value, label = "ID") {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw reloadRepositoryError(`${label} is invalid.`, "RELOAD_ID_INVALID", 400);
  }
  return parsed;
}

function photoReferences(values = []) {
  return (Array.isArray(values) ? values : [])
    .map((value) => String(value || ""))
    .filter((value) => value.startsWith("data:image/") || value.startsWith("r2://"));
}

function requireReloadPhotos(values) {
  const photos = photoReferences(values);
  if (photos.length < 2) throw reloadRepositoryError("At least 2 photos are required.", "RELOAD_PHOTOS_REQUIRED", 400);
  return photos;
}

function linePackedSalesQty(line = {}) {
  const converted = (quantity(line.packed_pallet_qty) * quantity(line.to_plt))
    + (quantity(line.packed_layer_qty) * quantity(line.to_lyr))
    + (quantity(line.packed_section_qty) * quantity(line.to_sec))
    + (quantity(line.packed_piece_qty) * quantity(line.to_pcs));
  return rounded(converted > 0 ? converted : line.packed_sales_qty);
}

function mapReloadLine(row) {
  if (!row) return null;
  const mapped = {
    id: Number(row.id),
    cycleId: Number(row.cycle_id),
    salesOrderLineId: Number(row.sales_order_line_id),
    netsuiteLineId: row.netsuite_line_id === null ? null : Number(row.netsuite_line_id),
    itemId: row.item_id === null ? null : Number(row.item_id),
    itemName: row.item_name || "",
    sku: row.sku || "",
    itemDescription: row.item_description || "",
    salesUom: row.sales_uom || "",
    targetSalesQty: quantity(row.target_sales_qty),
    targetPalletQty: quantity(row.target_pallet_qty),
    targetLayerQty: quantity(row.target_layer_qty),
    targetSectionQty: quantity(row.target_section_qty),
    targetPieceQty: quantity(row.target_piece_qty),
    toPlt: quantity(row.to_plt),
    toLyr: quantity(row.to_lyr),
    toSec: quantity(row.to_sec),
    toPcs: quantity(row.to_pcs),
    packedPalletQty: quantity(row.packed_pallet_qty),
    packedLayerQty: quantity(row.packed_layer_qty),
    packedSectionQty: quantity(row.packed_section_qty),
    packedPieceQty: quantity(row.packed_piece_qty),
    packedSalesQty: quantity(row.packed_sales_qty),
    reloadedPalletQty: quantity(row.reloaded_pallet_qty),
    reloadedLayerQty: quantity(row.reloaded_layer_qty),
    reloadedSectionQty: quantity(row.reloaded_section_qty),
    reloadedPieceQty: quantity(row.reloaded_piece_qty),
    reloadedSalesQty: quantity(row.reloaded_sales_qty),
    lineKey: row.line_key || "",
    historicalLineIndex: row.historical_line_index === null || row.historical_line_index === undefined
      ? null
      : Number(row.historical_line_index),
    historicalLineId: row.historical_line_id === null || row.historical_line_id === undefined
      ? null
      : Number(row.historical_line_id),
    historicalItemId: row.historical_item_id === null || row.historical_item_id === undefined
      ? null
      : Number(row.historical_item_id),
    historicalItemName: row.historical_item_name || "",
    historicalSku: row.historical_sku || "",
    historicalDescription: row.historical_description || "",
    historicalSalesUom: row.historical_sales_uom || "",
    historicalSalesQty: quantity(row.historical_loaded_sales_qty),
    historicalPalletQty: quantity(row.historical_pallet_qty),
    historicalLayerQty: quantity(row.historical_layer_qty),
    historicalSectionQty: quantity(row.historical_section_qty),
    historicalPieceQty: quantity(row.historical_piece_qty),
    currentSalesOrderLineId: row.current_sales_order_line_id === null || row.current_sales_order_line_id === undefined
      ? null
      : Number(row.current_sales_order_line_id),
    currentLineId: row.current_line_id === null || row.current_line_id === undefined ? null : Number(row.current_line_id),
    currentItemId: row.current_item_id === null || row.current_item_id === undefined ? null : Number(row.current_item_id),
    currentItemName: row.current_item_name || "",
    currentSku: row.current_sku || "",
    currentDescription: row.current_description || "",
    currentSalesQty: quantity(row.current_sales_qty),
    currentSalesUom: row.current_sales_uom || "",
    skuMismatch: Boolean(row.sku_mismatch),
    itemMismatch: Boolean(row.item_mismatch),
    selectedForReattempt: row.selected_for_reattempt !== false,
    selectionReason: row.selection_reason || "",
    alreadyDeliveredSalesQty: quantity(row.already_delivered_sales_qty),
    alreadyDeliveredPalletQty: quantity(row.already_delivered_pallet_qty),
    alreadyDeliveredLayerQty: quantity(row.already_delivered_layer_qty),
    alreadyDeliveredSectionQty: quantity(row.already_delivered_section_qty),
    alreadyDeliveredPieceQty: quantity(row.already_delivered_piece_qty),
    itemWeight: quantity(row.item_weight),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  };
  mapped.packedTotalSalesQty = linePackedSalesQty(row);
  mapped.remainingSalesQty = rounded(Math.max(0, mapped.targetSalesQty - mapped.reloadedSalesQty));
  return mapped;
}

function mapReattemptOrder(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    refNumber: row.ref_number || "",
    orderKind: row.order_kind || "custom",
    systemManaged: Boolean(row.system_managed),
    parentSalesOrderId: row.parent_sales_order_id === null ? null : Number(row.parent_sales_order_id),
    parentOrderRef: row.parent_order_ref || "",
    reloadCycleId: row.reload_cycle_id === null ? null : Number(row.reload_cycle_id),
    lineSnapshot: Array.isArray(row.line_snapshot) ? row.line_snapshot : [],
    palletQty: quantity(row.pallet_qty),
    layerQty: quantity(row.layer_qty),
    sectionQty: quantity(row.section_qty),
    pieceQty: quantity(row.piece_qty),
    salesQty: quantity(row.sales_qty),
    weightLbs: quantity(row.weight_lbs),
    pickupLocation: row.pickup_location || "",
    dropoffLocation: row.dropoff_location || "",
    status: row.status || "",
    billingDisposition: row.billing_disposition || "standard"
  };
}

function mapReloadCycle(row, lines = [], reattemptOrder = null, assignment = null) {
  if (!row) return null;
  return {
    id: Number(row.id),
    salesOrderId: Number(row.sales_order_id),
    orderRef: row.order_ref || "",
    outboundLocationId: row.outbound_location_id === null ? null : Number(row.outbound_location_id),
    cycleNumber: Number(row.cycle_number),
    requestId: row.request_id || "",
    status: row.status || "",
    reason: row.reason || "",
    netsuiteStatus: row.netsuite_status || "",
    netsuiteStatusText: row.netsuite_status_text || "",
    authorizedBy: row.authorized_by || null,
    authorizedAt: row.authorized_at || null,
    activityStartedAt: row.activity_started_at || null,
    preparingOperatorId: row.preparing_operator_id || null,
    preparingStartedAt: row.preparing_started_at || null,
    completedAt: row.completed_at || null,
    cancelledBy: row.cancelled_by || null,
    cancelledAt: row.cancelled_at || null,
    cancelReason: row.cancel_reason || "",
    workflowKind: row.workflow_kind || "standard_reload",
    sourceLoadRecordId: row.source_load_record_id === null || row.source_load_record_id === undefined
      ? null
      : Number(row.source_load_record_id),
    reattemptOrderId: row.reattempt_order_id === null || row.reattempt_order_id === undefined
      ? null
      : Number(row.reattempt_order_id),
    reattemptOrderRef: row.reattempt_order_ref || "",
    reattemptOrder,
    dispatchPlanId: assignment?.planId || null,
    dispatchPlanDate: assignment?.planDate || null,
    dispatchTruckPlate: assignment?.truckPlate || "",
    dispatchLoadId: assignment?.loadId || "",
    dispatchLoadName: assignment?.loadName || "",
    dispatchParkingSpot: assignment?.parkingSpot || "",
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    lines
  };
}

async function reattemptOrderForCycle(cycleId) {
  const result = await query(
    `SELECT child.*
       FROM dispatch_custom_orders child
      WHERE child.reload_cycle_id = $1
      LIMIT 1`,
    [cycleId]
  );
  return result.rowCount ? mapReattemptOrder(result.rows[0]) : null;
}

async function reattemptAssignment(orderRef) {
  if (!String(orderRef || "").trim()) return null;
  const result = await query(
    `SELECT plan.id::text AS plan_id,
            plan.plan_date::text AS plan_date,
            COALESCE(NULLIF(load.value ->> 'truckPlate', ''), truck.value ->> 'plate', '') AS truck_plate,
            COALESCE(load.value ->> 'id', '') AS load_id,
            COALESCE(load.value ->> 'name', '') AS load_name,
            COALESCE(load.value ->> 'parkingSpot', '') AS parking_spot
       FROM dispatch_plans plan
       JOIN dispatch_plan_snapshots snapshot ON snapshot.plan_id = plan.id
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(snapshot.trucks, '[]'::jsonb)) truck(value)
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(truck.value -> 'loads', '[]'::jsonb)) load(value)
      WHERE plan.status <> 'cancelled'
        AND EXISTS (
          SELECT 1
            FROM jsonb_array_elements(COALESCE(load.value -> 'stops', '[]'::jsonb)) stop(value)
           WHERE stop.value ->> 'type' = 'drop'
             AND lower(btrim(COALESCE(stop.value ->> 'orderId', ''))) = lower(btrim($1))
        )
      ORDER BY plan.plan_date DESC, plan.id DESC
      LIMIT 1`,
    [String(orderRef)]
  );
  if (!result.rowCount) return null;
  const row = result.rows[0];
  return {
    planId: row.plan_id,
    planDate: row.plan_date,
    truckPlate: row.truck_plate || "",
    loadId: row.load_id || "",
    loadName: row.load_name || "",
    parkingSpot: row.parking_spot || ""
  };
}

async function loadCycleLines(cycleId, { forUpdate = false } = {}) {
  const result = await query(
    `SELECT *
       FROM operator_reload_cycle_lines
      WHERE cycle_id = $1
      ORDER BY netsuite_line_id NULLS LAST, sales_order_line_id
      ${forUpdate ? "FOR UPDATE" : ""}`,
    [cycleId]
  );
  return result.rows.map(mapReloadLine);
}

async function cycleRowById(cycleId, { forUpdate = false } = {}) {
  const result = await query(
    `SELECT * FROM operator_reload_cycles WHERE id = $1 ${forUpdate ? "FOR UPDATE" : ""}`,
    [cycleId]
  );
  return result.rows[0] || null;
}

async function activeCycleRowForOrder(orderId, { forUpdate = false } = {}) {
  const result = await query(
    `SELECT *
       FROM operator_reload_cycles
      WHERE sales_order_id = $1
        AND status = ANY($2::text[])
      ORDER BY cycle_number DESC
      LIMIT 1
      ${forUpdate ? "FOR UPDATE" : ""}`,
    [orderId, ACTIVE_RELOAD_STATUSES]
  );
  return result.rows[0] || null;
}

export async function getReloadCycle(cycleId) {
  const row = await cycleRowById(positiveId(cycleId, "Re-load cycle"));
  if (!row) return null;
  const child = await reattemptOrderForCycle(row.id);
  const assignment = child ? await reattemptAssignment(child.refNumber) : null;
  return mapReloadCycle(row, await loadCycleLines(row.id), child, assignment);
}

export async function findReloadCycleByRequestId(requestId) {
  const normalized = normalizeReloadRequestId(requestId);
  const result = await query("SELECT id FROM operator_reload_cycles WHERE request_id = $1::uuid", [normalized]);
  return result.rowCount ? getReloadCycle(result.rows[0].id) : null;
}

export async function findLocalSalesOrderIdentity(orderId) {
  const result = await query(
    `SELECT netsuite_id, tranid, outbound_location_id
       FROM sales_orders
      WHERE netsuite_id = $1
      LIMIT 1`,
    [positiveId(orderId, "Sales Order")]
  );
  if (!result.rowCount) return null;
  return {
    netsuiteId: Number(result.rows[0].netsuite_id),
    tranid: result.rows[0].tranid || "",
    outboundLocationId: result.rows[0].outbound_location_id === null
      ? null
      : Number(result.rows[0].outbound_location_id)
  };
}

export async function lockReloadAuthorizationSnapshot(orderId) {
  const id = positiveId(orderId, "Sales Order");
  const orderResult = await query(
    `SELECT o.*, o.sales_order_type AS delivery_method, 'sales_order'::text AS order_type
       FROM sales_orders o
      WHERE o.netsuite_id = $1
      FOR UPDATE`,
    [id]
  );
  if (!orderResult.rowCount) {
    throw reloadRepositoryError("Sales Order was not found.", "RELOAD_ORDER_NOT_FOUND", 404);
  }
  const order = orderResult.rows[0];
  const lines = await query(
    `SELECT *
       FROM sales_order_lines
      WHERE sales_order_id = $1
      ORDER BY line_id NULLS LAST, id
      FOR UPDATE`,
    [id]
  );
  const prior = await query(
      `SELECT COUNT(*)::int AS count
         FROM operator_load_records
        WHERE order_family = 'sales_order'
          AND order_id = $1
          AND load_type = 'sales_order_delivery_load'
          AND reload_cycle_id IS NULL`,
      [id]
    );
  const sourceLoad = await query(
    `SELECT *
       FROM operator_load_records
      WHERE order_family = 'sales_order'
        AND order_id = $1
        AND load_type = 'sales_order_delivery_load'
        AND reload_cycle_id IS NULL
      ORDER BY created_at DESC, id DESC
      LIMIT 1
      FOR UPDATE`,
    [id]
  );
  const active = await query(
      `SELECT *
         FROM operator_reload_cycles
        WHERE sales_order_id = $1
          AND status = ANY($2::text[])
        LIMIT 1`,
      [id, ACTIVE_RELOAD_STATUSES]
    );
  const driver = await query(
      `SELECT EXISTS (
         SELECT 1
           FROM driver_job_records record
          WHERE record.status = 'complete'
            AND record.stop_type = 'dropoff'
            AND EXISTS (
              SELECT 1
                FROM jsonb_array_elements_text(
                  CASE
                    WHEN jsonb_typeof(COALESCE(record.order_refs, '[]'::jsonb)) = 'array'
                      THEN COALESCE(record.order_refs, '[]'::jsonb)
                    ELSE '[]'::jsonb
                  END
                ) reference(order_ref)
               WHERE lower(btrim(reference.order_ref)) = lower(btrim($1))
                  OR lower(btrim(reference.order_ref)) IN (
                    SELECT lower(btrim(member.group_ref))
                      FROM dispatch_delivery_group_members member
                      JOIN dispatch_delivery_groups delivery_group ON delivery_group.group_ref = member.group_ref
                     WHERE delivery_group.active = true
                       AND lower(btrim(member.member_order_ref)) = lower(btrim($1))
                  )
            )
       ) AS completed_dropoff`,
      [order.tranid || ""]
    );
  const consolidation = await query(
      `SELECT EXISTS (
         SELECT 1
           FROM operator_consolidation_claims claim
           JOIN operator_consolidation_orders batch_order ON batch_order.id = claim.batch_order_id
           JOIN operator_consolidation_batches batch ON batch.id = batch_order.batch_id
          WHERE claim.canonical_order_id = $1
            AND claim.released_at IS NULL
            AND batch.status = 'active'
       ) AS active_consolidation`,
      [id]
    );
  const draft = await query(
      `SELECT (
         o.preparing_operator_id IS NOT NULL
         OR EXISTS (
           SELECT 1
             FROM sales_order_lines line
            WHERE line.sales_order_id = o.netsuite_id
              AND (
                COALESCE(line.packed_pallet_qty, 0) > 0
                OR COALESCE(line.packed_layer_qty, 0) > 0
                OR COALESCE(line.packed_section_qty, 0) > 0
                OR COALESCE(line.packed_piece_qty, 0) > 0
                OR COALESCE(line.packed_sales_qty, 0) > 0
              )
         )
       ) AS active_draft
       FROM sales_orders o
       WHERE o.netsuite_id = $1`,
      [id]
    );
  const sourceLoadRow = sourceLoad.rows[0] || null;
  const historicalLines = Array.isArray(sourceLoadRow?.attempt_line_snapshot)
    && sourceLoadRow.attempt_line_snapshot.length
    ? sourceLoadRow.attempt_line_snapshot
    : (Array.isArray(sourceLoadRow?.line_snapshot) ? sourceLoadRow.line_snapshot : []);
  const historicalItemIds = [...new Set(historicalLines
    .map((line) => Number(line?.itemId ?? line?.item_id))
    .filter((value) => Number.isSafeInteger(value) && value > 0))];
  const catalog = historicalItemIds.length
    ? await query(
        `SELECT item_id, item_name, display_name, item_description, stock_unit,
                to_plt, to_lyr, to_sec, to_pcs, item_weight
           FROM inventory_items
          WHERE item_id = ANY($1::bigint[])`,
        [historicalItemIds]
      )
    : { rows: [] };
  const reattemptPreview = sourceLoadRow
    ? buildSalesOrderReattemptPreview({
        sourceLoadRecordId: sourceLoadRow.id,
        historicalLines,
        currentLines: lines.rows,
        itemCatalog: catalog.rows
      })
    : null;
  return {
    order,
    lines: lines.rows,
    priorLoadCount: Number(prior.rows[0]?.count || 0),
    completedDropoff: Boolean(driver.rows[0]?.completed_dropoff),
    activeCycle: active.rows[0] ? mapReloadCycle(active.rows[0]) : null,
    activeDraft: Boolean(draft.rows[0]?.active_draft),
    activeConsolidation: Boolean(consolidation.rows[0]?.active_consolidation),
    sourceLoadRecord: sourceLoadRow,
    reattemptPreview
  };
}

export async function getSalesOrderReattemptAuthorizationPreview(orderId) {
  const snapshot = await lockReloadAuthorizationSnapshot(orderId);
  if (!snapshot.reattemptPreview) {
    throw reloadRepositoryError(
      "This Sales Order has no immutable original load evidence.",
      "REATTEMPT_EVIDENCE_NOT_FOUND",
      409
    );
  }
  return {
    orderId: Number(snapshot.order.netsuite_id),
    orderRef: snapshot.order.tranid || "",
    completedDropoff: Boolean(snapshot.completedDropoff),
    workflowKind: snapshot.completedDropoff ? "sales_order_reattempt" : "standard_reload",
    sourceLoadRecordId: snapshot.reattemptPreview.sourceLoadRecordId,
    sourceLoadProcessedAt: snapshot.sourceLoadRecord?.created_at || null,
    lines: snapshot.reattemptPreview.lines
  };
}

function cycleTarget(target = {}, index, cleanReason) {
  const selectedForReattempt = target.selectedForReattempt !== false && quantity(target.targetSalesQty) > QUANTITY_TOLERANCE;
  return {
    ...target,
    lineKey: target.lineKey || `legacy:${index}:${target.netsuiteLineId || target.salesOrderLineId || "line"}`,
    historicalLineIndex: target.historicalLineIndex ?? index,
    historicalLineId: target.historicalLineId ?? target.netsuiteLineId ?? null,
    historicalItemId: target.historicalItemId ?? target.itemId ?? null,
    historicalItemName: target.historicalItemName || target.itemName || "",
    historicalSku: target.historicalSku || target.sku || target.itemName || "",
    historicalDescription: target.historicalDescription || target.itemDescription || "",
    historicalSalesUom: target.historicalSalesUom || target.salesUom || "",
    historicalSalesQty: target.historicalSalesQty ?? target.targetSalesQty,
    historicalPalletQty: target.historicalPalletQty ?? target.targetPalletQty,
    historicalLayerQty: target.historicalLayerQty ?? target.targetLayerQty,
    historicalSectionQty: target.historicalSectionQty ?? target.targetSectionQty,
    historicalPieceQty: target.historicalPieceQty ?? target.targetPieceQty,
    currentSalesOrderLineId: target.currentSalesOrderLineId ?? target.salesOrderLineId ?? null,
    currentLineId: target.currentLineId ?? target.netsuiteLineId ?? null,
    currentItemId: target.currentItemId ?? target.itemId ?? null,
    currentItemName: target.currentItemName || target.itemName || "",
    currentSku: target.currentSku || target.sku || "",
    currentDescription: target.currentDescription || target.itemDescription || "",
    currentSalesQty: target.currentSalesQty ?? target.targetSalesQty,
    currentSalesUom: target.currentSalesUom || target.salesUom || "",
    selectedForReattempt,
    selectionReason: selectedForReattempt ? (target.selectionReason || cleanReason) : "",
    alreadyDeliveredSalesQty: target.alreadyDeliveredSalesQty || 0,
    alreadyDeliveredPalletQty: target.alreadyDeliveredPalletQty || 0,
    alreadyDeliveredLayerQty: target.alreadyDeliveredLayerQty || 0,
    alreadyDeliveredSectionQty: target.alreadyDeliveredSectionQty || 0,
    alreadyDeliveredPieceQty: target.alreadyDeliveredPieceQty || 0,
    itemWeight: target.itemWeight || 0
  };
}

function reattemptLineSnapshot(target, cycleId) {
  const lineWeight = rounded(quantity(target.targetSalesQty) * quantity(target.itemWeight));
  return {
    lineRowId: `reattempt:${cycleId}:${target.historicalLineIndex}`,
    lineId: target.historicalLineId ?? target.netsuiteLineId ?? target.historicalLineIndex + 1,
    salesOrderLineId: target.currentSalesOrderLineId,
    itemId: target.historicalItemId,
    sku: target.historicalSku,
    itemName: target.historicalItemName || target.historicalSku,
    description: target.historicalDescription,
    pallets: quantity(target.targetPalletQty),
    layers: quantity(target.targetLayerQty),
    sections: quantity(target.targetSectionQty),
    pieces: quantity(target.targetPieceQty),
    quantity: quantity(target.targetSalesQty),
    salesQty: quantity(target.targetSalesQty),
    unit: target.historicalSalesUom,
    itemWeight: quantity(target.itemWeight),
    lineWeight,
    reason: target.selectionReason,
    historicalSku: target.historicalSku,
    currentSku: target.currentSku,
    skuMismatch: Boolean(target.skuMismatch),
    itemMismatch: Boolean(target.itemMismatch)
  };
}

export async function createReloadCycle({
  order,
  targets = [],
  reason,
  requestId,
  actor,
  workflowKind = "standard_reload",
  sourceLoadRecordId = null
} = {}) {
  const orderId = positiveId(order?.netsuite_id ?? order?.netsuiteId, "Sales Order");
  const cleanReason = normalizeReloadReason(reason);
  const cleanRequestId = normalizeReloadRequestId(requestId);
  const cleanWorkflowKind = workflowKind === "sales_order_reattempt" ? workflowKind : "standard_reload";
  const cleanSourceLoadRecordId = cleanWorkflowKind === "sales_order_reattempt"
    ? positiveId(sourceLoadRecordId, "Original load record")
    : null;
  return withTransaction(async () => {
    await query("SELECT netsuite_id FROM sales_orders WHERE netsuite_id = $1 FOR UPDATE", [orderId]);
    const nextCycle = await query(
      `SELECT COALESCE(MAX(cycle_number) + 1, 1)::int AS cycle_number
         FROM operator_reload_cycles
        WHERE sales_order_id = $1`,
      [orderId]
    );
    const cycleNumber = Number(nextCycle.rows[0]?.cycle_number || 1);
    const originalOrderRef = String(order.tranid || order.orderRef || "").trim();
    const reattemptOrderRef = cleanWorkflowKind === "sales_order_reattempt"
      ? `${originalOrderRef}-R${cycleNumber}`
      : null;
    if (reattemptOrderRef && reattemptOrderRef.length > 100) {
      throw reloadRepositoryError("The generated re-attempt reference is too long.", "REATTEMPT_REF_INVALID", 409);
    }
    const inserted = await query(
      `INSERT INTO operator_reload_cycles (
         sales_order_id, order_ref, outbound_location_id, cycle_number,
         request_id, status, reason, netsuite_status, netsuite_status_text,
         authorized_by, workflow_kind, source_load_record_id, reattempt_order_ref
       ) VALUES (
         $1, $2, $3, $4,
         $5::uuid, 'authorized', $6, $7, $8, $9,
         $10, $11, $12
       )
       RETURNING *`,
      [
        orderId,
        originalOrderRef,
        order.outbound_location_id ?? order.outboundLocationId ?? null,
        cycleNumber,
        cleanRequestId,
        cleanReason,
        order.status || "",
        order.status_text || order.statusText || "",
        actor?.id || null,
        cleanWorkflowKind,
        cleanSourceLoadRecordId,
        reattemptOrderRef
      ]
    );
    const cycleId = inserted.rows[0].id;
    const frozenTargets = targets.map((target, index) => cycleTarget(target, index, cleanReason));
    for (const target of frozenTargets) {
      await query(
        `INSERT INTO operator_reload_cycle_lines (
           cycle_id, sales_order_line_id, netsuite_line_id, item_id,
           item_name, sku, item_description, sales_uom,
           target_sales_qty, target_pallet_qty, target_layer_qty,
           target_section_qty, target_piece_qty,
           to_plt, to_lyr, to_sec, to_pcs,
           line_key, historical_line_index, historical_line_id, historical_item_id,
           historical_item_name, historical_sku, historical_description, historical_sales_uom,
           historical_loaded_sales_qty, historical_pallet_qty, historical_layer_qty,
           historical_section_qty, historical_piece_qty,
           current_sales_order_line_id, current_line_id, current_item_id,
           current_item_name, current_sku, current_description, current_sales_qty, current_sales_uom,
           sku_mismatch, item_mismatch, selected_for_reattempt, selection_reason,
           already_delivered_sales_qty, already_delivered_pallet_qty, already_delivered_layer_qty,
           already_delivered_section_qty, already_delivered_piece_qty, item_weight
         ) VALUES (
           $1, $2, $3, $4,
           $5, $6, $7, $8,
           $9, $10, $11, $12, $13,
           $14, $15, $16, $17,
           $18, $19, $20, $21,
           $22, $23, $24, $25,
           $26, $27, $28, $29, $30,
           $31, $32, $33, $34, $35, $36, $37, $38,
           $39, $40, $41, $42, $43, $44, $45, $46, $47, $48
         )`,
        [
          cycleId,
          target.salesOrderLineId,
          target.netsuiteLineId,
          target.itemId,
          target.itemName || "",
          target.sku || "",
          target.itemDescription || "",
          target.salesUom || "",
          target.targetSalesQty,
          target.targetPalletQty,
          target.targetLayerQty,
          target.targetSectionQty,
          target.targetPieceQty,
          target.toPlt,
          target.toLyr,
          target.toSec,
          target.toPcs,
          target.lineKey,
          target.historicalLineIndex,
          target.historicalLineId,
          target.historicalItemId,
          target.historicalItemName,
          target.historicalSku,
          target.historicalDescription,
          target.historicalSalesUom,
          target.historicalSalesQty,
          target.historicalPalletQty,
          target.historicalLayerQty,
          target.historicalSectionQty,
          target.historicalPieceQty,
          target.currentSalesOrderLineId,
          target.currentLineId,
          target.currentItemId,
          target.currentItemName,
          target.currentSku,
          target.currentDescription,
          target.currentSalesQty,
          target.currentSalesUom,
          Boolean(target.skuMismatch),
          Boolean(target.itemMismatch),
          target.selectedForReattempt,
          target.selectionReason,
          target.alreadyDeliveredSalesQty,
          target.alreadyDeliveredPalletQty,
          target.alreadyDeliveredLayerQty,
          target.alreadyDeliveredSectionQty,
          target.alreadyDeliveredPieceQty,
          target.itemWeight
        ]
      );
    }
    if (cleanWorkflowKind === "sales_order_reattempt") {
      const selectedLines = frozenTargets
        .filter((target) => target.selectedForReattempt)
        .map((target) => reattemptLineSnapshot(target, cycleId));
      if (!selectedLines.length) {
        throw reloadRepositoryError("Select at least one re-attempt line.", "REATTEMPT_SELECTION_REQUIRED", 400);
      }
      const pickupLocation = String(order.outbound_location || order.outboundLocation || "").trim();
      const dropoffLocation = String(order.dispatch_address || order.dispatchAddress || "").trim();
      if (!pickupLocation || !dropoffLocation) {
        throw reloadRepositoryError(
          "The re-attempt requires both a pickup yard and customer destination.",
          "REATTEMPT_ROUTE_INCOMPLETE",
          409
        );
      }
      const totals = selectedLines.reduce((sum, line) => ({
        pallets: rounded(sum.pallets + quantity(line.pallets)),
        layers: rounded(sum.layers + quantity(line.layers)),
        sections: rounded(sum.sections + quantity(line.sections)),
        pieces: rounded(sum.pieces + quantity(line.pieces)),
        salesQty: rounded(sum.salesQty + quantity(line.salesQty)),
        weightLbs: rounded(sum.weightLbs + quantity(line.lineWeight))
      }), { pallets: 0, layers: 0, sections: 0, pieces: 0, salesQty: 0, weightLbs: 0 });
      const child = await query(
        `INSERT INTO dispatch_custom_orders (
           ref_number, pickup_location, dropoff_location, order_details,
           weight_lbs, status, created_by, updated_by,
           order_kind, system_managed, parent_sales_order_id, parent_order_ref,
           reload_cycle_id, line_snapshot, pallet_qty, layer_qty, section_qty,
           piece_qty, sales_qty, billing_disposition
         ) VALUES (
           $1, $2, $3, $4, $5, 'open', $6, $6,
           'sales_order_reattempt', true, $7, $8,
           $9, $10::jsonb, $11, $12, $13, $14, $15, 'linked_parent_no_charge'
         )
         RETURNING *`,
        [
          reattemptOrderRef,
          pickupLocation,
          dropoffLocation,
          `Sales Order re-attempt for ${originalOrderRef}. ${selectedLines.length} selected line(s). ${cleanReason}`,
          totals.weightLbs,
          actor?.id || "system",
          orderId,
          originalOrderRef,
          cycleId,
          JSON.stringify(selectedLines),
          totals.pallets,
          totals.layers,
          totals.sections,
          totals.pieces,
          totals.salesQty
        ]
      );
      await query(
        `UPDATE operator_reload_cycles
            SET reattempt_order_id = $2,
                updated_at = now()
          WHERE id = $1`,
        [cycleId, child.rows[0].id]
      );
    }
    return getReloadCycle(cycleId);
  });
}

export async function getActiveReloadCycleForOrder(orderId, { forUpdate = false } = {}) {
  const row = await activeCycleRowForOrder(positiveId(orderId, "Sales Order"), { forUpdate });
  if (!row) return null;
  const child = await reattemptOrderForCycle(row.id);
  const assignment = child ? await reattemptAssignment(child.refNumber) : null;
  return mapReloadCycle(row, await loadCycleLines(row.id, { forUpdate }), child, assignment);
}

export async function lockReloadCycle(cycleId) {
  const row = await cycleRowById(positiveId(cycleId, "Re-load cycle"), { forUpdate: true });
  if (!row) return null;
  const child = await reattemptOrderForCycle(row.id);
  const assignment = child ? await reattemptAssignment(child.refNumber) : null;
  return mapReloadCycle(row, await loadCycleLines(row.id, { forUpdate: true }), child, assignment);
}

export async function cancelReloadCycle({ cycleId, reason, actor } = {}) {
  const id = positiveId(cycleId, "Re-load cycle");
  const cleanReason = normalizeReloadReason(reason);
  return withTransaction(async () => {
    const cycle = await lockReloadCycle(id);
    if (!cycle) throw reloadRepositoryError("Re-load cycle was not found.", "RELOAD_CYCLE_NOT_FOUND", 404);
    if (cycle.status === "cancelled") return cycle;
    if (cycle.activityStartedAt || cycle.status !== "authorized") {
      throw reloadRepositoryError(
        "This re-load already has Operator activity and cannot be cancelled.",
        "RELOAD_ALREADY_STARTED"
      );
    }
    if (cycle.workflowKind === "sales_order_reattempt") {
      if (cycle.dispatchPlanId) {
        throw reloadRepositoryError(
          `Unplan ${cycle.reattemptOrderRef} before cancelling this re-attempt.`,
          "REATTEMPT_UNPLAN_REQUIRED",
          409
        );
      }
      const activity = await query(
        `SELECT EXISTS (
           SELECT 1
             FROM driver_job_records record
            WHERE record.status IN ('in_progress', 'complete')
              AND EXISTS (
                SELECT 1
                  FROM jsonb_array_elements_text(
                    CASE WHEN jsonb_typeof(COALESCE(record.order_refs, '[]'::jsonb)) = 'array'
                      THEN COALESCE(record.order_refs, '[]'::jsonb)
                      ELSE '[]'::jsonb
                    END
                  ) reference(order_ref)
                 WHERE lower(btrim(reference.order_ref)) = lower(btrim($1))
              )
         ) AS has_activity`,
        [cycle.reattemptOrderRef]
      );
      if (activity.rows[0]?.has_activity || cycle.reattemptOrder?.status !== "open") {
        throw reloadRepositoryError(
          "This re-attempt has Driver activity and cannot be cancelled.",
          "RELOAD_ALREADY_STARTED",
          409
        );
      }
    }
    const result = await query(
      `UPDATE operator_reload_cycles
          SET status = 'cancelled',
              cancelled_by = $2,
              cancelled_at = now(),
              cancel_reason = $3,
              preparing_operator_id = null,
              preparing_started_at = null,
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [id, actor?.id || null, cleanReason]
    );
    if (cycle.reattemptOrderId) {
      await query(
        `UPDATE dispatch_custom_orders
            SET status = 'cancelled',
                cancelled_by = $2,
                cancelled_at = now(),
                updated_by = $2,
                updated_at = now()
          WHERE id = $1
            AND order_kind = 'sales_order_reattempt'
            AND status = 'open'`,
        [cycle.reattemptOrderId, actor?.id || "system"]
      );
    }
    return getReloadCycle(result.rows[0].id);
  });
}

export async function listActiveReloadOrders({ locationId = null } = {}) {
  const params = [ACTIVE_RELOAD_STATUSES];
  const locationClause = locationId === null || locationId === undefined || locationId === ""
    ? ""
    : `AND o.outbound_location_id = $${params.push(Number(locationId))}`;
  const result = await query(
    `SELECT o.*, o.sales_order_type AS delivery_method, 'sales_order'::text AS order_type,
            cycle.id AS reload_cycle_id
       FROM operator_reload_cycles cycle
       JOIN sales_orders o ON o.netsuite_id = cycle.sales_order_id
      WHERE cycle.status = ANY($1::text[])
        ${locationClause}
      ORDER BY cycle.authorized_at DESC, cycle.id DESC`,
    params
  );
  const rows = [];
  for (const row of result.rows) {
    const cycle = await getReloadCycle(row.reload_cycle_id);
    if (cycle?.workflowKind === "sales_order_reattempt" && !cycle.dispatchPlanId) continue;
    const reattempt = cycle?.workflowKind === "sales_order_reattempt";
    rows.push({
      ...row,
      tranid: reattempt ? cycle.reattemptOrderRef : row.tranid,
      original_order_ref: reattempt ? cycle.orderRef : row.tranid,
      dispatch_planned: reattempt ? true : row.dispatch_planned,
      dispatch_plan_date: reattempt ? cycle.dispatchPlanDate : row.dispatch_plan_date,
      dispatch_truck_plate: reattempt ? cycle.dispatchTruckPlate : row.dispatch_truck_plate,
      dispatch_load_name: reattempt ? cycle.dispatchLoadName : row.dispatch_load_name,
      dispatch_parking_spot: reattempt ? cycle.dispatchParkingSpot : row.dispatch_parking_spot,
      netsuite_id: Number(row.netsuite_id),
      outbound_location_id: row.outbound_location_id === null ? null : Number(row.outbound_location_id),
      reload_cycle: cycle,
      reloadCycle: cycle
    });
  }
  return rows;
}

function assertCycleOperator(cycle, operatorId) {
  if (cycle.preparingOperatorId && String(cycle.preparingOperatorId) !== String(operatorId)) {
    throw reloadRepositoryError("This re-load is preparing on another tablet.", "RELOAD_OPERATOR_CONFLICT");
  }
}

function assertReattemptPlanned(cycle) {
  if (cycle.workflowKind === "sales_order_reattempt" && !cycle.dispatchPlanId) {
    throw reloadRepositoryError(
      `Plan ${cycle.reattemptOrderRef || "the re-attempt child"} in Dispatch before Operator activity.`,
      "REATTEMPT_PLAN_REQUIRED",
      409
    );
  }
}

async function cycleLineRow(cycleId, salesOrderLineId, { forUpdate = false } = {}) {
  const result = await query(
    `SELECT *
       FROM operator_reload_cycle_lines
      WHERE cycle_id = $1
        AND sales_order_line_id = $2
      ${forUpdate ? "FOR UPDATE" : ""}`,
    [cycleId, salesOrderLineId]
  );
  return result.rows[0] || null;
}

export async function updateReloadPackedQuantity({
  orderId,
  lineId,
  values = {},
  operatorId,
  absolute = false
} = {}) {
  const salesOrderId = positiveId(orderId, "Sales Order");
  const salesOrderLineId = positiveId(lineId, "Sales Order line");
  if (!operatorId) throw reloadRepositoryError("Operator ID is required.", "RELOAD_ACTOR_REQUIRED", 401);
  return withTransaction(async () => {
    const cycle = await getActiveReloadCycleForOrder(salesOrderId, { forUpdate: true });
    if (!cycle) throw reloadRepositoryError("No active re-load was found.", "RELOAD_CYCLE_NOT_FOUND", 404);
    assertReattemptPlanned(cycle);
    assertCycleOperator(cycle, operatorId);
    if (cycle.status === "packed") {
      throw reloadRepositoryError("Move this re-load back to preparing before changing quantities.", "RELOAD_ALREADY_PACKED");
    }
    const row = await cycleLineRow(cycle.id, salesOrderLineId, { forUpdate: true });
    if (!row) throw reloadRepositoryError("Re-load line was not found.", "RELOAD_LINE_NOT_FOUND", 404);
    if (row.selected_for_reattempt === false) {
      throw reloadRepositoryError("This line was recorded as already delivered and is not part of the re-attempt.", "REATTEMPT_LINE_NOT_SELECTED", 409);
    }
    const target = mapReloadLine(row);
    const packed = reloadPackedQuantities(target, target, values, { absolute });
    const updated = await query(
      `UPDATE operator_reload_cycle_lines
          SET packed_pallet_qty = $3,
              packed_layer_qty = $4,
              packed_section_qty = $5,
              packed_piece_qty = $6,
              packed_sales_qty = $7,
              updated_at = now()
        WHERE cycle_id = $1
          AND sales_order_line_id = $2
        RETURNING *`,
      [
        cycle.id,
        salesOrderLineId,
        packed.packedPalletQty,
        packed.packedLayerQty,
        packed.packedSectionQty,
        packed.packedPieceQty,
        packed.packedSalesQty
      ]
    );
    await query(
      `UPDATE operator_reload_cycles
          SET status = 'preparing',
              activity_started_at = COALESCE(activity_started_at, now()),
              preparing_operator_id = $2,
              preparing_started_at = COALESCE(preparing_started_at, now()),
              updated_at = now()
        WHERE id = $1`,
      [cycle.id, operatorId]
    );
    await writeAudit({
      actorOperatorId: operatorId,
      source: "operator",
      action: absolute ? "delivery.reload.line.update_packed_quantity" : "delivery.reload.line.confirm",
      orderId: salesOrderId,
      lineId: salesOrderLineId,
      details: { cycleId: cycle.id, ...packed }
    });
    return {
      cycle: await getReloadCycle(cycle.id),
      line: mapReloadLine(updated.rows[0])
    };
  });
}

export async function updateReloadCycleStatus({ orderId, status, operatorId } = {}) {
  const salesOrderId = positiveId(orderId, "Sales Order");
  if (!operatorId) throw reloadRepositoryError("Operator ID is required.", "RELOAD_ACTOR_REQUIRED", 401);
  if (!new Set(["preparing", "packed"]).has(status)) {
    throw reloadRepositoryError("Invalid re-load status.", "RELOAD_STATUS_INVALID", 400);
  }
  return withTransaction(async () => {
    const cycle = await getActiveReloadCycleForOrder(salesOrderId, { forUpdate: true });
    if (!cycle) throw reloadRepositoryError("No active re-load was found.", "RELOAD_CYCLE_NOT_FOUND", 404);
    assertReattemptPlanned(cycle);
    assertCycleOperator(cycle, operatorId);
    if (status === "packed") {
      const packed = await query(
        `SELECT EXISTS (
           SELECT 1 FROM operator_reload_cycle_lines
            WHERE cycle_id = $1
              AND (
                COALESCE(packed_pallet_qty, 0) > 0
                OR COALESCE(packed_layer_qty, 0) > 0
                OR COALESCE(packed_section_qty, 0) > 0
                OR COALESCE(packed_piece_qty, 0) > 0
                OR COALESCE(packed_sales_qty, 0) > 0
              )
         ) AS has_packed`,
        [cycle.id]
      );
      if (!packed.rows[0]?.has_packed) {
        throw reloadRepositoryError("Confirm at least one re-load line before marking Packed.", "RELOAD_NOT_PACKED");
      }
    }
    await query(
      `UPDATE operator_reload_cycles
          SET status = $2,
              activity_started_at = COALESCE(activity_started_at, now()),
              preparing_operator_id = CASE WHEN $2 = 'packed' THEN null ELSE $3 END,
              preparing_started_at = CASE WHEN $2 = 'packed' THEN null ELSE COALESCE(preparing_started_at, now()) END,
              updated_at = now()
        WHERE id = $1`,
      [cycle.id, status, operatorId]
    );
    await writeAudit({
      actorOperatorId: operatorId,
      source: "operator",
      action: "delivery.reload.status",
      orderId: salesOrderId,
      details: { cycleId: cycle.id, status }
    });
    return getReloadCycle(cycle.id);
  });
}

export async function releaseReloadDraft(orderId, operatorId) {
  const salesOrderId = positiveId(orderId, "Sales Order");
  return withTransaction(async () => {
    const cycle = await getActiveReloadCycleForOrder(salesOrderId, { forUpdate: true });
    if (!cycle) return null;
    assertReattemptPlanned(cycle);
    assertCycleOperator(cycle, operatorId);
    await query(
      `UPDATE operator_reload_cycle_lines
          SET packed_pallet_qty = 0,
              packed_layer_qty = 0,
              packed_section_qty = 0,
              packed_piece_qty = 0,
              packed_sales_qty = 0,
              updated_at = now()
        WHERE cycle_id = $1`,
      [cycle.id]
    );
    await query(
      `UPDATE operator_reload_cycles
          SET status = CASE WHEN activity_started_at IS NULL THEN 'authorized' ELSE 'in_progress' END,
              preparing_operator_id = null,
              preparing_started_at = null,
              updated_at = now()
        WHERE id = $1`,
      [cycle.id]
    );
    await writeAudit({
      actorOperatorId: operatorId || null,
      source: "operator",
      action: "delivery.reload.draft.release",
      orderId: salesOrderId,
      details: { cycleId: cycle.id }
    });
    return getReloadCycle(cycle.id);
  });
}

async function existingReloadAttempt(requestId) {
  const result = await query(
    `SELECT record.*, cycle.reason, cycle.cycle_number
       FROM operator_load_records record
       JOIN operator_reload_cycles cycle ON cycle.id = record.reload_cycle_id
      WHERE record.load_request_id = $1::uuid
      LIMIT 1`,
    [requestId]
  );
  return result.rows[0] || null;
}

export async function getReloadLoadAttemptByRequestId(requestId) {
  const cleanRequestId = normalizeReloadRequestId(requestId);
  const row = await existingReloadAttempt(cleanRequestId);
  return row ? attemptResultFromRow(row, { idempotent: true }) : null;
}

function attemptResultFromRow(row, { idempotent = false } = {}) {
  const response = row?.response && typeof row.response === "object" ? row.response : {};
  const attemptLines = Array.isArray(row?.attempt_line_snapshot) ? row.attempt_line_snapshot : [];
  return {
    id: Number(row.id),
    salesOrderId: Number(row.order_id),
    localOnly: true,
    reloadCycleId: Number(row.reload_cycle_id),
    reloadCycleNumber: Number(row.cycle_number || response.reloadCycleNumber || 0),
    workflowKind: response.workflowKind || "standard_reload",
    reattemptOrderId: response.reattemptOrderId ? Number(response.reattemptOrderId) : null,
    reattemptOrderRef: response.reattemptOrderRef || "",
    completed: Boolean(response.completed),
    remainingSalesQty: quantity(response.remainingSalesQty),
    attemptLines,
    idempotent
  };
}

function assertReloadAttemptRequestScope(existing, { salesOrderId, activeCycle } = {}) {
  const sameOrder = Number(existing?.order_id) === Number(salesOrderId);
  const sameActiveCycle = !activeCycle || Number(existing?.reload_cycle_id) === Number(activeCycle.id);
  if (!sameOrder || !sameActiveCycle) {
    throw reloadRepositoryError(
      "Load request ID was already used for another order or re-load cycle.",
      "RELOAD_REQUEST_CONFLICT",
      409
    );
  }
}

export async function recordReloadLoadAttempt(orderId, operatorId, { photoDataUrls, requestId } = {}) {
  const salesOrderId = positiveId(orderId, "Sales Order");
  if (!operatorId) throw reloadRepositoryError("Operator ID is required.", "RELOAD_ACTOR_REQUIRED", 401);
  const photos = requireReloadPhotos(photoDataUrls);
  const cleanRequestId = normalizeReloadRequestId(requestId);
  return withTransaction(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [cleanRequestId]);
    const existing = await existingReloadAttempt(cleanRequestId);
    const cycle = await getActiveReloadCycleForOrder(salesOrderId, { forUpdate: true });
    if (existing) {
      assertReloadAttemptRequestScope(existing, { salesOrderId, activeCycle: cycle });
      return attemptResultFromRow(existing, { idempotent: true });
    }
    if (!cycle) throw reloadRepositoryError("No active re-load was found.", "RELOAD_CYCLE_NOT_FOUND", 404);
    assertReattemptPlanned(cycle);
    if (cycle.status !== "packed") {
      throw reloadRepositoryError("Re-load must be marked Packed before loading.", "RELOAD_NOT_PACKED");
    }
    const rows = await query(
      `SELECT *
         FROM operator_reload_cycle_lines
        WHERE cycle_id = $1
        ORDER BY netsuite_line_id NULLS LAST, sales_order_line_id
        FOR UPDATE`,
      [cycle.id]
    );
    const attemptLines = [];
    for (const line of rows.rows) {
      const loadedSalesQty = linePackedSalesQty(line);
      if (loadedSalesQty <= QUANTITY_TOLERANCE) continue;
      if (quantity(line.reloaded_sales_qty) + loadedSalesQty > quantity(line.target_sales_qty) + 0.1) {
        throw reloadRepositoryError("Packed re-load quantity exceeds its frozen authorization.", "RELOAD_QUANTITY_EXCEEDED");
      }
      attemptLines.push({
        lineId: line.netsuite_line_id === null ? Number(line.sales_order_line_id) : Number(line.netsuite_line_id),
        salesOrderLineId: Number(line.sales_order_line_id),
        itemId: line.item_id === null ? null : Number(line.item_id),
        itemName: line.item_name || "",
        sku: line.sku || "",
        description: line.item_description || "",
        loadedQty: loadedSalesQty,
        loadedUom: line.sales_uom || "",
        packedPallets: quantity(line.packed_pallet_qty),
        packedLayers: quantity(line.packed_layer_qty),
        packedSections: quantity(line.packed_section_qty),
        packedPieces: quantity(line.packed_piece_qty),
        packedSalesQty: quantity(line.packed_sales_qty)
      });
      await query(
        `UPDATE operator_reload_cycle_lines
            SET reloaded_pallet_qty = reloaded_pallet_qty + packed_pallet_qty,
                reloaded_layer_qty = reloaded_layer_qty + packed_layer_qty,
                reloaded_section_qty = reloaded_section_qty + packed_section_qty,
                reloaded_piece_qty = reloaded_piece_qty + packed_piece_qty,
                reloaded_sales_qty = reloaded_sales_qty + $2,
                packed_pallet_qty = 0,
                packed_layer_qty = 0,
                packed_section_qty = 0,
                packed_piece_qty = 0,
                packed_sales_qty = 0,
                updated_at = now()
          WHERE id = $1`,
        [line.id, loadedSalesQty]
      );
    }
    if (!attemptLines.length) {
      throw reloadRepositoryError("No packed re-load quantity was found.", "RELOAD_NOT_PACKED");
    }
    const progress = await query(
      `SELECT COALESCE(SUM(GREATEST(target_sales_qty - reloaded_sales_qty, 0)), 0) AS remaining_sales_qty,
              BOOL_AND(reloaded_sales_qty + 0.1 >= target_sales_qty) AS completed
         FROM operator_reload_cycle_lines
        WHERE cycle_id = $1`,
      [cycle.id]
    );
    const completed = Boolean(progress.rows[0]?.completed);
    const remainingSalesQty = rounded(progress.rows[0]?.remaining_sales_qty);
    await query(
      `UPDATE operator_reload_cycles
          SET status = $2,
              completed_at = CASE WHEN $2 = 'completed' THEN now() ELSE null END,
              preparing_operator_id = null,
              preparing_started_at = null,
              updated_at = now()
        WHERE id = $1`,
      [cycle.id, completed ? "completed" : "in_progress"]
    );
    const response = {
      localOnly: true,
      reloadCycleId: cycle.id,
      reloadCycleNumber: cycle.cycleNumber,
      workflowKind: cycle.workflowKind,
      reattemptOrderId: cycle.reattemptOrderId,
      reattemptOrderRef: cycle.reattemptOrderRef,
      completed,
      remainingSalesQty
    };
    const inserted = await query(
      `INSERT INTO operator_load_records (
         load_type, order_family, order_id, order_ref,
         operator_id, photo_data_url, photo_data_urls,
         line_snapshot, attempt_line_snapshot, response,
         reload_cycle_id, load_request_id
       ) VALUES (
         'sales_order_delivery_load', 'sales_order', $1, $2,
         $3, $4, $5::jsonb,
         $6::jsonb, $6::jsonb, $7::jsonb,
         $8, $9::uuid
       )
       RETURNING *`,
      [
        salesOrderId,
        cycle.reattemptOrderRef || cycle.orderRef,
        operatorId,
        photos[0],
        JSON.stringify(photos),
        JSON.stringify(attemptLines),
        JSON.stringify(response),
        cycle.id,
        cleanRequestId
      ]
    );
    await writeAudit({
      actorOperatorId: operatorId,
      source: "operator",
      action: completed ? "delivery.reload.complete" : "delivery.reload.load",
      orderId: salesOrderId,
      details: {
        cycleId: cycle.id,
        loadRecordId: inserted.rows[0].id,
        completed,
        remainingSalesQty,
        lineCount: attemptLines.length
      }
    });
    return attemptResultFromRow({
      ...inserted.rows[0],
      cycle_number: cycle.cycleNumber
    });
  });
}

export async function listSalesOrderLoadAttempts(orderId) {
  const salesOrderId = positiveId(orderId, "Sales Order");
  const result = await query(
    `SELECT record.*,
            cycle.cycle_number,
            cycle.reason,
            cycle.authorized_by,
            cycle.authorized_at,
            operator.display_name AS operator_name,
            authorizer.display_name AS authorized_by_name
       FROM operator_load_records record
       LEFT JOIN operator_reload_cycles cycle ON cycle.id = record.reload_cycle_id
       LEFT JOIN operators operator ON operator.id = record.operator_id
       LEFT JOIN operators authorizer ON authorizer.id = cycle.authorized_by
      WHERE record.order_family = 'sales_order'
        AND record.order_id = $1
        AND record.load_type = 'sales_order_delivery_load'
      ORDER BY record.created_at DESC, record.id DESC`,
    [salesOrderId]
  );
  return result.rows.map((row) => {
    const exact = Array.isArray(row.attempt_line_snapshot) && row.attempt_line_snapshot.length > 0;
    const attemptLines = exact
      ? row.attempt_line_snapshot
      : (Array.isArray(row.line_snapshot) ? row.line_snapshot : []);
    const photos = photoReferences(
      Array.isArray(row.photo_data_urls) && row.photo_data_urls.length
        ? row.photo_data_urls
        : [row.photo_data_url]
    );
    return {
      id: Number(row.id),
      attemptKind: row.reload_cycle_id ? "reload" : "original",
      quantityBasis: exact ? "exact_attempt" : "legacy_recorded_state",
      reloadCycleId: row.reload_cycle_id === null ? null : Number(row.reload_cycle_id),
      cycleNumber: row.cycle_number === null ? null : Number(row.cycle_number),
      reason: row.reason || "",
      authorizedBy: row.authorized_by || null,
      authorizedByName: row.authorized_by_name || "",
      authorizedAt: row.authorized_at || null,
      operatorId: row.operator_id || null,
      operatorName: row.operator_name || "",
      processedAt: row.created_at,
      photos,
      attemptLines,
      response: row.response || {}
    };
  });
}
