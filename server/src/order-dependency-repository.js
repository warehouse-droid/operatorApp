import crypto from "node:crypto";
import { config, isNetSuiteSandboxEnvironment } from "./config.js";
import { query, withTransaction } from "./db.js";
import { writeDispatchAudit } from "./dispatch-audit-repository.js";
import { resolveDispatchSalesTarget } from "./dispatch-order-target-repository.js";
import { dispatchLoadAssignment } from "./dispatch-load-assignment.js";
import {
  dispatchLocationsShareYard,
  uniqueDispatchLocations
} from "./dispatch-location.js";
import {
  normalizeTransferDependencyReservationOverrides,
  transferDependencyPlanningAvailability,
  transferDependencyReservationContract,
  transferDependencyReservationOverrideKey,
  transferDependencyReservationOverrideSet,
  transferDependencyReservationOverridesFromSnapshot
} from "./transfer-dependency-reservation.js";
import { transferDependencySourceBackorderDecision } from "./transfer-dependency-source-backorder.js";
import {
  ensureTransferDependencyPendingFulfillment,
  transferDependencyApprovalStatusAfterPrintBlock,
  transferDependencyCreationOutcome
} from "./auto-transfer-approval-policy.js";
import {
  dependencyBlocksDispatchStructureChange,
  dispatchDependencyOrderRefs as dispatchOrderRefs,
  everySalesAssignmentFollowsTransfer
} from "./yard-dependency-structure.js";

export const DEPENDENCY_YARDS = Object.freeze([
  { code: "3445", locationId: 1, address: "3445 Kennedy Road, Toronto, ON", priority: 1, westPenaltyMinutes: 0 },
  { code: "2967", locationId: 28, address: "2967 Kennedy Road, Toronto, ON", priority: 2, westPenaltyMinutes: 0 },
  { code: "12441", locationId: 15, address: "12441 Woodbine Avenue, Whitchurch-Stouffville, ON", priority: 3, westPenaltyMinutes: 0 },
  { code: "150", locationId: 26, address: "150 Clark Blvd, Brampton, ON L6T 4Y8, Canada", priority: 4, westPenaltyMinutes: config.transferDependency.westYardPenaltyMinutes }
]);

const YARD_BY_ID = new Map(DEPENDENCY_YARDS.map((yard) => [String(yard.locationId), yard]));
const EPSILON = 0.000001;

export { transferDependencySourceBackorderDecision };
export {
  ensureTransferDependencyPendingFulfillment,
  transferDependencyApprovalStatusAfterPrintBlock,
  transferDependencyCreationOutcome
};

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

