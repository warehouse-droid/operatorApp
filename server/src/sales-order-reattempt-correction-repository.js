import { writeAudit } from "./auth-repository.js";
import { query, withTransaction } from "./db.js";
import {
  applyEffectiveReattemptIdentity,
  buildReattemptIdentityFingerprint,
  evaluateReattemptDriverReadiness,
  normalizeReattemptCorrectionCommand
} from "./sales-order-reattempt-correction.js";

function correctionError(message, code, status = 409) {
  return Object.assign(new Error(message), { code, status });
}

function positiveInteger(value, label, code = "REATTEMPT_CORRECTION_ID_INVALID") {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw correctionError(`${label} is invalid.`, code, 400);
  }
  return parsed;
}

function quantity(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Number(Math.max(0, parsed).toFixed(6)) : 0;
}

function normalizedRef(value) {
  return String(value || "").trim().toLowerCase();
}

function mapCorrection(row = {}) {
  if (!row?.id) {
    return null;
  }
  return {
    correctionId: Number(row.id),
    idempotencyKey: row.idempotency_key || "",
    childOrderId: Number(row.reattempt_order_id),
    cycleId: Number(row.cycle_id),
    parentSalesOrderId: Number(row.parent_sales_order_id),
    netsuiteLineId: Number(row.netsuite_line_id),
    beforeItemId: row.before_item_id === null ? null : Number(row.before_item_id),
    beforeSku: row.before_sku || "",
    beforeItemName: row.before_item_name || "",
    beforeDescription: row.before_description || "",
    beforeSalesUom: row.before_sales_uom || "",
    afterItemId: Number(row.after_item_id),
    afterSku: row.after_sku || "",
    afterItemName: row.after_item_name || "",
    afterDescription: row.after_description || "",
    afterSalesUom: row.after_sales_uom || "",
    targetSalesQty: quantity(row.target_sales_qty),
    targetPalletQty: quantity(row.target_pallet_qty),
    targetLayerQty: quantity(row.target_layer_qty),
    targetSectionQty: quantity(row.target_section_qty),
    targetPieceQty: quantity(row.target_piece_qty),
    expectedChildStatus: row.expected_child_status || "",
    expectedCycleStatus: row.expected_cycle_status || "",
    expectedStateFingerprint: row.expected_state_fingerprint || "",
    reason: row.reason || "",
    actorOperatorId: row.actor_operator_id || "",
    supersedesCorrectionId: row.supersedes_correction_id === null ? null : Number(row.supersedes_correction_id),
    createdAt: row.created_at || null
  };
}

async function correctionRowsForOrders(orderIds = []) {
  const ids = [...new Set(orderIds.map(Number).filter((value) => Number.isSafeInteger(value) && value > 0))];
  if (!ids.length) {
    return [];
  }
  const result = await query(
    `SELECT DISTINCT ON (correction.reattempt_order_id, correction.netsuite_line_id)
            correction.*
       FROM sales_order_reattempt_item_corrections correction
      WHERE correction.reattempt_order_id = ANY($1::bigint[])
      ORDER BY correction.reattempt_order_id, correction.netsuite_line_id,
               correction.created_at DESC, correction.id DESC`,
    [ids]
  );
  return result.rows.map(mapCorrection);
}

export async function listLatestSalesOrderReattemptItemCorrections(orderIds = []) {
  return correctionRowsForOrders(orderIds);
}

export async function listLatestSalesOrderReattemptCycleCorrections(cycleIds = []) {
  const ids = [...new Set(cycleIds.map(Number).filter((value) => Number.isSafeInteger(value) && value > 0))];
  if (!ids.length) {
    return [];
  }
  const result = await query(
    `SELECT DISTINCT ON (correction.cycle_id, correction.netsuite_line_id)
            correction.*
       FROM sales_order_reattempt_item_corrections correction
      WHERE correction.cycle_id = ANY($1::bigint[])
      ORDER BY correction.cycle_id, correction.netsuite_line_id,
               correction.created_at DESC, correction.id DESC`,
    [ids]
  );
  return result.rows.map(mapCorrection);
}

