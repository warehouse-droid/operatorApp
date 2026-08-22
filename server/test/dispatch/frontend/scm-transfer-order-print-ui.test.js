import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [page, html, schedule, menu, sidebar, server, service, migration] = await Promise.all([
  readFile(new URL("../../../public/scm-to-printing.js", import.meta.url), "utf8"),
  readFile(new URL("../../../public/scm-to-printing.html", import.meta.url), "utf8"),
  readFile(new URL("../../../public/scm-schedule.js", import.meta.url), "utf8"),
  readFile(new URL("../../../public/scm-menu.html", import.meta.url), "utf8"),
  readFile(new URL("../../../public/app-sidebar.js", import.meta.url), "utf8"),
  readFile(new URL("../../../src/server.js", import.meta.url), "utf8"),
  readFile(new URL("../../../src/scm-transfer-order-print-service.js", import.meta.url), "utf8"),
  readFile(new URL("../../../migrations/168_scm_transfer_order_print_history.sql", import.meta.url), "utf8")
]);

test("SCM has a dedicated TO Printing page modeled on the Sales preview/history flow", () => {
  for (const expected of [
    "Transfer Order Printing",
    'data-action="preview-to"',
    'data-action="history-to"',
    'data-action="view-snapshot"',
    'data-action="queue-preview"',
    "Print to both TO printers",
    "All-module picking-ticket history",
    "Smart SCM, Auto Transfer, and Stock Requests",
    "/api/scm/to-printing/transfer-orders",
    "/api/scm/to-printing/print-jobs"
  ]) {assert.ok(page.includes(expected), `TO Printing UI is missing: ${expected}`);}
  assert.ok(html.includes("/sales.css?v=20260724-preview-queue-v4"));
  assert.ok(html.includes("/scm-to-printing.js?v=20260818-to-printing-v1"));
  assert.ok(page.includes('roles: ["admin", "scm", "scm_staff"]'));
});

test("TO Printing is discoverable from SCM while the PO/TO Schedule has no print action", () => {
  assert.ok(menu.includes("location.href='/scm/to-printing'"));
  assert.ok(sidebar.includes('{ label: "TO Printing", href: "/scm/to-printing", icon: "TP"'));
  assert.ok(server.includes('app.get("/scm/to-printing", (req, res) => {'));
  assert.doesNotMatch(schedule, /data-action="print-transfer-order"/u);
  assert.doesNotMatch(schedule, /scmScheduleTransferOrderPrintRequestId/u);
});

test("the TO Printing API requires SCM write access and enforces preview-before-print", () => {
  assert.ok(server.includes('app.use("/api/scm/to-printing", requireSmartScmWriteAccess);'));
  for (const route of [
    'app.get("/api/scm/to-printing/printers"',
    'app.get("/api/scm/to-printing/print-jobs"',
    'app.get("/api/scm/to-printing/transfer-orders"',
    'app.get("/api/scm/to-printing/transfer-orders/:id/print-history"',
    'app.get("/api/scm/to-printing/transfer-orders/:id/print-history/:jobId/snapshot"',
    'app.get("/api/scm/to-printing/transfer-orders/:id/picking-ticket-preview"',
    'app.post("/api/scm/to-printing/transfer-orders/:id/print"'
  ]) {assert.ok(server.includes(route), `TO Printing API route is missing: ${route}`);}
  assert.ok(server.includes("storeScmTransferOrderPrintPreview({"));
  assert.ok(server.includes("getScmTransferOrderPrintPreview(req.body?.previewToken"));
  assert.ok(server.includes("requestId: req.body?.requestId ?? req.body?.request_id"));
});

test("shared TO history resolves and labels jobs from every TO-producing module", () => {
  for (const expected of [
    "SCM_TRANSFER_ORDER_PRINT_DOCUMENT_TYPES",
    "proposal.netsuite_transfer_order_id",
    "proposal.netsuite_transfer_order_ref",
    "stock-request:%",
    "transfer-dependency:%",
    "smart-scm:%",
    "scm-to-printing:%",
    'sourceModule: cleanText(row.source_module)'
  ]) {assert.ok(service.includes(expected), `Cross-module TO print history is missing: ${expected}`);}
  assert.ok(server.includes("sourceOrderId: transferOrderId"));
  assert.ok(server.includes("sourceOrderRef: transferOrderRef"));
  assert.match(migration, /UPDATE scm_print_jobs job[\s\S]*?scm_smart_proposals proposal/u);
  assert.ok(migration.includes("idx_scm_print_jobs_transfer_order_history_id"));
  assert.ok(migration.includes("idx_scm_print_jobs_transfer_order_history_ref"));
});

test("manual TO printing reads NetSuite and never mutates the Transfer Order", () => {
  assert.ok(service.includes("fetchPickingTicketFromNetSuite"));
  assert.ok(service.includes("fetchTransferOrderByIdFromNetSuite"));
  assert.ok(service.includes("assertAuthoritativeScmTransferOrder"));
  assert.ok(service.includes('documentType: "picking_ticket"'));
  assert.ok(service.includes("queueSmartScmPrintJob"));
  assert.ok(service.includes("isNetSuiteOrderClosed"));
  assert.doesNotMatch(service, /updateTransferOrder(?:Status)?InNetSuite/u);
  assert.doesNotMatch(service, /createTransferOrderInNetSuite/u);
});
