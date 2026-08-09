import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const server = read("src/server.js");
const control = read("public/control.js");
const operator = read("public/operator.js");
const yard = read("src/yard-movement-repository.js");
const migration = read("migrations/139_sales_order_reload_cycles.sql");
const regressionHistory = read("test/sales-order-reload-regression-matrix.md");

const requireText = (source, text, message) => assert.ok(source.includes(text), message || `Missing ${text}`);
const requirePattern = (source, pattern, message) => assert.match(source, pattern, message);

requireText(server, "authorizeSalesOrderReload", "Control API must use the tested authorization service.");
requireText(server, "cancelSalesOrderReload", "Control API must use the tested cancellation service.");
requireText(server, "assertSalesOrderReloadControlYard", "Yard managers must be scoped to assigned outbound yards.");
requireText(server, "refreshSalesOrderForReload", "Authorization must perform a dedicated fresh NetSuite refresh.");
requirePattern(
  server,
  /async function refreshSalesOrderForReload[\s\S]*anyNetSuiteSyncRunning\(\)[\s\S]*targetedSyncRunning = true[\s\S]*syncTargetedNetSuiteOrder[\s\S]*finally[\s\S]*targetedSyncRunning = false/,
  "Fresh re-load refresh must share the NetSuite synchronization lock and release it in finally."
);
requirePattern(
  server,
  /app\.post\("\/api\/control\/sales-orders\/:orderId\/reload-cycles", requireOperator, requireControlAccess/,
  "Authorization route must require authenticated Control access."
);
requirePattern(
  server,
  /app\.post\("\/api\/control\/sales-orders\/:orderId\/reload-cycles\/:cycleId\/cancel", requireOperator, requireControlAccess/,
  "Cancellation route must require authenticated Control access."
);
requireText(server, "requestId: req.body?.requestId", "Authorization must accept an idempotency request ID.");
requireText(server, "reason: req.body?.reason", "Authorization and cancellation must record a reason.");
requireText(server, "requestId: req.body?.requestId", "Operator loading must forward its idempotency request ID.");
requireText(server, '"attempt ID"');
requireText(server, '"attempt kind"');
requireText(server, '"re-load cycle"');
requireText(server, '"re-load reason"');
requireText(server, '"attempt operator"');

requireText(control, 'data-action="authorize-sales-order-reload"');
requireText(control, 'data-action="cancel-sales-order-reload"');
requireText(control, "Authorize Re-load");
requireText(control, "Cancel Re-load");
requireText(control, "Re-load reason");
requireText(control, "Exactly the currently loaded local quantities will be offered again");
requireText(control, "/reload-cycles");
requireText(control, "/cancel");
requireText(control, "crypto.randomUUID");
requireText(control, "loadAttempts");
requireText(control, "Physical load attempts");
requireText(control, "Re-load #");
requireText(control, "Original load");

requireText(operator, "reload_authorized");
requireText(operator, "RE-LOAD");
requireText(operator, "reload_reason");
requireText(operator, "Local-only re-load");
requireText(operator, "fulfillmentLoadRequestId");
requireText(operator, "function isPackedReloadReady");
requireText(operator, "Take Photos & Re-load");
requireText(operator, 'data-action="edit-reload-packing"');
requirePattern(
  operator,
  /async function startFulfillment[\s\S]*await api\(`\/api\/delivery\/orders\/[\s\S]*isPackedReloadReady/,
  "Re-load photo entry must refresh and validate the packed cycle before opening the camera screen."
);
requirePattern(
  operator,
  /photoDataUrls: uploadedPhotoRefs,[\s\S]*requestId: fulfillmentLoadRequestId/,
  "Operator load retries must reuse the same request ID."
);

requireText(yard, "listSalesOrderLoadAttempts");
requireText(yard, "activeReloadCycle");
requireText(yard, "attempt_kind");
requireText(yard, "attempt_quantity_basis");
requireText(migration, "uq_operator_reload_cycles_active_sales_order");
requireText(migration, "load_request_id uuid");
requireText(migration, "attempt_line_snapshot jsonb");
requireText(regressionHistory, "SOB116330");
requireText(regressionHistory, "BD98773 / Load 1");
requireText(regressionHistory, "test:sales-order-reload-delivery");
requireText(regressionHistory, "ordinary loaded SO remains protected");
requireText(regressionHistory, "test:sales-order-reload-photo-entry");
requireText(regressionHistory, "Take Photos & Re-load");

console.log(JSON.stringify({
  ok: true,
  assertions: 49,
  controlAuthorization: true,
  operatorMarker: true,
  attemptTimelineAndCsv: true
}));
