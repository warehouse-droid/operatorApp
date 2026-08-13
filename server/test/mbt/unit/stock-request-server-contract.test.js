import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const serverSource = fs.readFileSync(new URL("../../../src/server.js", import.meta.url), "utf8");
const serviceSource = fs.readFileSync(new URL("../../../src/stock-request-service.js", import.meta.url), "utf8");
const policySource = fs.readFileSync(new URL("../../../src/stock-request-policy.js", import.meta.url), "utf8");

test("Sales stock-request APIs require both Sales role and private staff access", () => {
  for (const route of [
    "/api/sales/stock-request-items",
    "/api/sales/stock-requests"
  ]) {
    const escaped = route.replaceAll("/", "\\/");
    assert.match(
      serverSource,
      new RegExp(`app\\.(?:get|post)\\(\\"${escaped}[^\\n]+requireSalesAccess[^\\n]+requirePrivateSalesRecordAccess`)
    );
  }
  assert.match(serverSource, /app\.get\(\[?[^\n]*\/sales\/stock-requests/);
});

test("Sales over-availability permission comes from the Admin gate and never from the request body", () => {
  assert.match(policySource, /sales_stock_request_over_availability/);
  assert.match(policySource, /row\?\.enabled\s*===\s*true/);
  assert.match(serverSource, /getSalesStockRequestAvailabilityPolicy\(\)/);
  assert.match(serverSource, /allowOverAvailability:\s*availabilityPolicy\.allowOverAvailability/);
  assert.doesNotMatch(serverSource, /allowOverAvailability:\s*req\.body/);
});

test("SCM stock-request APIs use SCM write authorization and required revision inputs", () => {
  assert.match(serverSource, /app\.get\(\"\/api\/scm\/stock-requests[^\n]+requireScmAccess/);
  assert.match(serverSource, /app\.post\(\"\/api\/scm\/stock-requests\/:id\/convert[^\n]+requireSmartScmWriteAccess/);
  assert.match(serverSource, /app\.post\(\"\/api\/scm\/stock-transfers\/:id\/confirm-print[^\n]+requireSmartScmWriteAccess/);
  assert.match(serverSource, /app\.post\(\"\/api\/scm\/stock-transfers\/:id\/reprint[^\n]+requireSmartScmWriteAccess/);
  assert.match(serverSource, /expectedRevision/);
});

test("NetSuite order webhook reconciles stock-request transfers and emits the module event", () => {
  assert.match(serverSource, /reconcileStockRequestTransferWebhook/);
  assert.match(serverSource, /stock-request\.updated/);
});

test("SCM conversion and quantity revision both refresh live OAuth inventory before reserving", () => {
  const conversion = serviceSource.match(/export async function convertStockRequestLines[\s\S]*?\n}/)?.[0] || "";
  const revision = serviceSource.match(/export async function reviseStockTransfer[\s\S]*?\n}/)?.[0] || "";
  assert.match(conversion, /dependencies\.refreshAvailability \|\| refreshStockRequestItemsAvailability/);
  assert.match(conversion, /await refreshAvailability\(itemIds\)/);
  assert.match(revision, /dependencies\.refreshAvailability \|\| refreshStockRequestItemsAvailability/);
  assert.match(revision, /await refreshAvailability\(current\.lines\.map/);
  assert.match(revision, /reviseStockTransferQuantities/);
});

test("stock-request list APIs forward every supported server-side filter", () => {
  const salesRoute = serverSource.match(/app\.get\("\/api\/sales\/stock-requests"[\s\S]*?\n}\);/)?.[0] || "";
  const scmRoute = serverSource.match(/app\.get\("\/api\/scm\/stock-requests"[\s\S]*?\n}\);/)?.[0] || "";

  for (const field of ["vendor", "requestDate", "sourceLocationId"]) {
    assert.match(salesRoute, new RegExp(`${field}: req\\.query\\.${field}`));
    assert.match(scmRoute, new RegExp(`${field}: req\\.query\\.${field}`));
  }
  assert.match(scmRoute, /destinationLocationId: req\.query\.destinationLocationId/);
  assert.match(salesRoute, /filterOptions/);
  assert.match(scmRoute, /filterOptions/);
});

test("pre-confirm Pending TO rejection is an explicit SCM-write route", () => {
  assert.match(
    serverSource,
    /app\.post\("\/api\/scm\/stock-transfers\/:id\/reject"[^\n]+requireSmartScmWriteAccess/
  );
  assert.match(serverSource, /rejectPendingStockTransfer/);
  assert.match(serverSource, /scm-pending-transfer-reject/);
});
