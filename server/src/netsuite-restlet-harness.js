import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(dirname, "../netsuite-smart-scm-picking-ticket-restlet.js");
const source = fs.readFileSync(sourcePath, "utf8");

assert.match(source, /@NApiVersion 2\.1/);
assert.match(source, /@NScriptType Restlet/);

let entryPoints;
let remainingUsage = 4990;
let renderFailure = null;
let renderedContent = Buffer.from("%PDF-1.4\nMBBS sandbox stub\n").toString("base64");
let getContentsCalls = 0;
const renderCalls = [];
const recordLoadCalls = [];
const auditLogs = [];
const errorLogs = [];

const errorModule = {
  create(options = {}) {
    const created = new Error(String(options.message || ""));
    created.name = String(options.name || "ERROR");
    created.notifyOff = options.notifyOff === true;
    return created;
  }
};

const logModule = {
  audit(entry) {
    auditLogs.push(entry);
  },
  error(entry) {
    errorLogs.push(entry);
  }
};

const renderModule = {
  PrintMode: { PDF: "PDF" },
  transaction(options) {
    renderCalls.push(JSON.parse(JSON.stringify(options)));
    remainingUsage -= 10;
    return {
      name: "PO 123.pdf",
      size: 27,
      getContents() { getContentsCalls += 1; return renderedContent; }
    };
  },
  pickingTicket(options) {
    renderCalls.push(JSON.parse(JSON.stringify(options)));
    if (renderFailure) throw renderFailure;
    remainingUsage -= 10;
    return {
      name: "SO 123 / picking ticket.pdf",
      size: 27,
      getContents() {
        getContentsCalls += 1;
        return renderedContent;
      }
    };
  }
};

const runtimeModule = {
  accountId: "123456_SB1",
  envType: "SANDBOX",
  EnvType: { SANDBOX: "SANDBOX", PRODUCTION: "PRODUCTION" },
  executionContext: "RESTLET",
  getCurrentScript() {
    return {
      id: "customscript_mbbs_restlet",
      deploymentId: "customdeploy_mbbs_restlet_sb",
      getRemainingUsage() {
        return remainingUsage;
      }
    };
  },
  getCurrentUser() {
    return { id: 321, role: 1042 };
  }
};

const purchaseOrderRecord = {
  getValue({ fieldId }) {
    if (fieldId === "lastmodifieddate") return new Date("2026-08-01T12:30:45.000Z");
    return null;
  },
  getText({ fieldId }) {
    return fieldId === "orderstatus" ? "Pending Receipt" : "";
  },
  getLineCount({ sublistId }) {
    return sublistId === "item" ? 1 : 0;
  },
  getSublistValue({ fieldId }) {
    if (fieldId === "lineuniquekey") return 7001;
    if (fieldId === "item") return 8801;
    if (fieldId === "quantityreceived" || fieldId === "quantityshiprecv") return 0;
    if (fieldId === "isclosed") return false;
    return null;
  },
  setValue() {},
  setSublistValue() {},
  save() { return 321; }
};

const recordModule = {
  Type: { PURCHASE_ORDER: "purchaseorder" },
  load(options) {
    recordLoadCalls.push({ ...options });
    return purchaseOrderRecord;
  }
};

const modules = new Map([
  ["N/error", errorModule],
  ["N/log", logModule],
  ["N/record", recordModule],
  ["N/render", renderModule],
  ["N/runtime", runtimeModule]
]);

const context = vm.createContext({
  define(dependencies, factory) {
    entryPoints = factory(...dependencies.map((dependency) => modules.get(dependency)));
  }
});
vm.runInContext(source, context, { filename: sourcePath });

assert.equal(typeof entryPoints?.get, "function");
assert.equal(typeof entryPoints?.post, "function");

const health = entryPoints.get({ action: "health", requireSandbox: "true" });
assert.equal(health.ok, true);
assert.equal(health.action, "health");
assert.equal(health.version, "3.0.0");
assert.equal(health.sandbox, true);
assert.equal(health.environment, "SANDBOX");
assert.equal(health.accountId, "123456_SB1");
assert.equal(health.capabilities.pickingTicket, true);
assert.equal(health.capabilities.purchaseOrderPdf, true);
assert.equal(health.capabilities.updatePurchaseOrder, true);
assert.equal(health.capabilities.metadataOnly, true);

