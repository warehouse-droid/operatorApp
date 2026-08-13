import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [server, page, client, control, sidebar, menu, sales, repository, yardQuantity, i18n, dispatchCss, controlCss] = await Promise.all([
  "server.js",
  "../public/dispatch-loaded-export.html",
  "../public/dispatch-loaded-export.js",
  "../public/control.js",
  "../public/app-sidebar.js",
  "../public/dispatch-menu.html",
  "../public/sales.js",
  "yard-movement-repository.js",
  "yard-quantity.js",
  "../public/i18n.js",
  "../public/dispatch.css",
  "../public/control.css"
].map((file) => readFile(new URL(file, import.meta.url), "utf8")));

function includesAll(source, values, label) {
  for (const value of values) assert.ok(source.includes(value), `${label} is missing: ${value}`);
}

includesAll(server, [
  'app.get(["/dispatch/loaded-export", "/dispatch/in-outbound-record"]',
  'app.get("/api/dispatch/loaded-orders"',
  'app.get("/api/dispatch/loaded-orders/detail"',
  'app.get("/api/dispatch/loaded-orders/drivers"',
  'app.get("/api/dispatch/loaded-orders/export.csv"',
  '"/control/in-outbound-record",',
  "sendLoadedOrdersCsv(req, res)"
], "Canonical In/Outbound Record and legacy server routes");

includesAll(server, [
  'app.get("/sales/in-outbound-record"',
  '"/api/sales/in-outbound-records"',
  '"/api/sales/in-outbound-records/detail"',
  '"/api/sales/in-outbound-records/drivers"',
  '"/api/sales/in-outbound-records/export.csv"',
  "operatorSalesYardLocationIds(req.operator)",
  "allowedSalesStoreLocationIds"
], "Sales In/Outbound Record routes and store scoping");

includesAll(server, [
  "listYardMovements",
  "getYardMovementDetail",
  "listYardMovementCsvRows",
  "itemSearch: req.query.itemSearch",
  "driver: req.query.driver",
  "yardMixedUnits",
  '"direction", "type", "order", "yard processed at", "last activity", "delivered at"',
  '"driver record only", "driver", "truck", "yard photos", "driver photos"',
  '"PLT", "LYR", "SEC", "PCS"'
], "Unified Yard movement server integration");

includesAll(page, [
  "<title>MBBS In/Outbound Record</title>",
  'id="dispatchLoadedApp"',
  '/dispatch-auth.js?v=',
  '/dispatch-loaded-export.js?v='
], "Dispatch loaded page");

includesAll(client, [
  'const loadedSalesHost = window.location.pathname === "/sales/in-outbound-record"',
  'const loadedApiBase = loadedSalesHost ? "/api/sales/in-outbound-records" : "/api/dispatch/loaded-orders"',
  'const loadedRoles = loadedSalesHost ? ["sales", "admin"] : ["dispatcher", "admin"]',
  "loadedAllowedYards",
  "`${loadedApiBase}/detail?",
  "`${loadedApiBase}/export.csv?",
  "in-outbound-record-",
  "/api/photo-upload/preview?",
  'data-action="open-loaded-photo"',
  'id="dispatchLoadedSearch"',
  'id="dispatchLoadedItemSearch"',
  'id="dispatchLoadedDriver"',
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
  "Math.floor((remainder / definition.conversionQty) + 0.000001)",
  "driverRecords",
  "driverPhotos",
  "delivery_at",
  "driver_only",
  "renderDriverRecords",
  "Driver delivery photos",
  'variant", "thumbnail"',
  'loading="lazy" decoding="async"',
  "const loadedDefaultDate = loadedToday()",
  "In/Outbound Record"
], "Dispatch loaded client");