export function transferDependencyRevisionProgressBlock(state = {}) {
  const dependencyStatus = text(state.dependencyStatus).toLowerCase();
  if (dependencyStatus && !["active", "attention"].includes(dependencyStatus)) {
    return `Transfer execution has started (${dependencyStatus}); its quantities can no longer be changed.`;
  }
  const progressFields = [
    "loadedQuantity",
    "deliveredQuantity",
    "locallyReceivedQuantity",
    "transferPackedQuantity",
    "transferLoadedQuantity",
    "transferFulfilledQuantity",
    "transferReceivedQuantity"
  ];
  if (progressFields.some((field) => number(state[field]) > EPSILON)) {
    return "Transfer packing, loading, fulfillment, delivery, or receiving has started; its quantities can no longer be changed.";
  }
  if (state.lastItemFulfillmentId || state.lastItemReceiptId || state.fulfilledAt || state.receivedAt) {
    return "NetSuite fulfillment or receiving has started; its quantities can no longer be changed.";
  }
  return null;
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

function transferOrderReceiptEvidenceComplete(row = {}) {
  const receivingStatus = text(
    row.transfer_receiving_status ?? row.receiving_status ?? row.transferReceivingStatus
  ).toLowerCase();
  if (["received", "completed", "shipped"].includes(receivingStatus)) return true;

  const statusText = text(
    row.transfer_status_text ?? row.status_text ?? row.transferStatusText
  );
  if (/^transfer\s+order\s*:\s*received$/i.test(statusText)) return true;

  const applicationStatus = text(
    row.transfer_application_status ?? row.application_status ?? row.transferApplicationStatus
  ).toLowerCase();
  const reconciliationStatus = text(
    row.transfer_reconciliation_status ?? row.transferReconciliationStatus
  ).toLowerCase();
  if (applicationStatus !== "completed" || !["ok", "current"].includes(reconciliationStatus)) {
    return false;
  }
  const orderedQuantity = nullableNumber(
    row.transfer_ordered_qty ?? row.ordered_qty ?? row.transferOrderedQuantity
  );
  const receivedQuantity = nullableNumber(
    row.transfer_received_qty ?? row.received_qty ?? row.transferReceivedQuantity
  );
  const remainingQuantity = nullableNumber(
    row.transfer_remaining_qty ?? row.remaining_qty ?? row.transferRemainingQuantity
  );
  const destinationRemainingQuantity = nullableNumber(
    row.transfer_destination_remaining_qty
      ?? row.destination_remaining_qty
      ?? row.transferDestinationRemainingQuantity
  );
  return (orderedQuantity === null || receivedQuantity === null || receivedQuantity + EPSILON >= orderedQuantity)
    && (remainingQuantity === null || remainingQuantity <= EPSILON)
    && (destinationRemainingQuantity === null || destinationRemainingQuantity <= EPSILON);
}

function transferDependencyReceiptComplete(row = {}) {
  const dependencyStatus = text(row.status ?? row.dependencyStatus).toLowerCase();
  const dependencyReconciliationStatus = text(
    row.reconciliation_status ?? row.reconciliationStatus
  ).toLowerCase();
  return ["delivered", "received_local"].includes(dependencyStatus)
    || dependencyReconciliationStatus === "reconciled"
    || transferOrderReceiptEvidenceComplete(row);
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
    transferReceivingStatus: row.transfer_receiving_status,
    transferStatus: row.transfer_status,
    transferStatusText: row.transfer_status_text,
    transferDispatchPlanned: Boolean(row.transfer_dispatch_planned),
    transferDispatchPlanDate: dateText(row.transfer_dispatch_plan_date),
    transferApplicationStatus: row.transfer_application_status,
    transferReconciliationStatus: row.transfer_reconciliation_status,
    transferReceived: transferDependencyReceiptComplete(row),
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
    `SELECT d.*,
            t.receiving_status AS transfer_receiving_status,
            t.status AS transfer_status,
            t.status_text AS transfer_status_text,
            t.dispatch_planned AS transfer_dispatch_planned,
            t.dispatch_plan_date AS transfer_dispatch_plan_date,
            state.application_status AS transfer_application_status,
            state.reconciliation_status AS transfer_reconciliation_status,
            state.ordered_qty AS transfer_ordered_qty,
            state.received_qty AS transfer_received_qty,
            state.remaining_qty AS transfer_remaining_qty,
            state.destination_remaining_qty AS transfer_destination_remaining_qty
       FROM order_dependencies d
       LEFT JOIN transfer_orders t ON t.netsuite_id = d.transfer_order_id
       LEFT JOIN scm_reconciliation_order_state state
         ON state.order_kind = 'TO'
        AND state.source_order_netsuite_id = d.transfer_order_id
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

export async function assertNoActiveOrderDependenciesByRefs(orderRefs = [], action = "change these orders", _options = {}) {
  const refs = [...new Set((orderRefs || []).map(text).filter(Boolean))];
  if (!refs.length) return;
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
  // A yard-replenishment dependency owns canonical SO/TO line allocations, not
  // the temporary Dispatch container. Group/split edits therefore leave its
  // inventory contract intact; ordering and execution gates are enforced by
  // validateDispatchPlanDependencies and getSalesOrderDependencyExecutionBlock.
  // Direct-to-customer dependencies remain locked because their pickup and
  // customer drop must stay coupled on one physical load.
  const blocked = result.rows.filter(dependencyBlocksDispatchStructureChange);
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
    `WITH requested_refs AS (
       SELECT unnest($1::text[]) AS order_ref
     ), effective_refs AS (
       SELECT order_ref FROM requested_refs
       UNION
       SELECT split.source_so_ref
         FROM dispatch_scm_so_splits split
         JOIN requested_refs requested ON requested.order_ref = split.split_so_ref
        WHERE split.status = 'active'
     )
     SELECT COALESCE(d.dispatch_target_ref, d.sales_order_ref) AS dispatch_target_ref,
            d.sales_order_ref, d.transfer_order_ref, d.status, d.reconciliation_status,
            t.receiving_status AS transfer_receiving_status,
            t.status AS transfer_status, t.status_text AS transfer_status_text,
            t.received_at, t.netsuite_active,
            state.application_status AS transfer_application_status,
            state.reconciliation_status AS transfer_reconciliation_status,
            state.ordered_qty AS transfer_ordered_qty,
            state.received_qty AS transfer_received_qty,
            state.remaining_qty AS transfer_remaining_qty,
            state.destination_remaining_qty AS transfer_destination_remaining_qty
       FROM order_dependencies d
       JOIN transfer_orders t ON t.netsuite_id = d.transfer_order_id
       LEFT JOIN scm_reconciliation_order_state state
         ON state.order_kind = 'TO'
        AND state.source_order_netsuite_id = d.transfer_order_id
      WHERE EXISTS (
              SELECT 1
                FROM effective_refs candidate
               WHERE candidate.order_ref = d.dispatch_target_ref
                  OR candidate.order_ref = d.sales_order_ref
            )
        AND d.dependency_mode = 'yard_replenishment'
        AND d.status <> 'cancelled'
      ORDER BY d.dispatch_target_ref, d.transfer_order_ref`,
    [refs]
  );
  const row = result.rows.find((candidate) => !transferDependencyReceiptComplete(candidate));
  if (!row) return null;
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
              t.status AS transfer_status, t.status_text AS transfer_status_text,
              state.application_status AS transfer_application_status,
              state.reconciliation_status AS transfer_reconciliation_status,
              state.ordered_qty AS transfer_ordered_qty,
              state.received_qty AS transfer_received_qty,
              state.remaining_qty AS transfer_remaining_qty,
              state.destination_remaining_qty AS transfer_destination_remaining_qty
         FROM order_dependencies d
         JOIN transfer_orders t ON t.netsuite_id = d.transfer_order_id
         LEFT JOIN scm_reconciliation_order_state state
           ON state.order_kind = 'TO'
          AND state.source_order_netsuite_id = d.transfer_order_id
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
      const formalReceiptComplete = transferDependencyReceiptComplete(dependency);
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

function directPickupRouteMismatches(row = {}, execution = {}) {
  const mismatches = [];
  if (
    row.planned_plan_id !== null
    && row.planned_plan_id !== undefined
    && execution.planId !== null
    && execution.planId !== undefined
    && execution.planId !== ""
    && text(row.planned_plan_id) !== text(execution.planId)
  ) mismatches.push("plan");
  if (
    row.planned_date
    && execution.planDate
    && dateText(row.planned_date) !== dateText(execution.planDate)
  ) mismatches.push("plan_date");
  if (
    row.planned_truck_plate
    && execution.truckPlate
    && normalizedToken(row.planned_truck_plate) !== normalizedToken(execution.truckPlate)
  ) mismatches.push("truck");
  if (
    row.planned_load_id
    && execution.loadId
    && text(row.planned_load_id) !== text(execution.loadId)
  ) mismatches.push("load");
  return mismatches;
}

export async function getDirectPickupDependencyExecutionBlock(
  transferOrderRefs = [],
  execution = {}
) {
  const refs = [...new Set((transferOrderRefs || []).map(text).filter(Boolean))];
  if (!refs.length) return null;
  const result = await query(
    `SELECT d.id, d.transfer_order_ref,
            COALESCE(d.dispatch_target_ref, d.sales_order_ref) AS dispatch_target_ref,
            d.sales_order_ref, d.status, d.attention_reason,
            d.planned_plan_id, d.planned_date, d.planned_truck_plate,
            d.planned_load_id, d.planned_load_name
       FROM order_dependencies d
      WHERE d.transfer_order_ref = ANY($1::text[])
        AND d.dependency_mode = 'direct_to_customer'
      ORDER BY d.transfer_order_ref,
               CASE WHEN d.status = 'cancelled' THEN 1 ELSE 0 END,
               d.id DESC`,
    [refs]
  );
  const byRef = new Map();
  for (const row of result.rows) {
    if (!byRef.has(text(row.transfer_order_ref))) byRef.set(text(row.transfer_order_ref), row);
  }
  for (const ref of refs) {
    const row = byRef.get(ref);
    if (!row || row.status === "cancelled") {
      return {
        code: "DIRECT_TRANSFER_DEPENDENCY_UNAVAILABLE",
        salesOrderRef: row?.dispatch_target_ref || row?.sales_order_ref || "",
        transferOrderRef: ref,
        message: `${ref} is no longer an active direct pickup on this route. Refresh the Driver route before continuing.`
      };
    }
    if (row.status === "attention") {
      return {
        code: "DIRECT_TRANSFER_REVIEW_REQUIRED",
        salesOrderRef: row.dispatch_target_ref || row.sales_order_ref,
        transferOrderRef: ref,
        message: `${ref} requires Dispatch review before this direct pickup can continue.`,
        reason: text(row.attention_reason)
      };
    }
    const mismatches = directPickupRouteMismatches(row, execution);
    if (mismatches.length) {
      return {
        code: "DIRECT_TRANSFER_ROUTE_MISMATCH",
        salesOrderRef: row.dispatch_target_ref || row.sales_order_ref,
        transferOrderRef: ref,
        mismatches,
        message: `${ref} belongs to another confirmed plan, truck, or load. Refresh the Driver route before continuing.`
      };
    }
  }
  return null;
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
            EXISTS (
              SELECT 1
                FROM dispatch_order_completion_events completion
               WHERE completion.order_kind = 'SO'
                 AND lower(btrim(completion.order_ref)) = lower(btrim(o.tranid))
            ) AS dispatch_completed,
            GREATEST(
              COALESCE(o.status_updated_at, '-infinity'::timestamptz),
              COALESCE(o.synced_at, '-infinity'::timestamptz),
              COALESCE(l.synced_at, '-infinity'::timestamptz)
            ) AS latest_activity_at,
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
    const batch = batches.get(String(order.salesOrderId));
    const transferCreated = batch?.has_created_transfer === true;
    const systemReopenedNoTransfer = review?.status === "stale"
      && text(review.reopened_by).toLowerCase() === "system"
      && !transferCreated;
    const explicitlyReopened = review?.status === "stale"
      && Boolean(text(review.reopened_by))
      && text(review.reopened_by).toLowerCase() !== "system";
    let activeReview = review?.status === "reviewed" || systemReopenedNoTransfer;
    const signatureChanged = Boolean(review?.shortage_signature)
      && review.shortage_signature !== signature;
    // Reviewed - No Transfer is a durable user decision. NetSuite allocation,
    // IR, or partial-fulfillment changes may update its displayed shortage but
    // cannot silently undo the review. Existing system-stale rows are treated
    // as reviewed so orders reopened by the former policy recover immediately.
    // A manually reviewed created TO keeps its existing change/review behavior.
    if (review?.status === "reviewed" && signatureChanged && transferCreated) {
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
      explicitlyReopened,
      completed: Boolean(completionType),
      completionType,
      completedAt: activeReview ? review.reviewed_at : transferCompleted ? batch.last_printed_at || batch.updated_at : null,
      workflowStage,
      dependencyBatchId: transferCreated ? batch.batch_id : null,
      transferCreatedAt: transferCreated ? batch.transfer_created_at || null : null,
      latestActivityAt: latestTransferDependencyActivityAt(
        order.latestActivityAt,
        batch?.updated_at,
        batch?.transfer_created_at,
        batch?.last_printed_at,
        review?.updated_at,
        review?.reviewed_at,
        review?.reopened_at
      )
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
  const visible = enriched.filter((order) => order.workflowStage !== "open"
    || order.dispatchCompleted !== true
    || order.explicitlyReopened === true);
  if (normalizedStatus === "all") return sortTransferDependencyCandidatesByLatestActivity(visible);
  return sortTransferDependencyCandidatesByLatestActivity(
    visible.filter((order) => order.workflowStage === "open" && number(order.uncoveredQuantity) > EPSILON)
  );
}

function latestTransferDependencyActivityAt(...values) {
  let latest = 0;
  for (const value of values) {
    const parsed = Date.parse(value || "");
    if (Number.isFinite(parsed) && parsed > latest) latest = parsed;
  }
  return latest ? new Date(latest).toISOString() : null;
}

export function sortTransferDependencyCandidatesByLatestActivity(orders = []) {
  const timestamp = (value) => {
    const parsed = Date.parse(value || "");
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return [...orders].sort((left, right) => (
    timestamp(right.latestActivityAt) - timestamp(left.latestActivityAt)
    || Number(right.salesOrderId || 0) - Number(left.salesOrderId || 0)
    || String(left.salesOrderRef || "").localeCompare(String(right.salesOrderRef || ""))
  ));
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
        dispatchCompleted: row.dispatch_completed === true,
        latestActivityAt: row.latest_activity_at || null,
        uncoveredQuantity: 0,
        lines: []
      });
    }
    const order = orders.get(key);
    order.latestActivityAt = latestTransferDependencyActivityAt(order.latestActivityAt, row.latest_activity_at);
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
      WHERE sales_order_id = $1
        AND (
          status = 'reviewed'
          OR (status = 'stale' AND lower(COALESCE(reopened_by, '')) = 'system')
        )
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
            j.last_error AS print_error,
            dependency.status AS dependency_status,
            COALESCE(dependency.loaded_quantity, 0) AS dependency_loaded_quantity,
            COALESCE(dependency.delivered_quantity, 0) AS dependency_delivered_quantity,
            COALESCE(dependency.locally_received_quantity, 0) AS dependency_locally_received_quantity,
            COALESCE(transfer_progress.packed_quantity, 0) AS transfer_packed_quantity,
            COALESCE(transfer_progress.loaded_quantity, 0) AS transfer_loaded_quantity,
            COALESCE(transfer_progress.fulfilled_quantity, 0) AS transfer_fulfilled_quantity,
            COALESCE(transfer_progress.received_quantity, 0) AS transfer_received_quantity,
            transfer_header.last_item_fulfillment_id,
            transfer_header.last_item_receipt_id,
            transfer_header.fulfilled_at,
            transfer_header.received_at
       FROM scm_transfer_dependency_proposals p
       LEFT JOIN scm_print_jobs j ON j.id = p.print_job_id
       LEFT JOIN LATERAL (
         SELECT d.status,
                SUM(dl.loaded_quantity) AS loaded_quantity,
                SUM(dl.delivered_quantity) AS delivered_quantity,
                SUM(dl.locally_received_quantity) AS locally_received_quantity
           FROM order_dependencies d
           LEFT JOIN order_dependency_lines dl ON dl.dependency_id = d.id
          WHERE d.proposal_id = p.id AND d.status <> 'cancelled'
          GROUP BY d.id, d.status
          ORDER BY d.id DESC
          LIMIT 1
       ) dependency ON true
       LEFT JOIN transfer_orders transfer_header
         ON transfer_header.netsuite_id = p.netsuite_transfer_order_id
       LEFT JOIN LATERAL (
         SELECT SUM(
                  COALESCE(line.packed_pallet_qty, 0)
                  + COALESCE(line.packed_layer_qty, 0)
                  + COALESCE(line.packed_section_qty, 0)
                  + COALESCE(line.packed_piece_qty, 0)
                ) AS packed_quantity,
                SUM(COALESCE(line.loaded_qty, 0)) AS loaded_quantity,
                SUM(
                  COALESCE(line.fulfilled_pallet_qty, 0)
                  + COALESCE(line.fulfilled_layer_qty, 0)
                  + COALESCE(line.fulfilled_section_qty, 0)
                  + COALESCE(line.fulfilled_piece_qty, 0)
                ) AS fulfilled_quantity,
                SUM(
                  COALESCE(line.received_pallet_qty, 0)
                  + COALESCE(line.received_layer_qty, 0)
                  + COALESCE(line.received_section_qty, 0)
                  + COALESCE(line.received_piece_qty, 0)
                  + COALESCE(line.netsuite_received_qty, 0)
                ) AS received_quantity
           FROM transfer_order_lines line
          WHERE line.transfer_order_id = p.netsuite_transfer_order_id
            AND COALESCE(line.netsuite_active, true)
       ) transfer_progress ON true
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
      allowSourceBackorder: proposal.allow_source_backorder === true,
      palletItemId: proposal.pallet_item_id,
      palletItemName: proposal.pallet_item_name || "PALLET",
      mergedFromProposalIds: (proposal.merged_from_proposal_ids || []).map(Number),
      creationStatus: proposal.creation_status,
      creationAttemptId: proposal.creation_attempt_id,
      creationStartedAt: proposal.creation_started_at,
      transferOrderId: proposal.netsuite_transfer_order_id,
      transferOrderRef: proposal.netsuite_transfer_order_ref,
      creationError: proposal.creation_error,
      revision: Number(proposal.revision || 1),
      revisionStatus: proposal.revision_status || "idle",
      revisionRequestId: proposal.revision_request_id,
      revisionError: proposal.revision_error,
      revisionBlockedReason: transferDependencyRevisionProgressBlock({
        dependencyStatus: proposal.dependency_status,
        loadedQuantity: proposal.dependency_loaded_quantity,
        deliveredQuantity: proposal.dependency_delivered_quantity,
        locallyReceivedQuantity: proposal.dependency_locally_received_quantity,
        transferPackedQuantity: proposal.transfer_packed_quantity,
        transferLoadedQuantity: proposal.transfer_loaded_quantity,
        transferFulfilledQuantity: proposal.transfer_fulfilled_quantity,
        transferReceivedQuantity: proposal.transfer_received_quantity,
        lastItemFulfillmentId: proposal.last_item_fulfillment_id,
        lastItemReceiptId: proposal.last_item_receipt_id,
        fulfilledAt: proposal.fulfilled_at,
        receivedAt: proposal.received_at
      }),
      quantityVerificationStatus: proposal.quantity_verification_status || "pending",
      quantityVerificationError: proposal.quantity_verification_error,
      quantityVerifiedAt: proposal.quantity_verified_at,
      quantityVerifiedBy: proposal.quantity_verified_by,
      approvalStatus: proposal.approval_status || "pending",
      approvalError: proposal.approval_error,
      approvedAt: proposal.approved_at,
      approvedBy: proposal.approved_by,
      printGeneration: Number(proposal.print_generation || 0),
      printRequestStatus: proposal.print_request_status || "idle",
      printRequestError: proposal.print_request_error,
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
    const currentProposalSettings = proposals.length ? await query(
      `SELECT id, creation_status, allow_source_backorder
         FROM scm_transfer_dependency_proposals
        WHERE batch_id = $1 AND id = ANY($2::bigint[])
        ORDER BY id
        FOR UPDATE`,
      [Number(batchId), proposals.map((proposal) => Number(proposal.id)).filter(Number.isInteger)]
    ) : { rows: [] };
    const sourceBackorderByProposal = new Map(currentProposalSettings.rows.map((proposal) => [
      Number(proposal.id),
      {
        enabled: proposal.allow_source_backorder === true,
        creationStatus: proposal.creation_status
      }
    ]));
    const sourceBackorderChanges = [];
    for (const proposal of proposals) {
      const fromYard = YARD_BY_ID.get(String(proposal.fromLocationId));
      const toYard = YARD_BY_ID.get(String(proposal.toLocationId));
      if (!fromYard || !toYard) throw new Error("Select configured From and To yards.");
      if (fromYard.locationId === toYard.locationId) throw new Error("Transfer source and destination cannot be the same yard.");
      const requestedSourceBackorder = typeof proposal.allowSourceBackorder === "boolean"
        ? proposal.allowSourceBackorder
        : null;
      await query(
        `UPDATE scm_transfer_dependency_proposals
            SET dependency_mode = $3, from_location_id = $4, from_location = $5,
                to_location_id = $6, to_location = $7, memo = $8,
                allow_source_backorder = CASE
                  WHEN creation_status IN ('draft', 'failed')
                    THEN COALESCE($9::boolean, allow_source_backorder)
                  ELSE allow_source_backorder
                END,
                updated_at = now()
          WHERE id = $1 AND batch_id = $2 AND creation_status <> 'created'`,
        [Number(proposal.id), Number(batchId), normalizeMode(proposal.mode), fromYard.locationId,
          fromYard.code, toYard.locationId, toYard.code, text(proposal.memo), requestedSourceBackorder]
      );
      const previousSourceBackorder = sourceBackorderByProposal.get(Number(proposal.id));
      if (requestedSourceBackorder !== null
        && previousSourceBackorder !== undefined
        && ["draft", "failed"].includes(previousSourceBackorder.creationStatus)
        && previousSourceBackorder.enabled !== requestedSourceBackorder) {
        sourceBackorderChanges.push({
          proposalId: Number(proposal.id),
          fromLocationId: fromYard.locationId,
          fromLocation: fromYard.code,
          before: previousSourceBackorder.enabled,
          after: requestedSourceBackorder
        });
      }
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
    if (sourceBackorderChanges.length) {
      await writeDispatchAudit({
        action: "scm.transfer_dependency.source_backorder_updated",
        source: "scm",
        entityType: "dependency_batch",
        entityId: String(batchId),
        orderId: current.rows[0].sales_order_ref,
        operatorId,
        before: { proposals: sourceBackorderChanges.map(({ proposalId, before }) => ({ proposalId, allowSourceBackorder: before })) },
        after: { proposals: sourceBackorderChanges.map(({ proposalId, after }) => ({ proposalId, allowSourceBackorder: after })) },
        details: { changes: sourceBackorderChanges }
      });
    }
    return getTransferDependencyBatch(batchId);
  });
}

function transferDependencyRevisionTarget(proposal, input = {}) {
  const requestedLines = Array.isArray(input.lines) ? input.lines : [];
  const requestedById = new Map();
  for (const line of requestedLines) {
    const id = Number(line.proposalLineId);
    if (!Number.isInteger(id) || id <= 0 || requestedById.has(id)) {
      throw Object.assign(new Error("Every revised Transfer Order line must have one unique proposal-line ID."), { status: 400 });
    }
    requestedById.set(id, line);
  }
  const currentIds = new Set((proposal.lines || []).map((line) => Number(line.id)));
  if (requestedById.size !== currentIds.size || [...requestedById.keys()].some((id) => !currentIds.has(id))) {
    throw Object.assign(new Error("Submit every current Transfer Order line exactly once. Refresh before retrying."), { status: 409 });
  }
  const lines = (proposal.lines || []).map((line) => {
    const requested = requestedById.get(Number(line.id));
    const converted = allocationSalesQuantity({
      quantity: requested.proposedQuantity,
      quantities: requested.quantities
    }, line);
    if (converted.quantity <= EPSILON) {
      throw Object.assign(new Error("Every revised Transfer Order line must have a quantity above zero."), { status: 400 });
    }
    return {
      ...line,
      proposedQuantity: converted.quantity,
      palletQty: converted.display.palletQty,
      layerQty: converted.display.layerQty,
      sectionQty: converted.display.sectionQty,
      pieceQty: converted.display.pieceQty,
      quantities: {
        pallets: converted.display.palletQty,
        layers: converted.display.layerQty,
        sections: converted.display.sectionQty,
        pieces: converted.display.pieceQty,
        salesQty: Object.values(line.conversions || {}).some((value) => number(value) > EPSILON)
          ? 0
          : converted.quantity
      }
    };
  });
  const pallet = calculateTransferProposalPallets(lines);
  const overrideProvided = input.palletTransferQuantity !== undefined
    && input.palletTransferQuantity !== null
    && input.palletTransferQuantity !== "";
  if (!pallet.complete && !overrideProvided && !proposal.palletQuantityOverridden) {
    throw Object.assign(new Error("Enter the required PALLET quantity because at least one item has no PLT conversion."), { status: 400 });
  }
  const palletTransferQuantity = overrideProvided
    ? number(input.palletTransferQuantity)
    : proposal.palletQuantityOverridden
      ? number(proposal.palletTransferQuantity)
      : pallet.recommendedQuantity;
  if (palletTransferQuantity + EPSILON < pallet.explicitQuantity) {
    throw Object.assign(new Error(`PALLET quantity cannot be below ${pallet.explicitQuantity}.`), { status: 400 });
  }
  return {
    lines: lines.map((line) => ({
      id: Number(line.id),
      proposedQuantity: number(line.proposedQuantity),
      palletQty: number(line.palletQty),
      layerQty: number(line.layerQty),
      sectionQty: number(line.sectionQty),
      pieceQty: number(line.pieceQty)
    })),
    calculatedPalletQuantity: pallet.calculatedQuantity,
    palletTransferQuantity,
    palletCalculationComplete: pallet.complete,
    palletQuantityOverridden: overrideProvided || proposal.palletQuantityOverridden === true
  };
}

function transferDependencyProposalWithRevisionTarget(proposal, target = {}) {
  const targetById = new Map((target.lines || []).map((line) => [Number(line.id), line]));
  return {
    ...proposal,
    calculatedPalletQuantity: number(target.calculatedPalletQuantity),
    palletTransferQuantity: number(target.palletTransferQuantity),
    palletCalculationComplete: target.palletCalculationComplete !== false,
    palletQuantityOverridden: target.palletQuantityOverridden === true,
    lines: (proposal.lines || []).map((line) => {
      const revised = targetById.get(Number(line.id));
      if (!revised) throw Object.assign(new Error("A saved quantity revision no longer matches the proposal lines."), { status: 409 });
      return {
        ...line,
        proposedQuantity: number(revised.proposedQuantity),
        palletQty: number(revised.palletQty),
        layerQty: number(revised.layerQty),
        sectionQty: number(revised.sectionQty),
        pieceQty: number(revised.pieceQty),
        quantities: {
          pallets: number(revised.palletQty),
          layers: number(revised.layerQty),
          sections: number(revised.sectionQty),
          pieces: number(revised.pieceQty),
          salesQty: Object.values(line.conversions || {}).some((value) => number(value) > EPSILON)
            ? 0
            : number(revised.proposedQuantity)
        }
      };
    })
  };
}

async function assertTransferDependencyRevisionCoverage(proposal, target) {
  if (proposal.mode !== "direct_to_customer") return;
  const salesLineIds = (proposal.lines || [])
    .filter((line) => line.lineSource !== "manual" && Number.isInteger(Number(line.salesLineId)))
    .map((line) => Number(line.salesLineId));
  if (!salesLineIds.length) return;
  await query(
    "SELECT id FROM sales_order_lines WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE",
    [salesLineIds]
  );
  const coverage = await query(
    `SELECT sl.id AS sales_line_id,
            COALESCE(sl.netsuite_backordered_qty, 0) AS backordered_quantity,
            COALESCE(SUM(CASE
              WHEN d.status <> 'cancelled' AND d.proposal_id IS DISTINCT FROM $2
              THEN dl.allocated_quantity
              ELSE 0
            END), 0) AS other_allocated_quantity
       FROM sales_order_lines sl
       LEFT JOIN order_dependency_lines dl ON dl.sales_line_id = sl.id
       LEFT JOIN order_dependencies d ON d.id = dl.dependency_id
      WHERE sl.id = ANY($1::bigint[])
      GROUP BY sl.id, sl.netsuite_backordered_qty`,
    [salesLineIds, Number(proposal.id)]
  );
  const coverageByLine = new Map(coverage.rows.map((row) => [String(row.sales_line_id), row]));
  const targetById = new Map((target.lines || []).map((line) => [Number(line.id), line]));
  for (const currentLine of proposal.lines || []) {
    if (currentLine.lineSource === "manual" || !currentLine.salesLineId) continue;
    const row = coverageByLine.get(String(currentLine.salesLineId));
    const maximum = Math.max(0, number(row?.backordered_quantity) - number(row?.other_allocated_quantity));
    const revised = targetById.get(Number(currentLine.id));
    const layerAllowance = number(revised?.layerQty) > EPSILON && number(currentLine.toLyr) > EPSILON
      ? number(currentLine.toLyr) / 2
      : 0;
    if (number(revised?.proposedQuantity) > maximum + layerAllowance + EPSILON) {
      throw Object.assign(new Error(
        `${currentLine.itemName || currentLine.itemId} revised quantity ${number(revised?.proposedQuantity)} exceeds the Sales Order backorder available to this dependency (${maximum}).`
      ), { status: 409 });
    }
  }
}

async function transferDependencyRevisionProgressState(proposalId) {
  const result = await query(
    `SELECT d.status AS dependency_status,
            COALESCE(SUM(dl.loaded_quantity), 0) AS loaded_quantity,
            COALESCE(SUM(dl.delivered_quantity), 0) AS delivered_quantity,
            COALESCE(SUM(dl.locally_received_quantity), 0) AS locally_received_quantity,
            transfer_header.last_item_fulfillment_id,
            transfer_header.last_item_receipt_id,
            transfer_header.fulfilled_at,
            transfer_header.received_at,
            COALESCE(progress.packed_quantity, 0) AS transfer_packed_quantity,
            COALESCE(progress.loaded_quantity, 0) AS transfer_loaded_quantity,
            COALESCE(progress.fulfilled_quantity, 0) AS transfer_fulfilled_quantity,
            COALESCE(progress.received_quantity, 0) AS transfer_received_quantity
       FROM scm_transfer_dependency_proposals p
       LEFT JOIN order_dependencies d ON d.proposal_id = p.id AND d.status <> 'cancelled'
       LEFT JOIN order_dependency_lines dl ON dl.dependency_id = d.id
       LEFT JOIN transfer_orders transfer_header ON transfer_header.netsuite_id = p.netsuite_transfer_order_id
       LEFT JOIN LATERAL (
         SELECT SUM(COALESCE(line.packed_pallet_qty, 0) + COALESCE(line.packed_layer_qty, 0)
                    + COALESCE(line.packed_section_qty, 0) + COALESCE(line.packed_piece_qty, 0)) AS packed_quantity,
                SUM(COALESCE(line.loaded_qty, 0)) AS loaded_quantity,
                SUM(COALESCE(line.fulfilled_pallet_qty, 0) + COALESCE(line.fulfilled_layer_qty, 0)
                    + COALESCE(line.fulfilled_section_qty, 0) + COALESCE(line.fulfilled_piece_qty, 0)) AS fulfilled_quantity,
                SUM(COALESCE(line.received_pallet_qty, 0) + COALESCE(line.received_layer_qty, 0)
                    + COALESCE(line.received_section_qty, 0) + COALESCE(line.received_piece_qty, 0)
                    + COALESCE(line.netsuite_received_qty, 0)) AS received_quantity
           FROM transfer_order_lines line
          WHERE line.transfer_order_id = p.netsuite_transfer_order_id
            AND COALESCE(line.netsuite_active, true)
       ) progress ON true
      WHERE p.id = $1
      GROUP BY p.id, d.id, d.status, transfer_header.netsuite_id,
               transfer_header.last_item_fulfillment_id, transfer_header.last_item_receipt_id,
               transfer_header.fulfilled_at, transfer_header.received_at,
               progress.packed_quantity, progress.loaded_quantity,
               progress.fulfilled_quantity, progress.received_quantity
      ORDER BY d.id DESC NULLS LAST
      LIMIT 1`,
    [Number(proposalId)]
  );
  const row = result.rows[0] || {};
  return {
    dependencyStatus: row.dependency_status,
    loadedQuantity: row.loaded_quantity,
    deliveredQuantity: row.delivered_quantity,
    locallyReceivedQuantity: row.locally_received_quantity,
    transferPackedQuantity: row.transfer_packed_quantity,
    transferLoadedQuantity: row.transfer_loaded_quantity,
    transferFulfilledQuantity: row.transfer_fulfilled_quantity,
    transferReceivedQuantity: row.transfer_received_quantity,
    lastItemFulfillmentId: row.last_item_fulfillment_id,
    lastItemReceiptId: row.last_item_receipt_id,
    fulfilledAt: row.fulfilled_at,
    receivedAt: row.received_at
  };
}

async function applyTransferDependencyRevisionLocally({
  batch,
  proposal,
  target,
  revisionId,
  targetRevision,
  operatorId
}) {
  return withTransaction(async () => {
    const locked = await query(
      `SELECT p.id, p.revision, p.revision_status, p.netsuite_transfer_order_id
         FROM scm_transfer_dependency_proposals p
        WHERE p.id = $1 AND p.batch_id = $2
        FOR UPDATE`,
      [Number(proposal.id), Number(batch.id)]
    );
    if (!locked.rowCount) throw Object.assign(new Error("Transfer proposal not found."), { status: 404 });
    const revision = await query(
      "SELECT * FROM scm_transfer_dependency_revisions WHERE id = $1 FOR UPDATE",
      [Number(revisionId)]
    );
    if (revision.rows[0]?.status === "applied") {
      return { batch: await getTransferDependencyBatch(batch.id), reused: true };
    }
    if (Number(locked.rows[0].revision) !== Number(targetRevision) - 1) {
      throw Object.assign(new Error("This Transfer Order revision changed. Refresh before retrying."), { status: 409 });
    }
    const progressBlock = transferDependencyRevisionProgressBlock(
      await transferDependencyRevisionProgressState(proposal.id)
    );
    if (progressBlock) throw Object.assign(new Error(progressBlock), { status: 409 });

    const targetById = new Map((target.lines || []).map((line) => [Number(line.id), line]));
    for (const currentLine of proposal.lines || []) {
      const line = targetById.get(Number(currentLine.id));
      const updated = await query(
        `UPDATE scm_transfer_dependency_proposal_lines
            SET proposed_quantity = $3, pallet_qty = $4, layer_qty = $5,
                section_qty = $6, piece_qty = $7, updated_at = now()
          WHERE id = $1 AND proposal_id = $2`,
        [Number(currentLine.id), Number(proposal.id), number(line.proposedQuantity),
          number(line.palletQty), number(line.layerQty), number(line.sectionQty), number(line.pieceQty)]
      );
      if (updated.rowCount !== 1) throw new Error("A Transfer Order line changed while applying the revision.");
    }

    const dependency = await query(
      `SELECT id FROM order_dependencies
        WHERE proposal_id = $1 AND status <> 'cancelled'
        ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [Number(proposal.id)]
    );
    if (!dependency.rowCount) throw new Error("The linked order dependency is missing.");
    const transferLines = await transferLinesForOrder(locked.rows[0].netsuite_transfer_order_id);
    for (const currentLine of proposal.lines || []) {
      const line = targetById.get(Number(currentLine.id));
      const role = currentLine.lineSource === "manual" || !currentLine.salesLineId
        ? "manual_transfer"
        : "sales_allocation";
      const outbound = transferLines.find((candidate) => candidate.line_stage === "outbound"
        && String(candidate.item_id) === String(currentLine.itemId));
      const receiving = transferLines.find((candidate) => candidate.line_stage === "receiving"
        && String(candidate.item_id) === String(currentLine.itemId));
      const params = [dependency.rows[0].id, currentLine.salesLineId || null, currentLine.itemId, role,
        number(line.proposedQuantity), number(line.palletQty), number(line.layerQty),
        number(line.sectionQty), number(line.pieceQty), outbound?.id || null, receiving?.id || null];
      const updated = await query(
        `UPDATE order_dependency_lines
            SET allocated_quantity = $5, pallet_qty = $6, layer_qty = $7,
                section_qty = $8, piece_qty = $9,
                transfer_outbound_line_id = $10, transfer_receiving_line_id = $11,
                updated_at = now()
          WHERE dependency_id = $1
            AND item_id = $3
            AND line_role = $4
            AND (($2::bigint IS NULL AND sales_line_id IS NULL) OR sales_line_id = $2)`,
        params
      );
      if (updated.rowCount !== 1) throw new Error(`The linked dependency line for ${currentLine.itemName || currentLine.itemId} could not be revised exactly once.`);
    }
    const explicitPalletQuantity = (proposal.lines || []).reduce((total, currentLine) => (
      isPalletItem(currentLine) ? total + number(targetById.get(Number(currentLine.id))?.proposedQuantity) : total
    ), 0);
    const ancillaryPalletQuantity = Math.max(0, number(target.palletTransferQuantity) - explicitPalletQuantity);
    const existingPallet = await query(
      `SELECT id FROM order_dependency_lines
        WHERE dependency_id = $1 AND line_role = 'pallet'
        ORDER BY id LIMIT 1 FOR UPDATE`,
      [dependency.rows[0].id]
    );
    if (ancillaryPalletQuantity > EPSILON) {
      const palletOutbound = transferLines.find((candidate) => candidate.line_stage === "outbound"
        && String(candidate.item_id) === String(proposal.palletItemId));
      const palletReceiving = transferLines.find((candidate) => candidate.line_stage === "receiving"
        && String(candidate.item_id) === String(proposal.palletItemId));
      if (existingPallet.rowCount) {
        await query(
          `UPDATE order_dependency_lines
              SET allocated_quantity = $2, piece_qty = $2,
                  transfer_outbound_line_id = $3, transfer_receiving_line_id = $4,
                  updated_at = now()
            WHERE id = $1`,
          [existingPallet.rows[0].id, ancillaryPalletQuantity, palletOutbound?.id || null, palletReceiving?.id || null]
        );
      } else {
        await query(
          `INSERT INTO order_dependency_lines (
             dependency_id, sales_line_id, transfer_outbound_line_id, transfer_receiving_line_id,
             item_id, item_name, unit, allocated_quantity, pallet_qty, layer_qty,
             section_qty, piece_qty, line_role
           ) VALUES ($1, null, $2, $3, $4, $5, 'EACH', $6, 0, 0, 0, $6, 'pallet')`,
          [dependency.rows[0].id, palletOutbound?.id || null, palletReceiving?.id || null,
            proposal.palletItemId, proposal.palletItemName || "PALLET", ancillaryPalletQuantity]
        );
      }
    } else if (existingPallet.rowCount) {
      await query("DELETE FROM order_dependency_lines WHERE id = $1", [existingPallet.rows[0].id]);
    }

    await query(
      `UPDATE scm_transfer_dependency_proposals
          SET revision = $2, revision_status = 'idle', revision_request_id = NULL,
              revision_started_at = NULL, revision_error = NULL,
              calculated_pallet_qty = $3, pallet_transfer_qty = $4,
              pallet_calculation_complete = $5, pallet_qty_overridden = $6,
              quantity_verification_status = 'pending', quantity_verification_error = NULL,
              quantity_verified_at = NULL, quantity_verified_by = NULL,
              print_job_id = NULL, print_request_status = 'idle',
              print_request_id = NULL, print_request_started_at = NULL,
              print_request_error = NULL, updated_at = now()
        WHERE id = $1`,
      [Number(proposal.id), Number(targetRevision), number(target.calculatedPalletQuantity),
        number(target.palletTransferQuantity), target.palletCalculationComplete !== false,
        target.palletQuantityOverridden === true]
    );
    await query(
      `UPDATE scm_transfer_dependency_revisions
          SET status = 'applied', error = NULL, applied_at = now(), updated_at = now()
        WHERE id = $1`,
      [Number(revisionId)]
    );
    const shortageRows = await salesOrderShortageRows(batch.salesOrderId);
    const uncovered = shortageRows.reduce((total, row) => total + number(row.unresolved_quantity), 0);
    await query(
      `UPDATE scm_transfer_dependency_batches
          SET uncovered_shortage_qty = $2, updated_by = $3, updated_at = now()
        WHERE id = $1`,
      [Number(batch.id), uncovered, operatorId]
    );
    await writeDispatchAudit({
      action: "scm.transfer_dependency.quantity_revised",
      source: "scm",
      entityType: "transfer_dependency_proposal",
      entityId: String(proposal.id),
      orderId: proposal.transferOrderRef,
      operatorId,
      details: {
        batchId: batch.id,
        salesOrderRef: batch.salesOrderRef,
        transferOrderId: proposal.transferOrderId,
        revision: targetRevision,
        printInvalidated: Boolean(proposal.printJob)
      }
    });
    return { batch: await getTransferDependencyBatch(batch.id), reused: false };
  });
}

