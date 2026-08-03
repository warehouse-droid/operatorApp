import crypto from "node:crypto";
import { config, isNetSuiteSandboxEnvironment } from "./config.js";
import { query, withTransaction } from "./db.js";
import { writeDispatchAudit } from "./dispatch-audit-repository.js";
import { resolveDispatchSalesTarget } from "./dispatch-order-target-repository.js";
import { dispatchLoadAssignment } from "./dispatch-load-assignment.js";
import {
  normalizeTransferDependencyReservationOverrides,
  transferDependencyPlanningAvailability,
  transferDependencyReservationContract,
  transferDependencyReservationOverrideKey,
  transferDependencyReservationOverrideSet,
  transferDependencyReservationOverridesFromSnapshot
} from "./transfer-dependency-reservation.js";

export const DEPENDENCY_YARDS = Object.freeze([
  { code: "3445", locationId: 1, address: "3445 Kennedy Road, Toronto, ON", priority: 1, westPenaltyMinutes: 0 },
  { code: "2967", locationId: 28, address: "2967 Kennedy Road, Toronto, ON", priority: 2, westPenaltyMinutes: 0 },
  { code: "12441", locationId: 15, address: "12441 Woodbine Avenue, Whitchurch-Stouffville, ON", priority: 3, westPenaltyMinutes: 0 },
  { code: "150", locationId: 26, address: "150 Clark Blvd, Brampton, ON L6T 4Y8, Canada", priority: 4, westPenaltyMinutes: config.transferDependency.westYardPenaltyMinutes }
]);

const YARD_BY_ID = new Map(DEPENDENCY_YARDS.map((yard) => [String(yard.locationId), yard]));
const EPSILON = 0.000001;

