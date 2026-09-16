import assert from "node:assert/strict";
import { refKey, outboundFields, receivingFields } from "./to-cleanup-domain.mjs";

const sourceFields = { item_name: "itemName", sku: "itemName", item_description: "itemDescription", unit: "unit",
  item_type: "itemType", item_type_text: "itemTypeText", location: "location" };
const numberFields = { quantity: "quantity", pallet_qty: "palletQty", layer_qty: "layerQty", section_qty: "sectionQty",
  piece_qty: "pieceQty", to_plt: "toPlt", to_lyr: "toLyr", to_sec: "toSec", to_pcs: "toPcs", item_weight: "itemWeight" };
const identifierFields = { item_id: "itemId", location_id: "locationId" };
export const authoritativeLineFields = ["line_id", ...Object.keys(sourceFields), ...Object.keys(numberFields), ...Object.keys(identifierFields),
  "netsuite_active", "sync_exception", "sync_exception_at", "synced_at", "raw", "pack_quantity_source", ...outboundFields, ...receivingFields];
const lineColumns = [...new Set(["line_stage", "id", "transfer_order_id", ...authoritativeLineFields, "confirmed_at", "confirmed_by",
  "fulfilled_pallet_qty", "fulfilled_layer_qty", "fulfilled_section_qty", "fulfilled_piece_qty"])];
export const authorityLineKey = line => `${line.line_stage}:${line.line_id}`;

function validLine(line) {
  assert(["outbound", "receiving"].includes(line.stage), "Invalid TO stage");
  assert(line.identityStatus === "exact" && !line.identityIssue, "Ambiguous NetSuite line identity");
  assert(/^\d+$/.test(String(line.sourceLineKey)) && Number(line.sourceLineKey) > 0, "Missing NetSuite line identity");
  assert(Number.isFinite(line.quantity) && line.quantity > 0, "Invalid NetSuite quantity");
  assert(Number.isInteger(line.itemId) && line.itemId > 0 && String(line.unit || "").trim(), "Missing item or unit");
  for (const field of ["cumulativeProgressQuantity", "palletQty", "layerQty", "sectionQty", "pieceQty", "toPlt", "toLyr", "toSec", "toPcs"]) {
    assert(line[field] === null || line[field] === undefined || (Number.isFinite(line[field]) && line[field] >= 0), `Invalid NetSuite ${field}`);
  }
}

function validAuthority(order, remote) {
  assert(remote?.kind === "TO" && remote.recordType === "TrnfrOrd", "A Transfer Order is required");
  assert(String(remote.id) === String(order.netsuite_id) && refKey(remote.tranid) === refKey(order.tranid), "NetSuite order identity mismatch");
  const label = refKey(remote.statusText).replace(/^transfer order\s*:\s*/, "");
  assert((remote.status === "G" && label === "received") || (remote.status === "F" && label === "pending receipt"), "NetSuite does not confirm full shipment");
  assert(remote.lines?.length > 0, "NetSuite line proof is empty");
  remote.lines.forEach(validLine);
  assert.equal(new Set(remote.lines.map(line => `${line.stage}:${line.sourceLineKey}`)).size, remote.lines.length, "Duplicate NetSuite line");
  validPairs(remote.lines);
}

function validPairs(remoteLines) {
  const groups = new Map();
  for (const line of remoteLines) {groups.set(line.logicalLineIdentity, [...(groups.get(line.logicalLineIdentity) || []), line]);}
  for (const [identity, lines] of groups) {
    assert(identity && lines.length === 2 && new Set(lines.map(line => line.stage)).size === 2, "Incomplete source/destination pair");
    assert(lines[0].itemId === lines[1].itemId && lines[0].quantity === lines[1].quantity && lines[0].unit === lines[1].unit, "NetSuite source/destination disagreement");
  }
}