const legacyTicket = entryPoints.get({
  entityId: "123",
  location: "28",
  formId: "7",
  shipgroup: "2",
  inCustLocale: "true"
});
assert.equal(legacyTicket.ok, true);
assert.equal(legacyTicket.action, "pickingTicket");
assert.equal(legacyTicket.entityId, 123);
assert.equal(legacyTicket.locationApplied, true);
assert.equal(legacyTicket.locationId, 28);
assert.equal(legacyTicket.filename, "SO-123-picking-ticket.pdf");
assert.equal(legacyTicket.contentType, "application/pdf");
assert.equal(legacyTicket.contentEncoding, "base64");
assert.equal(legacyTicket.contentBase64, renderedContent);
assert.equal(legacyTicket.usageUnitsConsumed, 10);
assert.deepEqual(renderCalls[0], {
  entityId: 123,
  printMode: "PDF",
  location: 28,
  formId: 7,
  shipgroup: 2,
  inCustLocale: true
});

const poPdf = entryPoints.post({ action: "purchaseOrderPdf", entityId: 321 });
assert.equal(poPdf.ok, true);
assert.equal(poPdf.action, "purchaseOrderPdf");
assert.equal(poPdf.entityId, 321);
assert.equal(poPdf.contentBase64, renderedContent);
assert.deepEqual(recordLoadCalls[0], { type: "purchaseorder", id: 321, isDynamic: false });

const updatedPo = entryPoints.post({
  action: "updatePurchaseOrder",
  entityId: 321,
  expectedLastModifiedAt: "2026-08-01T12:30:45.000Z",
  lines: [{ lineId: 7001, itemId: 8801, quantity: 12, rate: 5.25, locationId: 28 }]
});
assert.equal(updatedPo.ok, true);
assert.equal(updatedPo.entityId, 321);
assert.throws(
  () => entryPoints.post({
    action: "updatePurchaseOrder",
    entityId: 321,
    expectedLastModifiedAt: "2026-08-01T12:30:45.000Z",
    lines: [{ lineId: 7001, quantity: 12 }, { lineId: 7001, quantity: 13 }]
  }),
  (caught) => caught.name === "MBBS_DUPLICATE_PO_LINE"
);

const contentCallsBeforeMetadata = getContentsCalls;
const metadataTicket = entryPoints.post({
  action: "picking-ticket",
  entityId: 456,
  includeContent: false,
  requireSandbox: true
});
assert.equal(metadataTicket.ok, true);
assert.equal(metadataTicket.entityId, 456);
assert.equal(metadataTicket.contentIncluded, false);
assert.equal(metadataTicket.contentLength, 0);
assert.equal(metadataTicket.contentBase64, "");
assert.equal(getContentsCalls, contentCallsBeforeMetadata);

assert.throws(
  () => entryPoints.get({ action: "pickingTicket", entityId: "abc" }),
  (caught) => caught.name === "MBBS_INVALID_ARGUMENT" && /entityId/.test(caught.message)
);
assert.throws(
  () => entryPoints.get({ action: "pickingTicket", entityId: 123, location: -1 }),
  (caught) => caught.name === "MBBS_INVALID_ARGUMENT" && /location/.test(caught.message)
);
assert.throws(
  () => entryPoints.get({ action: "deleteEverything" }),
  (caught) => caught.name === "MBBS_UNSUPPORTED_ACTION"
);

runtimeModule.envType = runtimeModule.EnvType.PRODUCTION;
runtimeModule.accountId = "123456";
assert.throws(
  () => entryPoints.get({ action: "health", requireSandbox: true }),
  (caught) => caught.name === "MBBS_NOT_SANDBOX"
);
const productionHealth = entryPoints.get({ action: "health" });
assert.equal(productionHealth.ok, true);
assert.equal(productionHealth.sandbox, false);

runtimeModule.envType = runtimeModule.EnvType.SANDBOX;
runtimeModule.accountId = "123456_SB1";
renderFailure = new Error("internal render detail");
assert.throws(
  () => entryPoints.get({ entityId: 999 }),
  (caught) => caught.name === "MBBS_RESTLET_FAILED"
    && /reference mbbs-/.test(caught.message)
    && !/internal render detail/.test(caught.message)
);
renderFailure = null;

renderedContent = "";
assert.throws(
  () => entryPoints.get({ entityId: 1000 }),
  (caught) => caught.name === "MBBS_EMPTY_PDF"
);

assert.ok(auditLogs.length >= 8);
assert.ok(errorLogs.some((entry) => entry.details?.code === "MBBS_NOT_SANDBOX"));
assert.ok(errorLogs.some((entry) => entry.details?.code === "Error"));

console.log("NetSuite sandbox RESTlet health, rendering, validation, and error-contract checks passed.");