export function projectSalesOrderReattemptLineSnapshot(lineSnapshot = [], corrections = []) {
  const latestByLine = new Map();
  for (const correction of corrections || []) {
    const key = String(correction.netsuiteLineId || "");
    if (key && !latestByLine.has(key)) {
      latestByLine.set(key, correction);
    }
  }
  return (Array.isArray(lineSnapshot) ? lineSnapshot : []).map((line) => {
    const netsuiteLineId = String(line.lineId ?? line.netsuiteLineId ?? "");
    return applyEffectiveReattemptIdentity(line, latestByLine.get(netsuiteLineId) || null);
  });
}

async function loadReattemptState(orderRef, { forUpdate = false } = {}) {
  const cleanRef = String(orderRef || "").trim();
  const childResult = await query(
    `SELECT child.*,
            cycle.status AS cycle_status,
            cycle.workflow_kind,
            cycle.sales_order_id,
            cycle.order_ref AS parent_order_ref_from_cycle,
            cycle.completed_at AS cycle_completed_at,
            cycle.completion_source,
            cycle.operator_load_evidence_missing
       FROM dispatch_custom_orders child
       JOIN operator_reload_cycles cycle ON cycle.id = child.reload_cycle_id
      WHERE lower(btrim(child.ref_number)) = lower(btrim($1))
        AND child.order_kind = 'sales_order_reattempt'
      LIMIT 1
      ${forUpdate ? "FOR UPDATE OF child, cycle" : ""}`,
    [cleanRef]
  );
  if (!childResult.rowCount) {
    throw correctionError("Sales Order re-attempt was not found.", "REATTEMPT_CORRECTION_ORDER_NOT_FOUND", 404);
  }
  const child = childResult.rows[0];
  const lineResult = await query(
    `SELECT *
       FROM operator_reload_cycle_lines
      WHERE cycle_id = $1
        AND selected_for_reattempt = true
      ORDER BY historical_line_index NULLS LAST, id
      ${forUpdate ? "FOR UPDATE" : ""}`,
    [child.reload_cycle_id]
  );
  const netsuiteLineIds = [...new Set(lineResult.rows
    .map((line) => Number(line.current_line_id ?? line.netsuite_line_id))
    .filter((value) => Number.isSafeInteger(value) && value > 0))];
  const currentResult = netsuiteLineIds.length
    ? await query(
        `SELECT *
           FROM sales_order_lines
          WHERE sales_order_id = $1
            AND line_id = ANY($2::bigint[])
            AND netsuite_active = true
          ORDER BY line_id, id`,
        [child.sales_order_id, netsuiteLineIds]
      )
    : { rows: [] };
  const currentByLine = new Map();
  for (const current of currentResult.rows) {
    const key = String(current.line_id || "");
    const rows = currentByLine.get(key) || [];
    rows.push(current);
    currentByLine.set(key, rows);
  }
  const corrections = await correctionRowsForOrders([child.id]);
  const correctionByLine = new Map(corrections.map((entry) => [String(entry.netsuiteLineId), entry]));
  const activityResult = await query(
    `SELECT EXISTS (
              SELECT 1
                FROM operator_load_records record
               WHERE record.reload_cycle_id = $1
            ) AS has_operator_load,
            EXISTS (
              SELECT 1
                FROM driver_job_records record
               WHERE record.status IN ('in_progress', 'complete')
                 AND EXISTS (
                   SELECT 1
                     FROM jsonb_array_elements_text(
                       CASE WHEN jsonb_typeof(COALESCE(record.order_refs, '[]'::jsonb)) = 'array'
                         THEN COALESCE(record.order_refs, '[]'::jsonb) ELSE '[]'::jsonb END
                     ) reference(value)
                    WHERE lower(btrim(reference.value)) = lower(btrim($2))
                 )
            ) AS has_driver_activity,
            EXISTS (
              SELECT 1
                FROM driver_job_records record
               WHERE record.status = 'complete'
                 AND EXISTS (
                   SELECT 1
                     FROM jsonb_array_elements_text(
                       CASE WHEN jsonb_typeof(COALESCE(record.order_refs, '[]'::jsonb)) = 'array'
                         THEN COALESCE(record.order_refs, '[]'::jsonb) ELSE '[]'::jsonb END
                     ) reference(value)
                    WHERE lower(btrim(reference.value)) = lower(btrim($2))
                 )
            ) AS has_completed_driver_activity,
            (
              SELECT MAX(record.completed_at)
                FROM driver_job_records record
               WHERE record.status = 'complete'
                 AND EXISTS (
                   SELECT 1
                     FROM jsonb_array_elements_text(
                       CASE WHEN jsonb_typeof(COALESCE(record.order_refs, '[]'::jsonb)) = 'array'
                         THEN COALESCE(record.order_refs, '[]'::jsonb) ELSE '[]'::jsonb END
                     ) reference(value)
                    WHERE lower(btrim(reference.value)) = lower(btrim($2))
                 )
            ) AS driver_completed_at,
            EXISTS (
              SELECT 1
                FROM dispatch_plans plan
                JOIN dispatch_plan_snapshots snapshot ON snapshot.plan_id = plan.id
               WHERE plan.status <> 'cancelled'
                 AND (
                   EXISTS (
                     SELECT 1 FROM jsonb_array_elements(COALESCE(snapshot.orders, '[]'::jsonb)) plan_order(value)
                      WHERE lower(btrim(COALESCE(plan_order.value ->> 'id', plan_order.value ->> 'dispatchRef', ''))) = lower(btrim($2))
                   )
                   OR EXISTS (
                     SELECT 1
                       FROM jsonb_array_elements(COALESCE(snapshot.trucks, '[]'::jsonb)) truck(value)
                       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(truck.value -> 'loads', '[]'::jsonb)) load(value)
                       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(load.value -> 'stops', '[]'::jsonb)) stop(value)
                      WHERE lower(btrim(COALESCE(stop.value ->> 'orderId', ''))) = lower(btrim($2))
                   )
                 )
            ) AS is_planned`,
    [child.reload_cycle_id, child.ref_number]
  );
  const activity = activityResult.rows[0] || {};
  const childSnapshotByLine = new Map((Array.isArray(child.line_snapshot) ? child.line_snapshot : [])
    .map((line) => [String(line.lineId ?? line.netsuiteLineId ?? ""), line]));
  const lines = lineResult.rows.map((line) => {
    const netsuiteLineId = Number(line.current_line_id ?? line.netsuite_line_id);
    const currentMatches = currentByLine.get(String(netsuiteLineId)) || [];
    const current = currentMatches.length === 1 ? currentMatches[0] : null;
    const priorCorrection = correctionByLine.get(String(netsuiteLineId)) || null;
    const childLine = childSnapshotByLine.get(String(netsuiteLineId)) || {};
    const beforeItemId = priorCorrection?.afterItemId ?? childLine.itemId ?? line.item_id ?? null;
    const beforeSku = priorCorrection?.afterSku || childLine.sku || line.sku || "";
    const beforeItemName = priorCorrection?.afterItemName || childLine.itemName || line.item_name || beforeSku;
    const beforeDescription = priorCorrection?.afterDescription || childLine.description || line.item_description || "";
    const beforeSalesUom = priorCorrection?.afterSalesUom || childLine.unit || line.sales_uom || "";
    const targetSalesQty = quantity(line.target_sales_qty);
    const targetPalletQty = quantity(line.target_pallet_qty);
    const currentSalesQty = quantity(current?.quantity);
    const currentPalletQty = quantity(current?.pallet_qty);
    const currentQuantitySupportsTarget = Boolean(current)
      && currentSalesQty + 0.000001 >= targetSalesQty
      && (targetPalletQty <= 0 || currentPalletQty + 0.000001 >= targetPalletQty);
    const fingerprint = buildReattemptIdentityFingerprint({
      childOrderId: child.id,
      cycleId: child.reload_cycle_id,
      parentSalesOrderId: child.sales_order_id,
      netsuiteLineId,
      beforeItemId,
      beforeSku,
      afterItemId: current?.item_id,
      afterSku: current?.sku || current?.item_name || "",
      currentSalesQty,
      currentPalletQty,
      targetSalesQty,
      targetPalletQty,
      childStatus: child.status,
      cycleStatus: child.cycle_status
    });
    return {
      cycleLineId: Number(line.id),
      netsuiteLineId,
      currentMappingCount: currentMatches.length,
      currentSalesOrderLineId: current ? Number(current.id) : null,
      beforeItemId: beforeItemId === null ? null : Number(beforeItemId),
      beforeSku,
      beforeItemName,
      beforeDescription,
      beforeSalesUom,
      afterItemId: current?.item_id === null || current?.item_id === undefined ? null : Number(current.item_id),
      afterSku: current?.sku || current?.item_name || "",
      afterItemName: current?.item_name || current?.sku || "",
      afterDescription: current?.item_description || "",
      afterSalesUom: current?.unit || line.current_sales_uom || line.sales_uom || "",
      currentSalesQty,
      currentPalletQty,
      currentQuantitySupportsTarget,
      targetSalesQty,
      targetPalletQty,
      targetLayerQty: quantity(line.target_layer_qty),
      targetSectionQty: quantity(line.target_section_qty),
      targetPieceQty: quantity(line.target_piece_qty),
      historicalItemId: line.historical_item_id === null ? null : Number(line.historical_item_id),
      historicalSku: line.historical_sku || "",
      historicalItemName: line.historical_item_name || "",
      historicalDescription: line.historical_description || "",
      historicalSalesUom: line.historical_sales_uom || "",
      expectedStateFingerprint: fingerprint,
      requiresCorrection: Boolean(current && (
        Number(beforeItemId || 0) !== Number(current.item_id || 0)
        || String(beforeSku || "") !== String(current.sku || current.item_name || "")
      )),
      latestCorrection: priorCorrection
    };
  });
  return {
    orderRef: child.ref_number,
    childOrderId: Number(child.id),
    childStatus: child.status || "",
    completedAt: child.completed_at || null,
    cycleId: Number(child.reload_cycle_id),
    cycleStatus: child.cycle_status || "",
    workflowKind: child.workflow_kind || "",
    parentSalesOrderId: Number(child.sales_order_id),
    parentOrderRef: child.parent_order_ref || child.parent_order_ref_from_cycle || "",
    billingDisposition: child.billing_disposition || "",
    completionSource: child.completion_source || "",
    operatorLoadEvidenceMissing: Boolean(child.operator_load_evidence_missing),
    hasOperatorLoad: Boolean(activity.has_operator_load),
    hasDriverActivity: Boolean(activity.has_driver_activity),
    hasCompletedDriverActivity: Boolean(activity.has_completed_driver_activity),
    driverCompletedAt: activity.driver_completed_at || null,
    isPlanned: Boolean(activity.is_planned),
    lines
  };
}