function emptyLine(order, remote) {
  const line = Object.fromEntries(lineColumns.map(field => [field, null]));
  Object.assign(line, { id: `new:${remote.stage}:${order.netsuite_id}:${remote.sourceLineKey}`, transfer_order_id: String(order.netsuite_id),
    line_stage: remote.stage, confirmed: false, loaded_qty: 0, loaded_uom: remote.unit, netsuite_received_qty: 0 });
  for (const field of lineColumns.filter(key => key.startsWith("fulfilled_"))) {line[field] = "0";}
  for (const field of [...outboundFields, ...receivingFields].filter(key => /^(packed_|received_)/.test(key))) {line[field] = 0;}
  return line;
}

function chooseLine(order, lines, remote) {
  const exact = lines.filter(line => line.line_stage === remote.stage && String(line.line_id) === String(remote.sourceLineKey));
  assert(exact.length <= 1, "Duplicate local canonical line");
  if (exact.length) {return { ...exact[0] };}
  const aliases = new Set((remote.sourceLineAliases || []).map(String));
  const matched = lines.filter(line => line.line_stage === remote.stage && aliases.has(String(line.line_id)));
  assert(matched.length <= 1, "Multiple local aliases without a canonical anchor");
  return matched.length ? { ...matched[0] } : emptyLine(order, remote);
}

function clearSelection(line, received) {
  const fields = line.line_stage === "outbound" ? outboundFields.filter(field => field.startsWith("packed_"))
    : received ? receivingFields.filter(field => field.startsWith("received_")) : [];
  for (const field of fields) {line[field] = 0;}
  if (line.line_stage === "outbound") {line.confirmed = false;}
}

function packSource(line) {
  if (["pallet_qty", "layer_qty", "section_qty", "piece_qty"].some(field => Number(line[field]) > 0)) {return "netsuite_manual";}
  return ["to_plt", "to_lyr", "to_sec", "to_pcs"].some(field => Number(line[field]) > 0) ? "item_conversion" : "sales_only";
}

function numericText(value) {
  return value === null || value === undefined ? null : String(value);
}

function activeLine(order, lines, remote, observedAt, received) {
  const line = chooseLine(order, lines, remote);
  for (const [field, source] of Object.entries(sourceFields)) {line[field] = remote[source] || "";}
  for (const [field, source] of Object.entries(numberFields)) {line[field] = numericText(remote[source]);}
  for (const [field, source] of Object.entries(identifierFields)) {line[field] = remote[source] ? String(remote[source]) : null;}
  Object.assign(line, { line_id: String(remote.sourceLineKey), netsuite_active: true, sync_exception: null, sync_exception_at: null,
    synced_at: observedAt, pack_quantity_source: packSource(line), raw: { ...(remote.raw || {}), sourceLineKey: remote.sourceLineKey,
      sourceLineAliases: remote.sourceLineAliases, logicalLineIdentity: remote.logicalLineIdentity, identityStatus: "exact", identityIssue: "", reconciliationStage: remote.stage } });
  if (remote.stage === "receiving") {line.netsuite_received_qty = received ? Math.max(remote.quantity, remote.cumulativeProgressQuantity || 0) : remote.cumulativeProgressQuantity || 0;}
  clearSelection(line, received);
  return line;
}

export function projectAuthoritativeTransferLines(order, lines, remote, observedAt) {
  validAuthority(order, remote);
  assert(Number.isFinite(Date.parse(observedAt)), "A proof observation time is required");
  const active = remote.lines.map(line => activeLine(order, lines, line, observedAt, remote.status === "G"));
  assert.equal(new Set(active.map(line => `${line.line_stage}:${line.id}`)).size, active.length, "Local line reused across canonical items");
  const selected = new Set(active.map(line => `${line.line_stage}:${line.id}`));
  const retired = lines.filter(line => !selected.has(`${line.line_stage}:${line.id}`)).map(original => {
    const line = { ...original, netsuite_active: false, sync_exception: null, sync_exception_at: null, synced_at: observedAt };
    clearSelection(line, remote.status === "G");
    return line;
  });
  return [...active, ...retired].map(line => JSON.parse(JSON.stringify(line)));
}
