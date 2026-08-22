import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

test("server exposes gated Sales, SCM, Dispatch, media, SO, and PO workflow routes", () => {
  const source = read("src/server.js");
  for (const route of [
    "/api/sales/special-stock-requests/policy",
    "/api/sales/special-stock-requests",
    "/api/scm/special-stock-requests",
    "/api/dispatch/special-stock-handoffs"
  ]) {
    assert.match(source, new RegExp(route.replaceAll("/", "\\/"), "u"));
  }
  assert.match(source, /special-stock-request-repository\.js/u);
  assert.match(source, /special-stock-request-service\.js/u);
  assert.match(source, /getSpecialStockRequestPolicy/u);
  assert.match(source, /media-ticket/u);
  assert.match(source, /sales-order\/create/u);
  assert.match(source, /purchase-order\/create/u);
  assert.match(source, /handoff-route/u);
  assert.match(source, /vendor-pickup\/complete/u);
  assert.match(source, /special-stock-requests\/vendors/u);
  assert.match(source, /\/api\/sales\/special-stock-requests\/vendors/u);
  assert.match(source, /special-stock-requests\/order-links/u);
  assert.match(source, /reconcileSpecialOrderWebhook/u);
});

test("Sales and SCM Special tabs are real feature-gated interfaces", () => {
  const salesHtml = read("public/sales-stock-requests.html");
  const scmHtml = read("public/scm-stock-requests.html");
  const salesRegular = read("public/sales-stock-requests.js");
  const scmRegular = read("public/scm-stock-requests.js");
  const salesSpecial = read("public/sales-special-stock-requests.js");
  const scmSpecial = read("public/scm-special-stock-requests.js");
  assert.match(salesHtml, /sales-special-stock-requests\.js/u);
  assert.match(scmHtml, /scm-special-stock-requests\.js/u);
  assert.match(salesRegular, /data-sales-stock-action="special"/u);
  assert.doesNotMatch(salesRegular, /Special[^<]*(?:Coming soon|later phase)/iu);
  assert.match(scmRegular, /data-scm-stock-action="special"/u);
  assert.doesNotMatch(scmRegular, /Special[^<]*(?:Coming soon|added later)/iu);
  for (const required of ["customerName", "vendorName", "productName", "quantity", "requiredDate"]) {
    assert.match(salesSpecial, new RegExp(required, "u"));
  }
  for (const required of ["supplyStatus", "availableDate", "unitPurchaseCost", "itemResolution"]) {
    assert.match(scmSpecial, new RegExp(required, "u"));
  }
  assert.match(scmSpecial, /data-special-scm-vendor-search/u);
  assert.doesNotMatch(scmSpecial, /data-special-scm-item-search/u, "SCM's first reply must not own exact item resolution");
  assert.match(scmSpecial, /data-special-po-link-search/u);
  assert.match(salesSpecial, /data-special-so-link-search/u);
  assert.match(salesSpecial, /Case inquiry date/u);
  assert.match(salesSpecial, /NetSuite Quote ID \(optional\)/u);
  assert.match(salesSpecial, /data-special-case-customer-search/u);
  assert.match(salesSpecial, /data-special-case-vendor-search/u);
  assert.match(salesSpecial, /data-special-decision-item-search/u);
  assert.doesNotMatch(salesSpecial, /<span>Case required date/u);
  assert.doesNotMatch(salesSpecial, /<span>Estimate number/u);
  for (const value of ["PLT", "LYR", "SEC", "PCS", "EACH"]) {
    assert.match(salesSpecial, new RegExp(`\\[\"${value}\"`, "u"));
  }
  assert.match(scmSpecial, /First SCM response · Availability/u);
  assert.match(scmSpecial, /Second SCM response · Purchase Order preparation/u);
  assert.match(scmSpecial, /line\.poReady/u);
  assert.match(scmSpecial, /replaceSuggestions/u);
  const scmSearchHandler = scmSpecial.slice(
    scmSpecial.indexOf('mount.addEventListener("input"'),
    scmSpecial.indexOf('mount.addEventListener("change"')
  );
  assert.doesNotMatch(scmSearchHandler, /\brender\(\)/u, "SCM item/vendor lookup must not erase unsaved line responses");
  const salesSearchHandler = salesSpecial.slice(
    salesSpecial.indexOf('mount.addEventListener("input"'),
    salesSpecial.indexOf('mount.addEventListener("change"')
  );
  assert.match(salesSearchHandler, /syncSoFromDom\(\)/u, "Sales lookups must retain the unsaved SO editor");
  const stockRequestCss = read("public/stock-requests.css");
  assert.match(stockRequestCss, /\.special-case-initial-grid\s*\{[\s\S]*grid-template-columns:\s*repeat\(3,/u);
});

test("Special delivery staging uses its own guarded R2 record type", () => {
  assert.match(read("src/photo-upload.js"), /sales-special-stock-request-media/u);
});