export async function getSalesOrderReattemptCurrentItemCorrectionPreview(orderRef) {
  const state = await loadReattemptState(orderRef);
  return {
    ...state,
    correctionMode: state.childStatus === "completed" ? "completed_overlay" : "unstarted_rebase",
    canCorrect: state.lines.some((line) => (
      line.requiresCorrection
      && line.currentMappingCount === 1
      && line.currentQuantitySupportsTarget
    )),
    warning: state.hasCompletedDriverActivity && !state.hasOperatorLoad
      ? "Operator load evidence is absent. Applying the correction reconciles the cycle from immutable Driver completion without creating a load record."
      : ""
  };
}

function assertIdempotencyScope(existing, state, line) {
  if (
    Number(existing.reattempt_order_id) !== state.childOrderId
    || Number(existing.cycle_id) !== state.cycleId
    || Number(existing.parent_sales_order_id) !== state.parentSalesOrderId
    || Number(existing.netsuite_line_id) !== line.netsuiteLineId
    || Number(existing.after_item_id) !== Number(line.afterItemId)
    || String(existing.after_sku || "") !== String(line.afterSku || "")
  ) {
    throw correctionError(
      "This idempotency key was already used for another re-attempt correction.",
      "REATTEMPT_CORRECTION_IDEMPOTENCY_CONFLICT"
    );
  }
}