export async function reviseTransferDependencyProposal(batchId, proposalId, input = {}, {
  operatorId = null,
  inspectTransferOrder,
  updateTransferOrder,
  hydrateTransferOrder
} = {}) {
  if (typeof inspectTransferOrder !== "function" || typeof updateTransferOrder !== "function"
      || typeof hydrateTransferOrder !== "function") {
    throw new Error("NetSuite Transfer Order revision transport is unavailable.");
  }
  const resolvedBatchId = Number(batchId);
  const resolvedProposalId = Number(proposalId);
  const requestId = text(input.requestId);
  if (!Number.isInteger(resolvedBatchId) || resolvedBatchId <= 0
      || !Number.isInteger(resolvedProposalId) || resolvedProposalId <= 0) {
    throw Object.assign(new Error("A valid dependency batch and proposal are required."), { status: 400 });
  }
  if (!requestId || requestId.length > 200) {
    throw Object.assign(new Error("A stable quantity-revision request ID is required."), { status: 400 });
  }
  let batch = await getTransferDependencyBatch(resolvedBatchId);
  if (!batch) throw Object.assign(new Error("Dependency batch not found."), { status: 404 });
  let proposal = batch.proposals.find((row) => Number(row.id) === resolvedProposalId);
  if (!proposal) throw Object.assign(new Error("Transfer proposal not found."), { status: 404 });
  if (!["created", "attention"].includes(proposal.creationStatus) || !proposal.transferOrderId) {
    throw Object.assign(new Error("Create the NetSuite Transfer Order before revising its quantities."), { status: 409 });
  }

  const sameRequest = await query(
    `SELECT * FROM scm_transfer_dependency_revisions
      WHERE proposal_id = $1 AND request_id = $2`,
    [resolvedProposalId, requestId]
  );
  if (sameRequest.rows[0]?.status === "applied") {
    return { batch, reused: true, recovered: false };
  }
  let expectedRevision;
  let target;
  if (sameRequest.rowCount && ["updating", "attention"].includes(sameRequest.rows[0].status)) {
    expectedRevision = Number(sameRequest.rows[0].expected_revision);
    target = sameRequest.rows[0].request_payload;
  } else {
    expectedRevision = Number(input.expectedRevision);
    if (!Number.isInteger(expectedRevision) || expectedRevision <= 0) {
      throw Object.assign(new Error("The current Transfer Order revision is required."), { status: 400 });
    }
    target = transferDependencyRevisionTarget(proposal, input);
  }
  const targetPayload = JSON.stringify(target);
  let revisionClaim;
  await withTransaction(async () => {
    const locked = await query(
      `SELECT id, revision, revision_status, revision_request_id
         FROM scm_transfer_dependency_proposals
        WHERE id = $1 AND batch_id = $2
        FOR UPDATE`,
      [resolvedProposalId, resolvedBatchId]
    );
    if (!locked.rowCount) throw Object.assign(new Error("Transfer proposal not found."), { status: 404 });
    const existingSameRequest = await query(
      `SELECT * FROM scm_transfer_dependency_revisions
        WHERE proposal_id = $1 AND request_id = $2 FOR UPDATE`,
      [resolvedProposalId, requestId]
    );
    if (existingSameRequest.rowCount) {
      revisionClaim = existingSameRequest.rows[0];
      return;
    }
    const active = await query(
      `SELECT *, request_payload = $2::jsonb AS payload_matches
         FROM scm_transfer_dependency_revisions
        WHERE proposal_id = $1 AND status IN ('updating', 'attention')
        ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [resolvedProposalId, targetPayload]
    );
    if (active.rowCount) {
      if (Number(active.rows[0].expected_revision) !== expectedRevision
          || active.rows[0].payload_matches !== true) {
        throw Object.assign(new Error("Another quantity revision needs recovery. Refresh before changing this Transfer Order."), { status: 409 });
      }
      revisionClaim = active.rows[0];
      return;
    }
    if (Number(locked.rows[0].revision) !== expectedRevision) {
      throw Object.assign(new Error("This Transfer Order revision changed. Refresh and review the latest quantities."), { status: 409 });
    }
    const progressBlock = transferDependencyRevisionProgressBlock(
      await transferDependencyRevisionProgressState(resolvedProposalId)
    );
    if (progressBlock) throw Object.assign(new Error(progressBlock), { status: 409 });
    await assertTransferDependencyRevisionCoverage(proposal, target);
    const inserted = await query(
      `INSERT INTO scm_transfer_dependency_revisions (
         proposal_id, request_id, expected_revision, target_revision,
         status, request_payload, requested_by
       ) VALUES ($1, $2, $3, $4, 'updating', $5::jsonb, $6)
       RETURNING *`,
      [resolvedProposalId, requestId, expectedRevision, expectedRevision + 1, targetPayload, operatorId]
    );
    revisionClaim = inserted.rows[0];
    await query(
      `UPDATE scm_transfer_dependency_proposals
          SET revision_status = 'updating', revision_request_id = $2,
              revision_started_at = now(), revision_error = NULL, updated_at = now()
        WHERE id = $1`,
      [resolvedProposalId, revisionClaim.request_id]
    );
  });
  if (revisionClaim.status === "applied") return { batch: await getTransferDependencyBatch(resolvedBatchId), reused: true };
  target = revisionClaim.request_payload;
  proposal = transferDependencyProposalWithRevisionTarget(proposal, target);
  let mutationAttempted = false;
  try {
    let inspection = await inspectTransferOrder({ proposal, batch, transferOrderId: proposal.transferOrderId });
    if (inspection?.revisionStatusBlock) {
      throw Object.assign(new Error(inspection.revisionStatusBlock), { status: 409 });
    }
    if (!inspection?.matches) {
      mutationAttempted = true;
      await updateTransferOrder({ proposal, batch, transferOrderId: proposal.transferOrderId });
      await hydrateTransferOrder(proposal.transferOrderId, proposal);
      inspection = await inspectTransferOrder({ proposal, batch, transferOrderId: proposal.transferOrderId });
    }
    if (inspection?.revisionStatusBlock) {
      throw Object.assign(new Error(inspection.revisionStatusBlock), { status: 409 });
    }
    if (!inspection?.matches) {
      const mismatchText = (inspection?.mismatches || []).slice(0, 8).join("; ") || "NetSuite quantities did not match";
      throw new Error(`TO quantity revision verification failed: ${mismatchText}`);
    }
    const result = await applyTransferDependencyRevisionLocally({
      batch,
      proposal,
      target,
      revisionId: revisionClaim.id,
      targetRevision: revisionClaim.target_revision,
      operatorId
    });
    return { ...result, recovered: !mutationAttempted };
  } catch (error) {
    await withTransaction(async () => {
      await query(
        `UPDATE scm_transfer_dependency_revisions
            SET status = 'attention', error = $2, updated_at = now()
          WHERE id = $1 AND status <> 'applied'`,
        [Number(revisionClaim.id), error.message]
      );
      await query(
        `UPDATE scm_transfer_dependency_proposals
            SET revision_status = 'attention', revision_error = $2, updated_at = now()
          WHERE id = $1 AND revision < $3`,
        [resolvedProposalId, error.message, Number(revisionClaim.target_revision)]
      );
    });
    throw error;
  }
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
    const allowSourceBackorder = selected.every((proposal) => proposal.allow_source_backorder === true);

    const replacement = await query(
      `INSERT INTO scm_transfer_dependency_proposals (
         batch_id, proposal_key, dependency_mode, from_location_id, from_location,
         to_location_id, to_location, memo, route_minutes,
         priority_penalty_minutes, route_score, calculated_pallet_qty,
         pallet_transfer_qty, pallet_calculation_complete, pallet_qty_overridden,
         pallet_item_id, pallet_item_name, allow_source_backorder
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       RETURNING id`,
      [resolvedBatchId, replacementKey, template.dependency_mode,
        template.from_location_id, template.from_location, template.to_location_id, template.to_location,
        template.memo, template.route_minutes, template.priority_penalty_minutes, template.route_score,
        pallet.calculatedQuantity, finalPalletQuantity, pallet.complete, hasManualPalletOverride,
        palletItemId, palletItemName, allowSourceBackorder]
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
  const addRequestedSourceQuantity = ({ proposal, itemId, itemName, quantity }) => {
    const normalizedItemId = Number(itemId);
    const normalizedLocationId = Number(proposal.fromLocationId);
    if (!Number.isInteger(normalizedItemId) || !Number.isInteger(normalizedLocationId)) return;
    const requested = number(quantity);
    if (requested <= EPSILON) return;
    const key = `${normalizedItemId}:${normalizedLocationId}`;
    const entry = requestedBySource.get(key) || {
      itemId: normalizedItemId,
      itemName: text(itemName) || String(normalizedItemId),
      locationId: normalizedLocationId,
      requestedQuantity: 0,
      backorderEligibleQuantity: 0,
      proposalIds: new Set(),
      backorderProposalIds: new Set()
    };
    entry.requestedQuantity += requested;
    entry.proposalIds.add(Number(proposal.id));
    if (proposal.allowSourceBackorder === true) {
      entry.backorderEligibleQuantity += requested;
      entry.backorderProposalIds.add(Number(proposal.id));
    }
    requestedBySource.set(key, entry);
  };
  for (const proposal of pendingProposals) {
    for (const line of proposal.lines || []) {
      if (isPalletItem(line)) continue;
      addRequestedSourceQuantity({
        proposal,
        itemId: line.itemId,
        itemName: line.itemName,
        quantity: line.proposedQuantity
      });
    }
    const palletItemId = Number(proposal.palletItemId);
    if (Number.isInteger(palletItemId) && number(proposal.palletTransferQuantity) > EPSILON) {
      addRequestedSourceQuantity({
        proposal,
        itemId: palletItemId,
        itemName: proposal.palletItemName || "PALLET",
        quantity: proposal.palletTransferQuantity
      });
    }
  }
  const sourceBackorders = [];
  for (const [key, request] of requestedBySource) {
    const sourceAvailability = availableBySource.get(key) || {};
    const decision = transferDependencySourceBackorderDecision({
      requestedQuantity: request.requestedQuantity,
      backorderEligibleQuantity: request.backorderEligibleQuantity,
      availableQuantity: sourceAvailability.available
    });
    const yard = YARD_BY_ID.get(String(request.locationId));
    if (!decision.allowed) {
      const policy = sourceAvailability.overridden
        ? " after applying the selected full NetSuite Available override"
        : "";
      const protectedText = decision.backorderEligibleQuantity > EPSILON
        ? `protected proposed ${decision.protectedQuantity}`
        : `proposed ${decision.requestedQuantity}`;
      throw new Error(`${yard?.code || request.locationId} has ${decision.availableQuantity} available${policy} for ${request.itemName}, below the ${protectedText}.`);
    }
    if (decision.backorderQuantity > EPSILON) {
      sourceBackorders.push({
        itemId: request.itemId,
        itemName: request.itemName,
        locationId: request.locationId,
        location: yard?.code || String(request.locationId),
        requestedQuantity: decision.requestedQuantity,
        availableQuantity: decision.availableQuantity,
        backorderQuantity: decision.backorderQuantity,
        proposalIds: [...request.backorderProposalIds].filter(Number.isInteger).sort((left, right) => left - right)
      });
    }
  }
  const currentShortage = shortageRows.reduce((total, row) => total + number(row.unresolved_quantity), 0);
  const destinationCoverage = pendingProposals
    .filter((proposal) => String(proposal.toLocationId) === String(batch.outboundLocationId))
    .flatMap((proposal) => proposal.lines || [])
    .filter((line) => line.lineSource !== "manual")
    .reduce((total, line) => total + number(line.proposedQuantity), 0);
  return {
    uncovered: Math.max(0, currentShortage - destinationCoverage),
    pendingProposals,
    sourceBackorders
  };
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
  approveTransferOrder = null,
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
  if (requestedProposal
      && ["created", "attention"].includes(requestedProposal.creationStatus)
      && requestedProposal.transferOrderId
      && requestedProposal.approvalStatus === "approved") {
    return {
      batch,
      results: [{ proposalId: requestedProposal.id, status: requestedProposal.creationStatus,
        transferOrderId: requestedProposal.transferOrderId, transferOrderRef: requestedProposal.transferOrderRef, reused: true }]
    };
  }
  const validation = await validateTransferDependencyBatchForCreation(batch, {
    proposalIds: requestedProposal ? [requestedProposal.id] : null
  });
  const recoverableProposals = (batch.proposals || []).filter((proposal) => (
    ["created", "attention"].includes(proposal.creationStatus)
    && proposal.transferOrderId
    && proposal.approvalStatus !== "approved"
    && (!requestedProposal || String(proposal.id) === String(requestedProposal.id))
  ));
  validation.pendingProposals = [
    ...recoverableProposals,
    ...validation.pendingProposals.filter((proposal) =>
      !recoverableProposals.some((candidate) => String(candidate.id) === String(proposal.id)))
  ];
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
    let createdTransferOrderId = Number(proposal.transferOrderId) || null;
    let createdTransferOrderRef = proposal.transferOrderRef || null;
    let approvalConfirmed = proposal.approvalStatus === "approved";
    try {
      let created = createdTransferOrderId
        ? { id: createdTransferOrderId, recovered: true }
        : null;
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
      const transferOrder = await ensureTransferDependencyPendingFulfillment({
        created,
        proposal,
        batch,
        hydrateTransferOrder,
        approveTransferOrder,
        rememberTransferOrder: async (identified) => {
          createdTransferOrderRef = identified.tranid;
          await query(
            `UPDATE scm_transfer_dependency_proposals
                SET creation_status = 'creating', creation_error = NULL,
                    netsuite_transfer_order_id = $2,
                    netsuite_transfer_order_ref = $3,
                    approval_status = 'approving', approval_error = NULL,
                    updated_at = now()
              WHERE id = $1`,
            [proposal.id, identified.id, identified.tranid]
          );
        }
      });
      const outcome = transferDependencyCreationOutcome(transferOrder);
      approvalConfirmed = outcome.pendingFulfillment;
      await query(
        `UPDATE scm_transfer_dependency_proposals
            SET creation_status = $4, netsuite_transfer_order_id = $2,
                netsuite_transfer_order_ref = $3, creation_error = $5,
                approval_status = $6,
                approval_error = $5,
                approved_at = CASE WHEN $6 = 'approved' THEN COALESCE(approved_at, now()) ELSE NULL END,
                approved_by = CASE WHEN $6 = 'approved' THEN COALESCE(approved_by, $7) ELSE NULL END,
                quantity_verification_status = 'pending',
                quantity_verification_error = NULL,
                quantity_verified_at = NULL, quantity_verified_by = NULL,
                print_job_id = NULL, print_request_status = 'idle',
                print_request_id = NULL, print_request_started_at = NULL,
                print_request_error = NULL,
                updated_at = now()
          WHERE id = $1`,
        [proposal.id, transferOrder.id, transferOrder.tranid, outcome.creationStatus,
          outcome.statusMessage, outcome.approvalStatus, operatorId]
      );
      const dependencyId = await createDependencyFromProposal(proposal, batch, transferOrder, operatorId);
      if (!outcome.pendingFulfillment) {
        await query(
          `UPDATE order_dependencies
              SET status = 'attention', attention_reason = $2, updated_by = $3, updated_at = now()
            WHERE id = $1`,
          [dependencyId, outcome.statusMessage, operatorId]
        );
      }
      results.push({ proposalId: proposal.id, status: outcome.creationStatus, transferOrderId: transferOrder.id,
        transferOrderRef: transferOrder.tranid, netsuiteStatus: transferOrder.statusText || transferOrder.status,
        approvalStatus: outcome.approvalStatus, printStatus: outcome.printStatus,
        recovered: created?.recovered === true, error: outcome.statusMessage });
    } catch (error) {
      if (error.status === 409) throw error;
      await query(
        `UPDATE scm_transfer_dependency_proposals
            SET creation_status = $3, creation_error = $2,
                netsuite_transfer_order_id = COALESCE(netsuite_transfer_order_id, $4),
                netsuite_transfer_order_ref = COALESCE(netsuite_transfer_order_ref, $5),
                approval_status = CASE
                  WHEN $6::boolean THEN 'approved'
                  WHEN $4::bigint IS NOT NULL THEN 'failed'
                  ELSE approval_status
                END,
                approval_error = CASE
                  WHEN $6::boolean THEN NULL
                  WHEN $4::bigint IS NOT NULL THEN $2
                  ELSE approval_error
                END,
                updated_at = now()
          WHERE id = $1`,
        [proposal.id, error.message, createdTransferOrderId ? "attention" : "failed",
          createdTransferOrderId, createdTransferOrderRef, approvalConfirmed]
      );
      results.push({ proposalId: proposal.id, status: createdTransferOrderId ? "attention" : "failed",
        transferOrderId: createdTransferOrderId, transferOrderRef: createdTransferOrderRef,
        approvalStatus: approvalConfirmed ? "approved" : createdTransferOrderId ? "failed" : "pending",
        error: error.message });
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
      sourceBackorders: validation.sourceBackorders,
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
  return {
    batch: await getTransferDependencyBatch(batchId),
    results,
    sourceBackorders: validation.sourceBackorders
  };
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
    await query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`order-dependency:${targetRef.toLowerCase()}`]
    );
    const resolved = await resolveDispatchSalesTarget({ dispatchTargetRef: targetRef, planDate });
    const transfer = await query(
      "SELECT * FROM transfer_orders WHERE tranid = $1 FOR UPDATE",
      [text(transferOrderRef)]
    );
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
      `SELECT id, status, dependency_mode,
              COALESCE(dispatch_target_ref, sales_order_ref) AS dispatch_target_ref
         FROM order_dependencies
        WHERE transfer_order_id = $1 AND status <> 'cancelled'
        FOR UPDATE`,
      [transfer.rows[0].netsuite_id]
    );
    const existingDependency = active.rows[0] || null;
    if (existingDependency && existingDependency.dispatch_target_ref !== resolved.target.ref) {
      throw Object.assign(
        new Error(`${transferOrderRef} is already linked to ${existingDependency.dispatch_target_ref}.`),
        {
          status: 409,
          code: "TO_ALREADY_LINKED_ELSEWHERE",
          linkedTargetRef: existingDependency.dispatch_target_ref
        }
      );
    }
    if (existingDependency && existingDependency.dependency_mode !== normalizedMode) {
      throw Object.assign(
        new Error(
          `${transferOrderRef} is already linked to ${resolved.target.ref} as ${existingDependency.dependency_mode}. Change its mode separately before adding quantity.`
        ),
        {
          status: 409,
          code: "DEPENDENCY_MODE_MISMATCH",
          currentMode: existingDependency.dependency_mode,
          requestedMode: normalizedMode
        }
      );
    }
    if (existingDependency && existingDependency.status !== "active") {
      throw Object.assign(
        new Error(`${transferOrderRef} is ${existingDependency.status} and cannot accept more linked quantity.`),
        { status: 409, code: "DEPENDENCY_NOT_EXTENDABLE" }
      );
    }
    const existingLines = existingDependency ? await query(
      `SELECT *
         FROM order_dependency_lines
        WHERE dependency_id = $1
        FOR UPDATE`,
      [existingDependency.id]
    ) : { rows: [] };
    if (existingLines.rows.some((line) => (
      number(line.loaded_quantity) > EPSILON
      || number(line.delivered_quantity) > EPSILON
      || number(line.locally_received_quantity) > EPSILON
    ))) {
      throw Object.assign(
        new Error("This dependency has already started and cannot accept more linked quantity."),
        { status: 409, code: "DEPENDENCY_EXECUTION_STARTED" }
      );
    }
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
    const requestedByTargetLine = new Map();
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
      const requestedForTargetLine = number(requestedByTargetLine.get(targetLine.targetLineKey)) + qty;
      if (requestedForTargetLine > availableShortage + EPSILON) {
        throw new Error(`${targetLine.itemName || itemId} allocation ${requestedForTargetLine} exceeds ${targetRef} remaining quantity ${availableShortage}.`);
      }
      requestedByTargetLine.set(targetLine.targetLineKey, requestedForTargetLine);
      requestedByItem.set(String(itemId), number(requestedByItem.get(String(itemId))) + qty);
      normalized.push({
        targetLine,
        outbound,
        receiving,
        qty,
        display: requestedQuantity.display
      });
    }
    const existingAllocatedByItem = new Map();
    for (const line of existingLines.rows.filter((entry) => entry.line_role === "sales_allocation")) {
      const key = String(line.item_id);
      existingAllocatedByItem.set(key, number(existingAllocatedByItem.get(key)) + number(line.allocated_quantity));
    }
    for (const [itemId, requestedQuantity] of requestedByItem) {
      const available = Math.max(
        0,
        number(outboundByItem.get(itemId)?.quantity) - number(existingAllocatedByItem.get(itemId))
      );
      if (requestedQuantity > available + EPSILON) {
        const itemName = normalized.find((entry) => String(entry.targetLine.itemId) === itemId)?.targetLine.itemName || itemId;
        throw new Error(`${itemName} allocation ${requestedQuantity} exceeds ${transferOrderRef} quantity ${available}.`);
      }
    }
    const anchor = normalized[0].targetLine;
    const dependencyId = existingDependency?.id || (await query(
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
    )).rows[0].id;
    for (const entry of normalized) {
      const existingLine = existingLines.rows.find((line) => (
        line.line_role === "sales_allocation"
        && line.dispatch_target_line_key === entry.targetLine.targetLineKey
      ));
      if (existingLine) {
        await query(
          `UPDATE order_dependency_lines
              SET allocated_quantity = allocated_quantity + $2,
                  pallet_qty = pallet_qty + $3,
                  layer_qty = layer_qty + $4,
                  section_qty = section_qty + $5,
                  piece_qty = piece_qty + $6,
                  updated_at = now()
            WHERE id = $1`,
          [existingLine.id, entry.qty, entry.display.palletQty, entry.display.layerQty,
            entry.display.sectionQty, entry.display.pieceQty]
        );
      } else {
        await query(
          `INSERT INTO order_dependency_lines (
             dependency_id, sales_line_id, transfer_outbound_line_id, transfer_receiving_line_id,
             item_id, item_name, unit, allocated_quantity, pallet_qty, layer_qty, section_qty, piece_qty,
             line_role, dispatch_target_line_key
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'sales_allocation', $13)`,
          [dependencyId, entry.targetLine.salesLineId, entry.outbound.id, entry.receiving?.id || null,
            entry.targetLine.itemId, entry.targetLine.itemName, entry.targetLine.unit, entry.qty,
            entry.display.palletQty, entry.display.layerQty, entry.display.sectionQty, entry.display.pieceQty,
            entry.targetLine.targetLineKey]
        );
      }
    }
    if (existingDependency) {
      await query(
        `UPDATE order_dependencies
            SET updated_by = $2, updated_at = now()
          WHERE id = $1`,
        [dependencyId, operatorId]
      );
    }
    await writeDispatchAudit({
      action: existingDependency
        ? "dispatch.order_dependency.extended"
        : "dispatch.order_dependency.linked",
      entityType: "order_dependency",
      entityId: String(dependencyId),
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
    const saved = (await loadDependencies({ salesOrderRef: resolved.target.ref }))
      .find((row) => String(row.id) === String(dependencyId));
    return {
      ...saved,
      effectiveAction: existingDependency ? "extend_to" : "link_to"
    };
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
    const salesRefs = dispatchOrderRefs({ ...order, id: ref });
    const salesDependencies = [...new Map(
      salesRefs.flatMap((salesRef) => bySales.get(salesRef) || [])
        .map((dependency) => [String(dependency.id), dependency])
    ).values()];
    const uncoveredQuantity = salesRefs.reduce((total, salesRef) => total + number(uncoveredBySales.get(salesRef)), 0);
    const transferDependency = byTransfer.get(ref);
    if (salesDependencies.length || uncoveredQuantity > EPSILON) {
      const direct = salesDependencies.filter((dependency) => dependency.mode === "direct_to_customer" && dependency.status !== "cancelled");
      const replenishment = salesDependencies.filter((dependency) => dependency.mode === "yard_replenishment" && dependency.status !== "cancelled");
      const waitingReplenishment = replenishment.filter((dependency) => !dependency.transferReceived);
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
        pickupLocations: uniqueDispatchLocations([
          ...(Array.isArray(order.pickupLocations) ? order.pickupLocations : [order.sourceYard].filter(Boolean)),
          ...directPickupManifest.map((entry) => entry.location).filter(Boolean)
        ]),
        orderDependencies: salesDependencies,
        dependencyDirectPickup: direct.length > 0,
        dependencyWaitingForTransfer: waitingReplenishment.length > 0,
        dependencyAttention: salesDependencies.some((dependency) =>
          dependency.status === "attention" && !dependency.transferReceived
        ),
        dependencyUncovered: uncoveredQuantity > EPSILON,
        dependencyUncoveredQuantity: uncoveredQuantity,
        directPickupManifest,
        dependencyLabels: [...new Set([
          ...salesDependencies.map((dependency) => `Requires ${dependency.transferOrderRef}`),
          ...(direct.length ? ["Direct pickup"] : []),
          ...(waitingReplenishment.length ? ["Waiting for transfer"] : []),
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

function loadSequenceAssignments(plan = {}) {
  const assignmentsByRef = new Map();
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
        const pickupLocations = uniqueDispatchLocations((Array.isArray(order.pickupLocations) && order.pickupLocations.length
          ? order.pickupLocations
          : [order.sourceYard || order.outboundLocation].filter(Boolean)).map(text).filter(Boolean));
        const pickupSequences = sequencedStops
          .filter((entry) => entry.stop.type === "pick"
            && pickupLocations.some((location) => dispatchLocationsShareYard(location, entry.stop.location)))
          .map((entry) => entry.sequence);
        const pickupArrivals = sequencedStops
          .filter((entry) => entry.stop.type === "pick"
            && pickupLocations.some((location) => dispatchLocationsShareYard(location, entry.stop.location)))
          .map((entry) => entry.arrival)
          .filter(Number.isFinite);
        const assignment = {
          orderRef: text(stop.orderId),
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
        for (const ref of dispatchOrderRefs(order)) {
          if (!assignmentsByRef.has(ref)) assignmentsByRef.set(ref, []);
          assignmentsByRef.get(ref).push(assignment);
        }
      }
    }
  }
  return assignmentsByRef;
}

function loadSequenceIndexFromAssignments(assignmentsByRef = new Map()) {
  return new Map(
    [...assignmentsByRef.entries()]
      .filter(([, assignments]) => assignments.length)
      .map(([ref, assignments]) => [ref, assignments[assignments.length - 1]])
  );
}

function loadSequenceIndex(plan = {}) {
  return loadSequenceIndexFromAssignments(loadSequenceAssignments(plan));
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
  const assignmentsByRef = loadSequenceAssignments(plan);
  const current = loadSequenceIndexFromAssignments(assignmentsByRef);
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
    const salesAssignments = assignmentsByRef.get(plannedSalesRef) || [];
    const salesAssignment = current.get(plannedSalesRef);
    if (dependency.mode === "yard_replenishment" && dependency.transferReceived) continue;
    if (dependency.status === "attention") {
      if (salesAssignments.length) conflicts.push(`${plannedSalesRef}: ${dependency.attentionReason || `${dependency.transferOrderRef} requires attention`}.`);
      continue;
    }
    if (!salesAssignments.length) continue;
    if (dependency.mode === "direct_to_customer") {
      const assignedLoad = (plan.trucks || []).flatMap((truck) => truck.loads || [])
        .find((load) => String(load.id || "") === String(salesAssignment.loadId || ""));
      const dropIndex = (assignedLoad?.stops || []).findIndex((stop) => {
        if (stop.type !== "drop") return false;
        const order = (plan.orders || []).find((entry) => dispatchOrderRefs(entry).includes(String(stop.orderId || "")));
        return order ? dispatchOrderRefs(order).includes(plannedSalesRef) : String(stop.orderId || "") === plannedSalesRef;
      });
      const pickupIndex = (assignedLoad?.stops || []).findIndex((stop) =>
        stop.type === "pick" && dispatchLocationsShareYard(stop.location, dependency.sourceLocation)
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
    const complete = dependency.transferReceived
      || transferOrderReceiptEvidenceComplete(transferRow);
    if (complete) continue;
    if (priorTransferRefs.has(dependency.transferOrderRef)) continue;
    if (everySalesAssignmentFollowsTransfer(
      transferAssignment,
      salesAssignments,
      replenishmentTransferPrecedesSales
    )) continue;
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

export async function markDirectDependencyPickupCompleted({
  transferOrderRefs = [],
  driverJobId = "",
  driverLogin = "",
  planId = null,
  planDate = "",
  truckPlate = "",
  loadId = ""
} = {}) {
  const refs = [...new Set((transferOrderRefs || []).map(text).filter(Boolean))];
  if (!refs.length) return [];
  const jobId = text(driverJobId);
  if (!jobId) throw new Error("Direct pickup completion requires completed Driver pickup evidence.");
  return withTransaction(async () => {
    const completedJobResult = await query(
      `SELECT job_id, plan_id, plan_date, driver_login, truck_plate, load_id,
              stop_type, order_refs, photo_data_urls, status, completed_at, job_details
         FROM driver_job_records
        WHERE job_id = $1
        LIMIT 1
        FOR UPDATE`,
      [jobId]
    );
    const completedJob = completedJobResult.rows[0];
    if (
      !completedJob
      || completedJob.status !== "complete"
      || completedJob.stop_type !== "pickup"
      || !completedJob.completed_at
    ) {
      throw new Error("Direct pickup completion requires completed Driver pickup evidence.");
    }
    if (
      driverLogin
      && text(completedJob.driver_login).toLowerCase() !== text(driverLogin).toLowerCase()
    ) throw new Error("The completed Driver pickup belongs to another driver.");
    if (
      planId !== null
      && planId !== undefined
      && planId !== ""
      && text(completedJob.plan_id) !== text(planId)
    ) throw new Error("The completed Driver pickup belongs to another dispatch plan.");
    if (planDate && dateText(completedJob.plan_date) !== dateText(planDate)) {
      throw new Error("The completed Driver pickup belongs to another plan date.");
    }
    if (
      truckPlate
      && normalizedToken(completedJob.truck_plate) !== normalizedToken(truckPlate)
    ) throw new Error("The completed Driver pickup belongs to another truck.");
    if (loadId && text(completedJob.load_id) !== text(loadId)) {
      throw new Error("The completed Driver pickup belongs to another load.");
    }

    const completedRefs = new Set((completedJob.order_refs || []).map(text).filter(Boolean));
    const directEvidenceRefs = new Set(
      (Array.isArray(completedJob.job_details?.orders) ? completedJob.job_details.orders : [])
        .filter((order) => text(order?.source) === "direct_dependency")
        .map((order) => text(order?.orderRef))
        .filter(Boolean)
    );
    const unprovenRefs = refs.filter((ref) => !completedRefs.has(ref) || !directEvidenceRefs.has(ref));
    if (unprovenRefs.length) {
      throw new Error(`The completed Driver pickup does not contain direct-route evidence for ${unprovenRefs.join(", ")}.`);
    }
    const requiredPhotos = Math.max(0, Number(completedJob.job_details?.requiredPhotos || 0));
    const photoCount = Array.isArray(completedJob.photo_data_urls)
      ? completedJob.photo_data_urls.length
      : 0;
    if (photoCount < requiredPhotos) {
      throw new Error(`The completed Driver pickup is missing ${requiredPhotos - photoCount} required photo${requiredPhotos - photoCount === 1 ? "" : "s"}.`);
    }

    const rows = await query(
      `SELECT id, transfer_order_ref, status, attention_reason,
              planned_plan_id, planned_date, planned_truck_plate,
              planned_load_id, planned_load_name
         FROM order_dependencies
        WHERE transfer_order_ref = ANY($1::text[])
          AND dependency_mode = 'direct_to_customer'
          AND status <> 'cancelled'
        FOR UPDATE`,
      [refs]
    );
    const byRef = new Map(rows.rows.map((row) => [text(row.transfer_order_ref), row]));
    const missingRefs = refs.filter((ref) => !byRef.has(ref));
    if (missingRefs.length) {
      throw new Error(`The direct pickup dependency is unavailable for ${missingRefs.join(", ")}.`);
    }
    const updates = [];
    for (const row of rows.rows) {
      if (row.status === "attention") {
        throw new Error(`${row.transfer_order_ref} requires Dispatch review before Driver pickup completion.`);
      }
      const mismatches = directPickupRouteMismatches(row, {
        planId: completedJob.plan_id,
        planDate: completedJob.plan_date,
        truckPlate: completedJob.truck_plate,
        loadId: completedJob.load_id
      });
      if (mismatches.length) {
        throw new Error(`${row.transfer_order_ref} does not belong to this completed Driver plan, truck, and load.`);
      }
      if (["in_transit", "delivered", "received_local"].includes(row.status)) {
        updates.push({
          dependencyId: row.id,
          transferOrderRef: row.transfer_order_ref,
          status: row.status,
          alreadyCompleted: true
        });
        continue;
      }
      await query(
        `UPDATE order_dependency_lines
            SET loaded_quantity = allocated_quantity, updated_at = now()
          WHERE dependency_id = $1`,
        [row.id]
      );
      await query(
        `UPDATE order_dependencies
            SET status = 'in_transit', updated_at = now(), attention_reason = null
          WHERE id = $1`,
        [row.id]
      );
      await writeDispatchAudit({
        action: "driver.direct_dependency.picked_up",
        source: "driver",
        entityType: "order_dependency",
        entityId: String(row.id),
        orderId: row.transfer_order_ref,
        details: {
          driverJobId: jobId,
          driverLogin: text(completedJob.driver_login),
          planId: completedJob.plan_id,
          planDate: dateText(completedJob.plan_date),
          truckPlate: text(completedJob.truck_plate),
          loadId: text(completedJob.load_id)
        }
      });
      updates.push({
        dependencyId: row.id,
        transferOrderRef: row.transfer_order_ref,
        status: "in_transit",
        alreadyCompleted: false
      });
    }
    return updates;
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
              t.netsuite_active AS transfer_active, t.receiving_status AS transfer_receiving_status,
              state.application_status AS transfer_application_status,
              state.reconciliation_status AS transfer_reconciliation_status,
              state.ordered_qty AS transfer_ordered_qty,
              state.received_qty AS transfer_received_qty,
              state.remaining_qty AS transfer_remaining_qty,
              state.destination_remaining_qty AS transfer_destination_remaining_qty
         FROM order_dependencies d
         JOIN transfer_orders t ON t.netsuite_id = d.transfer_order_id
         LEFT JOIN scm_reconciliation_order_state state
           ON state.order_kind = 'TO'
          AND state.source_order_netsuite_id = d.transfer_order_id
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
        && (reconciled || transferOrderReceiptEvidenceComplete(dependency));
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
