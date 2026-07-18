import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [server, page, client, control, sidebar, menu, repository, yardQuantity] = await Promise.all([
  "server.js",
  "../public/dispatch-loaded-export.html",
  "../public/dispatch-loaded-export.js",
  "../public/control.js",
  "../public/app-sidebar.js",
  "../public/dispatch-menu.html",
  "yard-movement-repository.js",
  "yard-quantity.js"
].map((file) => readFile(new URL(file, import.meta.url), "utf8")));

function includesAll(source, values, label) {
  for (const value of values) assert.ok(source.includes(value), `${label} is missing: ${value}`);
}

includesAll(server, [
  'app.get("/dispatch/loaded-export"',
  'app.get("/api/dispatch/loaded-orders"',
  'app.get("/api/dispatch/loaded-orders/detail"',
  'app.get("/api/dispatch/loaded-orders/export.csv"',
  "sendLoadedOrdersCsv(req, res)"
], "Dispatch loaded server routes");

includesAll(server, [
  "listYardMovements",
  "getYardMovementDetail",
  "listYardMovementCsvRows",
  "itemSearch: req.query.itemSearch",
  "yardMixedUnits",
  '"direction", "type", "order", "processed at"',
  '"PLT", "LYR", "SEC", "PCS"'
], "Unified Yard movement server integration");

includesAll(page, [
  'id="dispatchLoadedApp"',
  '/dispatch-auth.js?v=',
  '/dispatch-loaded-export.js?v='
], "Dispatch loaded page");

includesAll(client, [
  "/api/dispatch/loaded-orders?",
  "/api/dispatch/loaded-orders/detail?",
  "/api/dispatch/loaded-orders/export.csv?",
  "/api/photo-upload/preview?ref=",
  'data-action="open-loaded-photo"',
  'id="dispatchLoadedSearch"',
  'id="dispatchLoadedItemSearch"',
  'data-action="yard-direction"',
  'data-action="yard-type"',
  "itemSearch",
  "processed_qty",
  "processed_pallet_qty",
  "to_plt",
  "to_lyr",
  "to_sec",
  "to_pcs",
  "movementMixedUnits",
  "movement-quantity-equation",
  "Math.floor((remainder / definition.conversionQty) + 0.000001)"
], "Dispatch loaded client");

includesAll(control, [
  'id="loadedSearch"',
  'id="loadedItemSearch"',
  'data-action="yard-direction"',
  'data-action="yard-type"',
  "movementMixedUnits",
  "movement-quantity-equation",
  "Math.floor((remainder / definition.conversionQty) + 0.000001)",
  "processed_qty"
], "Control Yard movement client");

assert.ok(
  client.indexOf('id="dispatchLoadedItemSearch"') < client.indexOf('<div class="dispatch-yard-tabs">'),
  "Dispatch Yard tabs must render below the search container"
);
assert.ok(
  control.indexOf('id="loadedItemSearch"') < control.indexOf('<div class="yard-movement-tabs">'),
  "Control Yard tabs must render below the search container"
);
assert.ok(!client.includes("Search is global:"), "Dispatch should not render the global-search description");
assert.ok(!control.includes("Search is global:"), "Control should not render the global-search description");
assert.ok(client.includes('title="${loadedEscape(movementTypeLabel(orderType))}" type="button">${movementTypeCode(orderType)}</button>'),
  "Dispatch type tabs should display only their short codes");
assert.ok(control.includes('title="${escapeHtml(movementTypeLabel(orderType))}" type="button">${movementTypeCode(orderType)}</button>'),
  "Control type tabs should display only their short codes");

assert.ok(sidebar.includes('{ label: "Yard In/Outbound", href: "/dispatch/loaded-export"'), "Dispatch sidebar entry missing");
assert.ok(menu.includes("location.href='/dispatch/loaded-export'"), "Dispatch menu entry missing");
includesAll(repository, [
  "export async function listYardMovements",
  "export async function getYardMovementDetail",
  "export async function listYardMovementCsvRows",
  "operator_load_records",
  "receiving_receipt_records",
  "local_co_receipt_records",
  "sales_order_delivery_load",
  "customer_pickup_load",
  "transfer_order_load",
  "local_co_load",
  "vrma_local_load",
  "purchase_order",
  "co_order",
  "vrma_order",
  "itemSearch",
  "movement_lines",
  "jsonb_array_elements_text",
  "processed_pallet_qty",
  "processed_layer_qty",
  "processed_section_qty",
  "processed_piece_qty"
], "Unified Yard movement repository");

includesAll(yardQuantity, [
  "export function yardMixedUnits",
  "let remainder = processedQty",
  "Math.floor((remainder / definition.conversion) + QUANTITY_EPSILON)",
  "remainder = Math.max(0, remainder - (value * definition.conversion))"
], "Shared Yard mixed-unit calculation");

console.log("Yard In/Outbound harness passed.");