export async function applySalesOrderReattemptCurrentItemCorrection(input = {}, actor = {}) {
  const command = normalizeReattemptCorrectionCommand(input);
  const netsuiteLineId = positiveInteger(input.netsuiteLineId, "NetSuite line", "REATTEMPT_CORRECTION_LINE_INVALID");
  if (!actor?.id) {
    throw correctionError("An authenticated administrator is required.", "REATTEMPT_CORRECTION_ACTOR_REQUIRED", 401);
  }
  return withTransaction(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [command.idempotencyKey]);
    const existingResult = await query(
      `SELECT correction.*, child.ref_number
         FROM sales_order_reattempt_item_corrections correction
         JOIN dispatch_custom_orders child ON child.id = correction.reattempt_order_id
        WHERE correction.idempotency_key = $1::uuid
        LIMIT 1`,
      [command.idempotencyKey]
    );
    const state = await loadReattemptState(command.orderRef, { forUpdate: true });
    const line = state.lines.find((candidate) => candidate.netsuiteLineId === netsuiteLineId);
    if (!line) {
      throw correctionError("The selected re-attempt line was not found.", "REATTEMPT_CORRECTION_LINE_NOT_FOUND", 404);
    }
    if (existingResult.rowCount) {
      assertIdempotencyScope(existingResult.rows[0], state, line);
      return {
        correction: mapCorrection(existingResult.rows[0]),
        preview: await getSalesOrderReattemptCurrentItemCorrectionPreview(command.orderRef),
        idempotent: true
      };
    }
    if (line.currentMappingCount !== 1 || !line.afterItemId || !line.afterSku) {
      throw correctionError(
        "The current NetSuite line does not map to one active item.",
        "REATTEMPT_CORRECTION_CURRENT_LINE_AMBIGUOUS"
      );
    }
    if (line.expectedStateFingerprint !== command.expectedStateFingerprint) {
      throw correctionError(
        "The re-attempt or current Sales Order line changed. Refresh the correction preview.",
        "REATTEMPT_CORRECTION_STALE"
      );
    }
    if (!line.currentQuantitySupportsTarget) {
      throw correctionError(
        "The current NetSuite line quantity is below the immutable authorized re-attempt quantity.",
        "REATTEMPT_CORRECTION_CURRENT_QUANTITY_UNSUPPORTED"
      );
    }
    if (!line.requiresCorrection) {
      throw correctionError("This line already uses the current item.", "REATTEMPT_CORRECTION_NOT_REQUIRED");
    }
    const completedMode = state.childStatus === "completed";
    if (completedMode && !state.hasCompletedDriverActivity) {
      throw correctionError(
        "A completed re-attempt correction requires immutable completed Driver evidence.",
        "REATTEMPT_CORRECTION_DRIVER_EVIDENCE_REQUIRED"
      );
    }
    if (!completedMode && (
      state.childStatus !== "open"
      || state.cycleStatus !== "authorized"
      || state.hasOperatorLoad
      || state.hasDriverActivity
      || state.isPlanned
    )) {
      throw correctionError(
        "Only an open, unplanned re-attempt with no Operator or Driver activity can be rebased.",
        "REATTEMPT_CORRECTION_REBASE_BLOCKED"
      );
    }
    const inserted = await query(
      `INSERT INTO sales_order_reattempt_item_corrections (
         idempotency_key, reattempt_order_id, cycle_id, parent_sales_order_id,
         netsuite_line_id, before_item_id, before_sku, before_item_name,
         before_description, before_sales_uom,
         after_item_id, after_sku, after_item_name, after_description, after_sales_uom,
         target_sales_qty, target_pallet_qty, target_layer_qty, target_section_qty, target_piece_qty,
         expected_child_status, expected_cycle_status, expected_state_fingerprint,
         physically_delivered_current_item, reason, actor_operator_id, supersedes_correction_id
       ) VALUES (
         $1::uuid, $2, $3, $4,
         $5, $6, $7, $8, $9, $10,
         $11, $12, $13, $14, $15,
         $16, $17, $18, $19, $20,
         $21, $22, $23, true, $24, $25, $26
       )
       RETURNING *`,
      [
        command.idempotencyKey,
        state.childOrderId,
        state.cycleId,
        state.parentSalesOrderId,
        line.netsuiteLineId,
        line.beforeItemId,
        line.beforeSku,
        line.beforeItemName,
        line.beforeDescription,
        line.beforeSalesUom,
        line.afterItemId,
        line.afterSku,
        line.afterItemName,
        line.afterDescription,
        line.afterSalesUom,
        line.targetSalesQty,
        line.targetPalletQty,
        line.targetLayerQty,
        line.targetSectionQty,
        line.targetPieceQty,
        state.childStatus,
        state.cycleStatus,
        command.expectedStateFingerprint,
        command.reason,
        actor.id,
        line.latestCorrection?.correctionId || null
      ]
    );
    if (!completedMode) {
      await query(
        `UPDATE operator_reload_cycle_lines
            SET sales_order_line_id = $2,
                item_id = $3,
                item_name = $4,
                sku = $5,
                item_description = $6,
                sales_uom = $7,
                current_sales_order_line_id = $2,
                current_item_id = $3,
                current_item_name = $4,
                current_sku = $5,
                current_description = $6,
                current_sales_uom = $7,
                sku_mismatch = historical_sku <> $5,
                item_mismatch = historical_item_id IS DISTINCT FROM $3,
                updated_at = now()
          WHERE id = $1`,
        [line.cycleLineId, line.currentSalesOrderLineId, line.afterItemId, line.afterItemName, line.afterSku, line.afterDescription, line.afterSalesUom]
      );
      const child = await query("SELECT line_snapshot FROM dispatch_custom_orders WHERE id = $1 FOR UPDATE", [state.childOrderId]);
      const projected = projectSalesOrderReattemptLineSnapshot(child.rows[0]?.line_snapshot || [], [mapCorrection(inserted.rows[0])]);
      await query(
        `UPDATE dispatch_custom_orders
            SET line_snapshot = $2::jsonb,
                updated_by = $3,
                updated_at = now()
          WHERE id = $1`,
        [state.childOrderId, JSON.stringify(projected), actor.id]
      );
    } else if (!state.hasOperatorLoad) {
      await query(
        `UPDATE operator_reload_cycles
            SET status = 'completed',
                completed_at = COALESCE(completed_at, $2::timestamptz, now()),
                completion_source = 'driver_completion_reconciliation',
                operator_load_evidence_missing = true,
                completion_reconciled_at = now(),
                completion_reconciled_by = $3,
                completion_reconciliation_note = $4,
                updated_at = now()
          WHERE id = $1`,
        [state.cycleId, state.driverCompletedAt || state.completedAt, actor.id, command.reason]
      );
    }
    const correction = mapCorrection(inserted.rows[0]);
    await writeAudit({
      actorOperatorId: actor.id,
      source: "control",
      action: completedMode
        ? "sales_order_reattempt.current_item.corrected"
        : "sales_order_reattempt.current_item.rebased",
      orderId: state.parentSalesOrderId,
      lineId: line.currentSalesOrderLineId,
      details: {
        correctionId: correction.correctionId,
        childOrderId: state.childOrderId,
        childOrderRef: state.orderRef,
        cycleId: state.cycleId,
        netsuiteLineId: line.netsuiteLineId,
        beforeItemId: line.beforeItemId,
        beforeSku: line.beforeSku,
        afterItemId: line.afterItemId,
        afterSku: line.afterSku,
        completionSource: completedMode && !state.hasOperatorLoad
          ? "driver_completion_reconciliation"
          : state.completionSource,
        operatorLoadEvidenceMissing: completedMode && !state.hasOperatorLoad,
        reason: command.reason
      }
    });
    return {
      correction,
      preview: await getSalesOrderReattemptCurrentItemCorrectionPreview(command.orderRef),
      idempotent: false
    };
  });
}

