// @ts-check
import crypto from "node:crypto";
import { stableCanonicalJson } from "./operator-netsuite-posting-domain.js";

const QUANTITIES = ["quantity", "loaded_qty", "packed_pallet_qty", "packed_layer_qty", "packed_section_qty", "packed_piece_qty", "packed_sales_qty", "to_plt", "to_lyr", "to_sec", "to_pcs"];
const TYPES = new Set(["sales_order", "transfer_order", "co_order", "vrma_order"]);
/** @param {string} message */
export function consolidationError(message, code = "CONSOLIDATION_LOAD_INVALID", status = 409) {
  return Object.assign(new Error(message), { code, status });
}
/** @param {any} value */
export function consolidationDate(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value || "").slice(0, 10);
}
/** @param {any} left @param {any} right */
export function compareConsolidationOrders(left, right) {
  const a = left.assignment || {}, b = right.assignment || {};
  return compareText(a.planDate, b.planDate)
    || compareText(a.truckPlate, b.truckPlate)
    || Number(a.sequence || 0) - Number(b.sequence || 0)
    || compareText(left.tranid, right.tranid);
}
/** @param {any} left @param {any} right */
function compareText(left, right) { return String(left || "").localeCompare(String(right || ""), undefined, { numeric: true }); }
/** @param {any} order */
export function consolidationOrderKey(order) { return `${order.order_type}:${order.netsuite_id}`; }
/** @param {any} line */
export function consolidationPackedLine(line) {
  return ["packed_pallet_qty", "packed_layer_qty", "packed_section_qty", "packed_piece_qty", "packed_sales_qty"]
    .some((field) => Number(line[field]) > 0.000001);
}
/** @param {any} line */
function snapshotLine(line) {
  const quantities = Object.fromEntries(QUANTITIES.map((field) => {
    const value = Number(line[field] || 0);
    if (!Number.isFinite(value) || value < 0) throw consolidationError("A packed line contains an invalid quantity.");
    return [field, Number(value.toFixed(6))];
  }));
  return { id: String(line.id), line_id: String(line.line_id), item_id: String(line.item_id || ""),
    item_name: String(line.item_name || line.sku || "Item"), sku: String(line.sku || ""), unit: String(line.unit || ""),
    item_type: String(line.item_type || ""), ...quantities };
}
/** @param {any[]} orders */
function requireAssignment(orders) {
  if (!Array.isArray(orders) || !orders.length) throw consolidationError("Select at least one packed order.");
  const first = orders[0], assignment = first.assignment;
  const locationId = Number(first.outbound_location_id ?? first.source_location_id);
  if (!locationId || !assignment?.planId || !assignment.loadId || !assignment.truckPlate || !/^\d{4}-\d{2}-\d{2}$/.test(assignment.planDate || "")) {
    throw consolidationError("Every order must belong to a planned truck load.");
  }
  return { locationId, assignment };
}
/** @param {any} order @param {number} locationId @param {any} assignment */
function snapshotOrder(order, locationId, assignment) {
  if (!TYPES.has(order.order_type) || order.vrma_reference_only || order.operator_status !== "packed") throw consolidationError(`${order.tranid} is not ready to load.`);
  if (Number(order.outbound_location_id ?? order.source_location_id) !== locationId
      || ["planId", "loadId", "planDate", "truckPlate"].some((field) => String(order.assignment?.[field] || "") !== String(assignment[field]))) {
    throw consolidationError("Select orders from the same yard, planned date, truck and load.");
  }
  /** @type {any[]} */
  const lines = (order.lines || []).filter(consolidationPackedLine);
  if (!lines.length || lines.some((line) => line.sync_exception || line.no_yard_load_required || line.linked_quantity_blocked || line.netsuite_active === false)) {
    throw consolidationError(`${order.tranid} has no valid packed quantities or needs review.`);
  }
  return { key: consolidationOrderKey(order), netsuite_id: String(order.netsuite_id), tranid: String(order.tranid), order_type: String(order.order_type),
    reloadCycleId: String(order.reload_cycle?.id || ""), reloadAuthorized: Boolean(order.reload_authorized),
    lines: lines.map(snapshotLine).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })) };
}
/** @param {any[]} orders */
export function buildConsolidationSnapshot(orders) {
  const { locationId, assignment } = requireAssignment(orders);
  const seen = new Set();
  const snapshots = [...orders].sort(compareConsolidationOrders).map((order) => {
    const key = consolidationOrderKey(order);
    if (seen.has(key)) throw consolidationError("An order cannot be selected more than once.");
    seen.add(key);
    return snapshotOrder(order, locationId, assignment);
  });
  return { locationId, assignment: { planId: String(assignment.planId), loadId: String(assignment.loadId), planDate: assignment.planDate,
    truckPlate: assignment.truckPlate, loadName: String(assignment.loadName || ""), sequence: Number(assignment.sequence || 0) }, orders: snapshots };
}
/** @param {any} snapshot */
export function consolidationSnapshotHash(snapshot) { return crypto.createHash("sha256").update(stableCanonicalJson(snapshot)).digest("hex"); }

/** @param {any[]} sources @param {number} yard @param {boolean} selected */
export function originalConsolidationOrders(sources, yard, selected) {
  const originals = new Map();
  for (const root of sources.filter(Boolean)) {
    for (const order of root.is_dispatch_group ? root.child_orders || [] : [root]) {
      const id = String(order.netsuite_id);
      if (selected && originals.has(id)) throw consolidationError("A selected group overlaps another selected order.");
      if (Number(order.outbound_location_id ?? order.source_location_id) !== yard) {
        if (selected) throw consolidationError("A selected order is outside this yard.", "OPERATOR_YARD_FORBIDDEN", 403);
        continue;
      }
      originals.set(id, order);
    }
  }
  return [...originals.values()];
}