includesAll(control, [
  'id="loadedSearch"',
  'id="loadedItemSearch"',
  'id="loadedDriver"',
  'data-action="yard-direction"',
  'data-action="yard-type"',
  "movementMixedUnits",
  "movement-quantity-equation",
  "Math.floor((remainder / definition.conversionQty) + 0.000001)",
  "processed_qty",
  "driverRecords",
  "driverPhotos",
  "delivery_at",
  "driver_only",
  "Driver delivery photos",
  'data-secure-photo-variant="thumbnail"',
  "const loadedDefaultDate = todayKey()",
  "In/Outbound Record"
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
assert.ok(!client.includes('from: localStorage.getItem("mbbs.dispatch.loaded.from")'), "Dispatch dates must reset to today on page load");
assert.ok(!control.includes('from: localStorage.getItem("mbbs.control.loaded.from")'), "Control dates must reset to today on page load");
assert.ok(client.includes('title="${loadedEscape(movementTypeLabel(orderType))}" type="button">${movementTypeCode(orderType)}</button>'),
  "Dispatch type tabs should display only their short codes");
assert.ok(control.includes('title="${escapeHtml(movementTypeLabel(orderType))}" type="button">${movementTypeCode(orderType)}</button>'),
  "Control type tabs should display only their short codes");

assert.ok(sidebar.includes('{ label: "In/Outbound Record", href: "/dispatch/loaded-export"'), "Renamed Dispatch sidebar entry missing");
assert.ok(sidebar.includes('{ label: "In/Outbound Record", href: "/control/yard-in-outbound"'), "Renamed Control sidebar entry missing");
assert.ok(sidebar.includes('{ label: "In/Outbound Record", href: "/sales/in-outbound-record"'), "Sales sidebar entry missing");
assert.ok(menu.includes("location.href='/dispatch/loaded-export'"), "Dispatch menu entry missing");
assert.ok(menu.includes('"In/Outbound Record"'), "Dispatch menu must use the renamed module label");
assert.ok(sales.includes("location.href='/sales/in-outbound-record'"), "Sales menu entry missing");
assert.ok(sales.includes('"In/Outbound Record"'), "Sales menu must use the renamed module label");
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
  "driverLogin",
  "movement.driver_login",
  "movement_lines",
  "jsonb_array_elements_text",
  "processed_pallet_qty",
  "processed_layer_qty",
  "processed_section_qty",
  "processed_piece_qty",
  "driver_job_records",
  "driverRecords",
  "driverPhotos",
  "delivery_at",
  "driver_only",
  "salesStoreLocationIdSql",
  "allowedSalesStoreLocationIds"
], "Unified Yard movement repository");

assert.match(repository, /if \(!hasActiveTransaction\(\)\) return Promise\.all\(reads\.map\(\(read\) => read\(\)\)\);/,
  "Movement detail queries should run concurrently outside transactions");
assert.match(repository, /runIndependentReads\(\[\s*readLines,\s*readPhotos,\s*readDriverRecords,\s*readDriverPhotos,/,
  "Movement detail should fan out its independent reads after authorization");
assert.match(dispatchCss, /\.dispatch-loaded-order\s*\{[^}]*max-width:\s*100%;[^}]*overflow:\s*hidden;/s,
  "Dispatch order cards must contain long content");
assert.match(controlCss, /\.loaded-order-card\s*\{[^}]*max-width:\s*100%;[^}]*overflow:\s*hidden;/s,
  "Control order cards must contain long content");

includesAll(i18n, [
  '"yard.driverOnly"',
  '"yard.deliveryTime"',
  '"yard.driverActivities"',
  '"yard.driverDeliveryPhotos"',
  '"yard.allDrivers"'
], "In/Outbound Record translations");

includesAll(yardQuantity, [
  "export function yardMixedUnits",
  "let remainder = processedQty",
  "Math.floor((remainder / definition.conversion) + QUANTITY_EPSILON)",
  "remainder = Math.max(0, remainder - (value * definition.conversion))"
], "Shared Yard mixed-unit calculation");

console.log("In/Outbound Record harness passed.");