export async function getSalesOrderReattemptDriverReadiness(orderRefs = []) {
  const refs = [...new Set((orderRefs || []).map(normalizedRef).filter(Boolean))];
  if (!refs.length) {
    return [];
  }
  const result = await query(
    `SELECT child.ref_number,
            cycle.id AS cycle_id,
            cycle.status AS cycle_status,
            cycle.workflow_kind,
            cycle.completion_source,
            EXISTS (
              SELECT 1 FROM operator_load_records record
               WHERE record.reload_cycle_id = cycle.id
            ) AS has_operator_load
       FROM dispatch_custom_orders child
       JOIN operator_reload_cycles cycle ON cycle.id = child.reload_cycle_id
      WHERE child.order_kind = 'sales_order_reattempt'
        AND lower(btrim(child.ref_number)) = ANY($1::text[])`,
    [refs]
  );
  return result.rows.map((row) => ({
    orderRef: row.ref_number,
    cycleId: Number(row.cycle_id),
    workflowKind: row.workflow_kind,
    cycleStatus: row.cycle_status,
    completionSource: row.completion_source || "",
    hasOperatorLoad: Boolean(row.has_operator_load),
    ...evaluateReattemptDriverReadiness({
      workflowKind: row.workflow_kind,
      cycleStatus: row.cycle_status,
      completionSource: row.completion_source,
      hasOperatorLoad: Boolean(row.has_operator_load)
    })
  }));
}

export async function assertSalesOrderReattemptDriverReady(orderRefs = []) {
  const blocked = (await getSalesOrderReattemptDriverReadiness(orderRefs))
    .find((entry) => entry.allowed !== true);
  if (!blocked) {
    return null;
  }
  throw correctionError(
    `${blocked.orderRef} is waiting for its matching Operator re-load to be completed before Driver execution.`,
    "DRIVER_REATTEMPT_OPERATOR_LOAD_REQUIRED"
  );
}