function number(value) {
  const parsed = Number(String(value ?? 0).replaceAll(",", ""));
  return Number.isFinite(parsed) ? Math.abs(parsed) : 0;
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(String(value).replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value) {
  return String(value ?? "").trim();
}

function dateText(value) {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function normalizedToken(value) {
  return text(value).replace(/\s+/g, "").toUpperCase();
}

function normalizeMode(value) {
  return value === "direct_to_customer" ? "direct_to_customer" : "yard_replenishment";
}

function terminalTransferOrderStatus(row = {}) {
  const transfer = row || {};
  const status = text(transfer.transfer_status ?? transfer.status).toUpperCase();
  const statusText = text(transfer.transfer_status_text ?? transfer.status_text);
  const combined = `${status} ${statusText}`;
  if (status === "H" || /closed|cancel/i.test(combined)) return statusText || "Closed";
  if (status === "C" || /reject/i.test(combined)) return statusText || "Rejected";
  return "";
}

function isMaterialLine(line = {}) {
  const name = `${line.item_name || ""} ${line.sku || ""}`.trim().toLowerCase();
  const type = `${line.item_type || ""} ${line.item_type_text || ""}`.toLowerCase();
  if (/delivery\s*(charge|fee)|sales\s*credit|discount|shipping\s*(charge|fee)/i.test(name)) return false;
  if (/non[- ]?inventory|service|discount|description|subtotal|payment/i.test(type)) return false;
  return number(line.quantity) > EPSILON;
}

function isPalletItem(line = {}) {
  return [line.sku, line.item_name, line.itemName]
    .some((value) => text(value).toUpperCase() === "PALLET");
}

export function calculateTransferProposalPallets(lines = []) {
  const materialByItem = new Map();
  let explicitQuantity = 0;
  for (const line of lines || []) {
    const quantity = number(line.proposedQuantity ?? line.proposed_quantity);
    if (quantity <= EPSILON) continue;
    if (isPalletItem(line)) {
      explicitQuantity += quantity;
      continue;
    }
    const key = String(line.itemId ?? line.item_id ?? line.sku ?? line.itemName ?? line.item_name);
    const current = materialByItem.get(key) || { quantity: 0, toPlt: number(line.toPlt ?? line.to_plt) };
    current.quantity += quantity;
    if (!current.toPlt) current.toPlt = number(line.toPlt ?? line.to_plt);
    materialByItem.set(key, current);
  }
  let calculatedQuantity = 0;
  let complete = true;
  for (const item of materialByItem.values()) {
    if (!item.toPlt) {
      complete = false;
      continue;
    }
    calculatedQuantity += Math.ceil(Math.max(0, item.quantity - EPSILON) / item.toPlt);
  }
  calculatedQuantity = Number(calculatedQuantity.toFixed(6));
  explicitQuantity = Number(explicitQuantity.toFixed(6));
  return {
    calculatedQuantity,
    explicitQuantity,
    complete,
    recommendedQuantity: Math.max(calculatedQuantity, explicitQuantity)
  };
}

function conversionDisplay(quantity, line = {}) {
  let remaining = number(quantity);
  const result = { palletQty: 0, layerQty: 0, sectionQty: 0, pieceQty: 0 };
  const conversions = [
    ["palletQty", number(line.toPlt ?? line.to_plt)],
    ["layerQty", number(line.toLyr ?? line.to_lyr)],
    ["sectionQty", number(line.toSec ?? line.to_sec)],
    ["pieceQty", number(line.toPcs ?? line.to_pcs)]
  ];
  let hasConversion = false;
  let smallestConversion = null;
  for (const [field, conversion] of conversions) {
    if (!conversion || remaining <= EPSILON) continue;
    hasConversion = true;
    if (!smallestConversion || conversion < smallestConversion.conversion) {
      smallestConversion = { field, conversion };
    }
    const units = Math.floor((remaining / conversion) + EPSILON);
    if (units > 0) {
      result[field] = units;
      remaining = Math.max(0, Number((remaining - (units * conversion)).toFixed(6)));
    }
  }
  if (hasConversion && remaining > EPSILON && smallestConversion) {
    result[smallestConversion.field] = Number((
      result[smallestConversion.field] + (remaining / smallestConversion.conversion)
    ).toFixed(6));
  }
  if (!hasConversion) result.pieceQty = number(quantity);
  return result;
}

export function transferProposalConversionSelection(quantity, line = {}) {
  const salesQty = number(quantity);
  const conversions = {
    pallets: number(line.toPlt ?? line.to_plt),
    layers: number(line.toLyr ?? line.to_lyr),
    sections: number(line.toSec ?? line.to_sec),
    pieces: number(line.toPcs ?? line.to_pcs)
  };
  const hasConversion = Object.values(conversions).some((value) => value > EPSILON);
  const converted = hasConversion ? conversionDisplay(salesQty, {
    to_plt: conversions.pallets,
    to_lyr: conversions.layers,
    to_sec: conversions.sections,
    to_pcs: conversions.pieces
  }) : { palletQty: 0, layerQty: 0, sectionQty: 0, pieceQty: 0 };
  if (hasConversion && conversions.layers > EPSILON) {
    converted.layerQty = Math.max(0, Math.round(number(converted.layerQty)));
  }
  const convertedSalesQty = hasConversion
    ? Number((
      (number(converted.palletQty) * conversions.pallets)
      + (number(converted.layerQty) * conversions.layers)
      + (number(converted.sectionQty) * conversions.sections)
      + (number(converted.pieceQty) * conversions.pieces)
    ).toFixed(6))
    : salesQty;
  return {
    salesQty: convertedSalesQty,
    hasConversion,
    conversions,
    available: hasConversion ? {
      pallets: conversions.pallets ? Math.floor((salesQty / conversions.pallets) + EPSILON) : 0,
      layers: conversions.layers ? Math.floor((salesQty / conversions.layers) + EPSILON) : 0,
      sections: conversions.sections ? Math.floor((salesQty / conversions.sections) + EPSILON) : 0,
      pieces: conversions.pieces ? Math.floor((salesQty / conversions.pieces) + EPSILON) : 0,
      salesQty: 0
    } : { pallets: 0, layers: 0, sections: 0, pieces: 0, salesQty },
    quantities: hasConversion ? {
      pallets: number(converted.palletQty),
      layers: number(converted.layerQty),
      sections: number(converted.sectionQty),
      pieces: number(converted.pieceQty),
      salesQty: 0
    } : { pallets: 0, layers: 0, sections: 0, pieces: 0, salesQty }
  };
}

const conversionSelection = transferProposalConversionSelection;

export function preferredFullCoverageSourceYards(lines = [], matrixItems = [], rankedYards = []) {
  const requiredByItem = new Map();
  for (const line of lines || []) {
    const itemKey = String(line.itemId ?? line.item_id ?? line.salesLineId ?? line.sales_line_id);
    requiredByItem.set(itemKey, number(requiredByItem.get(itemKey)) + number(line.unresolvedQuantity ?? line.unresolved_quantity));
  }
  const matrixByItem = new Map((matrixItems || []).map((item) => [String(item.itemId ?? item.item_id), item]));
  const preferredByItem = new Map();
  for (const [itemKey, required] of requiredByItem.entries()) {
    if (required <= EPSILON) continue;
    const item = matrixByItem.get(itemKey);
    const fullCoverYard = (rankedYards || []).find((yard) => {
      const locationId = yard.locationId ?? yard.location_id;
      const balance = (item?.balances || []).find((entry) => String(entry.locationId ?? entry.location_id) === String(locationId));
      return number(balance?.effectiveAvailable ?? balance?.effective_available) + EPSILON >= required;
    });
    if (fullCoverYard) preferredByItem.set(itemKey, fullCoverYard.locationId ?? fullCoverYard.location_id);
  }
  return preferredByItem;
}

function allocationSalesQuantity(allocation = {}, targetLine = {}) {
  if (!allocation.quantities || typeof allocation.quantities !== "object") {
    const quantity = number(allocation.quantity);
    return {
      quantity,
      display: conversionDisplay(quantity, {
        to_plt: targetLine.toPlt,
        to_lyr: targetLine.toLyr,
        to_sec: targetLine.toSec,
        to_pcs: targetLine.toPcs
      })
    };
  }
  const quantities = {
    pallets: number(allocation.quantities.pallets),
    layers: Math.max(0, Math.round(number(allocation.quantities.layers))),
    sections: number(allocation.quantities.sections),
    pieces: number(allocation.quantities.pieces),
    salesQty: number(allocation.quantities.salesQty)
  };
  const conversions = {
    pallets: number(targetLine.toPlt),
    layers: number(targetLine.toLyr),
    sections: number(targetLine.toSec),
    pieces: number(targetLine.toPcs)
  };
  for (const [unit, selected] of Object.entries(quantities)) {
    if (unit === "salesQty" || selected <= EPSILON) continue;
    if (conversions[unit] <= EPSILON) throw new Error(`${targetLine.itemName || targetLine.itemId} has no ${unit} conversion.`);
  }
  const convertedQuantity = ["pallets", "layers", "sections", "pieces"]
    .reduce((sum, unit) => sum + (quantities[unit] * conversions[unit]), 0);
  if (convertedQuantity > EPSILON && quantities.salesQty > EPSILON) {
    throw new Error(`${targetLine.itemName || targetLine.itemId}: use converted units or sales quantity, not both.`);
  }
  const quantity = Number((convertedQuantity > EPSILON ? convertedQuantity : quantities.salesQty).toFixed(6));
  return {
    quantity,
    display: {
      palletQty: quantities.pallets,
      layerQty: quantities.layers,
      sectionQty: quantities.sections,
      pieceQty: quantities.pieces
    }
  };
}

function serializeLine(row = {}) {
  return {
    id: row.id,
    salesLineId: row.sales_line_id,
    transferOutboundLineId: row.transfer_outbound_line_id,
    transferReceivingLineId: row.transfer_receiving_line_id,
    itemId: row.item_id,
    itemName: row.item_name,
    unit: row.unit,
    itemWeight: number(row.item_weight),
    allocatedQuantity: number(row.allocated_quantity),
    palletQty: number(row.pallet_qty),
    layerQty: number(row.layer_qty),
    sectionQty: number(row.section_qty),
    pieceQty: number(row.piece_qty),
    loadedQuantity: number(row.loaded_quantity),
    deliveredQuantity: number(row.delivered_quantity),
    locallyReceivedQuantity: number(row.locally_received_quantity),
    lineRole: row.line_role || "sales_allocation",
    targetLineKey: row.dispatch_target_line_key || "",
    sourceOrderRef: row.source_order_ref || ""
  };
}

function aggregateDependencyManifestItems(lines = []) {
  const items = new Map();
  for (const line of lines || []) {
    const key = String(line.itemId || line.itemName || line.id);
    const item = items.get(key) || {
      itemId: line.itemId,
      itemName: line.itemName,
      unit: line.unit,
      itemWeight: number(line.itemWeight),
      quantity: 0,
      palletQty: 0,
      layerQty: 0,
      sectionQty: 0,
      pieceQty: 0
    };
    item.quantity += number(line.allocatedQuantity);
    item.palletQty += number(line.palletQty);
    item.layerQty += number(line.layerQty);
    item.sectionQty += number(line.sectionQty);
    item.pieceQty += number(line.pieceQty);
    items.set(key, item);
  }
  return [...items.values()];
}

function serializeDependency(row = {}, lines = []) {
  const dispatchTargetRef = row.dispatch_target_ref || row.sales_order_ref;
  return {
    id: row.id,
    salesOrderId: row.sales_order_id,
    salesOrderRef: dispatchTargetRef,
    canonicalSalesOrderRef: row.sales_order_ref,
    dispatchTargetRef,
    dispatchTargetKind: row.dispatch_target_kind || "normal",
    transferOrderId: row.transfer_order_id,
    transferOrderRef: row.transfer_order_ref,
    proposalId: row.proposal_id,
    mode: row.dependency_mode,
    sameLoadRequired: row.same_load_required,
    status: row.status,
    sourceLocationId: row.source_location_id,
    sourceLocation: row.source_location,
    accountingDestinationLocationId: row.accounting_destination_location_id,
    accountingDestinationLocation: row.accounting_destination_location,
    plannedPlanId: row.planned_plan_id,
    plannedDate: row.planned_date,
    plannedTruckPlate: row.planned_truck_plate,
    plannedLoadId: row.planned_load_id,
    plannedLoadName: row.planned_load_name,
    directReceivedAt: row.direct_received_at,
    reconciliationStatus: row.reconciliation_status,
    reconciledAt: row.reconciled_at,
    attentionReason: row.attention_reason,
    lines
  };
}

async function loadDependencies({ salesOrderRef = "", transferOrderRef = "", includeCancelled = false } = {}) {
  const params = [];
  const clauses = [];
  if (salesOrderRef) {
    params.push(text(salesOrderRef));
    clauses.push(`(d.dispatch_target_ref = $${params.length} OR d.sales_order_ref = $${params.length})`);
  }
  if (transferOrderRef) {
    params.push(text(transferOrderRef));
    clauses.push(`d.transfer_order_ref = $${params.length}`);
  }
  if (!includeCancelled) clauses.push("d.status <> 'cancelled'");
  const rows = await query(
    `SELECT d.*
       FROM order_dependencies d
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY d.created_at DESC, d.id DESC`,
    params
  );
  if (!rows.rowCount) return [];
  const ids = rows.rows.map((row) => row.id);
  const lineRows = await query(
    `SELECT dl.*, COALESCE(sl.item_weight, i.item_weight, 0) AS item_weight,
            source_sales.tranid AS source_order_ref
       FROM order_dependency_lines dl
       LEFT JOIN sales_order_lines sl ON sl.id = dl.sales_line_id
       LEFT JOIN sales_orders source_sales ON source_sales.netsuite_id = sl.sales_order_id
       LEFT JOIN inventory_items i ON i.item_id = dl.item_id
      WHERE dl.dependency_id = ANY($1::bigint[])
      ORDER BY dl.dependency_id, dl.item_name, dl.id`,
    [ids]
  );
  const byDependency = new Map();
  for (const line of lineRows.rows) {
    if (!byDependency.has(String(line.dependency_id))) byDependency.set(String(line.dependency_id), []);
    byDependency.get(String(line.dependency_id)).push(serializeLine(line));
  }
  return rows.rows.map((row) => serializeDependency(row, byDependency.get(String(row.id)) || []));
}

export async function listOrderDependencies(filters = {}) {
  return loadDependencies(filters);
}

export async function assertNoActiveOrderDependenciesByRefs(orderRefs = [], action = "change these orders", options = {}) {
  const refs = [...new Set((orderRefs || []).map(text).filter(Boolean))];
  if (!refs.length) return;
  const allowNormalGroupingRefs = new Set(
    (options.allowNormalGroupingRefs || []).map(text).filter(Boolean)
  );
  const allowEstablishedGroupTargets = new Map(
    (options.allowEstablishedGroupTargets || [])
      .map((target) => [text(target?.sourceOrderRef), text(target?.groupRef)])
      .filter(([sourceOrderRef, groupRef]) => sourceOrderRef && groupRef)
  );
  const allowEstablishedUngroupTargets = new Map(
    (options.allowEstablishedUngroupTargets || [])
      .map((target) => [text(target?.sourceOrderRef), text(target?.groupRef)])
      .filter(([sourceOrderRef, groupRef]) => sourceOrderRef && groupRef)
  );
  const result = await query(
    `SELECT DISTINCT dependency.dispatch_target_ref, dependency.sales_order_ref,
            dependency.transfer_order_ref, dependency.dependency_mode, dependency.status,
            dependency.dispatch_target_kind,
            EXISTS (
              SELECT 1
                FROM order_dependency_lines progress_line
               WHERE progress_line.dependency_id = dependency.id
                 AND (
                   COALESCE(progress_line.loaded_quantity, 0) > $2
                   OR COALESCE(progress_line.delivered_quantity, 0) > $2
                   OR COALESCE(progress_line.locally_received_quantity, 0) > $2
                 )
            ) AS has_execution_progress
       FROM order_dependencies dependency
       LEFT JOIN order_dependency_lines line ON line.dependency_id = dependency.id
       LEFT JOIN sales_order_lines sales_line ON sales_line.id = line.sales_line_id
       LEFT JOIN sales_orders source_sales ON source_sales.netsuite_id = sales_line.sales_order_id
      WHERE dependency.status <> 'cancelled'
        AND (
          dependency.dispatch_target_ref = ANY($1::text[])
          OR dependency.sales_order_ref = ANY($1::text[])
          OR dependency.transfer_order_ref = ANY($1::text[])
          OR source_sales.tranid = ANY($1::text[])
        )
      ORDER BY dependency.dispatch_target_ref, dependency.transfer_order_ref`,
    [refs, EPSILON]
  );
  const blocked = result.rows.filter((row) => {
    const targetRef = text(row.dispatch_target_ref || row.sales_order_ref);
    const safeNormalGrouping = allowNormalGroupingRefs.has(targetRef)
      && row.dispatch_target_kind === "normal"
      && row.dependency_mode === "yard_replenishment"
      && ["active", "attention"].includes(row.status)
      && !row.has_execution_progress;
    const safeEstablishedGrouping = allowEstablishedGroupTargets.get(text(row.sales_order_ref)) === targetRef
      && row.dispatch_target_kind === "group"
      && row.dependency_mode === "yard_replenishment"
      && ["active", "attention"].includes(row.status)
      && !row.has_execution_progress;
    const safeEstablishedUngroup = allowEstablishedUngroupTargets.get(text(row.sales_order_ref)) === targetRef
      && row.dispatch_target_kind === "group"
      && row.dependency_mode === "yard_replenishment"
      && ["active", "attention"].includes(row.status)
      && !row.has_execution_progress;
    return !safeNormalGrouping && !safeEstablishedGrouping && !safeEstablishedUngroup;
  });
  if (!blocked.length) return;
  const relations = blocked.map((row) => `${row.dispatch_target_ref || row.sales_order_ref} -> ${row.transfer_order_ref}`).join(", ");
  const error = new Error(`Cannot ${action} while an active order dependency exists: ${relations}. Unlink the dependency first.`);
  error.status = 409;
  error.code = "ORDER_DEPENDENCY_STRUCTURE_LOCK";
  throw error;
}

export async function getSalesOrderDependencyExecutionBlock(orderRefs = []) {
  const refs = [...new Set((orderRefs || []).map(text).filter(Boolean))];
  if (!refs.length) return null;
  const result = await query(
    `SELECT COALESCE(d.dispatch_target_ref, d.sales_order_ref) AS dispatch_target_ref,
            d.sales_order_ref, d.transfer_order_ref, d.status,
            t.receiving_status, t.received_at, t.netsuite_active
       FROM order_dependencies d
       JOIN transfer_orders t ON t.netsuite_id = d.transfer_order_id
      WHERE (d.dispatch_target_ref = ANY($1::text[]) OR d.sales_order_ref = ANY($1::text[]))
        AND d.dependency_mode = 'yard_replenishment'
        AND d.status <> 'cancelled'
        AND NOT (
          d.status IN ('delivered', 'received_local')
          OR LOWER(COALESCE(t.receiving_status, '')) IN ('received', 'completed', 'shipped')
        )
      ORDER BY d.dispatch_target_ref, d.transfer_order_ref
      LIMIT 1`,
    [refs]
  );
  if (!result.rowCount) return null;
  const row = result.rows[0];
  return {
    code: "DEPENDENT_TRANSFER_NOT_RECEIVED",
    salesOrderRef: row.dispatch_target_ref || row.sales_order_ref,
    transferOrderRef: row.transfer_order_ref,
    message: `${row.dispatch_target_ref || row.sales_order_ref} is waiting for ${row.transfer_order_ref} to be received before delivery can start.`
  };
}

export async function completeYardDependenciesForTransferDrop({
  transferOrderRefs = [],
  driverJobId,
  driverLogin = "",
  planId = null,
  planDate = "",
  truckPlate = "",
  loadId = "",
  loadName = "",
  destinationLocationId = null,
  expectedSourceOfflineEventId = "",
  requireAppliedEvidence = false,
  completedBefore = null,
  beforeDeviceId = "",
  beforeClientSequence = null,
  salesOrderRefs = []
} = {}) {
  const refs = [...new Set((transferOrderRefs || []).map(text).filter(Boolean))];
  const targetRefs = [...new Set((salesOrderRefs || []).map(text).filter(Boolean))];
  const jobId = text(driverJobId);
  if (!refs.length || !jobId) return { completed: [], alreadyCompleted: [], skipped: [] };

  return withTransaction(async () => {
    const completedJobResult = await query(
      `SELECT r.job_id, r.plan_id, r.plan_date, r.driver_login, r.truck_id, r.truck_plate,
              r.load_id, r.load_name, r.stop_id, r.stop_type, r.order_refs,
              r.photo_data_urls, r.completed_at, r.source_offline_event_id::text,
              r.job_details, e.status AS source_event_status, e.device_id AS source_device_id,
              e.client_sequence AS source_client_sequence
         FROM driver_job_records r
         LEFT JOIN driver_offline_events e ON e.event_id = r.source_offline_event_id
        WHERE r.job_id = $1
          AND r.status = 'complete'
        LIMIT 1
        FOR UPDATE OF r`,
      [jobId]
    );
    if (!completedJobResult.rowCount || completedJobResult.rows[0].stop_type !== "dropoff") {
      throw new Error("Yard replenishment delivery requires a completed transfer drop job.");
    }
    const completedJob = completedJobResult.rows[0];
    const completedRefs = new Set((completedJob.order_refs || []).map(text).filter(Boolean));
    const matchingRefs = refs.filter((ref) => completedRefs.has(ref));
    if (!matchingRefs.length) {
      throw new Error("The completed transfer drop does not contain the expected Transfer Order.");
    }
    if (driverLogin && text(completedJob.driver_login).toLowerCase() !== text(driverLogin).toLowerCase()) {
      throw new Error("The completed transfer drop belongs to another driver.");
    }
    if (planId !== null && planId !== undefined && text(completedJob.plan_id) !== text(planId)) {
      throw new Error("The completed transfer drop belongs to another dispatch plan.");
    }
    if (planDate && dateText(completedJob.plan_date) !== dateText(planDate)) {
      throw new Error("The completed transfer drop belongs to another plan date.");
    }
    if (truckPlate && normalizedToken(completedJob.truck_plate) !== normalizedToken(truckPlate)) {
      throw new Error("The completed transfer drop belongs to another truck.");
    }
    if (loadId && text(completedJob.load_id) !== text(loadId)) {
      throw new Error("The completed transfer drop belongs to another load.");
    }
    const sourceEventId = text(completedJob.source_offline_event_id);
    if (
      expectedSourceOfflineEventId
      && sourceEventId !== text(expectedSourceOfflineEventId)
    ) {
      throw new Error("The completed transfer drop is linked to another offline event.");
    }

    const skipped = [];
    if (requireAppliedEvidence) {
      const photoCount = Array.isArray(completedJob.photo_data_urls)
        ? completedJob.photo_data_urls.length
        : 0;
      if (photoCount < 2) {
        skipped.push({
          driverJobId: jobId,
          reason: "completed_transfer_drop_photos_missing"
        });
      }
      if (sourceEventId && completedJob.source_event_status !== "applied") {
        skipped.push({
          driverJobId: jobId,
          reason: "completed_transfer_drop_event_not_applied"
        });
      }
      const cutoff = completedBefore ? new Date(completedBefore) : null;
      if (
        cutoff
        && Number.isFinite(cutoff.getTime())
        && completedJob.completed_at
        && new Date(completedJob.completed_at).getTime() > cutoff.getTime()
      ) {
        skipped.push({
          driverJobId: jobId,
          reason: "completed_transfer_drop_occurs_after_start"
        });
      }
      if (
        beforeDeviceId
        && completedJob.source_device_id === beforeDeviceId
        && beforeClientSequence !== null
        && beforeClientSequence !== undefined
        && beforeClientSequence !== ""
        && Number.isFinite(Number(beforeClientSequence))
        && Number(completedJob.source_client_sequence) >= Number(beforeClientSequence)
      ) {
        skipped.push({
          driverJobId: jobId,
          reason: "completed_transfer_drop_sequence_not_prior"
        });
      }
      if (skipped.length) return { completed: [], alreadyCompleted: [], skipped };
    }

    const dependencies = await query(
      `SELECT d.*, t.receiving_status AS transfer_receiving_status,
              t.netsuite_active AS transfer_active,
              t.status AS transfer_status, t.status_text AS transfer_status_text
         FROM order_dependencies d
         JOIN transfer_orders t ON t.netsuite_id = d.transfer_order_id
        WHERE d.transfer_order_ref = ANY($1::text[])
          AND d.dependency_mode = 'yard_replenishment'
          AND d.status <> 'cancelled'
          AND (
            cardinality($2::text[]) = 0
            OR d.dispatch_target_ref = ANY($2::text[])
            OR d.sales_order_ref = ANY($2::text[])
          )
        ORDER BY d.id
        FOR UPDATE OF d`,
      [matchingRefs, targetRefs]
    );
    const completed = [];
    const alreadyCompleted = [];
    const recordedDestinationId = text(completedJob.job_details?.destinationLocationId);
    const recordedDestinationLabel = text(
      completedJob.job_details?.dropLocation || completedJob.job_details?.location
    );
    const expectedDestinationId = text(destinationLocationId);

    for (const dependency of dependencies.rows) {
      const prior = await query(
        `SELECT driver_job_id, result
           FROM order_dependency_receipts
          WHERE dependency_id = $1
            AND result ->> 'reason' = 'yard_replenishment_physical_delivery'
          ORDER BY id
          LIMIT 1`,
        [dependency.id]
      );
      if (prior.rowCount) {
        alreadyCompleted.push({
          dependencyId: dependency.id,
          transferOrderRef: dependency.transfer_order_ref,
          driverJobId: prior.rows[0].driver_job_id,
          result: prior.rows[0].result
        });
        continue;
      }
      if (dependency.status === "received_local") {
        alreadyCompleted.push({
          dependencyId: dependency.id,
          transferOrderRef: dependency.transfer_order_ref,
          driverJobId: jobId,
          result: null
        });
        continue;
      }
      const formalReceiptComplete = ["received", "completed", "shipped"].includes(
        text(dependency.transfer_receiving_status).toLowerCase()
      );
      if (dependency.status === "attention") {
        skipped.push({
          dependencyId: dependency.id,
          transferOrderRef: dependency.transfer_order_ref,
          driverJobId: jobId,
          reason: "dependency_requires_attention"
        });
        continue;
      }
      const terminalStatus = terminalTransferOrderStatus(dependency);
      if (!formalReceiptComplete && (dependency.transfer_active === false || terminalStatus)) {
        skipped.push({
          dependencyId: dependency.id,
          transferOrderRef: dependency.transfer_order_ref,
          driverJobId: jobId,
          reason: terminalStatus ? "transfer_order_terminal" : "transfer_order_inactive"
        });
        continue;
      }
      if (
        dependency.planned_plan_id !== null
        && completedJob.plan_id !== null
        && text(dependency.planned_plan_id) !== text(completedJob.plan_id)
      ) {
        skipped.push({
          dependencyId: dependency.id,
          transferOrderRef: dependency.transfer_order_ref,
          driverJobId: jobId,
          reason: "dependency_plan_mismatch"
        });
        continue;
      }
      if (
        dependency.planned_date
        && completedJob.plan_date
        && dateText(dependency.planned_date) !== dateText(completedJob.plan_date)
      ) {
        skipped.push({
          dependencyId: dependency.id,
          transferOrderRef: dependency.transfer_order_ref,
          driverJobId: jobId,
          reason: "dependency_plan_date_mismatch"
        });
        continue;
      }
      const dependencyDestinationId = text(dependency.accounting_destination_location_id);
      const dependencyDestinationLabel = text(dependency.accounting_destination_location);
      const actualDestinationId = recordedDestinationId || expectedDestinationId;
      if (
        dependencyDestinationId
        && actualDestinationId
        && dependencyDestinationId !== actualDestinationId
      ) {
        skipped.push({
          dependencyId: dependency.id,
          transferOrderRef: dependency.transfer_order_ref,
          driverJobId: jobId,
          reason: "dependency_destination_mismatch"
        });
        continue;
      }
      if (
        !actualDestinationId
        && dependencyDestinationLabel
        && recordedDestinationLabel
        && normalizedToken(dependencyDestinationLabel) !== normalizedToken(recordedDestinationLabel)
      ) {
        skipped.push({
          dependencyId: dependency.id,
          transferOrderRef: dependency.transfer_order_ref,
          driverJobId: jobId,
          reason: "dependency_destination_mismatch"
        });
        continue;
      }

      const lines = await query(
        `SELECT id, allocated_quantity, delivered_quantity
           FROM order_dependency_lines
          WHERE dependency_id = $1
          ORDER BY id
          FOR UPDATE`,
        [dependency.id]
      );
      const deliveredQuantity = Number(lines.rows.reduce(
        (total, line) => total + number(line.allocated_quantity),
        0
      ).toFixed(6));
      await query(
        `UPDATE order_dependency_lines
            SET delivered_quantity = GREATEST(
                  COALESCE(delivered_quantity, 0),
                  allocated_quantity
                ),
                updated_at = now()
          WHERE dependency_id = $1`,
        [dependency.id]
      );
      const updatedDependency = await query(
        `UPDATE order_dependencies
            SET status = 'delivered',
                local_completed_at = COALESCE(local_completed_at, $2::timestamptz, now()),
                reconciliation_status = CASE
                  WHEN $3 THEN CASE
                    WHEN reconciliation_status = 'reconciled' THEN 'reconciled'
                    ELSE 'not_required'
                  END
                  ELSE 'required'
                END,
                reconciled_at = CASE WHEN $3 THEN reconciled_at ELSE null END,
                updated_at = now()
          WHERE id = $1
          RETURNING status, reconciliation_status`,
        [dependency.id, completedJob.completed_at, formalReceiptComplete]
      );
      const persistedReconciliationStatus = updatedDependency.rows[0]?.reconciliation_status
        || (formalReceiptComplete ? "not_required" : "required");
      const result = {
        dependencyId: dependency.id,
        salesOrderRef: dependency.dispatch_target_ref || dependency.sales_order_ref,
        transferOrderRef: dependency.transfer_order_ref,
        deliveredQuantity,
        reason: "yard_replenishment_physical_delivery",
        physicalDeliveryOnly: true,
        formalReceiptPending: !formalReceiptComplete,
        driverJobId: jobId,
        sourceOfflineEventId: sourceEventId || "",
        transferDropStopId: completedJob.stop_id || ""
      };
      const receipt = await query(
        `INSERT INTO order_dependency_receipts (
           dependency_id, driver_job_id, sales_order_ref, transfer_order_ref,
           plan_id, plan_date, truck_plate, load_id, load_name, received_quantity, result
         ) VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, $9, $10, $11::jsonb)
         ON CONFLICT (dependency_id, driver_job_id) DO NOTHING
         RETURNING id`,
        [
          dependency.id,
          jobId,
          dependency.dispatch_target_ref || dependency.sales_order_ref,
          dependency.transfer_order_ref,
          completedJob.plan_id,
          completedJob.plan_date,
          completedJob.truck_plate,
          completedJob.load_id,
          completedJob.load_name || loadName || "",
          deliveredQuantity,
          JSON.stringify(result)
        ]
      );
      if (!receipt.rowCount) {
        const existing = await query(
          `SELECT driver_job_id, result
             FROM order_dependency_receipts
            WHERE dependency_id = $1 AND driver_job_id = $2`,
          [dependency.id, jobId]
        );
        alreadyCompleted.push({
          dependencyId: dependency.id,
          transferOrderRef: dependency.transfer_order_ref,
          driverJobId: existing.rows[0]?.driver_job_id || jobId,
          result: existing.rows[0]?.result || result
        });
        continue;
      }
      await writeDispatchAudit({
        action: "driver.yard_replenishment.delivered",
        source: "driver",
        entityType: "order_dependency",
        entityId: String(dependency.id),
        orderId: dependency.transfer_order_ref,
        loadId: completedJob.load_id,
        truckId: completedJob.truck_id || completedJob.truck_plate,
        planId: completedJob.plan_id,
        planDate: dateText(completedJob.plan_date),
        before: {
          status: dependency.status,
          reconciliationStatus: dependency.reconciliation_status
        },
        after: {
          status: "delivered",
          reconciliationStatus: persistedReconciliationStatus
        },
        details: {
          driverJobId: jobId,
          driverLogin: completedJob.driver_login,
          sourceOfflineEventId: sourceEventId || "",
          salesOrderRef: dependency.dispatch_target_ref || dependency.sales_order_ref,
          transferOrderRef: dependency.transfer_order_ref,
          deliveredQuantity,
          physicalDeliveryOnly: true,
          formalReceivingStatusUnchanged: dependency.transfer_receiving_status || ""
        }
      });
      completed.push(result);
    }
    return { completed, alreadyCompleted, skipped };
  });
}

export async function reconcileCompletedYardTransfersForSalesOrderStart({
  salesOrderRefs = [],
  currentJob = null,
  routeJobs = [],
  driverLogin = "",
  event = null
} = {}) {
  const refs = [...new Set((salesOrderRefs || []).map(text).filter(Boolean))];
  const jobs = Array.isArray(routeJobs) ? routeJobs : [];
  if (!refs.length || !currentJob?.jobId || !jobs.length) {
    return { completed: [], alreadyCompleted: [], skipped: [] };
  }
  const currentIndex = jobs.findIndex((job) => text(job?.jobId) === text(currentJob.jobId));
  if (currentIndex <= 0) return { completed: [], alreadyCompleted: [], skipped: [] };

  const blocking = await query(
    `SELECT d.transfer_order_ref
       FROM order_dependencies d
       JOIN transfer_orders t ON t.netsuite_id = d.transfer_order_id
      WHERE (d.dispatch_target_ref = ANY($1::text[]) OR d.sales_order_ref = ANY($1::text[]))
        AND d.dependency_mode = 'yard_replenishment'
        AND d.status NOT IN ('cancelled', 'attention', 'delivered', 'received_local')
        AND NOT (
          LOWER(COALESCE(t.receiving_status, '')) IN ('received', 'completed', 'shipped')
        )
      ORDER BY d.id`,
    [refs]
  );
  if (!blocking.rowCount) return { completed: [], alreadyCompleted: [], skipped: [] };
  const requiredTransfers = new Set(blocking.rows.map((row) => text(row.transfer_order_ref)));
  const currentPlanId = text(currentJob.planId);
  const currentPlanDate = dateText(currentJob.planDate);
  const currentDriver = text(driverLogin || currentJob.driverLogin).toLowerCase();
  const candidates = jobs.slice(0, currentIndex).filter((job) =>
    job?.stopType === "dropoff"
    && text(job.planId) === currentPlanId
    && dateText(job.planDate) === currentPlanDate
    && text(job.driverLogin).toLowerCase() === currentDriver
    && (job.orderRefs || []).some((ref) => requiredTransfers.has(text(ref)))
  );
  const aggregate = { completed: [], alreadyCompleted: [], skipped: [] };
  for (const candidate of candidates) {
    const transferRefs = (candidate.orderRefs || [])
      .map(text)
      .filter((ref) => requiredTransfers.has(ref));
    if (!transferRefs.length) continue;
    const applied = await completeYardDependenciesForTransferDrop({
      transferOrderRefs: transferRefs,
      driverJobId: candidate.jobId,
      driverLogin: currentDriver,
      planId: candidate.planId,
      planDate: candidate.planDate,
      truckPlate: candidate.truckPlate,
      loadId: candidate.loadId,
      loadName: candidate.loadName,
      destinationLocationId: candidate.destinationLocationId,
      requireAppliedEvidence: true,
      completedBefore: event?.occurredAt || currentJob.startedAt || new Date().toISOString(),
      beforeDeviceId: event?.deviceId || "",
      beforeClientSequence: event?.clientSequence ?? null,
      salesOrderRefs: refs
    });
    aggregate.completed.push(...applied.completed);
    aggregate.alreadyCompleted.push(...applied.alreadyCompleted);
    aggregate.skipped.push(...applied.skipped);
  }
  return aggregate;
}

export async function getDirectPickupDependencyExecutionBlock(transferOrderRefs = []) {
  const refs = [...new Set((transferOrderRefs || []).map(text).filter(Boolean))];
  if (!refs.length) return null;
  const result = await query(
    `SELECT d.transfer_order_ref, COALESCE(d.dispatch_target_ref, d.sales_order_ref) AS dispatch_target_ref,
            d.sales_order_ref, d.status
       FROM order_dependencies d
      WHERE d.transfer_order_ref = ANY($1::text[])
        AND d.dependency_mode = 'direct_to_customer'
        AND d.status <> 'cancelled'
        AND (
          d.status NOT IN ('loaded', 'in_transit', 'delivered', 'received_local')
          OR EXISTS (
            SELECT 1 FROM order_dependency_lines dl
             WHERE dl.dependency_id = d.id
               AND dl.loaded_quantity + $2::numeric < dl.allocated_quantity
          )
        )
      ORDER BY d.transfer_order_ref
      LIMIT 1`,
    [refs, EPSILON]
  );
  if (!result.rowCount) return null;
  const row = result.rows[0];
  return {
    code: "DIRECT_TRANSFER_NOT_LOADED",
    salesOrderRef: row.dispatch_target_ref || row.sales_order_ref,
    transferOrderRef: row.transfer_order_ref,
    message: `${row.transfer_order_ref} must be loaded by its source-yard operator before this pickup can start.`
  };
}

export async function syncDirectDependencyOperatorProgress(transferOrderId) {
  const id = Number(transferOrderId);
  if (!Number.isInteger(id)) return [];
  return withTransaction(async () => {
    const dependencies = await query(
      `SELECT d.id, d.status, d.transfer_order_ref, t.outbound_operator_status
         FROM order_dependencies d
         JOIN transfer_orders t ON t.netsuite_id = d.transfer_order_id
        WHERE d.transfer_order_id = $1
          AND d.dependency_mode = 'direct_to_customer'
          AND d.status <> 'cancelled'
        FOR UPDATE OF d`,
      [id]
    );
    const updated = [];
    for (const dependency of dependencies.rows) {
      await query(
        `UPDATE order_dependency_lines dl
            SET loaded_quantity = LEAST(dl.allocated_quantity, COALESCE(line.loaded_qty, 0)),
                updated_at = now()
           FROM transfer_order_lines line
          WHERE dl.dependency_id = $1
            AND dl.transfer_outbound_line_id = line.id
            AND line.line_stage = 'outbound'`,
        [dependency.id]
      );
      const progress = await query(
        `SELECT COALESCE(SUM(loaded_quantity), 0) AS loaded_quantity,
                COALESCE(SUM(allocated_quantity), 0) AS allocated_quantity
           FROM order_dependency_lines
          WHERE dependency_id = $1`,
        [dependency.id]
      );
      const loadedQuantity = number(progress.rows[0]?.loaded_quantity);
      const nextStatus = loadedQuantity > EPSILON
        ? "loaded"
        : String(dependency.outbound_operator_status || "").toLowerCase() === "packed"
          ? "packed"
          : "active";
      const result = await query(
        `UPDATE order_dependencies
            SET status = $2, updated_at = now()
          WHERE id = $1
            AND status IN ('active', 'packed', 'loaded')
          RETURNING id, sales_order_ref, transfer_order_ref, status`,
        [dependency.id, nextStatus]
      );
      if (result.rowCount) updated.push({
        ...result.rows[0],
        loadedQuantity,
        allocatedQuantity: number(progress.rows[0]?.allocated_quantity)
      });
    }
    return updated;
  });
}

export async function getOrderDependencyOptions({ dispatchTargetRef = "", salesOrderRef = "", transferOrderRef = "", planDate = "" } = {}) {
  const targetRef = text(dispatchTargetRef || salesOrderRef);
  const existingLinks = targetRef ? await loadDependencies({ salesOrderRef: targetRef }) : [];
  const transferOrders = await query(
    `SELECT t.netsuite_id, t.tranid, t.from_location, t.to_location,
            t.dispatch_planned, t.fulfillment_status, t.status, t.status_text,
            COALESCE(d.dispatch_target_ref, d.sales_order_ref) AS linked_sales_order_ref
       FROM transfer_orders t
       LEFT JOIN order_dependencies d
         ON d.transfer_order_id = t.netsuite_id AND d.status <> 'cancelled'
      WHERE COALESCE(t.netsuite_active, true)
        AND UPPER(COALESCE(t.status, '')) NOT IN ('C', 'H')
        AND LOWER(COALESCE(t.status_text, '')) !~ '(closed|cancel|reject)'
      ORDER BY t.trandate DESC NULLS LAST, t.tranid
      LIMIT 500`
  );
  const requestedTransfer = transferOrderRef
    ? transferOrders.rows.find((row) => row.tranid === text(transferOrderRef))
      || (await query("SELECT * FROM transfer_orders WHERE tranid = $1", [text(transferOrderRef)])).rows[0]
    : null;
  const requestedTerminalStatus = terminalTransferOrderStatus(requestedTransfer);
  const transfer = requestedTerminalStatus ? null : requestedTransfer;
  let resolved = null;
  let targetResolutionError = "";
  if (targetRef) {
    try {
      resolved = await resolveDispatchSalesTarget({ dispatchTargetRef: targetRef, planDate });
    } catch (error) {
      if (!existingLinks.length) throw error;
      targetResolutionError = text(error?.message || error);
    }
  }
  let matchingLines = [];
  let matchError = targetResolutionError
    ? `${targetRef} is no longer available in the selected dispatch plan. Existing links can still be unlinked, but new links are disabled.`
    : requestedTerminalStatus
      ? `${text(transferOrderRef)} is ${requestedTerminalStatus} and cannot be linked.`
      : "";
  if (transferOrderRef && !transfer && !requestedTerminalStatus) matchError = `Transfer Order ${text(transferOrderRef)} was not found.`;
  if (resolved && transfer) {
    const transferLines = await query(
      `SELECT item_id, MAX(COALESCE(sku, item_name, item_id::text)) AS item_label,
              SUM(quantity) AS transfer_quantity
         FROM transfer_order_lines
        WHERE transfer_order_id = $1
          AND line_stage = 'outbound'
          AND COALESCE(netsuite_active, true)
        GROUP BY item_id`,
      [transfer.netsuite_id]
    );
    const remainingByItem = new Map(transferLines.rows.map((row) => [String(row.item_id), number(row.transfer_quantity)]));
    matchingLines = resolved.lines.map((line) => {
      const itemKey = String(line.itemId);
      const transferQuantity = number(remainingByItem.get(itemKey));
      const availableShortage = Math.max(0, number(line.shortageQuantity) - number(line.dependencyAllocatedQuantity));
      const suggestedQuantity = Math.min(availableShortage, transferQuantity);
      remainingByItem.set(itemKey, Math.max(0, transferQuantity - suggestedQuantity));
      const availableSelection = conversionSelection(availableShortage, line);
      const suggestedSelection = conversionSelection(suggestedQuantity, line);
      const transferSelection = conversionSelection(transferQuantity, line);
      return {
        targetLineKey: line.targetLineKey,
        sourceOrderRef: line.sourceOrderRef,
        salesLineId: line.salesLineId,
        itemId: line.itemId,
        itemName: line.itemName,
        sku: line.sku,
        unit: line.unit,
        salesQuantity: number(line.quantity),
        shortageQuantity: availableShortage,
        transferQuantity,
        suggestedQuantity,
        hasConversion: availableSelection.hasConversion,
        conversions: availableSelection.conversions,
        available: availableSelection.available,
        suggestedQuantities: suggestedSelection.quantities,
        transferDisplay: transferSelection.quantities,
        ...conversionDisplay(suggestedQuantity, {
          to_plt: line.toPlt,
          to_lyr: line.toLyr,
          to_sec: line.toSec,
          to_pcs: line.toPcs
        })
      };
    }).filter((row) => row.suggestedQuantity > EPSILON);
    if (!matchingLines.length) {
      const transferItems = transferLines.rows.filter((row) => number(row.transfer_quantity) > EPSILON);
      const targetItems = resolved.lines.filter((line) => Math.max(0, number(line.shortageQuantity) - number(line.dependencyAllocatedQuantity)) > EPSILON);
      const targetItemIds = new Set(targetItems.map((line) => String(line.itemId)));
      const commonItem = transferItems.some((line) => targetItemIds.has(String(line.item_id)));
      if (!transferItems.length) {
        matchError = `${transfer.tranid} has no active outbound item quantity.`;
      } else if (!targetItems.length) {
        matchError = `${resolved.target.ref} has no remaining quantity available to link.`;
      } else if (!commonItem) {
        const toLabels = transferItems.slice(0, 6).map((line) => line.item_label).filter(Boolean).join(", ");
        const soLabels = targetItems.slice(0, 6).map((line) => line.sku || line.itemName).filter(Boolean).join(", ");
        matchError = `No matching item lines. ${transfer.tranid}: ${toLabels || "no items"}. ${resolved.target.ref}: ${soLabels || "no items"}.`;
      } else {
        matchError = `Matching items were found, but no quantity remains available on both ${resolved.target.ref} and ${transfer.tranid}.`;
      }
    }
  }
  return {
    dispatchTargetRef: resolved?.target?.ref || targetRef,
    dispatchTargetKind: resolved?.target?.kind || "normal",
    target: resolved?.target || null,
    targetSignature: resolved?.signature || "",
    salesOrderRef: resolved?.target?.ref || targetRef,
    transferOrderRef: transfer?.tranid || text(transferOrderRef),
    salesOrders: resolved ? [{
      id: resolved.target.ref,
      ref: resolved.target.ref,
      customer: resolved.target.customer,
      outboundLocation: resolved.target.outboundLocation,
      expectedDeliveryDate: null
    }] : [],
    transferOrders: transferOrders.rows.map((row) => ({
      id: row.netsuite_id,
      ref: row.tranid,
      fromLocation: row.from_location,
      toLocation: row.to_location,
      planned: row.dispatch_planned,
      fulfillmentStatus: row.fulfillment_status,
      linkedSalesOrderRef: row.linked_sales_order_ref
    })),
    matchingLines,
    matchError,
    targetUnavailable: Boolean(targetResolutionError),
    targetResolutionError,
    existingLinks
  };
}

async function salesOrderShortageRows(salesOrderId = null) {
  const params = [isNetSuiteSandboxEnvironment()];
  const orderClause = salesOrderId ? `AND o.netsuite_id = $${params.push(Number(salesOrderId))}` : "";
  const result = await query(
    `WITH allocated AS (
       SELECT dl.sales_line_id, SUM(dl.allocated_quantity) AS allocated_quantity
         FROM order_dependency_lines dl
         JOIN order_dependencies d ON d.id = dl.dependency_id
        WHERE d.status <> 'cancelled'
        GROUP BY dl.sales_line_id
     )
     SELECT o.netsuite_id AS sales_order_id,
            o.tranid AS sales_order_ref,
            o.customer,
            o.memo,
            o.dispatch_address,
            o.expected_delivery_date,
            o.outbound_location_id,
            o.outbound_location,
            o.is_test_fixture,
            l.*,
            COALESCE(b.quantity_available, 0) AS outbound_available,
            COALESCE(a.allocated_quantity, 0) AS dependency_allocated,
            COALESCE(l.netsuite_backordered_qty, 0) AS shortage_quantity
       FROM sales_orders o
       JOIN sales_order_lines l ON l.sales_order_id = o.netsuite_id
       LEFT JOIN inventory_balances b
         ON b.item_id = l.item_id
        AND b.location_id = o.outbound_location_id
       LEFT JOIN allocated a ON a.sales_line_id = l.id
      WHERE (
          (
            COALESCE(o.is_test_fixture, false) = false
            AND COALESCE(o.netsuite_active, true) = true
          )
          OR ($1::boolean AND COALESCE(o.is_test_fixture, false) = true)
        )
        AND (
          COALESCE(l.netsuite_active, true) = true
          OR ($1::boolean AND COALESCE(o.is_test_fixture, false) = true)
        )
        AND COALESCE(o.sales_order_type, '') NOT ILIKE '%pick%'
        AND COALESCE(o.fulfillment_status, '') NOT IN ('fulfilled', 'shipped')
        ${orderClause}
      ORDER BY o.expected_delivery_date NULLS LAST, o.tranid, l.item_name`,
    params
  );
  return result.rows.filter(isMaterialLine).map((row) => ({
    ...row,
    shortage_quantity: number(row.shortage_quantity),
    dependency_allocated: number(row.dependency_allocated),
    unresolved_quantity: Math.max(0, number(row.shortage_quantity) - number(row.dependency_allocated))
  }));
}

function transferDependencyShortageSignature(order = {}) {
  const lines = (order.lines || []).map((line) => ({
    salesLineId: String(line.salesLineId || ""),
    itemId: String(line.itemId || ""),
    backorderedQuantity: Number(number(line.backorderedQuantity).toFixed(6))
  })).sort((left, right) => `${left.salesLineId}|${left.itemId}`.localeCompare(`${right.salesLineId}|${right.itemId}`));
  return crypto.createHash("sha256").update(JSON.stringify({
    outboundLocationId: String(order.outboundLocationId || ""),
    lines
  })).digest("hex");
}

async function applyTransferDependencyReviews(orders = [], reviewStatus = "open") {
  if (!orders.length) return [];
  const ids = orders.map((order) => Number(order.salesOrderId)).filter(Number.isInteger);
  const [reviewRows, batchRows] = await Promise.all([
    query(
      `SELECT * FROM scm_transfer_dependency_reviews WHERE sales_order_id = ANY($1::bigint[])`,
      [ids]
    ),
    query(
      `SELECT DISTINCT ON (b.sales_order_id)
              b.sales_order_id, b.id AS batch_id, b.status, b.updated_at,
              COALESCE(
                (
                  SELECT MAX(d.created_at)
                    FROM scm_transfer_dependency_proposals created_proposal
                    JOIN order_dependencies d ON d.proposal_id = created_proposal.id
                   WHERE created_proposal.batch_id = b.id
                ),
                (
                  SELECT MAX(COALESCE(created_proposal.creation_started_at, created_proposal.updated_at))
                    FROM scm_transfer_dependency_proposals created_proposal
                   WHERE created_proposal.batch_id = b.id
                     AND created_proposal.netsuite_transfer_order_id IS NOT NULL
                )
              ) AS transfer_created_at,
              EXISTS (
                SELECT 1
                  FROM scm_transfer_dependency_proposals p
                 WHERE p.batch_id = b.id AND p.netsuite_transfer_order_id IS NOT NULL
              ) AS has_created_transfer,
              NOT EXISTS (
                SELECT 1
                  FROM scm_transfer_dependency_proposals p
                  LEFT JOIN scm_print_jobs j ON j.id = p.print_job_id
                 WHERE p.batch_id = b.id
                   AND p.netsuite_transfer_order_id IS NOT NULL
                   AND (p.approval_status <> 'approved' OR COALESCE(j.status, '') <> 'printed')
              ) AS all_created_transfers_printed,
              (SELECT MAX(j.printed_at)
                 FROM scm_transfer_dependency_proposals p
                 JOIN scm_print_jobs j ON j.id = p.print_job_id
                WHERE p.batch_id = b.id AND j.status = 'printed') AS last_printed_at
         FROM scm_transfer_dependency_batches b
        WHERE b.sales_order_id = ANY($1::bigint[])
        ORDER BY b.sales_order_id, b.updated_at DESC, b.id DESC`,
      [ids]
    )
  ]);
  const reviews = new Map(reviewRows.rows.map((row) => [String(row.sales_order_id), row]));
  const batches = new Map(batchRows.rows.map((row) => [String(row.sales_order_id), row]));
  const enriched = [];
  for (const order of orders) {
    const signature = transferDependencyShortageSignature(order);
    const review = reviews.get(String(order.salesOrderId));
    let activeReview = review?.status === "reviewed" && review.shortage_signature === signature;
    if (review?.status === "reviewed" && !activeReview) {
      const reopened = await query(
        `UPDATE scm_transfer_dependency_reviews
            SET status = 'stale', reopened_by = 'system', reopened_at = now(), updated_at = now()
          WHERE sales_order_id = $1 AND status = 'reviewed'
          RETURNING reviewed_at, shortage_signature`,
        [Number(order.salesOrderId)]
      );
      if (reopened.rowCount) {
        await writeDispatchAudit({
          action: "scm.transfer_dependency.review_reopened",
          source: "scm",
          entityType: "sales_order",
          entityId: String(order.salesOrderId),
          orderId: order.salesOrderRef,
          details: {
            reason: "shortage_changed",
            previousSignature: reopened.rows[0].shortage_signature,
            currentSignature: signature
          }
        });
      }
      activeReview = false;
    }
    const batch = batches.get(String(order.salesOrderId));
    const transferCreated = batch?.has_created_transfer === true;
    const transferCompleted = transferCreated
      && batch?.all_created_transfers_printed === true
      && number(order.uncoveredQuantity) <= EPSILON;
    const workflowStage = activeReview || transferCompleted ? "completed" : transferCreated ? "created" : "open";
    const completionType = activeReview
      ? (transferCreated ? "transfer_manually_reviewed" : "reviewed_no_transfer")
      : transferCompleted
        ? "transfer_approved_printed"
        : transferCreated
          ? "transfer_created"
          : null;
    enriched.push({
      ...order,
      shortageSignature: signature,
      reviewed: activeReview,
      reviewedAt: activeReview ? review.reviewed_at : null,
      reviewedBy: activeReview ? review.reviewed_by : null,
      completed: Boolean(completionType),
      completionType,
      completedAt: activeReview ? review.reviewed_at : transferCompleted ? batch.last_printed_at || batch.updated_at : null,
      workflowStage,
      dependencyBatchId: transferCreated ? batch.batch_id : null,
      transferCreatedAt: transferCreated ? batch.transfer_created_at || null : null
    });
  }
  const normalizedStatus = ["reviewed", "created", "completed", "all"].includes(reviewStatus) ? reviewStatus : "open";
  if (["reviewed", "completed"].includes(normalizedStatus)) {
    return sortTransferDependencyCandidatesByCompletedAt(
      enriched.filter((order) => order.workflowStage === "completed")
    );
  }
  if (normalizedStatus === "created") {
    return sortTransferDependencyCandidatesByCreatedAt(
      enriched.filter((order) => order.workflowStage === "created")
    );
  }
  if (normalizedStatus === "all") return enriched;
  return enriched.filter((order) => order.workflowStage === "open" && number(order.uncoveredQuantity) > EPSILON);
}

export function sortTransferDependencyCandidatesByCreatedAt(orders = []) {
  const createdTimestamp = (value) => {
    const parsed = Date.parse(value || "");
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return [...orders].sort((left, right) => (
    createdTimestamp(right.transferCreatedAt) - createdTimestamp(left.transferCreatedAt)
    || Number(right.dependencyBatchId || 0) - Number(left.dependencyBatchId || 0)
    || String(left.salesOrderRef || "").localeCompare(String(right.salesOrderRef || ""))
  ));
}

export function sortTransferDependencyCandidatesByCompletedAt(orders = []) {
  const completedTimestamp = (value) => {
    const parsed = Date.parse(value || "");
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return [...orders].sort((left, right) => (
    completedTimestamp(right.completedAt) - completedTimestamp(left.completedAt)
    || Number(right.dependencyBatchId || 0) - Number(left.dependencyBatchId || 0)
    || String(left.salesOrderRef || "").localeCompare(String(right.salesOrderRef || ""))
  ));
}

export async function listTransferDependencyCandidates({ search = "", salesOrderId = null, reviewStatus = "open" } = {}) {
  const rows = await salesOrderShortageRows(salesOrderId);
  const needle = text(search).toLowerCase();
  const orders = new Map();
  for (const row of rows) {
    if (row.shortage_quantity <= EPSILON) continue;
    const key = String(row.sales_order_id);
    if (!orders.has(key)) {
      orders.set(key, {
        salesOrderId: row.sales_order_id,
        salesOrderRef: row.sales_order_ref,
        customer: row.customer,
        expectedDeliveryDate: row.expected_delivery_date,
        outboundLocationId: row.outbound_location_id,
        outboundLocation: row.outbound_location,
        customerAddress: row.dispatch_address,
        testFixture: row.is_test_fixture === true,
        uncoveredQuantity: 0,
        lines: []
      });
    }
    const order = orders.get(key);
    order.uncoveredQuantity += row.unresolved_quantity;
    order.lines.push({
      salesLineId: row.id,
      itemId: row.item_id,
      itemName: row.item_name,
      sku: row.sku,
      unit: row.unit,
      quantity: number(row.quantity),
      committedQuantity: number(row.netsuite_committed_qty),
      backorderedQuantity: number(row.netsuite_backordered_qty),
      shortageQuantity: row.shortage_quantity,
      allocatedQuantity: row.dependency_allocated,
      unresolvedQuantity: row.unresolved_quantity,
      toPlt: number(row.to_plt),
      toLyr: number(row.to_lyr),
      toSec: number(row.to_sec),
      toPcs: number(row.to_pcs),
      ...conversionDisplay(row.unresolved_quantity, row)
    });
  }
  const reviewedOrders = await applyTransferDependencyReviews([...orders.values()], reviewStatus);
  if (!needle) return reviewedOrders;
  return reviewedOrders.filter((order) => `${order.salesOrderRef} ${order.customer} ${(order.lines || [])
    .map((line) => `${line.itemName} ${line.sku}`).join(" ")}`.toLowerCase().includes(needle));
}

export async function reviewTransferDependencyCandidate({ salesOrderId, operatorId = null } = {}) {
  const candidate = (await listTransferDependencyCandidates({ salesOrderId, reviewStatus: "all" }))[0];
  if (!candidate) throw new Error("This Sales Order has no unresolved inventory shortage to review.");
  if (candidate.reviewed) return candidate;
  const completionType = candidate.workflowStage === "created"
    ? "transfer_manually_reviewed"
    : "reviewed_no_transfer";
  await withTransaction(async () => {
    await query(
      `UPDATE scm_transfer_dependency_proposals p
          SET creation_status = 'cancelled', updated_at = now()
        FROM scm_transfer_dependency_batches b
       WHERE p.batch_id = b.id
         AND b.sales_order_id = $1
         AND p.creation_status IN ('draft', 'failed')`,
      [Number(salesOrderId)]
    );
    await query(
      `UPDATE scm_transfer_dependency_batches b
          SET status = CASE
                WHEN EXISTS (
                  SELECT 1 FROM scm_transfer_dependency_proposals p
                   WHERE p.batch_id = b.id
                     AND p.netsuite_transfer_order_id IS NOT NULL
                     AND p.creation_status = 'attention'
                ) THEN 'attention'
                WHEN EXISTS (
                  SELECT 1 FROM scm_transfer_dependency_proposals p
                   WHERE p.batch_id = b.id
                     AND p.netsuite_transfer_order_id IS NOT NULL
                ) THEN 'created'
                ELSE 'cancelled'
              END,
              updated_by = $2, updated_at = now()
        WHERE b.sales_order_id = $1
          AND b.status IN ('draft', 'suggested', 'partially_created', 'attention')`,
      [Number(salesOrderId), operatorId]
    );
    await query(
      `INSERT INTO scm_transfer_dependency_reviews (
         sales_order_id, status, shortage_signature, reviewed_by, reviewed_at,
         reopened_by, reopened_at, updated_at
       ) VALUES ($1, 'reviewed', $2, $3, now(), null, null, now())
       ON CONFLICT (sales_order_id) DO UPDATE SET
         status = 'reviewed', shortage_signature = EXCLUDED.shortage_signature,
         reviewed_by = EXCLUDED.reviewed_by, reviewed_at = now(),
         reopened_by = null, reopened_at = null, updated_at = now()`,
      [Number(salesOrderId), candidate.shortageSignature, operatorId]
    );
    await writeDispatchAudit({
      action: completionType === "transfer_manually_reviewed"
        ? "scm.transfer_dependency.transfer_manually_reviewed"
        : "scm.transfer_dependency.reviewed_no_transfer",
      source: "scm",
      entityType: "sales_order",
      entityId: String(candidate.salesOrderId),
      orderId: candidate.salesOrderRef,
      operatorId,
      details: {
        shortageSignature: candidate.shortageSignature,
        uncoveredQuantity: candidate.uncoveredQuantity,
        completionType
      }
    });
  });
  return (await listTransferDependencyCandidates({ salesOrderId, reviewStatus: "all" }))[0]
    || { ...candidate, reviewed: true, reviewedAt: new Date().toISOString(), reviewedBy: operatorId, completionType };
}

export async function reopenTransferDependencyCandidate({ salesOrderId, operatorId = null } = {}) {
  const candidate = (await listTransferDependencyCandidates({ salesOrderId, reviewStatus: "all" }))[0];
  if (!candidate) throw new Error("This Sales Order has no unresolved inventory shortage.");
  const result = await query(
    `UPDATE scm_transfer_dependency_reviews
        SET status = 'stale', reopened_by = $2, reopened_at = now(), updated_at = now()
      WHERE sales_order_id = $1 AND status = 'reviewed'
      RETURNING sales_order_id`,
    [Number(salesOrderId), operatorId]
  );
  if (result.rowCount) {
    await writeDispatchAudit({
      action: "scm.transfer_dependency.review_reopened",
      source: "scm",
      entityType: "sales_order",
      entityId: String(candidate.salesOrderId),
      orderId: candidate.salesOrderRef,
      operatorId,
      details: { reason: "manual" }
    });
  }
  const refreshed = (await listTransferDependencyCandidates({ salesOrderId, reviewStatus: "all" }))[0];
  if (refreshed) return refreshed;
  const returnsToCreated = candidate.completionType === "transfer_manually_reviewed";
  return {
    ...candidate,
    reviewed: false,
    reviewedAt: null,
    reviewedBy: null,
    completed: false,
    completedAt: null,
    workflowStage: returnsToCreated ? "created" : "open",
    completionType: returnsToCreated ? "transfer_created" : null
  };
}

export async function getDependencyInventoryMatrix(salesOrderId) {
  const lines = await salesOrderShortageRows(salesOrderId);
  const orderLines = lines.map((line) => ({
    salesLineId: line.id,
    itemId: line.item_id,
    itemName: line.item_name,
    sku: line.sku,
    unit: line.unit,
    quantity: number(line.quantity),
    committedQuantity: number(line.netsuite_committed_qty),
    backorderedQuantity: number(line.netsuite_backordered_qty),
    shortageQuantity: number(line.shortage_quantity),
    allocatedQuantity: number(line.dependency_allocated),
    unresolvedQuantity: number(line.unresolved_quantity),
    toPlt: number(line.to_plt),
    toLyr: number(line.to_lyr),
    toSec: number(line.to_sec),
    toPcs: number(line.to_pcs)
  }));
  const itemIds = [...new Set(lines.map((line) => Number(line.item_id)).filter(Number.isInteger))];
  if (!itemIds.length) return { items: [], orderLines, yards: DEPENDENCY_YARDS };
  const balances = await query(
    `WITH linked_transfer AS (
       SELECT dl.item_id, d.source_location_id AS location_id, SUM(dl.allocated_quantity) AS linked_transfer_quantity
         FROM order_dependency_lines dl
         JOIN order_dependencies d ON d.id = dl.dependency_id
        WHERE d.status NOT IN ('cancelled', 'delivered')
        GROUP BY dl.item_id, d.source_location_id
     ), draft_reserved AS (
       SELECT pl.item_id, p.from_location_id AS location_id, SUM(pl.proposed_quantity) AS reserved_quantity
         FROM scm_transfer_dependency_proposal_lines pl
         JOIN scm_transfer_dependency_proposals p ON p.id = pl.proposal_id
        WHERE p.creation_status IN ('draft', 'creating')
          AND p.batch_id <> COALESCE((
            SELECT active_batch.id
              FROM scm_transfer_dependency_batches active_batch
             WHERE active_batch.sales_order_id = $2
               AND active_batch.status NOT IN ('created', 'cancelled')
             ORDER BY active_batch.updated_at DESC, active_batch.id DESC
             LIMIT 1
          ), -1)
        GROUP BY pl.item_id, p.from_location_id
     )
     SELECT i.item_id, i.item_name, i.stock_unit, i.to_plt, i.to_lyr, i.to_sec, i.to_pcs,
            y.location_id, y.location,
            COALESCE(b.quantity_on_hand, 0) AS quantity_on_hand,
            COALESCE(b.quantity_available, 0) AS quantity_available,
            COALESCE(draft.reserved_quantity, 0) AS reserved_quantity,
            COALESCE(linked.linked_transfer_quantity, 0) AS linked_transfer_quantity,
            GREATEST(
              COALESCE(b.quantity_available, 0)
              - COALESCE(draft.reserved_quantity, 0),
              0
            ) AS effective_available
       FROM inventory_items i
       CROSS JOIN (VALUES (1::bigint, '3445'::text), (28, '2967'), (15, '12441'), (26, '150')) y(location_id, location)
       LEFT JOIN inventory_balances b ON b.item_id = i.item_id AND b.location_id = y.location_id
       LEFT JOIN draft_reserved draft
         ON draft.item_id = i.item_id AND draft.location_id = y.location_id
       LEFT JOIN linked_transfer linked
         ON linked.item_id = i.item_id AND linked.location_id = y.location_id
      WHERE i.item_id = ANY($1::bigint[])
      ORDER BY i.item_name, y.location_id`,
    [itemIds, Number(salesOrderId)]
  );
  const items = new Map();
  for (const row of balances.rows) {
    const key = String(row.item_id);
    if (!items.has(key)) {
      items.set(key, {
        itemId: row.item_id,
        itemName: row.item_name,
        unit: row.stock_unit,
        toPlt: number(row.to_plt),
        toLyr: number(row.to_lyr),
        toSec: number(row.to_sec),
        toPcs: number(row.to_pcs),
        balances: []
      });
    }
    items.get(key).balances.push({
      locationId: row.location_id,
      location: row.location,
      quantityOnHand: number(row.quantity_on_hand),
      quantityAvailable: number(row.quantity_available),
      reservedQuantity: number(row.reserved_quantity),
      linkedTransferQuantity: number(row.linked_transfer_quantity),
      effectiveAvailable: number(row.effective_available)
    });
  }
  return { items: [...items.values()], orderLines, yards: DEPENDENCY_YARDS };
}

function selectedTransferDependencyReservationOverrides(
  requested,
  matrix,
  outboundLocationId,
  operatorId
) {
  const normalized = normalizeTransferDependencyReservationOverrides(requested, { strict: true });
  if (!normalized.length) return { entries: [], keys: new Set() };
  const balances = new Map();
  for (const item of matrix?.items || []) {
    for (const balance of item.balances || []) {
      balances.set(
        transferDependencyReservationOverrideKey(item.itemId, balance.locationId),
        { item, balance }
      );
    }
  }
  const entries = normalized.map((override) => {
    const key = transferDependencyReservationOverrideKey(override.itemId, override.locationId);
    const selected = balances.get(key);
    if (!selected) {
      throw Object.assign(
        new Error("A selected reservation override no longer matches this Sales Order item and yard."),
        { status: 409, code: "TRANSFER_DEPENDENCY_RESERVATION_OVERRIDE_STALE" }
      );
    }
    if (String(override.locationId) === String(outboundLocationId)) {
      throw Object.assign(
        new Error("The outbound yard cannot be selected as a transfer source reservation override."),
        { status: 400, code: "TRANSFER_DEPENDENCY_RESERVATION_OVERRIDE_OUTBOUND" }
      );
    }
    const quantityAvailable = number(selected.balance.quantityAvailable);
    const reservedQuantity = number(selected.balance.reservedQuantity);
    const effectiveAvailable = number(selected.balance.effectiveAvailable);
    if (reservedQuantity <= EPSILON || quantityAvailable <= effectiveAvailable + EPSILON) {
      throw Object.assign(
        new Error(`${selected.item.itemName || override.itemId} at ${selected.balance.location || override.locationId} no longer has an unsent draft reservation to override.`),
        { status: 409, code: "TRANSFER_DEPENDENCY_RESERVATION_OVERRIDE_STALE" }
      );
    }
    return {
      itemId: Number(override.itemId),
      itemName: selected.item.itemName || "",
      locationId: Number(override.locationId),
      location: selected.balance.location || YARD_BY_ID.get(String(override.locationId))?.code || "",
      quantityAvailable,
      reservedQuantity,
      effectiveAvailable,
      policy: transferDependencyReservationContract.policy,
      selectedBy: text(operatorId),
      selectedAt: new Date().toISOString()
    };
  });
  return {
    entries,
    keys: transferDependencyReservationOverrideSet(entries)
  };
}

async function googleRouteMinutes(origin, destination) {
  if (!config.googleMapsApiKey || !origin || !destination) return null;
  const url = new URL("https://maps.googleapis.com/maps/api/directions/json");
  url.searchParams.set("origin", origin);
  url.searchParams.set("destination", destination);
  url.searchParams.set("mode", "driving");
  url.searchParams.set("avoid", "tolls");
  url.searchParams.set("region", "ca");
  url.searchParams.set("key", config.googleMapsApiKey);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout?.(15000) });
    if (!response.ok) return null;
    const payload = await response.json();
    const seconds = payload.routes?.[0]?.legs?.[0]?.duration?.value;
    return Number.isFinite(Number(seconds)) ? Math.max(1, Math.round(Number(seconds) / 60)) : null;
  } catch {
    return null;
  }
}

export async function generateTransferDependencySuggestion({
  salesOrderId,
  mode = "yard_replenishment",
  reservationOverrides = [],
  operatorId = null
} = {}) {
  const normalizedMode = normalizeMode(mode);
  const candidates = await listTransferDependencyCandidates({ salesOrderId });
  const order = candidates[0];
  if (!order) throw new Error("This Sales Order has no unresolved inventory shortage.");
  const destination = YARD_BY_ID.get(String(order.outboundLocationId));
  if (!destination) throw new Error("The Sales Order outbound location is not one of the four configured yards.");
  const matrix = await getDependencyInventoryMatrix(salesOrderId);
  const selectedOverrides = selectedTransferDependencyReservationOverrides(
    reservationOverrides,
    matrix,
    order.outboundLocationId,
    operatorId
  );
  const planningItems = matrix.items.map((item) => ({
    ...item,
    balances: (item.balances || []).map((balance) => {
      const availability = transferDependencyPlanningAvailability({
        ...balance,
        itemId: item.itemId
      }, selectedOverrides.keys);
      return {
        ...balance,
        effectiveAvailable: availability.planningAvailable,
        reservationOverrideApplied: availability.overridden
      };
    })
  }));
  const routeRows = await Promise.all(DEPENDENCY_YARDS.map(async (yard) => ({
    ...yard,
    routeMinutes: yard.locationId === destination.locationId
      ? 0
      : await googleRouteMinutes(yard.address, order.customerAddress || destination.address)
  })));
  const rankedYards = routeRows
    .filter((yard) => yard.locationId !== destination.locationId)
    .map((yard) => ({
      ...yard,
      routeScore: yard.routeMinutes === null ? (10000 + yard.priority) : yard.routeMinutes + yard.westPenaltyMinutes
    }))
    .sort((left, right) => left.routeScore - right.routeScore || left.priority - right.priority);
  const matrixByItem = new Map(planningItems.map((item) => [String(item.itemId), item]));
  const remainingAvailability = new Map(planningItems.flatMap((item) => (item.balances || []).map((balance) => [
    `${item.itemId}:${balance.locationId}`,
    number(balance.effectiveAvailable)
  ])));
  const preferredSourceByItem = preferredFullCoverageSourceYards(order.lines, planningItems, rankedYards);
  const proposalGroups = new Map();
  let uncovered = 0;
  for (const line of order.lines) {
    let remaining = line.unresolvedQuantity;
    const item = matrixByItem.get(String(line.itemId));
    const preferredSourceLocationId = preferredSourceByItem.get(String(line.itemId));
    const sourceYards = preferredSourceLocationId === undefined
      ? rankedYards
      : rankedYards.filter((yard) => String(yard.locationId) === String(preferredSourceLocationId));
    for (const yard of sourceYards) {
      if (remaining <= EPSILON) break;
      const balance = item?.balances?.find((entry) => String(entry.locationId) === String(yard.locationId));
      const availabilityKey = `${line.itemId}:${yard.locationId}`;
      const available = number(remainingAvailability.get(availabilityKey) ?? balance?.effectiveAvailable);
      if (available <= EPSILON) continue;
      const allocated = Math.min(remaining, available);
      const selection = transferProposalConversionSelection(allocated, line);
      const finalAllocated = selection.hasConversion ? selection.salesQty : allocated;
      if (finalAllocated <= EPSILON) continue;
      const groupKey = `${yard.locationId}:${destination.locationId}`;
      if (!proposalGroups.has(groupKey)) {
        proposalGroups.set(groupKey, {
          proposalKey: groupKey,
          mode: normalizedMode,
          fromLocationId: yard.locationId,
          fromLocation: yard.code,
          toLocationId: destination.locationId,
          toLocation: destination.code,
          routeMinutes: yard.routeMinutes,
          priorityPenaltyMinutes: yard.westPenaltyMinutes,
          routeScore: yard.routeScore,
          memo: `Inventory dependency for ${order.salesOrderRef}`,
          lines: []
        });
      }
      proposalGroups.get(groupKey).lines.push({
        salesLineId: line.salesLineId,
        itemId: line.itemId,
        itemName: line.itemName,
        sku: line.sku,
        unit: line.unit,
        proposedQuantity: finalAllocated,
        toPlt: line.toPlt,
        toLyr: line.toLyr,
        toSec: line.toSec,
        toPcs: line.toPcs,
        palletQty: selection.quantities.pallets,
        layerQty: selection.quantities.layers,
        sectionQty: selection.quantities.sections,
        pieceQty: selection.quantities.pieces
      });
      remainingAvailability.set(availabilityKey, Math.max(0, available - finalAllocated));
      remaining = Math.max(0, remaining - finalAllocated);
    }
    uncovered += Math.max(0, remaining);
  }
  const inventorySnapshot = {
    capturedAt: new Date().toISOString(),
    salesOrderId: order.salesOrderId,
    balances: matrix.items,
    reservationOverridePolicy: transferDependencyReservationContract.policy,
    reservationOverrides: selectedOverrides.entries
  };
  return withTransaction(async () => {
    const prior = await query(
      `SELECT id FROM scm_transfer_dependency_batches
        WHERE sales_order_id = $1 AND status IN ('draft', 'suggested', 'attention')
        ORDER BY updated_at DESC LIMIT 1 FOR UPDATE`,
      [order.salesOrderId]
    );
    let batchId = prior.rows[0]?.id;
    if (batchId) {
      await query(
        `DELETE FROM scm_transfer_dependency_proposals
          WHERE batch_id = $1 AND creation_status <> 'created'`,
        [batchId]
      );
      await query(
        `UPDATE scm_transfer_dependency_batches
            SET status = 'suggested', inventory_snapshot = $2::jsonb,
                inventory_snapshot_at = now(), uncovered_shortage_qty = $3,
                updated_by = $4, updated_at = now()
          WHERE id = $1`,
        [batchId, JSON.stringify(inventorySnapshot), uncovered, operatorId]
      );
    } else {
      const inserted = await query(
        `INSERT INTO scm_transfer_dependency_batches (
           sales_order_id, sales_order_ref, idempotency_key, status,
           inventory_snapshot, inventory_snapshot_at, uncovered_shortage_qty,
           created_by, updated_by
         ) VALUES ($1, $2, $3, 'suggested', $4::jsonb, now(), $5, $6, $6)
         RETURNING id`,
        [order.salesOrderId, order.salesOrderRef, crypto.randomUUID(), JSON.stringify(inventorySnapshot), uncovered, operatorId]
      );
      batchId = inserted.rows[0].id;
    }
    for (const proposal of proposalGroups.values()) {
      const pallet = calculateTransferProposalPallets(proposal.lines);
      const inserted = await query(
        `INSERT INTO scm_transfer_dependency_proposals (
           batch_id, proposal_key, dependency_mode, from_location_id, from_location,
           to_location_id, to_location, memo, route_minutes,
           priority_penalty_minutes, route_score, calculated_pallet_qty,
           pallet_transfer_qty, pallet_calculation_complete
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
          RETURNING id`,
        [batchId, proposal.proposalKey, proposal.mode, proposal.fromLocationId, proposal.fromLocation,
          proposal.toLocationId, proposal.toLocation, proposal.memo, proposal.routeMinutes,
          proposal.priorityPenaltyMinutes, proposal.routeScore, pallet.calculatedQuantity,
          pallet.recommendedQuantity, pallet.complete]
      );
      for (const line of proposal.lines) {
        await query(
          `INSERT INTO scm_transfer_dependency_proposal_lines (
             proposal_id, sales_line_id, item_id, item_name, unit, proposed_quantity,
             pallet_qty, layer_qty, section_qty, piece_qty, line_source,
             to_plt, to_lyr, to_sec, to_pcs
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'shortage', $11, $12, $13, $14)`,
          [inserted.rows[0].id, line.salesLineId, line.itemId, line.itemName, line.unit,
            line.proposedQuantity, line.palletQty, line.layerQty, line.sectionQty, line.pieceQty,
            line.toPlt, line.toLyr, line.toSec, line.toPcs]
        );
      }
    }
    await writeDispatchAudit({
      action: "scm.transfer_dependency.suggested",
      source: "scm",
      entityType: "dependency_batch",
      entityId: String(batchId),
      orderId: order.salesOrderRef,
      operatorId,
      details: {
        proposalCount: proposalGroups.size,
        uncoveredQuantity: uncovered,
        mode: normalizedMode,
        fullCoverItemCount: preferredSourceByItem.size,
        reservationOverrideCount: selectedOverrides.entries.length,
        reservationOverrides: selectedOverrides.entries.map((entry) => ({
          itemId: entry.itemId,
          itemName: entry.itemName,
          locationId: entry.locationId,
          location: entry.location,
          quantityAvailable: entry.quantityAvailable,
          reservedQuantity: entry.reservedQuantity,
          effectiveAvailable: entry.effectiveAvailable,
          policy: entry.policy
        }))
      }
    });
    return getTransferDependencyBatch(batchId);
  });
}

export async function getTransferDependencyBatch(batchId) {
  const header = await query(
    `SELECT b.*, o.customer, o.dispatch_address, o.outbound_location_id, o.outbound_location
       FROM scm_transfer_dependency_batches b
       JOIN sales_orders o ON o.netsuite_id = b.sales_order_id
      WHERE b.id = $1`,
    [Number(batchId)]
  );
  if (!header.rowCount) return null;
  const proposals = await query(
    `SELECT p.*,
            ARRAY(
              SELECT source.id
                FROM scm_transfer_dependency_proposals source
               WHERE source.merged_into_proposal_id = p.id
               ORDER BY source.id
            ) AS merged_from_proposal_ids,
            j.status AS print_status,
            j.document_name AS print_document_name,
            j.queued_at AS print_queued_at,
            j.started_at AS print_started_at,
            j.printed_at AS print_printed_at,
            j.last_error AS print_error
       FROM scm_transfer_dependency_proposals p
       LEFT JOIN scm_print_jobs j ON j.id = p.print_job_id
      WHERE p.batch_id = $1
        AND p.creation_status <> 'cancelled'
      ORDER BY p.id`,
    [Number(batchId)]
  );
  const proposalIds = proposals.rows.map((row) => row.id);
  const lines = proposalIds.length ? await query(
    `SELECT pl.*, COALESCE(sl.sku, i.item_name) AS sku,
            COALESCE(pl.to_plt, sl.to_plt, i.to_plt, 0) AS resolved_to_plt,
            COALESCE(pl.to_lyr, sl.to_lyr, i.to_lyr, 0) AS resolved_to_lyr,
            COALESCE(pl.to_sec, sl.to_sec, i.to_sec, 0) AS resolved_to_sec,
            COALESCE(pl.to_pcs, sl.to_pcs, i.to_pcs, 0) AS resolved_to_pcs
       FROM scm_transfer_dependency_proposal_lines pl
       LEFT JOIN sales_order_lines sl ON sl.id = pl.sales_line_id
       LEFT JOIN inventory_items i ON i.item_id = pl.item_id
      WHERE pl.proposal_id = ANY($1::bigint[])
      ORDER BY pl.proposal_id, pl.item_name, pl.id`,
    [proposalIds]
  ) : { rows: [] };
  const byProposal = new Map();
  for (const line of lines.rows) {
    if (!byProposal.has(String(line.proposal_id))) byProposal.set(String(line.proposal_id), []);
    const proposedQuantity = number(line.proposed_quantity);
    const resolvedLine = {
      ...line,
      to_plt: line.resolved_to_plt,
      to_lyr: line.resolved_to_lyr,
      to_sec: line.resolved_to_sec,
      to_pcs: line.resolved_to_pcs
    };
    const selection = conversionSelection(proposedQuantity, resolvedLine);
    const storedQuantities = {
      pallets: number(line.pallet_qty),
      layers: number(line.layer_qty),
      sections: number(line.section_qty),
      pieces: number(line.piece_qty),
      salesQty: 0
    };
    const storedSalesQuantity = ["pallets", "layers", "sections", "pieces"].reduce(
      (total, unit) => total + (storedQuantities[unit] * selection.conversions[unit]),
      0
    );
    byProposal.get(String(line.proposal_id)).push({
      id: line.id,
      salesLineId: line.sales_line_id,
      lineSource: line.line_source || "shortage",
      itemId: line.item_id,
      itemName: line.item_name,
      sku: line.sku,
      unit: line.unit,
      proposedQuantity,
      toPlt: number(resolvedLine.to_plt),
      toLyr: number(resolvedLine.to_lyr),
      toSec: number(resolvedLine.to_sec),
      toPcs: number(resolvedLine.to_pcs),
      palletQty: number(line.pallet_qty),
      layerQty: number(line.layer_qty),
      sectionQty: number(line.section_qty),
      pieceQty: number(line.piece_qty),
      hasConversion: selection.hasConversion,
      conversions: selection.conversions,
      quantities: selection.hasConversion
        ? (Math.abs(storedSalesQuantity - proposedQuantity) <= 0.0001 ? storedQuantities : selection.quantities)
        : selection.quantities
    });
  }
  const batch = header.rows[0];
  return {
    id: batch.id,
    salesOrderId: batch.sales_order_id,
    salesOrderRef: batch.sales_order_ref,
    customer: batch.customer,
    customerAddress: batch.dispatch_address,
    outboundLocationId: batch.outbound_location_id,
    outboundLocation: batch.outbound_location,
    status: batch.status,
    inventorySnapshot: batch.inventory_snapshot,
    inventorySnapshotAt: batch.inventory_snapshot_at,
    reservationOverridePolicy: batch.inventory_snapshot?.reservationOverridePolicy || "",
    reservationOverrides: transferDependencyReservationOverridesFromSnapshot(batch.inventory_snapshot),
    uncoveredShortageQuantity: number(batch.uncovered_shortage_qty),
    allowIncompleteCoverage: batch.allow_incomplete_coverage,
    createdAt: batch.created_at,
    updatedAt: batch.updated_at,
    proposals: proposals.rows.map((proposal) => ({
      id: proposal.id,
      proposalKey: proposal.proposal_key,
      mode: proposal.dependency_mode,
      fromLocationId: proposal.from_location_id,
      fromLocation: proposal.from_location,
      toLocationId: proposal.to_location_id,
      toLocation: proposal.to_location,
      memo: proposal.memo,
      routeMinutes: nullableNumber(proposal.route_minutes),
      priorityPenaltyMinutes: number(proposal.priority_penalty_minutes),
      routeScore: nullableNumber(proposal.route_score),
      calculatedPalletQuantity: number(proposal.calculated_pallet_qty),
      palletTransferQuantity: number(proposal.pallet_transfer_qty),
      palletCalculationComplete: proposal.pallet_calculation_complete !== false,
      palletQuantityOverridden: proposal.pallet_qty_overridden === true,
      palletItemId: proposal.pallet_item_id,
      palletItemName: proposal.pallet_item_name || "PALLET",
      mergedFromProposalIds: (proposal.merged_from_proposal_ids || []).map(Number),
      creationStatus: proposal.creation_status,
      creationAttemptId: proposal.creation_attempt_id,
      creationStartedAt: proposal.creation_started_at,
      transferOrderId: proposal.netsuite_transfer_order_id,
      transferOrderRef: proposal.netsuite_transfer_order_ref,
      creationError: proposal.creation_error,
      quantityVerificationStatus: proposal.quantity_verification_status || "pending",
      quantityVerificationError: proposal.quantity_verification_error,
      quantityVerifiedAt: proposal.quantity_verified_at,
      quantityVerifiedBy: proposal.quantity_verified_by,
      approvalStatus: proposal.approval_status || "pending",
      approvalError: proposal.approval_error,
      approvedAt: proposal.approved_at,
      approvedBy: proposal.approved_by,
      printJob: proposal.print_job_id ? {
        id: Number(proposal.print_job_id),
        status: proposal.print_status,
        documentName: proposal.print_document_name,
        queuedAt: proposal.print_queued_at,
        startedAt: proposal.print_started_at,
        printedAt: proposal.print_printed_at,
        error: proposal.print_error
      } : null,
      lines: byProposal.get(String(proposal.id)) || []
    }))
  };
}

async function recalculateTransferProposalPallets(proposalId, overrideValue = undefined) {
  const rows = await query(
    `SELECT pl.*, COALESCE(sl.sku, i.item_name) AS sku,
            COALESCE(pl.to_plt, sl.to_plt, i.to_plt, 0) AS resolved_to_plt,
            COALESCE(pl.to_lyr, sl.to_lyr, i.to_lyr, 0) AS resolved_to_lyr,
            COALESCE(pl.to_sec, sl.to_sec, i.to_sec, 0) AS resolved_to_sec,
            COALESCE(pl.to_pcs, sl.to_pcs, i.to_pcs, 0) AS resolved_to_pcs
       FROM scm_transfer_dependency_proposal_lines pl
       LEFT JOIN sales_order_lines sl ON sl.id = pl.sales_line_id
       LEFT JOIN inventory_items i ON i.item_id = pl.item_id
      WHERE pl.proposal_id = $1
      ORDER BY pl.id`,
    [Number(proposalId)]
  );
  const pallet = calculateTransferProposalPallets(rows.rows.map((line) => ({
    ...line,
    to_plt: line.resolved_to_plt,
    to_lyr: line.resolved_to_lyr,
    to_sec: line.resolved_to_sec,
    to_pcs: line.resolved_to_pcs
  })));
  const current = await query(
    `SELECT pallet_transfer_qty, pallet_qty_overridden
       FROM scm_transfer_dependency_proposals
      WHERE id = $1`,
    [Number(proposalId)]
  );
  if (!current.rowCount) throw new Error("Transfer proposal not found.");
  const overrideProvided = overrideValue !== undefined && overrideValue !== null && overrideValue !== "";
  const finalQuantity = overrideProvided
    ? number(overrideValue)
    : current.rows[0].pallet_qty_overridden
      ? number(current.rows[0].pallet_transfer_qty)
      : pallet.recommendedQuantity;
  await query(
    `UPDATE scm_transfer_dependency_proposals
        SET calculated_pallet_qty = $2,
            pallet_transfer_qty = $3,
            pallet_calculation_complete = $4,
            pallet_qty_overridden = CASE WHEN $5 THEN true ELSE pallet_qty_overridden END,
            updated_at = now()
      WHERE id = $1`,
    [Number(proposalId), pallet.calculatedQuantity, finalQuantity, pallet.complete, overrideProvided]
  );
  return { ...pallet, finalQuantity, overridden: overrideProvided || current.rows[0].pallet_qty_overridden === true };
}

export async function removeTransferDependencyProposalLine(batchId, proposalId, proposalLineId, operatorId = null) {
  return withTransaction(async () => {
    const selected = await query(
      `SELECT b.id AS batch_id, b.sales_order_id, b.sales_order_ref, b.status AS batch_status,
              p.id AS proposal_id, p.creation_status,
              pl.id AS proposal_line_id, pl.sales_line_id, pl.item_id, pl.item_name,
              pl.proposed_quantity, pl.line_source
         FROM scm_transfer_dependency_batches b
         JOIN scm_transfer_dependency_proposals p ON p.batch_id = b.id
         JOIN scm_transfer_dependency_proposal_lines pl ON pl.proposal_id = p.id
        WHERE b.id = $1 AND p.id = $2 AND pl.id = $3
        FOR UPDATE OF b, p, pl`,
      [Number(batchId), Number(proposalId), Number(proposalLineId)]
    );
    if (!selected.rowCount) {
      const error = new Error("Transfer proposal line not found.");
      error.status = 404;
      throw error;
    }
    const removed = selected.rows[0];
    if (["creating", "created"].includes(removed.batch_status)
      || !["draft", "failed"].includes(removed.creation_status)) {
      const error = new Error("This transfer proposal can no longer be edited.");
      error.status = 409;
      throw error;
    }
    await query(
      `DELETE FROM scm_transfer_dependency_proposal_lines
        WHERE id = $1 AND proposal_id = $2`,
      [Number(proposalLineId), Number(proposalId)]
    );
    const remaining = await query(
      `SELECT COUNT(*)::int AS line_count
         FROM scm_transfer_dependency_proposal_lines
        WHERE proposal_id = $1`,
      [Number(proposalId)]
    );
    const proposalRemoved = Number(remaining.rows[0]?.line_count || 0) === 0;
    if (proposalRemoved) {
      await query(
        `DELETE FROM scm_transfer_dependency_proposals
          WHERE id = $1 AND batch_id = $2`,
        [Number(proposalId), Number(batchId)]
      );
    } else {
      await recalculateTransferProposalPallets(proposalId);
    }
    const destinationCoverage = await query(
      `SELECT COALESCE(SUM(pl.proposed_quantity), 0) AS proposed
         FROM scm_transfer_dependency_proposal_lines pl
         JOIN scm_transfer_dependency_proposals p ON p.id = pl.proposal_id
         JOIN sales_orders o ON o.netsuite_id = $2
        WHERE p.batch_id = $1
          AND p.creation_status <> 'cancelled'
          AND pl.line_source = 'shortage'
          AND p.to_location_id = o.outbound_location_id`,
      [Number(batchId), Number(removed.sales_order_id)]
    );
    const shortageRows = await salesOrderShortageRows(removed.sales_order_id);
    const shortage = shortageRows.reduce((total, row) => total + row.unresolved_quantity, 0);
    const uncovered = Math.max(0, shortage - number(destinationCoverage.rows[0]?.proposed));
    await query(
      `UPDATE scm_transfer_dependency_batches
          SET uncovered_shortage_qty = $2, updated_by = $3, updated_at = now()
        WHERE id = $1`,
      [Number(batchId), uncovered, operatorId]
    );
    await writeDispatchAudit({
      action: "scm.transfer_dependency.proposal_line_removed",
      source: "scm",
      entityType: "dependency_batch",
      entityId: String(batchId),
      orderId: removed.sales_order_ref,
      operatorId,
      details: {
        proposalId: Number(proposalId),
        proposalLineId: Number(proposalLineId),
        salesLineId: removed.sales_line_id,
        itemId: removed.item_id,
        itemName: removed.item_name,
        lineSource: removed.line_source || "shortage",
        proposedQuantity: number(removed.proposed_quantity),
        proposalRemoved,
        uncoveredQuantity: uncovered
      }
    });
    return getTransferDependencyBatch(batchId);
  });
}

export async function prepareTransferDependencyPalletItem(batchId, palletItem, operatorId = null) {
  const itemId = Number(palletItem?.itemId ?? palletItem?.id);
  if (!Number.isInteger(itemId) || itemId <= 0) throw new Error("NetSuite PALLET item could not be resolved.");
  const pending = await query(
    `SELECT id FROM scm_transfer_dependency_proposals
      WHERE batch_id = $1 AND creation_status NOT IN ('created', 'attention', 'cancelled')
      ORDER BY id`,
    [Number(batchId)]
  );
  for (const proposal of pending.rows) await recalculateTransferProposalPallets(proposal.id);
  await query(
    `UPDATE scm_transfer_dependency_proposals
        SET pallet_item_id = $2, pallet_item_name = $3, updated_at = now()
      WHERE batch_id = $1
        AND creation_status NOT IN ('created', 'attention', 'cancelled')`,
    [Number(batchId), itemId, text(palletItem?.itemName) || "PALLET"]
  );
  await query(
    `UPDATE scm_transfer_dependency_batches SET updated_by = $2, updated_at = now() WHERE id = $1`,
    [Number(batchId), operatorId]
  );
  return getTransferDependencyBatch(batchId);
}

export async function updateTransferDependencyBatch(batchId, input = {}, operatorId = null) {
  return withTransaction(async () => {
    const current = await query(
      `SELECT * FROM scm_transfer_dependency_batches WHERE id = $1 FOR UPDATE`,
      [Number(batchId)]
    );
    if (!current.rowCount) throw new Error("Dependency batch not found.");
    if (["creating", "created"].includes(current.rows[0].status)) throw new Error("Created dependency proposals cannot be edited.");
    const proposals = Array.isArray(input.proposals) ? input.proposals : [];
    for (const proposal of proposals) {
      const fromYard = YARD_BY_ID.get(String(proposal.fromLocationId));
      const toYard = YARD_BY_ID.get(String(proposal.toLocationId));
      if (!fromYard || !toYard) throw new Error("Select configured From and To yards.");
      if (fromYard.locationId === toYard.locationId) throw new Error("Transfer source and destination cannot be the same yard.");
      await query(
        `UPDATE scm_transfer_dependency_proposals
            SET dependency_mode = $3, from_location_id = $4, from_location = $5,
                to_location_id = $6, to_location = $7, memo = $8, updated_at = now()
          WHERE id = $1 AND batch_id = $2 AND creation_status <> 'created'`,
        [Number(proposal.id), Number(batchId), normalizeMode(proposal.mode), fromYard.locationId,
          fromYard.code, toYard.locationId, toYard.code, text(proposal.memo)]
      );
      if (Array.isArray(proposal.lines)) {
        for (const line of proposal.lines) {
          const proposalLineId = Number(line.proposalLineId);
          const salesLineId = Number(line.salesLineId);
          const source = await query(
            `SELECT pl.*,
                    COALESCE(pl.to_plt, sl.to_plt, i.to_plt, 0) AS resolved_to_plt,
                    COALESCE(pl.to_lyr, sl.to_lyr, i.to_lyr, 0) AS resolved_to_lyr,
                    COALESCE(pl.to_sec, sl.to_sec, i.to_sec, 0) AS resolved_to_sec,
                    COALESCE(pl.to_pcs, sl.to_pcs, i.to_pcs, 0) AS resolved_to_pcs,
                    COALESCE(sl.item_name, sl.sku, pl.item_name, i.item_name) AS resolved_item_name
               FROM scm_transfer_dependency_proposal_lines pl
               JOIN scm_transfer_dependency_proposals p ON p.id = pl.proposal_id
               JOIN scm_transfer_dependency_batches b ON b.id = p.batch_id
               LEFT JOIN sales_order_lines sl ON sl.id = pl.sales_line_id
               LEFT JOIN inventory_items i ON i.item_id = pl.item_id
              WHERE b.id = $1
                AND p.id = $2
                AND (
                  ($3::bigint IS NOT NULL AND pl.id = $3)
                  OR ($3::bigint IS NULL AND $4::bigint IS NOT NULL AND pl.sales_line_id = $4)
                )
              FOR UPDATE OF pl`,
            [
              Number(batchId),
              Number(proposal.id),
              Number.isInteger(proposalLineId) && proposalLineId > 0 ? proposalLineId : null,
              Number.isInteger(salesLineId) && salesLineId > 0 ? salesLineId : null
            ]
          );
          if (!source.rowCount) throw new Error("A proposed transfer line is no longer available.");
          const sourceLine = source.rows[0];
          const converted = allocationSalesQuantity({
            quantity: line.proposedQuantity,
            quantities: line.quantities
          }, {
            itemId: sourceLine.item_id,
            itemName: sourceLine.resolved_item_name,
            toPlt: sourceLine.resolved_to_plt,
            toLyr: sourceLine.resolved_to_lyr,
            toSec: sourceLine.resolved_to_sec,
            toPcs: sourceLine.resolved_to_pcs
          });
          const qty = converted.quantity;
          if (qty <= EPSILON) throw new Error("Every proposed transfer line must have a quantity above zero.");
          await query(
              `UPDATE scm_transfer_dependency_proposal_lines
                SET proposed_quantity = $3, pallet_qty = $4, layer_qty = $5,
                    section_qty = $6, piece_qty = $7, updated_at = now()
              WHERE proposal_id = $1 AND id = $2`,
            [Number(proposal.id), Number(sourceLine.id), qty, converted.display.palletQty,
              converted.display.layerQty, converted.display.sectionQty, converted.display.pieceQty]
          );
        }
      }
      await recalculateTransferProposalPallets(proposal.id, proposal.palletTransferQuantity);
    }
    const destinationCoverage = await query(
      `SELECT COALESCE(SUM(pl.proposed_quantity), 0) AS proposed
         FROM scm_transfer_dependency_proposal_lines pl
         JOIN scm_transfer_dependency_proposals p ON p.id = pl.proposal_id
         JOIN scm_transfer_dependency_batches b ON b.id = p.batch_id
         JOIN sales_orders o ON o.netsuite_id = b.sales_order_id
        WHERE p.batch_id = $1
          AND p.creation_status <> 'cancelled'
          AND pl.line_source = 'shortage'
          AND p.to_location_id = o.outbound_location_id`,
      [Number(batchId)]
    );
    const shortageRows = await salesOrderShortageRows(current.rows[0].sales_order_id);
    const shortage = shortageRows.reduce((total, row) => total + row.unresolved_quantity, 0);
    const uncovered = Math.max(0, shortage - number(destinationCoverage.rows[0]?.proposed));
    await query(
      `UPDATE scm_transfer_dependency_batches
          SET uncovered_shortage_qty = $2,
              allow_incomplete_coverage = COALESCE($3, allow_incomplete_coverage),
              updated_by = $4, updated_at = now()
        WHERE id = $1`,
      [Number(batchId), uncovered, input.allowIncompleteCoverage === undefined ? null : input.allowIncompleteCoverage === true, operatorId]
    );
    return getTransferDependencyBatch(batchId);
  });
}

export async function mergeTransferDependencyProposals(batchId, input = {}, operatorId = null) {
  const resolvedBatchId = Number(batchId);
  if (!Number.isInteger(resolvedBatchId) || resolvedBatchId <= 0) {
    throw Object.assign(new Error("Select a valid dependency batch."), { status: 400 });
  }
  const requestedIds = Array.isArray(input.proposalIds) ? input.proposalIds : [];
  const proposalIds = [...new Set(requestedIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))]
    .sort((left, right) => left - right);
  if (proposalIds.length < 2) {
    throw Object.assign(new Error("Select at least two proposed Transfer Orders to merge."), { status: 400 });
  }
  if (proposalIds.length > 20) {
    throw Object.assign(new Error("Merge no more than 20 proposed Transfer Orders at once."), { status: 400 });
  }
  const requestedTargetId = input.targetProposalId === undefined || input.targetProposalId === null
    ? proposalIds[0]
    : Number(input.targetProposalId);
  if (!Number.isInteger(requestedTargetId) || !proposalIds.includes(requestedTargetId)) {
    throw Object.assign(new Error("The merge target must be one of the selected proposals."), { status: 400 });
  }
  const proposalUpdates = Array.isArray(input.proposals) ? input.proposals : [];
  const updateIds = proposalUpdates.map((proposal) => Number(proposal?.id));
  if (updateIds.some((id) => !Number.isInteger(id) || !proposalIds.includes(id))
    || new Set(updateIds).size !== updateIds.length) {
    throw Object.assign(new Error("Draft updates may include each selected proposal only once."), { status: 400 });
  }
  const mergeSignature = crypto.createHash("sha256").update(JSON.stringify({
    batchId: resolvedBatchId,
    proposalIds,
    targetProposalId: requestedTargetId
  })).digest("hex");
  const replacementKey = `manual-merge:${mergeSignature}`;
  const conflict = (message, code = "TRANSFER_DEPENDENCY_MERGE_CONFLICT") => Object.assign(
    new Error(message),
    { status: 409, code }
  );

  return withTransaction(async () => {
    const batchResult = await query(
      `SELECT * FROM scm_transfer_dependency_batches WHERE id = $1 FOR UPDATE`,
      [resolvedBatchId]
    );
    if (!batchResult.rowCount) {
      throw Object.assign(new Error("Dependency batch not found."), { status: 404 });
    }
    const batchRow = batchResult.rows[0];
    const priorReplacement = await query(
      `SELECT id
         FROM scm_transfer_dependency_proposals
        WHERE batch_id = $1 AND proposal_key = $2
        FOR UPDATE`,
      [resolvedBatchId, replacementKey]
    );
    if (priorReplacement.rowCount) {
      const mergedProposalId = Number(priorReplacement.rows[0].id);
      const lineage = await query(
        `SELECT id, merged_into_proposal_id
           FROM scm_transfer_dependency_proposals
          WHERE batch_id = $1 AND id = ANY($2::bigint[])
          ORDER BY id
          FOR UPDATE`,
        [resolvedBatchId, proposalIds]
      );
      const exactReplay = lineage.rowCount === proposalIds.length
        && lineage.rows.every((row) => Number(row.merged_into_proposal_id) === mergedProposalId);
      if (!exactReplay) {
        throw conflict("This merge key is already associated with different proposal lineage. Refresh and try again.");
      }
      return {
        batch: await getTransferDependencyBatch(resolvedBatchId),
        mergedProposalId,
        sourceProposalIds: proposalIds,
        reused: true
      };
    }
    if (["creating", "created", "cancelled"].includes(batchRow.status)) {
      throw conflict("Only a batch with editable draft proposals can be merged.");
    }

    const lockSelected = async () => query(
      `SELECT *
         FROM scm_transfer_dependency_proposals
        WHERE batch_id = $1 AND id = ANY($2::bigint[])
        ORDER BY id
        FOR UPDATE`,
      [resolvedBatchId, proposalIds]
    );
    let selectedResult = await lockSelected();
    if (selectedResult.rowCount !== proposalIds.length) {
      throw Object.assign(new Error("One or more selected Transfer Order proposals were not found in this batch."), { status: 404 });
    }
    const assertDraftSources = (rows) => {
      if (rows.some((proposal) => proposal.creation_status !== "draft")) {
        throw conflict("Only draft Transfer Order proposals can be merged.");
      }
      if (rows.some((proposal) => proposal.netsuite_transfer_order_id
        || text(proposal.netsuite_transfer_order_ref)
        || text(proposal.creation_attempt_id)
        || proposal.creation_started_at
        || proposal.print_job_id
        || proposal.quantity_verification_status !== "pending"
        || proposal.approval_status !== "pending")) {
        throw conflict("A draft with Transfer Order execution, verification, approval, or print history cannot be merged.");
      }
    };
    assertDraftSources(selectedResult.rows);

    if (proposalUpdates.length || input.allowIncompleteCoverage !== undefined) {
      await updateTransferDependencyBatch(resolvedBatchId, {
        proposals: proposalUpdates,
        ...(input.allowIncompleteCoverage === undefined
          ? {}
          : { allowIncompleteCoverage: input.allowIncompleteCoverage === true })
      }, operatorId);
      selectedResult = await lockSelected();
      assertDraftSources(selectedResult.rows);
    }

    const selected = selectedResult.rows;
    const template = selected.find((proposal) => Number(proposal.id) === requestedTargetId);
    const route = `${template.from_location_id}:${template.to_location_id}`;
    if (selected.some((proposal) => `${proposal.from_location_id}:${proposal.to_location_id}` !== route)) {
      throw conflict("Proposed Transfer Orders can be merged only when they have the same From and To locations.");
    }
    if (selected.some((proposal) => proposal.dependency_mode !== template.dependency_mode)) {
      throw conflict("Proposed Transfer Orders must use the same dependency mode before merging.");
    }

    const configuredPalletItemIds = [...new Set(selected
      .map((proposal) => Number(proposal.pallet_item_id))
      .filter((itemId) => Number.isInteger(itemId) && itemId > 0))];
    if (configuredPalletItemIds.length > 1) {
      throw conflict("Selected proposals use different PALLET items and cannot be merged.");
    }
    const palletItemId = configuredPalletItemIds[0] || null;
    const palletItemName = selected.find((proposal) => Number(proposal.pallet_item_id) === palletItemId)?.pallet_item_name
      || template.pallet_item_name
      || "PALLET";

    const lineResult = await query(
      `SELECT pl.*, COALESCE(sl.sku, i.item_name) AS sku,
              COALESCE(pl.to_plt, sl.to_plt, i.to_plt, 0) AS resolved_to_plt,
              COALESCE(pl.to_lyr, sl.to_lyr, i.to_lyr, 0) AS resolved_to_lyr,
              COALESCE(pl.to_sec, sl.to_sec, i.to_sec, 0) AS resolved_to_sec,
              COALESCE(pl.to_pcs, sl.to_pcs, i.to_pcs, 0) AS resolved_to_pcs
         FROM scm_transfer_dependency_proposal_lines pl
         LEFT JOIN sales_order_lines sl ON sl.id = pl.sales_line_id
         LEFT JOIN inventory_items i ON i.item_id = pl.item_id
        WHERE pl.proposal_id = ANY($1::bigint[])
        ORDER BY array_position($1::bigint[], pl.proposal_id), pl.id
        FOR UPDATE OF pl`,
      [proposalIds]
    );
    if (!lineResult.rowCount) {
      throw conflict("Selected draft proposals have no transfer lines to merge.");
    }
    const combinedBySalesLine = new Map();
    for (const line of lineResult.rows) {
      const key = line.line_source === "manual"
        ? `manual:${line.item_id}`
        : `shortage:${line.sales_line_id}`;
      const current = combinedBySalesLine.get(key);
      if (!current) {
        combinedBySalesLine.set(key, {
          ...line,
          to_plt: number(line.resolved_to_plt),
          to_lyr: number(line.resolved_to_lyr),
          to_sec: number(line.resolved_to_sec),
          to_pcs: number(line.resolved_to_pcs),
          proposed_quantity: number(line.proposed_quantity),
          pallet_qty: number(line.pallet_qty),
          layer_qty: number(line.layer_qty),
          section_qty: number(line.section_qty),
          piece_qty: number(line.piece_qty)
        });
        continue;
      }
      if (String(current.item_id) !== String(line.item_id)) {
        throw conflict(`Transfer proposal line ${line.sales_line_id || line.item_id} resolves to different items and cannot be merged.`);
      }
      current.proposed_quantity = Number((current.proposed_quantity + number(line.proposed_quantity)).toFixed(6));
      current.pallet_qty = Number((current.pallet_qty + number(line.pallet_qty)).toFixed(6));
      current.layer_qty = Number((current.layer_qty + number(line.layer_qty)).toFixed(6));
      current.section_qty = Number((current.section_qty + number(line.section_qty)).toFixed(6));
      current.piece_qty = Number((current.piece_qty + number(line.piece_qty)).toFixed(6));
    }
    const combinedLines = [...combinedBySalesLine.values()];
    const pallet = calculateTransferProposalPallets(combinedLines);
    const hasManualPalletOverride = selected.some((proposal) => proposal.pallet_qty_overridden === true);
    const priorFinalPalletQuantity = Number(selected.reduce(
      (total, proposal) => total + number(proposal.pallet_transfer_qty),
      0
    ).toFixed(6));
    const finalPalletQuantity = hasManualPalletOverride
      ? priorFinalPalletQuantity
      : pallet.recommendedQuantity;

    const replacement = await query(
      `INSERT INTO scm_transfer_dependency_proposals (
         batch_id, proposal_key, dependency_mode, from_location_id, from_location,
         to_location_id, to_location, memo, route_minutes,
         priority_penalty_minutes, route_score, calculated_pallet_qty,
         pallet_transfer_qty, pallet_calculation_complete, pallet_qty_overridden,
         pallet_item_id, pallet_item_name
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       RETURNING id`,
      [resolvedBatchId, replacementKey, template.dependency_mode,
        template.from_location_id, template.from_location, template.to_location_id, template.to_location,
        template.memo, template.route_minutes, template.priority_penalty_minutes, template.route_score,
        pallet.calculatedQuantity, finalPalletQuantity, pallet.complete, hasManualPalletOverride,
        palletItemId, palletItemName]
    );
    const mergedProposalId = Number(replacement.rows[0].id);
    for (const line of combinedLines) {
      await query(
        `INSERT INTO scm_transfer_dependency_proposal_lines (
           proposal_id, sales_line_id, item_id, item_name, unit, proposed_quantity,
           pallet_qty, layer_qty, section_qty, piece_qty, line_source,
           to_plt, to_lyr, to_sec, to_pcs
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [mergedProposalId, line.sales_line_id, line.item_id, line.item_name, line.unit,
          line.proposed_quantity, line.pallet_qty, line.layer_qty, line.section_qty, line.piece_qty,
          line.line_source || "shortage", line.to_plt, line.to_lyr, line.to_sec, line.to_pcs]
      );
    }
    const cancelled = await query(
      `UPDATE scm_transfer_dependency_proposals
          SET creation_status = 'cancelled', merged_into_proposal_id = $2,
              merged_at = now(), merged_by = $3, updated_at = now()
        WHERE batch_id = $1
          AND id = ANY($4::bigint[])
          AND creation_status = 'draft'
        RETURNING id`,
      [resolvedBatchId, mergedProposalId, operatorId, proposalIds]
    );
    if (cancelled.rowCount !== proposalIds.length) {
      throw conflict("A selected proposal changed while the merge was being saved. Refresh and try again.");
    }

    const destinationCoverage = await query(
      `SELECT COALESCE(SUM(pl.proposed_quantity), 0) AS proposed
         FROM scm_transfer_dependency_proposal_lines pl
         JOIN scm_transfer_dependency_proposals p ON p.id = pl.proposal_id
         JOIN sales_orders o ON o.netsuite_id = $2
        WHERE p.batch_id = $1
          AND p.creation_status <> 'cancelled'
          AND pl.line_source = 'shortage'
          AND p.to_location_id = o.outbound_location_id`,
      [resolvedBatchId, Number(batchRow.sales_order_id)]
    );
    const shortageRows = await salesOrderShortageRows(batchRow.sales_order_id);
    const shortage = shortageRows.reduce((total, row) => total + row.unresolved_quantity, 0);
    const uncovered = Math.max(0, shortage - number(destinationCoverage.rows[0]?.proposed));
    await query(
      `UPDATE scm_transfer_dependency_batches
          SET uncovered_shortage_qty = $2,
              allow_incomplete_coverage = COALESCE($3, allow_incomplete_coverage),
              updated_by = $4, updated_at = now()
        WHERE id = $1`,
      [resolvedBatchId, uncovered,
        input.allowIncompleteCoverage === undefined ? null : input.allowIncompleteCoverage === true,
        operatorId]
    );

    const itemTotals = new Map();
    for (const line of combinedLines) {
      const key = String(line.item_id);
      const item = itemTotals.get(key) || {
        itemId: line.item_id,
        itemName: line.item_name,
        proposedQuantity: 0
      };
      item.proposedQuantity = Number((item.proposedQuantity + number(line.proposed_quantity)).toFixed(6));
      itemTotals.set(key, item);
    }
    await writeDispatchAudit({
      action: "scm.transfer_dependency.proposals_merged",
      source: "scm",
      entityType: "dependency_batch",
      entityId: String(resolvedBatchId),
      orderId: batchRow.sales_order_ref,
      operatorId,
      before: {
        proposalIds,
        proposalCount: proposalIds.length,
        lineCount: lineResult.rowCount,
        finalPalletQuantity: priorFinalPalletQuantity
      },
      after: {
        proposalId: mergedProposalId,
        proposalCount: 1,
        lineCount: combinedLines.length,
        finalPalletQuantity
      },
      details: {
        sourceProposalIds: proposalIds,
        replacementProposalId: mergedProposalId,
        targetProposalId: requestedTargetId,
        proposalKey: replacementKey,
        dependencyMode: template.dependency_mode,
        fromLocationId: Number(template.from_location_id),
        fromLocation: template.from_location,
        toLocationId: Number(template.to_location_id),
        toLocation: template.to_location,
        duplicateSalesLinesCombined: lineResult.rowCount - combinedLines.length,
        itemTotals: [...itemTotals.values()],
        calculatedPalletQuantity: pallet.calculatedQuantity,
        finalPalletQuantity,
        manualPalletOverridePreserved: hasManualPalletOverride,
        uncoveredQuantity: uncovered
      }
    });
    return {
      batch: await getTransferDependencyBatch(resolvedBatchId),
      mergedProposalId,
      sourceProposalIds: proposalIds,
      reused: false
    };
  });
}

export async function validateTransferDependencyBatchForCreation(batch, { proposalIds = null } = {}) {
  const selectedIds = proposalIds ? new Set(proposalIds.map(String)) : null;
  const pendingProposals = (batch.proposals || []).filter((proposal) =>
    !["created", "attention", "cancelled"].includes(proposal.creationStatus)
    && (!selectedIds || selectedIds.has(String(proposal.id))));
  if (!pendingProposals.length) return { uncovered: 0, pendingProposals: [] };
  const shortageRows = await salesOrderShortageRows(batch.salesOrderId);
  const shortageByLine = new Map(shortageRows.map((row) => [String(row.id), number(row.unresolved_quantity)]));
  const directRequestedByLine = new Map();
  const directRoundingAllowanceByLine = new Map();
  for (const proposal of pendingProposals) {
    if (String(proposal.fromLocationId) === String(proposal.toLocationId)) {
      throw new Error(`${proposal.fromLocation} cannot transfer to the same yard.`);
    }
    for (const line of proposal.lines || []) {
      if (proposal.mode !== "direct_to_customer" || line.lineSource === "manual") continue;
      const key = String(line.salesLineId);
      directRequestedByLine.set(key, number(directRequestedByLine.get(key)) + number(line.proposedQuantity));
      if (number(line.layerQty) > EPSILON && number(line.toLyr) > EPSILON) {
        directRoundingAllowanceByLine.set(
          key,
          number(directRoundingAllowanceByLine.get(key)) + (number(line.toLyr) / 2)
        );
      }
    }
    const pallet = calculateTransferProposalPallets(proposal.lines || []);
    if (!proposal.palletCalculationComplete && !proposal.palletQuantityOverridden) {
      throw new Error(`${proposal.fromLocation} has an item without PLT conversion. Enter the required PALLET quantity before creating the Transfer Order.`);
    }
    if (number(proposal.palletTransferQuantity) + EPSILON < pallet.explicitQuantity) {
      throw new Error(`${proposal.fromLocation} PALLET quantity cannot be below the explicit PALLET shortage of ${pallet.explicitQuantity}.`);
    }
    if (number(proposal.palletTransferQuantity) > EPSILON && !Number.isInteger(Number(proposal.palletItemId))) {
      throw new Error("The active NetSuite PALLET item has not been resolved. Refresh inventory and try again.");
    }
  }
  for (const [lineId, requested] of directRequestedByLine) {
    const shortage = number(shortageByLine.get(lineId));
    const roundingAllowance = number(directRoundingAllowanceByLine.get(lineId));
    if (requested > shortage + roundingAllowance + EPSILON) {
      throw new Error(`Direct-pickup quantity ${requested} exceeds the current Sales Order shortage ${shortage}. Use Replenish yard for intentional surplus transfer.`);
    }
  }

  const itemIds = [...new Set(pendingProposals.flatMap((proposal) => [
    ...(proposal.lines || []).map((line) => Number(line.itemId)),
    number(proposal.palletTransferQuantity) > EPSILON ? Number(proposal.palletItemId) : null
  ]).filter(Number.isInteger))];
  const locationIds = [...new Set(pendingProposals.map((proposal) => Number(proposal.fromLocationId)).filter(Number.isInteger))];
  const availability = itemIds.length && locationIds.length ? await query(
    `WITH linked_transfer AS (
       SELECT dl.item_id, d.source_location_id AS location_id, SUM(dl.allocated_quantity) AS linked_transfer_quantity
         FROM order_dependency_lines dl
         JOIN order_dependencies d ON d.id = dl.dependency_id
        WHERE d.status NOT IN ('cancelled', 'delivered')
          AND dl.item_id = ANY($1::bigint[])
          AND d.source_location_id = ANY($2::bigint[])
        GROUP BY dl.item_id, d.source_location_id
     ), proposal_reserved AS (
       SELECT pl.item_id, p.from_location_id AS location_id, SUM(pl.proposed_quantity) AS reserved_quantity
         FROM scm_transfer_dependency_proposal_lines pl
         JOIN scm_transfer_dependency_proposals p ON p.id = pl.proposal_id
        WHERE p.batch_id <> $3
          AND p.creation_status IN ('draft', 'creating')
          AND pl.item_id = ANY($1::bigint[])
          AND p.from_location_id = ANY($2::bigint[])
        GROUP BY pl.item_id, p.from_location_id
     )
     SELECT item.item_id, yard.location_id,
            COALESCE(balance.quantity_available, 0) AS quantity_available,
            COALESCE(proposal.reserved_quantity, 0) AS reserved_quantity,
            COALESCE(linked.linked_transfer_quantity, 0) AS linked_transfer_quantity,
            GREATEST(
              COALESCE(balance.quantity_available, 0)
              - COALESCE(proposal.reserved_quantity, 0), 0
            ) AS effective_available
       FROM unnest($1::bigint[]) item(item_id)
       CROSS JOIN unnest($2::bigint[]) yard(location_id)
       LEFT JOIN inventory_balances balance
         ON balance.item_id = item.item_id AND balance.location_id = yard.location_id
       LEFT JOIN linked_transfer linked
         ON linked.item_id = item.item_id AND linked.location_id = yard.location_id
       LEFT JOIN proposal_reserved proposal
         ON proposal.item_id = item.item_id AND proposal.location_id = yard.location_id`,
    [itemIds, locationIds, Number(batch.id)]
  ) : { rows: [] };
  const reservationOverrideKeys = transferDependencyReservationOverrideSet(batch.reservationOverrides);
  const availableBySource = new Map(availability.rows.map((row) => {
    const resolved = transferDependencyPlanningAvailability(row, reservationOverrideKeys);
    return [
      `${row.item_id}:${row.location_id}`,
      {
        available: number(resolved.planningAvailable),
        overridden: resolved.overridden,
        reservedQuantity: number(row.reserved_quantity),
        linkedTransferQuantity: number(row.linked_transfer_quantity),
        quantityAvailable: number(row.quantity_available)
      }
    ];
  }));
  const requestedBySource = new Map();
  for (const proposal of pendingProposals) {
    for (const line of proposal.lines || []) {
      if (isPalletItem(line)) continue;
      const key = `${line.itemId}:${proposal.fromLocationId}`;
      requestedBySource.set(key, number(requestedBySource.get(key)) + number(line.proposedQuantity));
    }
    const palletItemId = Number(proposal.palletItemId);
    if (Number.isInteger(palletItemId) && number(proposal.palletTransferQuantity) > EPSILON) {
      const key = `${palletItemId}:${proposal.fromLocationId}`;
      requestedBySource.set(key, number(requestedBySource.get(key)) + number(proposal.palletTransferQuantity));
    }
  }
  for (const [key, requested] of requestedBySource) {
    const sourceAvailability = availableBySource.get(key) || {};
    const available = number(sourceAvailability.available);
    if (requested > available + EPSILON) {
      const [itemId, locationId] = key.split(":");
      const yard = YARD_BY_ID.get(String(locationId));
      const item = pendingProposals.flatMap((proposal) => proposal.lines || []).find((line) => String(line.itemId) === itemId);
      const palletProposal = pendingProposals.find((proposal) => String(proposal.palletItemId) === itemId);
      const policy = sourceAvailability.overridden
        ? " after applying the selected full NetSuite Available override"
        : "";
      throw new Error(`${yard?.code || locationId} has ${available} available${policy} for ${item?.itemName || palletProposal?.palletItemName || itemId}, below the proposed ${requested}.`);
    }
  }
  const currentShortage = shortageRows.reduce((total, row) => total + number(row.unresolved_quantity), 0);
  const destinationCoverage = pendingProposals
    .filter((proposal) => String(proposal.toLocationId) === String(batch.outboundLocationId))
    .flatMap((proposal) => proposal.lines || [])
    .filter((line) => line.lineSource !== "manual")
    .reduce((total, line) => total + number(line.proposedQuantity), 0);
  return { uncovered: Math.max(0, currentShortage - destinationCoverage), pendingProposals };
}

async function transferLinesForOrder(transferOrderId) {
  const result = await query(
    `SELECT * FROM transfer_order_lines
      WHERE transfer_order_id = $1 AND COALESCE(netsuite_active, true) = true
      ORDER BY item_id, line_stage, id`,
    [Number(transferOrderId)]
  );
  return result.rows;
}

async function createDependencyFromProposal(proposal, batch, transferOrder, operatorId) {
  return withTransaction(async () => {
    const existing = await query(
      `SELECT id FROM order_dependencies WHERE proposal_id = $1 AND status <> 'cancelled' FOR UPDATE`,
      [proposal.id]
    );
    if (existing.rowCount) return existing.rows[0].id;
    const transferLines = await transferLinesForOrder(transferOrder.id);
    const inserted = await query(
      `INSERT INTO order_dependencies (
         sales_order_id, sales_order_ref, dispatch_target_ref, dispatch_target_kind,
         transfer_order_id, transfer_order_ref, proposal_id,
         dependency_mode, same_load_required, source_location_id, source_location,
         accounting_destination_location_id, accounting_destination_location,
         reconciliation_status, created_by, updated_by
       ) VALUES ($1, $2, $2, 'normal', $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', $12, $12)
       RETURNING id`,
      [batch.salesOrderId, batch.salesOrderRef, transferOrder.id, transferOrder.tranid, proposal.id,
        proposal.mode, proposal.mode === "direct_to_customer", proposal.fromLocationId, proposal.fromLocation,
        proposal.toLocationId, proposal.toLocation, operatorId]
    );
    const dependencyId = inserted.rows[0].id;
    let explicitPalletQuantity = 0;
    for (const line of proposal.lines) {
      if (isPalletItem(line)) explicitPalletQuantity += number(line.proposedQuantity);
      const manualTransfer = line.lineSource === "manual" || !line.salesLineId;
      const outbound = transferLines.find((candidate) => candidate.line_stage === "outbound" && String(candidate.item_id) === String(line.itemId));
      const receiving = transferLines.find((candidate) => candidate.line_stage === "receiving" && String(candidate.item_id) === String(line.itemId));
      await query(
        `INSERT INTO order_dependency_lines (
           dependency_id, sales_line_id, transfer_outbound_line_id, transfer_receiving_line_id,
           item_id, item_name, unit, allocated_quantity, pallet_qty, layer_qty,
           section_qty, piece_qty, line_role, dispatch_target_line_key
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [dependencyId, manualTransfer ? null : line.salesLineId, outbound?.id || null, receiving?.id || null,
          line.itemId, line.itemName, line.unit, line.proposedQuantity,
          line.palletQty, line.layerQty, line.sectionQty, line.pieceQty,
          manualTransfer ? "manual_transfer" : "sales_allocation",
          manualTransfer ? null : `${batch.salesOrderRef}::${batch.salesOrderRef}::${line.salesLineId}`]
      );
    }
    const ancillaryPalletQuantity = Math.max(0, number(proposal.palletTransferQuantity) - explicitPalletQuantity);
    if (ancillaryPalletQuantity > EPSILON) {
      const palletOutbound = transferLines.find((candidate) => candidate.line_stage === "outbound"
        && String(candidate.item_id) === String(proposal.palletItemId));
      const palletReceiving = transferLines.find((candidate) => candidate.line_stage === "receiving"
        && String(candidate.item_id) === String(proposal.palletItemId));
      await query(
        `INSERT INTO order_dependency_lines (
           dependency_id, sales_line_id, transfer_outbound_line_id, transfer_receiving_line_id,
           item_id, item_name, unit, allocated_quantity, pallet_qty, layer_qty,
           section_qty, piece_qty, line_role
         ) VALUES ($1, null, $2, $3, $4, $5, 'EACH', $6, 0, 0, 0, $6, 'pallet')`,
        [dependencyId, palletOutbound?.id || null, palletReceiving?.id || null,
          proposal.palletItemId, proposal.palletItemName || "PALLET", ancillaryPalletQuantity]
      );
    }
    return dependencyId;
  });
}

export async function confirmTransferDependencyBatch(batchId, {
  operatorId = null,
  proposalId = null,
  createTransferOrder,
  hydrateTransferOrder,
  findTransferOrder = null
} = {}) {
  if (typeof createTransferOrder !== "function" || typeof hydrateTransferOrder !== "function") {
    throw new Error("NetSuite transfer-order transport is unavailable.");
  }
  const batch = await getTransferDependencyBatch(batchId);
  if (!batch) throw new Error("Dependency batch not found.");
  const salesOrder = await query(
    `SELECT COALESCE(is_test_fixture, false) AS is_test_fixture
       FROM sales_orders
      WHERE netsuite_id = $1`,
    [Number(batch.salesOrderId)]
  );
  if (salesOrder.rows[0]?.is_test_fixture && !isNetSuiteSandboxEnvironment()) {
    throw new Error("Test dependency fixtures can create Transfer Orders only while the active NetSuite account is sandbox.");
  }
  const candidate = (await listTransferDependencyCandidates({
    salesOrderId: batch.salesOrderId,
    reviewStatus: "all"
  }))[0];
  if (candidate?.reviewed) {
    throw new Error("This Sales Order is marked Reviewed - No Transfer. Undo the review before creating Transfer Orders.");
  }
  const requestedProposal = proposalId === null || proposalId === undefined
    ? null
    : batch.proposals.find((proposal) => String(proposal.id) === String(proposalId));
  if (proposalId !== null && proposalId !== undefined && !requestedProposal) {
    throw new Error("Transfer proposal not found in this dependency batch.");
  }
  if (requestedProposal && ["created", "attention"].includes(requestedProposal.creationStatus) && requestedProposal.transferOrderId) {
    return {
      batch,
      results: [{ proposalId: requestedProposal.id, status: requestedProposal.creationStatus,
        transferOrderId: requestedProposal.transferOrderId, transferOrderRef: requestedProposal.transferOrderRef, reused: true }]
    };
  }
  const validation = await validateTransferDependencyBatchForCreation(batch, {
    proposalIds: requestedProposal ? [requestedProposal.id] : null
  });
  if (!requestedProposal && validation.uncovered > EPSILON && !batch.allowIncompleteCoverage) {
    throw new Error("The shortage is not fully covered. Enable incomplete coverage before creating Transfer Orders.");
  }
  if (!requestedProposal) {
    await query(
      `UPDATE scm_transfer_dependency_batches SET status = 'creating', updated_by = $2, updated_at = now() WHERE id = $1`,
      [Number(batchId), operatorId]
    );
  }
  const results = [];
  for (const proposal of validation.pendingProposals) {
    let createdTransferOrderId = null;
    try {
      let created = null;
      if (["creating", "failed"].includes(proposal.creationStatus) && typeof findTransferOrder === "function") {
        created = await findTransferOrder({ proposal, batch });
      }
      if (!created && proposal.creationStatus === "creating") {
        const startedAt = new Date(proposal.creationStartedAt || 0).getTime();
        const attemptAgeMs = Number.isFinite(startedAt) ? Date.now() - startedAt : 0;
        if (attemptAgeMs < 3 * 60 * 1000) {
          const error = new Error("This Transfer Order creation is still in progress. Wait a moment, then use Recover Transfer Order.");
          error.status = 409;
          throw error;
        }
      }
      if (!created) {
        const attemptId = crypto.randomUUID();
        const claimableStatuses = proposal.creationStatus === "creating" ? ["creating"] : ["draft", "failed"];
        const claimed = await query(
          `UPDATE scm_transfer_dependency_proposals
              SET creation_status = 'creating', creation_error = null,
                  creation_attempt_id = $2, creation_started_at = now(), updated_at = now()
            WHERE id = $1
              AND creation_status = ANY($3::text[])
            RETURNING id`,
          [proposal.id, attemptId, claimableStatuses]
        );
        if (!claimed.rowCount) {
          const error = new Error("This Transfer Order proposal was changed by another request. Refresh before retrying.");
          error.status = 409;
          throw error;
        }
        created = await createTransferOrder({ proposal, batch, attemptId });
      }
      const transferOrderId = Number(created?.id);
      if (!Number.isInteger(transferOrderId) || transferOrderId <= 0) throw new Error("NetSuite did not return the created Transfer Order ID.");
      createdTransferOrderId = transferOrderId;
      const transferOrder = await hydrateTransferOrder(transferOrderId, proposal);
      if (!transferOrder?.id || !transferOrder?.tranid) throw new Error("The created Transfer Order could not be synchronized.");
      const pendingFulfillment = transferOrder.pendingFulfillment === true;
      const creationStatus = pendingFulfillment ? "created" : "attention";
      const statusMessage = pendingFulfillment
        ? null
        : `${transferOrder.tranid} was created, but NetSuite status is ${transferOrder.statusText || transferOrder.status || "unknown"} instead of Pending Fulfillment.`;
      await query(
        `UPDATE scm_transfer_dependency_proposals
            SET creation_status = $4, netsuite_transfer_order_id = $2,
                netsuite_transfer_order_ref = $3, creation_error = $5, updated_at = now()
          WHERE id = $1`,
        [proposal.id, transferOrder.id, transferOrder.tranid, creationStatus, statusMessage]
      );
      const dependencyId = await createDependencyFromProposal(proposal, batch, transferOrder, operatorId);
      if (!pendingFulfillment) {
        await query(
          `UPDATE order_dependencies
              SET status = 'attention', attention_reason = $2, updated_by = $3, updated_at = now()
            WHERE id = $1`,
          [dependencyId, statusMessage, operatorId]
        );
      }
      results.push({ proposalId: proposal.id, status: creationStatus, transferOrderId: transferOrder.id,
        transferOrderRef: transferOrder.tranid, netsuiteStatus: transferOrder.statusText || transferOrder.status,
        recovered: created?.recovered === true, error: statusMessage });
    } catch (error) {
      if (error.status === 409) throw error;
      await query(
        `UPDATE scm_transfer_dependency_proposals
            SET creation_status = $3, creation_error = $2,
                netsuite_transfer_order_id = COALESCE(netsuite_transfer_order_id, $4), updated_at = now()
          WHERE id = $1`,
        [proposal.id, error.message, createdTransferOrderId ? "attention" : "failed", createdTransferOrderId]
      );
      results.push({ proposalId: proposal.id, status: createdTransferOrderId ? "attention" : "failed",
        transferOrderId: createdTransferOrderId, error: error.message });
    }
  }
  const failed = results.filter((result) => result.status === "failed").length;
  const created = results.filter((result) => result.status === "created").length;
  const attention = results.filter((result) => result.status === "attention").length;
  const refreshed = await getTransferDependencyBatch(batchId);
  const proposalStatuses = (refreshed?.proposals || []).map((proposal) => proposal.creationStatus);
  const totalCreated = proposalStatuses.filter((status) => status === "created").length;
  const hasPending = proposalStatuses.some((status) => ["draft", "suggested", "creating"].includes(status));
  const hasFailed = proposalStatuses.includes("failed");
  const hasAttention = proposalStatuses.includes("attention");
  const status = hasAttention
    ? "attention"
    : hasPending
      ? (totalCreated ? "partially_created" : (hasFailed ? "attention" : "suggested"))
      : hasFailed
        ? (totalCreated ? "partially_created" : "attention")
        : "created";
  await query(
    `UPDATE scm_transfer_dependency_batches
        SET status = $2, confirmed_at = CASE WHEN $2 IN ('created', 'partially_created') THEN now() ELSE confirmed_at END,
            updated_by = $3, updated_at = now()
      WHERE id = $1`,
    [Number(batchId), status, operatorId]
  );
  await writeDispatchAudit({
    action: "scm.transfer_dependency.created",
    source: "scm",
    entityType: "dependency_batch",
    entityId: String(batchId),
    orderId: batch.salesOrderRef,
    operatorId,
    details: {
      status,
      created,
      failed,
      attention,
      results,
      reservationOverrideCount: (batch.reservationOverrides || []).length,
      reservationOverrides: (batch.reservationOverrides || []).map((entry) => ({
        itemId: entry.itemId,
        itemName: entry.itemName,
        locationId: entry.locationId,
        location: entry.location,
        quantityAvailable: entry.quantityAvailable,
        reservedQuantity: entry.reservedQuantity,
        policy: entry.policy
      }))
    }
  });
  return { batch: await getTransferDependencyBatch(batchId), results };
}

export async function retryTransferDependencyBatch(batchId, options = {}) {
  return confirmTransferDependencyBatch(batchId, options);
}

export async function createOrderDependency({
  dispatchTargetRef,
  salesOrderRef,
  transferOrderRef,
  planDate = "",
  targetSignature = "",
  mode = "direct_to_customer",
  allocations = [],
  operatorId = null
} = {}) {
  const normalizedMode = normalizeMode(mode);
  return withTransaction(async () => {
    const targetRef = text(dispatchTargetRef || salesOrderRef);
    const resolved = await resolveDispatchSalesTarget({ dispatchTargetRef: targetRef, planDate });
    const transfer = await query("SELECT * FROM transfer_orders WHERE tranid = $1", [text(transferOrderRef)]);
    if (targetSignature && targetSignature !== resolved.signature) {
      const error = new Error(`${targetRef} changed while the link window was open. Refresh the matched lines before linking.`);
      error.status = 409;
      error.code = "DISPATCH_TARGET_CHANGED";
      throw error;
    }
    if (!transfer.rowCount) throw new Error("Transfer Order not found.");
    const terminalStatus = terminalTransferOrderStatus(transfer.rows[0]);
    if (transfer.rows[0].netsuite_active === false || terminalStatus) {
      throw new Error(`${transferOrderRef} is ${terminalStatus || "inactive"} and cannot be linked.`);
    }
    if (String(transfer.rows[0].from_location_id || "") === String(transfer.rows[0].to_location_id || "")) {
      throw new Error(`${transferOrderRef} has the same source and destination yard.`);
    }
    const active = await query(
      `SELECT COALESCE(dispatch_target_ref, sales_order_ref) AS dispatch_target_ref
         FROM order_dependencies
        WHERE transfer_order_id = $1 AND status <> 'cancelled'
        FOR UPDATE`,
      [transfer.rows[0].netsuite_id]
    );
    if (active.rowCount) throw new Error(`${transferOrderRef} is already linked to ${active.rows[0].dispatch_target_ref}.`);
    if (normalizedMode === "direct_to_customer" && transfer.rows[0].dispatch_planned) {
      throw new Error(`${transferOrderRef} is already planned. Unplan it before linking as a direct pickup.`);
    }
    if (normalizedMode === "direct_to_customer"
      && ["packed", "loaded", "fulfilled", "shipped"].includes(String(transfer.rows[0].outbound_operator_status || transfer.rows[0].fulfillment_status || "").toLowerCase())) {
      throw new Error(`${transferOrderRef} has already started and cannot be linked.`);
    }
    const transferLines = await transferLinesForOrder(transfer.rows[0].netsuite_id);
    const outboundLines = transferLines.filter((line) => line.line_stage === "outbound");
    const receivingLines = transferLines.filter((line) => line.line_stage === "receiving");
    const requested = allocations.length ? allocations : [];
    if (!requested.length) throw new Error("Select at least one matched Transfer Order line quantity.");
    const targetLinesByKey = new Map(resolved.lines.map((line) => [line.targetLineKey, line]));
    const outboundByItem = new Map();
    for (const line of outboundLines) {
      const key = String(line.item_id);
      const entry = outboundByItem.get(key) || { quantity: 0, first: line };
      entry.quantity += number(line.quantity);
      outboundByItem.set(key, entry);
    }
    const normalized = [];
    const requestedByItem = new Map();
    for (const allocation of requested) {
      const requestedSalesLineId = Number(allocation.salesLineId);
      const targetLine = targetLinesByKey.get(text(allocation.targetLineKey))
        || resolved.lines.find((line) => Number(line.salesLineId) === requestedSalesLineId);
      const itemId = Number(targetLine?.itemId || allocation.itemId);
      const outboundEntry = outboundByItem.get(String(itemId));
      const outbound = outboundEntry?.first;
      const receiving = receivingLines.find((line) => Number(line.item_id) === itemId);
      if (!targetLine || !outbound) throw new Error(`Item ${itemId} is not available on both ${targetRef} and ${transferOrderRef}.`);
      const availableShortage = Math.max(0, number(targetLine.shortageQuantity) - number(targetLine.dependencyAllocatedQuantity));
      const requestedQuantity = allocationSalesQuantity(allocation, targetLine);
      const qty = requestedQuantity.quantity;
      if (qty <= EPSILON) throw new Error(`Enter a valid allocation for ${targetLine.itemName || itemId}.`);
      if (qty > availableShortage + EPSILON) {
        throw new Error(`${targetLine.itemName || itemId} allocation ${qty} exceeds ${targetRef} remaining quantity ${availableShortage}.`);
      }
      requestedByItem.set(String(itemId), number(requestedByItem.get(String(itemId))) + qty);
      normalized.push({
        targetLine,
        outbound,
        receiving,
        qty,
        display: requestedQuantity.display
      });
    }
    for (const [itemId, requestedQuantity] of requestedByItem) {
      const available = number(outboundByItem.get(itemId)?.quantity);
      if (requestedQuantity > available + EPSILON) {
        const itemName = normalized.find((entry) => String(entry.targetLine.itemId) === itemId)?.targetLine.itemName || itemId;
        throw new Error(`${itemName} allocation ${requestedQuantity} exceeds ${transferOrderRef} quantity ${available}.`);
      }
    }
    const anchor = normalized[0].targetLine;
    const inserted = await query(
      `INSERT INTO order_dependencies (
         sales_order_id, sales_order_ref, dispatch_target_ref, dispatch_target_kind,
         transfer_order_id, transfer_order_ref,
         dependency_mode, same_load_required, source_location_id, source_location,
         accounting_destination_location_id, accounting_destination_location,
         created_by, updated_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)
       RETURNING id`,
      [anchor.sourceOrderId, anchor.sourceOrderRef, resolved.target.ref, resolved.target.kind,
        transfer.rows[0].netsuite_id, transfer.rows[0].tranid,
        normalizedMode, normalizedMode === "direct_to_customer", transfer.rows[0].from_location_id,
        transfer.rows[0].from_location, transfer.rows[0].to_location_id, transfer.rows[0].to_location, operatorId]
    );
    for (const entry of normalized) {
      await query(
        `INSERT INTO order_dependency_lines (
           dependency_id, sales_line_id, transfer_outbound_line_id, transfer_receiving_line_id,
           item_id, item_name, unit, allocated_quantity, pallet_qty, layer_qty, section_qty, piece_qty,
           line_role, dispatch_target_line_key
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'sales_allocation', $13)`,
        [inserted.rows[0].id, entry.targetLine.salesLineId, entry.outbound.id, entry.receiving?.id || null,
          entry.targetLine.itemId, entry.targetLine.itemName, entry.targetLine.unit, entry.qty,
          entry.display.palletQty, entry.display.layerQty, entry.display.sectionQty, entry.display.pieceQty,
          entry.targetLine.targetLineKey]
      );
    }
    await writeDispatchAudit({
      action: "dispatch.order_dependency.linked",
      entityType: "order_dependency",
      entityId: String(inserted.rows[0].id),
      orderId: resolved.target.ref,
      planId: resolved.target.planId || null,
      planDate: resolved.target.planDate || planDate || null,
      operatorId,
      details: {
        transferOrderRef: transfer.rows[0].tranid,
        mode: normalizedMode,
        lineCount: normalized.length,
        dispatchTargetKind: resolved.target.kind,
        memberRefs: resolved.target.memberRefs
      }
    });
    return (await loadDependencies({ salesOrderRef: resolved.target.ref })).find((row) => String(row.id) === String(inserted.rows[0].id));
  });
}

async function loadDependencyMutationContext(
  dependencyId,
  requestedPlanDate,
  { allowHistoricalGroupTarget = false } = {}
) {
  const result = await query(
    `SELECT id, status, dispatch_target_ref, dispatch_target_kind,
            planned_plan_id, planned_date::text AS planned_date
       FROM order_dependencies
      WHERE id = $1
      FOR UPDATE`,
    [Number(dependencyId)]
  );
  if (!result.rowCount) {
    const error = new Error("Order dependency was not found.");
    error.status = 404;
    throw error;
  }
  const dependency = result.rows[0];
  if (
    dependency.status === "cancelled"
    || dependency.dispatch_target_kind !== "group"
    || !["active", "attention"].includes(dependency.status)
  ) {
    return dependency;
  }
  const requestedDate = dispatchPlanDateKey(requestedPlanDate);
  if (!requestedDate) {
    const error = new Error("Load the owning dispatch plan before changing this grouped dependency.");
    error.status = 409;
    error.code = "ORDER_DEPENDENCY_PLAN_MISMATCH";
    throw error;
  }
  const currentTarget = await query(
    `SELECT plan_id, plan_date
       FROM (
         SELECT plan.id AS plan_id, plan.plan_date::text AS plan_date, 1 AS priority
           FROM dispatch_plans plan
           JOIN dispatch_plan_snapshots snapshot ON snapshot.plan_id = plan.id
          WHERE plan.status <> 'cancelled'
            AND plan.plan_date = $2::date
            AND EXISTS (
              SELECT 1
                FROM jsonb_array_elements(COALESCE(snapshot.orders, '[]'::jsonb)) candidate
               WHERE candidate ->> 'id' = $1
            )
         UNION ALL
         SELECT projected.plan_id, projected.plan_date::text, 2 AS priority
           FROM dispatch_delivery_groups projected
          WHERE projected.group_ref = $1
            AND projected.active = true
            AND projected.plan_date = $2::date
       ) owned
      ORDER BY priority
      LIMIT 1`,
    [dependency.dispatch_target_ref, requestedDate]
  );
  if (currentTarget.rowCount) return dependency;

  let ownerDate = "";
  if (allowHistoricalGroupTarget) {
    const currentProjection = await query(
      `SELECT plan_date::text AS plan_date
         FROM dispatch_delivery_groups
        WHERE group_ref = $1 AND active = true
        LIMIT 1`,
      [dependency.dispatch_target_ref]
    );
    ownerDate = dispatchPlanDateKey(currentProjection.rows[0]?.plan_date);
    if (!ownerDate) ownerDate = dispatchPlanDateKey(dependency.planned_date);
    if (!ownerDate) {
      const auditOwner = await query(
        `SELECT plan_date::text AS plan_date
           FROM dispatch_audit_log
          WHERE entity_type = 'order_dependency'
            AND entity_id = $1
            AND order_id = $2
            AND action IN (
              'dispatch.order_dependency.group_target_moved',
              'dispatch.order_dependency.linked'
            )
            AND plan_date IS NOT NULL
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
        [String(dependency.id), dependency.dispatch_target_ref]
      );
      ownerDate = dispatchPlanDateKey(auditOwner.rows[0]?.plan_date);
    }
    if (ownerDate === requestedDate) return dependency;
  }
  const ownerHint = ownerDate
    ? ` It belongs to the ${ownerDate} plan.`
    : "";
  const error = new Error(
    allowHistoricalGroupTarget
      ? `This grouped dependency cannot be changed from the selected dispatch plan.${ownerHint} Load its owning plan and try again.`
      : "This grouped order is no longer available in the selected dispatch plan. Its dependency mode cannot be changed."
  );
  error.status = 409;
  error.code = allowHistoricalGroupTarget
    ? "ORDER_DEPENDENCY_PLAN_MISMATCH"
    : "ORDER_DEPENDENCY_TARGET_UNAVAILABLE";
  throw error;
}

export async function updateOrderDependencyMode(
  dependencyId,
  mode,
  operatorId = null,
  planDate = ""
) {
  return withTransaction(async () => {
    await loadDependencyMutationContext(dependencyId, planDate);
    const normalizedMode = normalizeMode(mode);
    const result = await query(
      `UPDATE order_dependencies
          SET dependency_mode = $2, same_load_required = ($2 = 'direct_to_customer'),
              updated_by = $3, updated_at = now()
        WHERE id = $1
          AND status IN ('active', 'attention')
          AND NOT EXISTS (
            SELECT 1 FROM order_dependency_lines l
             WHERE l.dependency_id = order_dependencies.id
               AND (l.loaded_quantity > 0 OR l.delivered_quantity > 0 OR l.locally_received_quantity > 0)
          )
        RETURNING *`,
      [Number(dependencyId), normalizedMode, operatorId]
    );
    if (!result.rowCount) throw new Error("This dependency has already started and its mode cannot be changed.");
    return (await loadDependencies({ salesOrderRef: result.rows[0].dispatch_target_ref || result.rows[0].sales_order_ref })).find((row) => String(row.id) === String(dependencyId));
  });
}

export async function cancelOrderDependency(
  dependencyId,
  operatorId = null,
  planDate = ""
) {
  return withTransaction(async () => {
    const context = await loadDependencyMutationContext(
      dependencyId,
      planDate,
      { allowHistoricalGroupTarget: true }
    );
    if (context.status === "cancelled") {
      return { cancelled: true, id: Number(dependencyId), alreadyCancelled: true };
    }
    const result = await query(
      `UPDATE order_dependencies
          SET status = 'cancelled', updated_by = $2, updated_at = now()
        WHERE id = $1
          AND status IN ('active', 'attention')
          AND NOT EXISTS (
            SELECT 1 FROM order_dependency_lines l
             WHERE l.dependency_id = order_dependencies.id
               AND (l.loaded_quantity > 0 OR l.delivered_quantity > 0 OR l.locally_received_quantity > 0)
          )
        RETURNING *`,
      [Number(dependencyId), operatorId]
    );
    if (!result.rowCount) {
      const existing = await query(
        `SELECT id, status,
                EXISTS (
                  SELECT 1
                    FROM order_dependency_lines line
                   WHERE line.dependency_id = dependency.id
                     AND (
                       COALESCE(line.loaded_quantity, 0) > $2
                       OR COALESCE(line.delivered_quantity, 0) > $2
                       OR COALESCE(line.locally_received_quantity, 0) > $2
                     )
                ) AS has_execution_progress
           FROM order_dependencies dependency
          WHERE id = $1`,
        [Number(dependencyId), EPSILON]
      );
      if (existing.rows[0].status === "cancelled") {
        return { cancelled: true, id: Number(dependencyId), alreadyCancelled: true };
      }
      const error = new Error("This dependency has already started and cannot be unlinked.");
      error.status = 409;
      throw error;
    }
    await writeDispatchAudit({
      action: "dispatch.order_dependency.unlinked",
      entityType: "order_dependency",
      entityId: String(dependencyId),
      orderId: result.rows[0].dispatch_target_ref || result.rows[0].sales_order_ref,
      operatorId,
      details: { transferOrderRef: result.rows[0].transfer_order_ref }
    });
    return { cancelled: true, id: Number(dependencyId) };
  });
}

export async function enrichDispatchOrdersWithDependencies(orders = []) {
  const dependencies = await loadDependencies();
  const shortageRows = await salesOrderShortageRows().catch(() => []);
  const uncoveredBySales = new Map();
  for (const row of shortageRows) {
    if (number(row.unresolved_quantity) <= EPSILON) continue;
    uncoveredBySales.set(row.sales_order_ref, number(uncoveredBySales.get(row.sales_order_ref)) + number(row.unresolved_quantity));
  }
  const bySales = new Map();
  const byTransfer = new Map();
  for (const dependency of dependencies) {
    if (!bySales.has(dependency.salesOrderRef)) bySales.set(dependency.salesOrderRef, []);
    bySales.get(dependency.salesOrderRef).push(dependency);
    byTransfer.set(dependency.transferOrderRef, dependency);
  }
  return orders.map((order) => {
    const ref = text(order.id || order.tranid);
    const salesRefs = [...new Set([
      ref,
      ...(Array.isArray(order.childOrders) ? order.childOrders : []),
      ...(Array.isArray(order.childOrderDetails)
        ? order.childOrderDetails.flatMap((child) => [child?.id, child?.originalOrderId])
        : [])
    ].map(text).filter(Boolean))];
    const salesDependencies = [...new Map(
      salesRefs.flatMap((salesRef) => bySales.get(salesRef) || [])
        .map((dependency) => [String(dependency.id), dependency])
    ).values()];
    const uncoveredQuantity = salesRefs.reduce((total, salesRef) => total + number(uncoveredBySales.get(salesRef)), 0);
    const transferDependency = byTransfer.get(ref);
    if (salesDependencies.length || uncoveredQuantity > EPSILON) {
      const direct = salesDependencies.filter((dependency) => dependency.mode === "direct_to_customer" && dependency.status !== "cancelled");
      const replenishment = salesDependencies.filter((dependency) => dependency.mode === "yard_replenishment" && dependency.status !== "cancelled");
      const directPickupManifest = direct.map((dependency) => ({
        dependencyId: dependency.id,
        salesOrderRef: dependency.salesOrderRef,
        transferOrderRef: dependency.transferOrderRef,
        locationId: dependency.sourceLocationId,
        location: dependency.sourceLocation,
        items: aggregateDependencyManifestItems(dependency.lines)
      }));
      return {
        ...order,
        pickupLocations: [...new Set([
          ...(Array.isArray(order.pickupLocations) ? order.pickupLocations : [order.sourceYard].filter(Boolean)),
          ...directPickupManifest.map((entry) => entry.location).filter(Boolean)
        ])],
        orderDependencies: salesDependencies,
        dependencyDirectPickup: direct.length > 0,
        dependencyWaitingForTransfer: replenishment.some((dependency) => !["received_local", "delivered"].includes(dependency.status)),
        dependencyAttention: salesDependencies.some((dependency) => dependency.status === "attention"),
        dependencyUncovered: uncoveredQuantity > EPSILON,
        dependencyUncoveredQuantity: uncoveredQuantity,
        directPickupManifest,
        dependencyLabels: [...new Set([
          ...salesDependencies.map((dependency) => `Requires ${dependency.transferOrderRef}`),
          ...(direct.length ? ["Direct pickup"] : []),
          ...(replenishment.length ? ["Waiting for transfer"] : []),
          ...(uncoveredQuantity > EPSILON ? [`Uncovered shortage ${uncoveredQuantity}`] : []),
          ...(salesDependencies.some((dependency) => dependency.reconciliationStatus === "required") ? ["NetSuite reconciliation required"] : [])
        ])]
      };
    }
    if (transferDependency) {
      const directLink = transferDependency.mode === "direct_to_customer";
      return {
        ...order,
        orderDependency: transferDependency,
        dependencyHidden: directLink,
        dependencyDirectPickup: directLink,
        dependentSalesOrderRef: transferDependency.salesOrderRef,
        dependencyLabels: directLink
          ? [`Link with ${transferDependency.salesOrderRef}`]
          : [`Required by ${transferDependency.salesOrderRef}`, "Replenishment"]
      };
    }
    return order;
  });
}

function dispatchOrderRefs(order = {}) {
  return [...new Set([
    order.id,
    order.tranid,
    ...(Array.isArray(order.childOrders) ? order.childOrders : []),
    ...(Array.isArray(order.childOrderDetails)
      ? order.childOrderDetails.flatMap((child) => [child?.id, child?.originalOrderId])
      : [])
  ].map(text).filter(Boolean))];
}

export function normalDispatchGroupTargets(plan = {}) {
  const targets = new Map();
  const ambiguousRefs = new Set();
  for (const order of plan.orders || []) {
    const groupRef = text(order?.id);
    const childDetails = Array.isArray(order?.childOrderDetails) ? order.childOrderDetails : [];
    const splitParentRefs = new Set(childDetails.map((child) => text(child?.originalOrderId)).filter(Boolean));
    const detailByRef = new Map(childDetails.map((child) => [text(child?.id), child]).filter(([ref]) => ref));
    const childRefs = [...new Set([
      ...(Array.isArray(order?.childOrders) ? order.childOrders : []),
      ...childDetails.map((child) => child?.id)
    ].map(text).filter(Boolean))];
    if (!groupRef || !childRefs.length) continue;
    for (const childRef of childRefs) {
      const detail = detailByRef.get(childRef);
      const isSplitChild = Boolean(text(detail?.originalOrderId))
        || splitParentRefs.has(childRef)
        || /-S\d+$/i.test(childRef);
      const isNestedGroup = Boolean(
        (Array.isArray(detail?.childOrders) && detail.childOrders.length)
        || (Array.isArray(detail?.childOrderDetails) && detail.childOrderDetails.length)
      );
      if (isSplitChild || isNestedGroup || childRef === groupRef) continue;
      const existing = targets.get(childRef);
      if (existing && existing !== groupRef) {
        ambiguousRefs.add(childRef);
        continue;
      }
      targets.set(childRef, groupRef);
    }
  }
  for (const ref of ambiguousRefs) targets.delete(ref);
  return targets;
}

function physicalTruckLoadSequence(plan = {}) {
  const sequences = new Map();
  const nextSequenceByTruck = new Map();
  for (const [truckIndex, truck] of (plan.trucks || []).entries()) {
    for (const [loadIndex, load] of (truck.loads || []).entries()) {
      const assignment = dispatchLoadAssignment(truck, load, { driverSequence: loadIndex });
      const truckPlate = text(assignment.truckPlate).replace(/\s+/g, "").toUpperCase() || `parent:${truckIndex}`;
      const sequence = nextSequenceByTruck.get(truckPlate) || 0;
      sequences.set(`${truckIndex}:${loadIndex}`, sequence);
      nextSequenceByTruck.set(truckPlate, sequence + 1);
    }
  }
  return sequences;
}

function loadSequenceIndex(plan = {}) {
  const index = new Map();
  const truckLoadSequence = physicalTruckLoadSequence(plan);
  const orderByRef = new Map();
  for (const order of plan.orders || []) {
    for (const ref of dispatchOrderRefs(order)) orderByRef.set(ref, order);
  }
  let sequence = 0;
  for (const [truckIndex, truck] of (plan.trucks || []).entries()) {
    for (const [loadIndex, load] of (truck.loads || []).entries()) {
      const loadAssignment = dispatchLoadAssignment(truck, load, { driverSequence: loadIndex });
      const sequencedStops = [];
      for (const stop of load.stops || []) {
        sequence += 1;
        if (!stop?.orderId) continue;
        sequencedStops.push({
          stop,
          sequence,
          arrival: dependencyTimingNumber(stop.timing?.arrival ?? stop.arrival ?? stop.arrive),
          departure: dependencyTimingNumber(stop.timing?.depart ?? stop.end ?? stop.departure ?? stop.leave)
        });
        if (stop.type !== "drop") continue;
        const order = orderByRef.get(String(stop.orderId)) || { id: stop.orderId };
        const pickupLocations = [...new Set((Array.isArray(order.pickupLocations) && order.pickupLocations.length
          ? order.pickupLocations
          : [order.sourceYard || order.outboundLocation].filter(Boolean)).map(text).filter(Boolean))];
        const pickupSequences = sequencedStops
          .filter((entry) => entry.stop.type === "pick"
            && pickupLocations.some((location) => location.toLowerCase() === text(entry.stop.location).toLowerCase()))
          .map((entry) => entry.sequence);
        const pickupArrivals = sequencedStops
          .filter((entry) => entry.stop.type === "pick"
            && pickupLocations.some((location) => location.toLowerCase() === text(entry.stop.location).toLowerCase()))
          .map((entry) => entry.arrival)
          .filter(Number.isFinite);
        const assignment = {
          sequence,
          firstPickupSequence: pickupSequences.length ? Math.min(...pickupSequences) : sequence,
          firstPickupArrival: pickupArrivals.length ? Math.min(...pickupArrivals) : null,
          planDate: plan.planDate,
          driverLogin: loadAssignment.driverLogin,
          driverSequence: loadAssignment.driverSequence,
          truckPlate: loadAssignment.truckPlate,
          truckIndex,
          loadIndex: truckLoadSequence.get(`${truckIndex}:${loadIndex}`) ?? loadIndex,
          loadId: load.id,
          loadName: load.name,
          stopType: stop.type,
          loadStart: dependencyTimingNumber(loadAssignment.plannedStartMinute ?? load.timing?.start),
          loadFinish: dependencyTimingNumber(loadAssignment.plannedFinishMinute ?? load.timing?.finish),
          arrival: dependencyTimingNumber(stop.timing?.arrival ?? stop.arrival ?? stop.arrive),
          departure: dependencyTimingNumber(stop.timing?.depart ?? stop.end ?? stop.departure ?? stop.leave)
        };
        for (const ref of dispatchOrderRefs(order)) index.set(ref, assignment);
      }
    }
  }
  return index;
}

function dependencyTimingNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dispatchPlanDateKey(value) {
  if (!value) return "";
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const raw = String(value).trim();
  const iso = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime())
    ? ""
    : parsed.toISOString().slice(0, 10);
}

function directDependencyRemainsOnPlannedAssignment(
  dependency = {},
  plan = {},
  salesAssignment = {}
) {
  const plannedPlanId = Number(dependency.plannedPlanId);
  const candidatePlanId = Number(plan.id);
  if (
    !Number.isSafeInteger(plannedPlanId)
    || plannedPlanId <= 0
    || !Number.isSafeInteger(candidatePlanId)
    || candidatePlanId !== plannedPlanId
  ) {
    return false;
  }
  const plannedDate = dispatchPlanDateKey(dependency.plannedDate);
  const candidateDate = dispatchPlanDateKey(plan.planDate);
  if (!plannedDate || !candidateDate || plannedDate !== candidateDate) {
    return false;
  }
  if (
    !text(dependency.plannedLoadId)
    || text(dependency.plannedLoadId) !== text(salesAssignment.loadId)
  ) {
    return false;
  }
  const plannedTruck = text(dependency.plannedTruckPlate)
    .replace(/\s+/g, "")
    .toUpperCase();
  const candidateTruck = text(salesAssignment.truckPlate)
    .replace(/\s+/g, "")
    .toUpperCase();
  return !plannedTruck || plannedTruck === candidateTruck;
}

function replenishmentTransferPrecedesSales(transferAssignment, salesAssignment) {
  if (!transferAssignment || !salesAssignment) return false;
  if (String(transferAssignment.loadId || "") === String(salesAssignment.loadId || "")) {
    return transferAssignment.sequence < salesAssignment.firstPickupSequence;
  }
  const transferFinish = dependencyTimingNumber(transferAssignment.loadFinish ?? transferAssignment.departure);
  const salesPickup = dependencyTimingNumber(salesAssignment.firstPickupArrival);
  const hasComparableTiming = Number.isFinite(transferFinish) && Number.isFinite(salesPickup);
  if (hasComparableTiming) return transferFinish <= salesPickup;
  const sameDriver = transferAssignment.driverLogin
    && String(transferAssignment.driverLogin) === String(salesAssignment.driverLogin);
  if (sameDriver) {
    const transferDriverSequence = dependencyTimingNumber(transferAssignment.driverSequence);
    const salesDriverSequence = dependencyTimingNumber(salesAssignment.driverSequence);
    if (
      Number.isFinite(transferDriverSequence)
      && Number.isFinite(salesDriverSequence)
      && transferDriverSequence !== salesDriverSequence
    ) {
      return transferDriverSequence < salesDriverSequence;
    }
  }
  const sameTruck = String(transferAssignment.truckPlate || "") === String(salesAssignment.truckPlate || "");
  return sameTruck && Number(transferAssignment.loadIndex) < Number(salesAssignment.loadIndex);
}

async function priorPlannedTransferRefs(transferRefs = [], plan = {}) {
  const refs = [...new Set((transferRefs || []).map(text).filter(Boolean))];
  const planDate = String(plan.planDate || "").slice(0, 10);
  if (!refs.length || !planDate) return new Set();
  const result = await query(
    `SELECT DISTINCT stop ->> 'orderId' AS order_ref
       FROM dispatch_plans p
       JOIN dispatch_plan_snapshots snapshot ON snapshot.plan_id = p.id
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(snapshot.trucks, '[]'::jsonb)) truck
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(truck -> 'loads', '[]'::jsonb)) load
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(load -> 'stops', '[]'::jsonb)) stop
      WHERE p.status <> 'cancelled'
        AND p.id <> $1
        AND p.plan_date < $2::date
        AND stop ->> 'type' = 'drop'
        AND stop ->> 'orderId' = ANY($3::text[])`,
    [Number(plan.id) || 0, planDate, refs]
  );
  return new Set(result.rows.map((row) => text(row.order_ref)).filter(Boolean));
}

export async function validateDispatchPlanDependencies(plan = {}) {
  const dependencies = await loadDependencies();
  if (!dependencies.length) return [];
  const current = loadSequenceIndex(plan);
  const transferIds = [...new Set(dependencies.map((dependency) => Number(dependency.transferOrderId)).filter(Number.isInteger))];
  const transferRows = transferIds.length ? await query(
    `SELECT netsuite_id, fulfillment_status, receiving_status, received_at,
            dispatch_planned, dispatch_plan_date
       FROM transfer_orders
      WHERE netsuite_id = ANY($1::bigint[])`,
    [transferIds]
  ) : { rows: [] };
  const transferById = new Map(transferRows.rows.map((row) => [String(row.netsuite_id), row]));
  const priorTransferRefs = await priorPlannedTransferRefs(
    dependencies.filter((dependency) => dependency.mode === "yard_replenishment").map((dependency) => dependency.transferOrderRef),
    plan
  );
  const conflicts = [];
  for (const dependency of dependencies) {
    const dispatchTargetRef = text(dependency.dispatchTargetRef || dependency.salesOrderRef);
    const canonicalRef = text(dependency.canonicalSalesOrderRef);
    const plannedSalesRef = current.has(dispatchTargetRef) ? dispatchTargetRef : canonicalRef;
    const salesAssignment = current.get(plannedSalesRef);
    if (dependency.status === "attention") {
      if (salesAssignment) conflicts.push(`${plannedSalesRef}: ${dependency.attentionReason || `${dependency.transferOrderRef} requires attention`}.`);
      continue;
    }
    if (!salesAssignment) continue;
    if (dependency.mode === "direct_to_customer") {
      const assignedLoad = (plan.trucks || []).flatMap((truck) => truck.loads || [])
        .find((load) => String(load.id || "") === String(salesAssignment.loadId || ""));
      const dropIndex = (assignedLoad?.stops || []).findIndex((stop) => {
        if (stop.type !== "drop") return false;
        const order = (plan.orders || []).find((entry) => dispatchOrderRefs(entry).includes(String(stop.orderId || "")));
        return order ? dispatchOrderRefs(order).includes(plannedSalesRef) : String(stop.orderId || "") === plannedSalesRef;
      });
      const pickupIndex = (assignedLoad?.stops || []).findIndex((stop) =>
        stop.type === "pick" && text(stop.location).toLowerCase() === text(dependency.sourceLocation).toLowerCase()
      );
      if (pickupIndex < 0 || dropIndex < 0 || pickupIndex > dropIndex) {
        conflicts.push(`${plannedSalesRef} requires direct pickup ${dependency.transferOrderRef} at ${dependency.sourceLocation} before the customer drop.`);
      }
      const row = transferById.get(String(dependency.transferOrderId));
      if (current.has(dependency.transferOrderRef)) {
        conflicts.push(`${dependency.transferOrderRef} is a direct pickup for ${plannedSalesRef} and cannot be planned independently.`);
      }
      if (row?.dispatch_planned && String(row.dispatch_plan_date || "") !== String(plan.planDate || "")) {
        conflicts.push(`${dependency.transferOrderRef} is planned independently. Unplan it before direct pickup with ${plannedSalesRef}.`);
      }
      const remainsOnPlannedAssignment = directDependencyRemainsOnPlannedAssignment(
        dependency,
        plan,
        salesAssignment
      );
      if (
        ["loaded", "fulfilled", "shipped"].includes(
          String(row?.fulfillment_status || "").toLowerCase()
        )
        && dependency.status === "active"
        && !remainsOnPlannedAssignment
      ) {
        conflicts.push(`${dependency.transferOrderRef} has already started and cannot be attached as a new direct pickup.`);
      }
      continue;
    }
    const transferAssignment = current.get(dependency.transferOrderRef);
    const transferRow = transferById.get(String(dependency.transferOrderId)) || {};
    const complete = ["received", "completed", "shipped"].includes(String(transferRow.receiving_status || "").toLowerCase())
      || ["delivered", "received_local"].includes(dependency.status);
    if (complete) continue;
    if (replenishmentTransferPrecedesSales(transferAssignment, salesAssignment)) continue;
    if (priorTransferRefs.has(dependency.transferOrderRef)) continue;
    conflicts.push(`${plannedSalesRef} requires ${dependency.transferOrderRef} to complete earlier or finish before its pickup.`);
  }
  return conflicts;
}

export async function syncOrderDependenciesFromDispatchPlan(plan = {}, {
  allowEstablishedUngroupTargets = []
} = {}) {
  return withTransaction(async () => {
    const assignments = loadSequenceIndex(plan);
    const groupTargets = normalDispatchGroupTargets(plan);
    const establishedUngroupTargets = new Map(
      (allowEstablishedUngroupTargets || [])
        .map((target) => [text(target?.sourceOrderRef), text(target?.groupRef)])
        .filter(([sourceOrderRef, groupRef]) => sourceOrderRef && groupRef)
    );
    const dependencies = await loadDependencies();
    const remapped = [];
    const released = [];
    for (const dependency of dependencies) {
      const canonicalRef = text(dependency.canonicalSalesOrderRef);
      const currentTargetRef = text(dependency.dispatchTargetRef || dependency.salesOrderRef);
      const groupRef = groupTargets.get(canonicalRef);
      const hasExecutionProgress = dependency.lines.some((line) =>
        number(line.loadedQuantity) > EPSILON
        || number(line.deliveredQuantity) > EPSILON
        || number(line.locallyReceivedQuantity) > EPSILON
      );
      let effectiveTargetRef = currentTargetRef;
      if (
        groupRef
        && dependency.dispatchTargetKind === "normal"
        && currentTargetRef === canonicalRef
        && dependency.mode === "yard_replenishment"
        && ["active", "attention"].includes(dependency.status)
        && !hasExecutionProgress
      ) {
        const moved = await query(
          `UPDATE order_dependencies
              SET dispatch_target_ref = $2, dispatch_target_kind = 'group', updated_at = now()
            WHERE id = $1
              AND dispatch_target_ref = $3
              AND sales_order_ref = $4
              AND dispatch_target_kind = 'normal'
              AND dependency_mode = 'yard_replenishment'
              AND status IN ('active', 'attention')
              AND NOT EXISTS (
                SELECT 1
                  FROM order_dependency_lines progress_line
                 WHERE progress_line.dependency_id = order_dependencies.id
                   AND (
                     COALESCE(progress_line.loaded_quantity, 0) > $5
                     OR COALESCE(progress_line.delivered_quantity, 0) > $5
                     OR COALESCE(progress_line.locally_received_quantity, 0) > $5
                   )
              )
          RETURNING id`,
          [dependency.id, groupRef, currentTargetRef, canonicalRef, EPSILON]
        );
        if (moved.rowCount) {
          await query(
            `UPDATE order_dependency_lines
                SET dispatch_target_line_key = CASE
                      WHEN dispatch_target_line_key LIKE $2 || '::%'
                        THEN $3 || substring(dispatch_target_line_key FROM char_length($2) + 1)
                      ELSE $3 || '::' || $4 || '::' || sales_line_id::text
                    END,
                    updated_at = now()
              WHERE dependency_id = $1
                AND line_role = 'sales_allocation'
                AND sales_line_id IS NOT NULL`,
            [dependency.id, currentTargetRef, groupRef, canonicalRef]
          );
          await writeDispatchAudit({
            action: "dispatch.order_dependency.group_target_moved",
            entityType: "order_dependency",
            entityId: String(dependency.id),
            orderId: groupRef,
            planId: plan.id || null,
            planDate: plan.planDate || null,
            before: {
              dispatchTargetRef: currentTargetRef,
              dispatchTargetKind: dependency.dispatchTargetKind
            },
            after: {
              dispatchTargetRef: groupRef,
              dispatchTargetKind: "group"
            },
            details: {
              canonicalSalesOrderRef: canonicalRef,
              transferOrderRef: dependency.transferOrderRef
            }
          });
          effectiveTargetRef = groupRef;
          remapped.push({
            dependencyId: dependency.id,
            sourceOrderRef: canonicalRef,
            groupRef
          });
        }
      }
      if (
        !groupRef
        && establishedUngroupTargets.get(canonicalRef) === currentTargetRef
        && dependency.dispatchTargetKind === "group"
        && dependency.mode === "yard_replenishment"
        && ["active", "attention"].includes(dependency.status)
        && !hasExecutionProgress
      ) {
        const releasedTarget = await query(
          `UPDATE order_dependencies
              SET dispatch_target_ref = $2, dispatch_target_kind = 'normal', updated_at = now()
            WHERE id = $1
              AND dispatch_target_ref = $3
              AND sales_order_ref = $2
              AND dispatch_target_kind = 'group'
              AND dependency_mode = 'yard_replenishment'
              AND status IN ('active', 'attention')
              AND NOT EXISTS (
                SELECT 1
                  FROM order_dependency_lines progress_line
                 WHERE progress_line.dependency_id = order_dependencies.id
                   AND (
                     COALESCE(progress_line.loaded_quantity, 0) > $4
                     OR COALESCE(progress_line.delivered_quantity, 0) > $4
                     OR COALESCE(progress_line.locally_received_quantity, 0) > $4
                   )
              )
          RETURNING id`,
          [dependency.id, canonicalRef, currentTargetRef, EPSILON]
        );
        if (releasedTarget.rowCount) {
          await query(
            `UPDATE order_dependency_lines
                SET dispatch_target_line_key = CASE
                      WHEN dispatch_target_line_key LIKE $2 || '::%'
                        THEN $3 || substring(dispatch_target_line_key FROM char_length($2) + 1)
                      ELSE $3 || '::' || $3 || '::' || sales_line_id::text
                    END,
                    updated_at = now()
              WHERE dependency_id = $1
                AND line_role = 'sales_allocation'
                AND sales_line_id IS NOT NULL`,
            [dependency.id, currentTargetRef, canonicalRef]
          );
          await writeDispatchAudit({
            action: "dispatch.order_dependency.group_target_released",
            entityType: "order_dependency",
            entityId: String(dependency.id),
            orderId: canonicalRef,
            planId: plan.id || null,
            planDate: plan.planDate || null,
            before: {
              dispatchTargetRef: currentTargetRef,
              dispatchTargetKind: dependency.dispatchTargetKind
            },
            after: {
              dispatchTargetRef: canonicalRef,
              dispatchTargetKind: "normal"
            },
            details: {
              canonicalSalesOrderRef: canonicalRef,
              previousGroupRef: currentTargetRef,
              transferOrderRef: dependency.transferOrderRef
            }
          });
          effectiveTargetRef = canonicalRef;
          released.push({
            dependencyId: dependency.id,
            sourceOrderRef: canonicalRef,
            previousGroupRef: currentTargetRef
          });
        }
      }
      const assignment = assignments.get(effectiveTargetRef) || assignments.get(canonicalRef);
      if (assignment) {
        await query(
          `UPDATE order_dependencies
              SET planned_plan_id = $2, planned_date = $3::date, planned_truck_plate = $4,
                  planned_load_id = $5, planned_load_name = $6, updated_at = now()
            WHERE id = $1`,
          [dependency.id, plan.id || null, plan.planDate, assignment.truckPlate,
            assignment.loadId || null, assignment.loadName || null]
        );
      } else if (String(dependency.plannedDate || "").slice(0, 10) === String(plan.planDate || "").slice(0, 10)) {
        await query(
          `UPDATE order_dependencies
              SET planned_plan_id = null, planned_date = null, planned_truck_plate = null,
                  planned_load_id = null, planned_load_name = null, updated_at = now()
            WHERE id = $1`,
          [dependency.id]
        );
      }
    }
    return { remapped, released };
  });
}

function receivedBaseQuantity(line) {
  const conversions = [
    [number(line.received_pallet_qty), number(line.to_plt)],
    [number(line.received_layer_qty), number(line.to_lyr)],
    [number(line.received_section_qty), number(line.to_sec)],
    [number(line.received_piece_qty), number(line.to_pcs)]
  ];
  const converted = conversions.reduce((total, [qty, conversion]) => total + (conversion ? qty * conversion : 0), 0);
  return converted > EPSILON ? converted : number(line.received_piece_qty);
}

export async function completeDirectDependenciesForSalesOrderDrop({
  salesOrderRefs = [],
  driverJobId,
  planId = null,
  planDate = null,
  truckPlate = null,
  loadId = null,
  loadName = null
} = {}) {
  const refs = [...new Set((salesOrderRefs || []).map(text).filter(Boolean))];
  if (!refs.length || !text(driverJobId)) return { completed: [], alreadyCompleted: [] };
  return withTransaction(async () => {
    const completedJob = await query(
      `SELECT job_id, plan_id, plan_date, truck_plate, load_id, load_name, stop_type, order_refs
         FROM driver_job_records
        WHERE job_id = $1 AND status = 'complete'
        ORDER BY completed_at DESC NULLS LAST, created_at DESC
        LIMIT 1
        FOR UPDATE`,
      [text(driverJobId)]
    );
    if (!completedJob.rowCount || completedJob.rows[0].stop_type !== "dropoff") {
      throw new Error("Direct dependency receipt requires a completed customer drop job.");
    }
    const completedRefs = new Set((completedJob.rows[0].order_refs || []).map(text));
    if (!refs.some((ref) => completedRefs.has(ref))) {
      throw new Error("The completed customer drop does not contain the dependent Sales Order.");
    }
    if (loadId && String(completedJob.rows[0].load_id || "") !== String(loadId)) {
      throw new Error("The completed customer drop does not match the dependency load.");
    }
    const rows = await query(
      `SELECT d.*
         FROM order_dependencies d
        WHERE (d.dispatch_target_ref = ANY($1::text[]) OR d.sales_order_ref = ANY($1::text[]))
          AND d.dependency_mode = 'direct_to_customer'
          AND d.status <> 'cancelled'
        ORDER BY d.id
        FOR UPDATE`,
      [refs]
    );
    const completed = [];
    const alreadyCompleted = [];
    for (const dependency of rows.rows) {
      const prior = await query(
        `SELECT result FROM order_dependency_receipts WHERE dependency_id = $1 AND driver_job_id = $2`,
        [dependency.id, text(driverJobId)]
      );
      if (prior.rowCount || dependency.status === "received_local") {
        alreadyCompleted.push({ dependencyId: dependency.id, transferOrderRef: dependency.transfer_order_ref, result: prior.rows[0]?.result || null });
        continue;
      }
      if (dependency.planned_load_id && loadId && String(dependency.planned_load_id) !== String(loadId)) {
        throw new Error(`${dependency.transfer_order_ref} is linked to another planned load.`);
      }
      const lines = await query(
        `SELECT dl.*, tr.line_stage, tr.to_plt, tr.to_lyr, tr.to_sec, tr.to_pcs
           FROM order_dependency_lines dl
           LEFT JOIN transfer_order_lines tr
             ON tr.id = dl.transfer_receiving_line_id AND tr.line_stage = 'receiving'
          WHERE dl.dependency_id = $1
          ORDER BY dl.id
          FOR UPDATE OF dl`,
        [dependency.id]
      );
      let receivedQuantity = 0;
      for (const line of lines.rows) {
        const remaining = Math.max(0, number(line.allocated_quantity) - number(line.locally_received_quantity));
        if (remaining <= EPSILON) continue;
        await query(
          `UPDATE order_dependency_lines
              SET delivered_quantity = allocated_quantity,
                  locally_received_quantity = allocated_quantity,
                  locally_received_pallet_qty = pallet_qty,
                  locally_received_layer_qty = layer_qty,
                  locally_received_section_qty = section_qty,
                  locally_received_piece_qty = piece_qty,
                  updated_at = now()
            WHERE id = $1`,
          [line.id]
        );
        if (line.transfer_receiving_line_id) {
          await query(
            `UPDATE transfer_order_lines
                SET received_pallet_qty = COALESCE(received_pallet_qty, 0) + $2,
                    received_layer_qty = COALESCE(received_layer_qty, 0) + $3,
                    received_section_qty = COALESCE(received_section_qty, 0) + $4,
                    received_piece_qty = COALESCE(received_piece_qty, 0) + $5,
                    confirmed = false, confirmed_at = null, confirmed_by = null
              WHERE id = $1 AND line_stage = 'receiving'`,
            [line.transfer_receiving_line_id, number(line.pallet_qty), number(line.layer_qty),
              number(line.section_qty), number(line.piece_qty)]
          );
        }
        receivedQuantity += remaining;
      }
      const allTransferLines = await query(
        `SELECT * FROM transfer_order_lines
          WHERE transfer_order_id = $1 AND line_stage = 'receiving' AND COALESCE(netsuite_active, true)`,
        [dependency.transfer_order_id]
      );
      const fullyReceived = allTransferLines.rows.length > 0 && allTransferLines.rows.every((line) =>
        receivedBaseQuantity(line) + EPSILON >= number(line.quantity)
      );
      const receivingStatus = fullyReceived ? "received" : "partial_received";
      await query(
        `UPDATE transfer_orders
            SET receiving_status = $2,
                local_yard_order_status = CASE WHEN $2 = 'received' THEN 'Received' ELSE 'Partially Received' END,
                received_at = CASE WHEN $2 = 'received' THEN COALESCE(received_at, now()) ELSE received_at END,
                status_updated_at = now()
          WHERE netsuite_id = $1`,
        [dependency.transfer_order_id, receivingStatus]
      );
      await query(
        `UPDATE order_dependencies
            SET status = 'received_local', local_completed_at = now(), direct_received_at = now(),
                direct_receipt_job_id = $2, reconciliation_status = 'required', updated_at = now()
          WHERE id = $1`,
        [dependency.id, text(driverJobId)]
      );
      const result = {
        dependencyId: dependency.id,
        salesOrderRef: dependency.dispatch_target_ref || dependency.sales_order_ref,
        transferOrderRef: dependency.transfer_order_ref,
        receivedQuantity,
        receivingStatus,
        reason: "direct_so_delivery"
      };
      await query(
        `INSERT INTO order_dependency_receipts (
           dependency_id, driver_job_id, sales_order_ref, transfer_order_ref,
           plan_id, plan_date, truck_plate, load_id, load_name, received_quantity, result
         ) VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, $9, $10, $11::jsonb)
         ON CONFLICT (dependency_id, driver_job_id) DO NOTHING`,
        [dependency.id, text(driverJobId), dependency.dispatch_target_ref || dependency.sales_order_ref, dependency.transfer_order_ref,
          planId, planDate, truckPlate, loadId, loadName, receivedQuantity, JSON.stringify(result)]
      );
      await query(
        `INSERT INTO receiving_receipt_records (
           order_id, operator_id, receipt_status, photo_data_urls, payload, response
         ) VALUES ($1, null, 'local_direct_receipt', '[]'::jsonb, $2::jsonb, $3::jsonb)`,
        [dependency.transfer_order_id, JSON.stringify({
          reason: "direct_so_delivery",
          salesOrderRef: dependency.dispatch_target_ref || dependency.sales_order_ref,
          driverJobId: text(driverJobId),
          planId,
          planDate,
          truckPlate,
          loadId,
          loadName
        }), JSON.stringify(result)]
      );
      completed.push(result);
    }
    return { completed, alreadyCompleted };
  });
}

export async function markDirectDependencyPickupCompleted({ transferOrderRefs = [], driverJobId = "" } = {}) {
  const refs = [...new Set((transferOrderRefs || []).map(text).filter(Boolean))];
  if (!refs.length) return [];
  return withTransaction(async () => {
    const rows = await query(
      `SELECT id, transfer_order_ref, status
         FROM order_dependencies
        WHERE transfer_order_ref = ANY($1::text[])
          AND dependency_mode = 'direct_to_customer'
          AND status IN ('active', 'packed', 'loaded', 'attention')
        FOR UPDATE`,
      [refs]
    );
    for (const row of rows.rows) {
      if (!["loaded", "in_transit", "delivered", "received_local"].includes(row.status)) {
        throw new Error(`${row.transfer_order_ref} has not been loaded by its source-yard operator.`);
      }
      await query(
        `UPDATE order_dependency_lines
            SET loaded_quantity = allocated_quantity, updated_at = now()
          WHERE dependency_id = $1`,
        [row.id]
      );
      await query(
        `UPDATE order_dependencies
            SET status = 'in_transit', updated_at = now(),
                attention_reason = CASE WHEN status = 'attention' THEN attention_reason ELSE null END
          WHERE id = $1`,
        [row.id]
      );
      await writeDispatchAudit({
        action: "driver.direct_dependency.picked_up",
        source: "driver",
        entityType: "order_dependency",
        entityId: String(row.id),
        orderId: row.transfer_order_ref,
        details: { driverJobId: text(driverJobId) }
      });
    }
    return rows.rows.map((row) => ({ dependencyId: row.id, transferOrderRef: row.transfer_order_ref, status: "in_transit" }));
  });
}

export async function reconcileOrderDependency(dependencyId, operatorId = null) {
  return withTransaction(async () => {
    const dependency = await query("SELECT * FROM order_dependencies WHERE id = $1 FOR UPDATE", [Number(dependencyId)]);
    if (!dependency.rowCount) throw new Error("Dependency not found.");
    const row = dependency.rows[0];
    const lines = await query(
      `SELECT dl.*, tr.netsuite_received_qty
         FROM order_dependency_lines dl
         LEFT JOIN transfer_order_lines tr
           ON tr.id = dl.transfer_receiving_line_id AND tr.line_stage = 'receiving'
        WHERE dl.dependency_id = $1`,
      [Number(dependencyId)]
    );
    const reconciled = lines.rows.every((line) => number(line.netsuite_received_qty) + EPSILON >= number(line.allocated_quantity));
    await query(
      `UPDATE order_dependencies
          SET reconciliation_status = $2,
              reconciled_at = CASE WHEN $2 = 'reconciled' THEN now() ELSE null END,
              updated_by = $3, updated_at = now()
        WHERE id = $1`,
      [Number(dependencyId), reconciled ? "reconciled" : "required", operatorId]
    );
    return { dependencyId: Number(dependencyId), reconciled };
  });
}

export async function syncOrderDependenciesForTransferOrder(transferOrderId) {
  const id = Number(transferOrderId);
  if (!Number.isInteger(id) || id <= 0) return [];
  return withTransaction(async () => {
    const dependencies = await query(
      `SELECT d.*, t.status AS transfer_status, t.status_text AS transfer_status_text,
              t.netsuite_active AS transfer_active, t.receiving_status AS transfer_receiving_status
         FROM order_dependencies d
         JOIN transfer_orders t ON t.netsuite_id = d.transfer_order_id
        WHERE d.transfer_order_id = $1 AND d.status <> 'cancelled'
        FOR UPDATE OF d`,
      [id]
    );
    const results = [];
    for (const dependency of dependencies.rows) {
      const lines = await query(
        `SELECT dl.*, out_line.quantity AS outbound_quantity,
                in_line.quantity AS receiving_quantity,
                in_line.netsuite_received_qty
           FROM order_dependency_lines dl
           LEFT JOIN transfer_order_lines out_line ON out_line.id = dl.transfer_outbound_line_id
           LEFT JOIN transfer_order_lines in_line ON in_line.id = dl.transfer_receiving_line_id
          WHERE dl.dependency_id = $1`,
        [dependency.id]
      );
      const terminalStatus = terminalTransferOrderStatus(dependency);
      const hasExecutionProgress = lines.rows.some((line) =>
        number(line.loaded_quantity) > EPSILON
        || number(line.delivered_quantity) > EPSILON
        || number(line.locally_received_quantity) > EPSILON
      );
      const canAutoCancel = Boolean(terminalStatus)
        && ["active", "attention"].includes(String(dependency.status || ""))
        && !hasExecutionProgress;
      if (canAutoCancel) {
        const attentionReason = `${dependency.transfer_order_ref} was automatically unlinked because NetSuite marked it ${terminalStatus}.`;
        await query(
          `UPDATE order_dependencies
              SET status = 'cancelled',
                  attention_reason = $2,
                  reconciliation_status = 'not_required',
                  reconciled_at = null,
                  updated_at = now()
            WHERE id = $1`,
          [dependency.id, attentionReason]
        );
        await writeDispatchAudit({
          action: "dispatch.order_dependency.unlinked",
          entityType: "order_dependency",
          entityId: String(dependency.id),
          orderId: dependency.dispatch_target_ref || dependency.sales_order_ref,
          source: "netsuite_sync",
          before: {
            status: dependency.status,
            reconciliationStatus: dependency.reconciliation_status
          },
          after: {
            status: "cancelled",
            reconciliationStatus: "not_required"
          },
          details: {
            automatic: true,
            transferOrderRef: dependency.transfer_order_ref,
            transferStatus: dependency.transfer_status,
            transferStatusText: dependency.transfer_status_text,
            reason: attentionReason
          }
        });
        results.push({
          dependencyId: dependency.id,
          cancelled: true,
          attention: false,
          attentionReason,
          reconciled: false
        });
        continue;
      }
      const unavailable = dependency.transfer_active === false || Boolean(terminalStatus);
      const reduced = lines.rows
        .filter((line) => line.line_role !== "pallet")
        .some((line) => {
          const available = line.outbound_quantity ?? line.receiving_quantity;
          return available === null || available === undefined || number(available) + EPSILON < number(line.allocated_quantity);
        });
      const reconciled = lines.rows.length > 0 && lines.rows.every((line) =>
        number(line.netsuite_received_qty) + EPSILON >= number(line.allocated_quantity)
      );
      const beforeDelivery = !["delivered", "received_local"].includes(dependency.status);
      const attention = beforeDelivery && (unavailable || reduced);
      const replenishmentComplete = dependency.dependency_mode === "yard_replenishment"
        && ["received", "completed", "shipped"].includes(String(dependency.transfer_receiving_status || "").toLowerCase());
      const attentionReason = terminalStatus
        ? `${dependency.transfer_order_ref} is ${terminalStatus} in NetSuite and has already started or has execution progress that requires review.`
        : dependency.transfer_active === false
          ? `${dependency.transfer_order_ref} is no longer active in NetSuite.`
        : reduced
          ? `${dependency.transfer_order_ref} quantity is below its linked Sales Order allocation.`
          : null;
      const resumedStatus = lines.rows.some((line) => number(line.loaded_quantity) > EPSILON) ? "in_transit" : "active";
      await query(
                `UPDATE order_dependencies
            SET status = CASE
                  WHEN $2 THEN 'attention'
                  WHEN $6 THEN 'delivered'
                  WHEN status = 'attention' THEN $5
                  ELSE status
                END,
                attention_reason = CASE WHEN $2 THEN $3 WHEN status = 'attention' THEN null ELSE attention_reason END,
                reconciliation_status = CASE
                  WHEN $2 THEN 'attention'
                  WHEN $4 THEN 'reconciled'
                  WHEN $6 THEN 'not_required'
                  WHEN reconciliation_status = 'attention' THEN 'pending'
                  WHEN dependency_mode = 'direct_to_customer' AND status IN ('delivered', 'received_local') THEN 'required'
                  ELSE reconciliation_status
                END,
                reconciled_at = CASE WHEN $4 THEN now() ELSE reconciled_at END,
                updated_at = now()
          WHERE id = $1`,
        [dependency.id, attention, attentionReason, reconciled, resumedStatus, replenishmentComplete]
      );
      results.push({ dependencyId: dependency.id, attention, attentionReason, reconciled });
    }
    return results;
  });
}

export async function activeDirectDependencyTransferOrderIds() {
  const result = await query(
    `SELECT transfer_order_id FROM order_dependencies
      WHERE dependency_mode = 'direct_to_customer' AND status <> 'cancelled'`
  );
  return result.rows.map((row) => Number(row.transfer_order_id));
}
