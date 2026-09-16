import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { isNetSuiteSalesOrderFulfilled } from "../src/sales-order-reconciliation.js";
import { applyOperatorLinkedQuantityProjection } from "../src/operator-linked-quantity-domain.js";

// Use the deployed Operator's quantity rules without starting the application.
const source = readFileSync(new URL("../src/delivery-repository.js", import.meta.url), "utf8");
const names = ["normalizeNumber", "normalizeQuantity", "positiveQuantity", "roundQuantity",
  "hasConversion", "hasRequiredCustomQuantity", "lineUnitsToSalesQuantity", "lineRequiredSalesQuantity",
  "linePackedSalesQuantity", "lineLoadedSalesQuantity", "isPalletSalesItem", "isLegacySalesQuantityOnlyLine",
  "isExcludedDeliveryServiceLine", "isDeliveryPickableLine", "lineHasPackedQuantity", "lineHasOpenQuantity"];
const quantityRules = vm.createContext({});
vm.runInContext(names.map(name => {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf("\n}", start);
  assert(start >= 0 && end > start, `Cannot find Operator quantity rule ${name}`);
  return source.slice(start, end + 2);
}).join("\n"), quantityRules);

export const packedFields = ["packed_pallet_qty", "packed_layer_qty", "packed_section_qty", "packed_piece_qty", "packed_sales_qty"];
export const lineWriteFields = ["loaded_qty", "loaded_uom", "confirmed", ...packedFields];
export const orderWriteFields = ["operator_status", "local_yard_order_status", "status", "status_text"];
export const normalizeRef = value => String(value ?? "").trim().toLowerCase();

function verifiedFulfillment(order, options) {
  const { verified, split, source: parent } = options;
  if (!verified || !["F", "G"].includes(verified.status) || !isNetSuiteSalesOrderFulfilled(verified)) return null;
  const child = Number(order.netsuite_id) < 0;
  const origin = child ? parent : order;
  if (!origin || origin.sales_order_type !== "Delivery") return null;
  if (child && (split?.status !== "active" || String(split.source_so_id) !== String(origin.netsuite_id)
    || String(split.split_so_id) !== String(order.netsuite_id))) return null;
  if (String(verified.id) !== String(origin.netsuite_id) || normalizeRef(verified.tranid) !== normalizeRef(origin.tranid)) return null;
  return { netsuiteId: String(verified.id), orderRef: verified.tranid, status: verified.status, inherited: child };
}

function lineReviewReasons(line, projected) {
  const reasons = [];
  if (Number(line.loaded_qty) > 0 && line.loaded_uom && line.loaded_uom !== (line.unit || "")) reasons.push("loaded_unit_differs_from_sales_unit");
  if (!line.netsuite_active && quantityRules.lineHasPackedQuantity(line)) reasons.push("inactive_line_has_packed_quantity");
  if (line.sync_exception && quantityRules.lineHasPackedQuantity(line)) reasons.push("packed_line_has_sync_exception");
  if (line.netsuite_active && projected.linked_quantity_blocked) reasons.push("linked_allocation_exceeds_order");
  return reasons;
}

function orderReviewReasons(order, options) {
  const reasons = [];
  if (options.identityCount !== 1 || options.sourceIdentityCount !== 1) reasons.push("duplicate_local_order_reference");
  if ([order.operator_status, order.local_yard_order_status].some(value => ["hold", "cancelled", "canceled"].includes(normalizeRef(value)))) reasons.push("locally_cancelled_or_held");
  if (options.activeReload) reasons.push("active_reload_or_reattempt");
  if (order.has_preparing_operator) reasons.push("operator_draft_in_progress");
  if (options.claimed) reasons.push("active_consolidation_or_posting_claim");
  return reasons;
}

export function effectiveCleanupLine(line, allocations = {}) {
  return applyOperatorLinkedQuantityProjection({ ...line }, { linkedPo: allocations[String(line.id)] || {} });
}

function projectLine(line, allocations) {
  if (!line.netsuite_active || !quantityRules.isDeliveryPickableLine(line)) return { ...line };
  return { ...line, loaded_qty: Math.max(Number(line.loaded_qty || 0), quantityRules.lineRequiredSalesQuantity(effectiveCleanupLine(line, allocations))),
    loaded_uom: line.unit || line.loaded_uom || "", confirmed: false,
    ...Object.fromEntries(packedFields.map(field => [field, 0])) };
}

export function cleanupOpenLines(lines, allocations = {}) {
  return lines.filter(line => line.netsuite_active || quantityRules.lineHasPackedQuantity(line))
    .map(line => effectiveCleanupLine(line, allocations)).filter(line => quantityRules.lineHasOpenQuantity(line));
}

export function projectCleanupOrder(order, lines, options = {}) {
  const evidence = verifiedFulfillment(order, options);
  const qualifies = order.sales_order_type === "Delivery" && !order.is_test_fixture && Boolean(evidence || options.locallyCompleted);
  const reasons = qualifies ? [...orderReviewReasons(order, options), ...lines.flatMap(line => lineReviewReasons(line, effectiveCleanupLine(line, options.allocations)))] : [];
  const eligible = qualifies && reasons.length === 0;
  const after = eligible ? { ...order, operator_status: "loaded", local_yard_order_status: "Loaded" } : { ...order };
  if (eligible && evidence && !evidence.inherited) {
    after.status = options.verified.status;
    after.status_text = options.verified.status_text || options.verified.statusText || `Sales Order : ${after.status === "G" ? "Billed" : "Pending Billing"}`;
  }
  const afterLines = eligible ? lines.map(line => projectLine(line, options.allocations)) : lines.map(line => ({ ...line }));
  if (eligible) assert.equal(cleanupOpenLines(afterLines, options.allocations).length, 0, `Cleanup leaves open quantities on ${order.tranid}`);
  return { eligible, qualifies, reasons: [...new Set(reasons)], evidence,
    locallyCompleted: Boolean(options.locallyCompleted), order: after, lines: afterLines,
    addCompletion: eligible && Boolean(evidence) && !options.hasCompletion };
}
