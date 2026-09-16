import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

export const refKey = value => String(value ?? "").trim().toLowerCase();
export const outboundFields = ["loaded_qty", "loaded_uom", "confirmed", "packed_pallet_qty", "packed_layer_qty", "packed_section_qty", "packed_piece_qty", "packed_sales_qty"];
export const receivingFields = ["netsuite_received_qty", "received_pallet_qty", "received_layer_qty", "received_section_qty", "received_piece_qty", "received_sales_qty"];
export const headerFields = ["outbound_operator_status", "local_yard_order_status", "receiving_status", "status", "status_text"];
const source = readFileSync(new URL("../src/delivery-repository.js", import.meta.url), "utf8");
const rules = vm.createContext({});
vm.runInContext(["normalizeNumber", "normalizeQuantity", "positiveQuantity", "roundQuantity", "hasConversion", "hasRequiredCustomQuantity",
  "lineUnitsToSalesQuantity", "lineRequiredSalesQuantity", "linePackedSalesQuantity", "lineLoadedSalesQuantity", "isPalletSalesItem",
  "isLegacySalesQuantityOnlyLine", "isExcludedDeliveryServiceLine", "isDeliveryPickableLine", "lineHasPackedQuantity", "lineHasOpenQuantity"]
  .map(name => {
    const start = source.indexOf(`function ${name}(`), end = source.indexOf("\n}", start);
    assert(start >= 0 && end > start, `Missing deployed Operator quantity rule: ${name}`);
    return source.slice(start, end + 2);
  }).join("\n"), rules);

function completeTransferStatus(verified) {
  if (!verified || !["F", "G"].includes(verified.status)) {return false;}
  const label = refKey(verified.status_text || verified.statusText).replace(/^transfer order\s*:\s*/, "");
  return label === (verified.status === "G" ? "received" : "pending receipt");
}

function validTransferSource(verified, parent) {
  return parent && String(verified.id) === String(parent.netsuite_id) && refKey(verified.tranid) === refKey(parent.tranid);
}

function validTransferSplit(order, split, parent) {
  return split?.status === "active" && String(split.split_to_id) === String(order.netsuite_id)
    && String(split.source_to_id) === String(parent.netsuite_id);
}

export function transferProof(order, { verified, split, parent = order } = {}) {
  const inherited = Number(order.netsuite_id) < 0;
  if (!completeTransferStatus(verified) || !validTransferSource(verified, parent)) {return null;}
  if (inherited && !validTransferSplit(order, split, parent)) {return null;}
  return { netsuiteId: String(verified.id), orderRef: verified.tranid, status: verified.status, inherited };
}

export function openTransferLines(lines) {
  return lines.filter(line => line.line_stage === "outbound" && (line.netsuite_active || rules.lineHasPackedQuantity(line)))
    .filter(line => rules.lineHasOpenQuantity(line));
}

function orderReviewReasons(order, options) {
  const reasons = [];
  if (options.identityCount !== 1 || options.sourceIdentityCount !== 1) {reasons.push("ambiguous_order_identity");}
  if (Number(order.netsuite_id) < 0 && options.split?.status !== "active") {reasons.push("inactive_or_unregistered_split");}
  if (options.restricted) {reasons.push("held_cancelled_missing_or_review");}
  if (order.preparing_operator_id || options.claimed) {reasons.push("active_operator_work");}
  return reasons;
}

function outboundReviewReasons(line) {
  const reasons = [];
  if (Number(line.loaded_qty) > 0 && line.loaded_uom && line.loaded_uom !== (line.unit || "")) {reasons.push("loaded_unit_differs_from_sales_unit");}
  if ((!line.netsuite_active || line.sync_exception) && rules.lineHasPackedQuantity(line)) {reasons.push("unsafe_packed_line");}
  return reasons;
}

function invalidQuantity(value) {
  return value !== null && value !== undefined && (!Number.isFinite(Number(value)) || Number(value) < 0);
}

function lineReviewReasons(line, receiving) {
  const reasons = line.line_stage === "outbound" ? outboundReviewReasons(line) : [];
  if (line.line_stage === "receiving" && receiving && line.sync_exception) {reasons.push("receiving_sync_exception");}
  const fields = ["quantity", "pallet_qty", "layer_qty", "section_qty", "piece_qty", "loaded_qty", "netsuite_received_qty"];
  if (line.netsuite_active && fields.some(field => invalidQuantity(line[field]))) {reasons.push("invalid_quantity");}
  return reasons;
}

function projectHeader(order, options, { outbound, receiving, evidence }) {
  const after = { ...order };
  if (outbound) {Object.assign(after, { outbound_operator_status: "loaded", local_yard_order_status: "Loaded" });}
  if (receiving) {after.receiving_status = "received";}
  // Local completion never changes cached NetSuite lifecycle fields.
  if (evidence && !evidence.inherited && !options.locallyCompleted) {
    after.status = options.verified.status;
    after.status_text = options.verified.status_text || options.verified.statusText;
  }
  return after;
}

function projectOutboundLine(line) {
  line.loaded_qty = Math.max(Number(line.loaded_qty || 0), rules.lineRequiredSalesQuantity(line));
  line.loaded_uom = line.unit || line.loaded_uom || "";
  line.confirmed = false;
  for (const key of outboundFields.filter(field => field.startsWith("packed_"))) {line[key] = 0;}
}

function projectReceivedLine(line) {
  // Header G proves that every active NetSuite line was received.
  line.netsuite_received_qty = Math.max(Number(line.netsuite_received_qty || 0), rules.lineRequiredSalesQuantity(line));
  for (const key of receivingFields.filter(field => field.startsWith("received_"))) {line[key] = 0;}
}

function projectLine(original, { outbound, receiving, evidence }) {
  const line = { ...original };
  if (!line.netsuite_active || !rules.isDeliveryPickableLine(line)) {return line;}
  if (line.line_stage === "outbound" && outbound) {projectOutboundLine(line);}
  if (line.line_stage === "receiving" && receiving && evidence?.status === "G") {projectReceivedLine(line);}
  return line;
}

function completionState(evidence, options) {
  return { outbound: Boolean(evidence || options.locallyCompleted || options.locallyReceived),
    receiving: Boolean(evidence?.status === "G" || options.locallyReceived), evidence };
}

function completionObservationAllowed(eligible, evidence, options) {
  return eligible && Boolean(evidence) && !options.locallyCompleted && !options.hasCompletion;
}

export function projectTransferCleanup(order, lines, options = {}) {
  const evidence = transferProof(order, options);
  const state = completionState(evidence, options);
  const qualifies = state.outbound || state.receiving;
  const reasons = qualifies ? [...orderReviewReasons(order, options), ...lines.flatMap(line => lineReviewReasons(line, state.receiving))] : [];
  const eligible = qualifies && reasons.length === 0;
  const after = eligible ? projectHeader(order, options, state) : { ...order };
  const projected = eligible ? lines.map(line => projectLine(line, state)) : lines.map(line => ({ ...line }));
  if (eligible) {assert.equal(openTransferLines(projected).length, 0, `Cleanup leaves open outbound quantities: ${order.tranid}`);}
  return { eligible, qualifies, ...state, reasons: [...new Set(reasons)], order: after, lines: projected,
    addCompletion: completionObservationAllowed(eligible, evidence, options) };
}
