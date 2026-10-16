// @ts-check

import { dependencyQuantityConversionDisplay } from "./order-dependency-quantity.js";
/** @typedef {Record<string, any>} Line */

const EPSILON = 0.000001;
const physicalFields = ["pallet_qty", "layer_qty", "section_qty", "piece_qty"];
const targetFields = ["pallets", "layers", "sections", "pieces"];
const conversionFields = ["toPlt", "toLyr", "toSec", "toPcs"];
/** @param {any} value */
function quantity(value) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw Object.assign(new Error("Direct-ship quantity must be finite and nonnegative."), { code: "LINKED_DIRECT_SHIP_QUANTITY_INVALID" });
  }
  return Number(parsed.toFixed(6));
}
/** @param {any} line */
function itemKey(line) {
  return `${line.itemId ?? line.item_id}:${String(line.unit || "").trim().toUpperCase()}`;
}
/** @param {Line} old @param {Line} target @param {Line[]} targets */
function matchesTarget(old, target, targets = []) {
  if (old.item_id && itemKey(old) !== itemKey(target)) { return false; }
  if (String(old.sales_line_id) === String(target.salesLineId)) { return true; }
  if (targets.some((/** @type {any} */ line) => String(line.salesLineId) === String(old.sales_line_id) && itemKey(old) === itemKey(line))) { return false; }
  return old.item_id && String(old.dispatch_target_line_key || "").split("::")[1] === target.sourceOrderRef;
}
/** @param {any} target @param {any[]} others */
function demand(target, others) {
  const original = quantity(target.quantity);
  const competing = others.filter(line => String(line.sales_line_id) === String(target.salesLineId));
  const amount = (/** @type {any} */ line) => quantity(line.allocated_quantity ?? line.allocated_sales_qty);
  const parentAvailable = Math.max(0, quantity(target.sourceQuantity ?? original) - quantity(target.loadedQuantity)
    - competing.reduce((sum, line) => sum + amount(line), 0));
  const targetAllocated = competing.filter(line => !line.dispatch_target_line_key
    || line.dispatch_target_line_key === target.targetLineKey).reduce((sum, line) => sum + amount(line), 0);
  return Math.min(Math.max(0, original - targetAllocated), parentAvailable);
}
/** @param {any} target @param {number} allocated */
function display(target, allocated) {
  const full = Math.abs(allocated - quantity(target.quantity)) < EPSILON;
  const hasConversion = conversionFields.some(field => quantity(target[field]) > 0);
  const converted = dependencyQuantityConversionDisplay(allocated, target);
  /** @type {Array<'palletQty'|'layerQty'|'sectionQty'|'pieceQty'>} */
  const convertedFields = ["palletQty", "layerQty", "sectionQty", "pieceQty"];
  const fits = targetFields.every((field,index) => converted[convertedFields[index]] <= quantity(target[field]) + EPSILON);
  return Object.fromEntries(physicalFields.map((field, index) => {
    const required = quantity(target[targetFields[index]]);
    const proportional = quantity(target.quantity) > 0 ? required * allocated / quantity(target.quantity) : 0;
    const selected = full ? required : hasConversion && fits ? converted[convertedFields[index]] : proportional;
    return [field, Number(Math.min(required, selected).toFixed(6))];
  }));
}
/** @param {any[]} sources @param {number} requested */
function consume(sources, requested) {
  let remaining = requested;
  for (const source of sources) {
    const used = Math.min(source.available, remaining);
    source.available = quantity(Math.max(0, source.available - used));
    remaining = quantity(Math.max(0, remaining - used));
  }
}
/** @param {Line} target @param {Line|undefined} prior @param {Line[]} sources @param {Line[]} others */
function allocationForTarget(target,prior,sources,others) {
  const matching = sources.filter(line => itemKey(line) === itemKey(target));
  matching.sort((left,right) => Number(String(right.id) === String(prior?.transfer_outbound_line_id))
    - Number(String(left.id) === String(prior?.transfer_outbound_line_id)));
  const allocated = quantity(Math.min(demand(target,others), matching.reduce((sum,line) => sum + line.available,0)));
  if (!prior && allocated <= EPSILON) { return null; }
  const source = matching.find(line => line.available > EPSILON) || matching[0];
  consume(matching,allocated);
  return { ...prior, sales_line_id: target.salesLineId, item_id: target.itemId, item_name: target.itemName,
    unit: target.unit, line_role: "sales_allocation", dispatch_target_line_key: target.targetLineKey,
    transfer_outbound_line_id: source?.id ?? prior?.transfer_outbound_line_id ?? null,
    allocated_quantity: allocated, ...display(target,allocated) };
}
/** @param {Line} prior @param {Line[]} sources */
function retainedAllocation(prior,sources) {
  const matching = sources.filter(line => itemKey(line) === itemKey(prior));
  const allocated = prior.line_role === "pallet" ? quantity(matching.reduce((sum,line) => sum + line.available,0)) : 0;
  consume(matching,allocated);
  const ratio = quantity(prior.allocated_quantity) > 0 ? allocated / quantity(prior.allocated_quantity) : 0;
  return { ...prior, allocated_quantity: allocated,
    ...Object.fromEntries(physicalFields.map(field => [field, quantity(prior[field]) * ratio])) };
}
/** @param {{targetLines?: Line[], sourceLines?: Line[], existingLines?: Line[], otherAllocations?: Line[]}} input @returns {Line[]} */
export function projectLinkedDirectShipAllocations({ targetLines = [], sourceLines = [], existingLines = [], otherAllocations = [] }) {
  const sources = sourceLines.filter(line => line.netsuite_active !== false && line.line_stage === "outbound")
    .map((/** @type {any} */ line) => ({ ...line, available: quantity(line.quantity) }));
  const oldSales = existingLines.filter((/** @type {any} */ line) => !line.line_role || line.line_role === "sales_allocation");
  for (const manual of existingLines.filter((/** @type {any} */ line) => line.line_role === "manual_transfer")) {
    consume(sources.filter(line => itemKey(line) === itemKey(manual)),quantity(manual.allocated_quantity));
  }
  const used = new Set();
  const output = [];
  const ordered = [...targetLines].sort((left, right) => Number(oldSales.some((/** @type {any} */ old) => matchesTarget(old,right,targetLines)))
    - Number(oldSales.some((/** @type {any} */ old) => matchesTarget(old,left,targetLines))));
  for (const target of ordered) {
    const prior = oldSales.find((/** @type {any} */ old) => !used.has(old.id) && matchesTarget(old,target,targetLines));
    const allocated = allocationForTarget(target,prior,sources,otherAllocations);
    if (!allocated) { continue; }
    if (prior) { used.add(prior.id); }
    output.push(allocated);
  }
  for (const prior of existingLines) {
    if (used.has(prior.id) || prior.line_role === "manual_transfer") { continue; }
    output.push(retainedAllocation(prior,sources));
  }
  return output;
}
