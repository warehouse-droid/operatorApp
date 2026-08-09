import { writeAudit } from "./auth-repository.js";
import { query, withTransaction } from "./db.js";
import {
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
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  };
  mapped.packedTotalSalesQty = linePackedSalesQty(row);
  mapped.remainingSalesQty = rounded(Math.max(0, mapped.targetSalesQty - mapped.reloadedSalesQty));
  return mapped;
}

function mapReloadCycle(row, lines = []) {
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
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    lines
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
  return mapReloadCycle(row, await loadCycleLines(row.id));
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
          AND load_type = 'sales_order_delivery_load'`,
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
  return {
    order,
    lines: lines.rows,
    priorLoadCount: Number(prior.rows[0]?.count || 0),
    completedDropoff: Boolean(driver.rows[0]?.completed_dropoff),
    activeCycle: active.rows[0] ? mapReloadCycle(active.rows[0]) : null,
    activeDraft: Boolean(draft.rows[0]?.active_draft),
    activeConsolidation: Boolean(consolidation.rows[0]?.active_consolidation)
  };
}

export async function createReloadCycle({ order, targets = [], reason, requestId, actor } = {}) {
  const orderId = positiveId(order?.netsuite_id ?? order?.netsuiteId, "Sales Order");
  const cleanReason = normalizeReloadReason(reason);
  const cleanRequestId = normalizeReloadRequestId(requestId);
  return withTransaction(async () => {
    await query("SELECT netsuite_id FROM sales_orders WHERE netsuite_id = $1 FOR UPDATE", [orderId]);
    const inserted = await query(
      `INSERT INTO operator_reload_cycles (
         sales_order_id, order_ref, outbound_location_id, cycle_number,
         request_id, status, reason, netsuite_status, netsuite_status_text,
         authorized_by
       ) VALUES (
         $1, $2, $3,
         COALESCE((SELECT MAX(cycle_number) + 1 FROM operator_reload_cycles WHERE sales_order_id = $1), 1),
         $4::uuid, 'authorized', $5, $6, $7, $8
       )
       RETURNING *`,
      [
        orderId,
        order.tranid || order.orderRef || "",
        order.outbound_location_id ?? order.outboundLocationId ?? null,
        cleanRequestId,
        cleanReason,
        order.status || "",
        order.status_text || order.statusText || "",
        actor?.id || null
      ]
    );
    const cycleId = inserted.rows[0].id;
    for (const target of targets) {
      await query(
        `INSERT INTO operator_reload_cycle_lines (
           cycle_id, sales_order_line_id, netsuite_line_id, item_id,
           item_name, sku, item_description, sales_uom,
           target_sales_qty, target_pallet_qty, target_layer_qty,
           target_section_qty, target_piece_qty,
           to_plt, to_lyr, to_sec, to_pcs
         ) VALUES (
           $1, $2, $3, $4,
           $5, $6, $7, $8,
           $9, $10, $11, $12, $13,
           $14, $15, $16, $17
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
          target.toPcs
        ]
      );
    }
    return mapReloadCycle(inserted.rows[0], await loadCycleLines(cycleId));
  });
}

export async function getActiveReloadCycleForOrder(orderId, { forUpdate = false } = {}) {
  const row = await activeCycleRowForOrder(positiveId(orderId, "Sales Order"), { forUpdate });
  if (!row) return null;
  return mapReloadCycle(row, await loadCycleLines(row.id, { forUpdate }));
}

export async function lockReloadCycle(cycleId) {
  const row = await cycleRowById(positiveId(cycleId, "Re-load cycle"), { forUpdate: true });
  if (!row) return null;
  return mapReloadCycle(row, await loadCycleLines(row.id, { forUpdate: true }));
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
    return mapReloadCycle(result.rows[0], cycle.lines);
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
    rows.push({
      ...row,
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
    assertCycleOperator(cycle, operatorId);
    if (cycle.status === "packed") {
      throw reloadRepositoryError("Move this re-load back to preparing before changing quantities.", "RELOAD_ALREADY_PACKED");
    }
    const row = await cycleLineRow(cycle.id, salesOrderLineId, { forUpdate: true });
    if (!row) throw reloadRepositoryError("Re-load line was not found.", "RELOAD_LINE_NOT_FOUND", 404);
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
        cycle.orderRef,
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
