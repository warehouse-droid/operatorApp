import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { buildPurchaseOrderHistoryRestPayload } from "./netsuite.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const migration = read("migrations/099_scm_netsuite_po_history.sql");
const repository = read("src/scm-netsuite-po-history-repository.js");
const service = read("src/scm-netsuite-po-history-service.js");
const vendorCodes = read("src/smart-scm-vendor-code-service.js");
const netsuite = read("src/netsuite.js");
const worker = read("netsuite-order-webhook-scheduled.js");
const directWebhook = read("netsuite-order-webhook-user-event-direct.js");
const restlet = read("netsuite-smart-scm-picking-ticket-restlet.js");
const ui = read("public/scm-netsuite-po.js");
const server = read("src/server.js");

assert.match(migration, /CREATE TABLE IF NOT EXISTS scm_netsuite_po_history/);
assert.match(migration, /creation_snapshot jsonb NOT NULL/);
assert.match(migration, /archived_at timestamptz/);
assert.match(migration, /remote_last_modified_at/);
assert.match(migration, /CREATE TABLE IF NOT EXISTS scm_netsuite_vendor_item_codes/);
assert.match(migration, /source IN \('item_vendor', 'single_vendor_fallback'\)/);

for (const name of ["listScmNetSuitePoHistory", "recordScmNetSuitePoCreation", "setScmNetSuitePoHistoryArchived", "persistScmNetSuitePoSnapshot"]) {
  assert.match(repository, new RegExp(`export async function ${name}\\b`));
}
for (const name of ["registerScmNetSuitePoHistoryCreation", "refreshScmNetSuitePoHistory", "updateScmNetSuitePoHistory", "getScmNetSuitePoHistoryPdf", "processScmNetSuitePoHistoryWebhook"]) {
  assert.match(service, new RegExp(`export async function ${name}\\b`));
}
assert.match(service, /received, closed, cancelled, or inactive and is read-only/);
assert.match(service, /expectedLastModifiedAt/);
assert.match(service, /source: "application"/);
assert.match(service, /Object\.keys\(line\)\.length > 3/,
  "REST line identity fields alone must not turn an unchanged PO line into an update.");
const restUpdatePayload = buildPurchaseOrderHistoryRestPayload({
  header: {
    transactionDate: "2026-08-07",
    expectedDeliveryDate: "2026-08-12",
    memo: "History edit",
    vendorReference: "VENDOR-REF"
  },
  lines: [{
    lineId: 4748749,
    restLineId: 1,
    itemId: 2055,
    quantity: 217.95,
    rate: 5.93,
    locationId: 1
  }]
});
assert.deepEqual(restUpdatePayload, {
  tranDate: "2026-08-07",
  custbody4: "2026-08-12",
  memo: "History edit",
  otherRefNum: "VENDOR-REF",
  item: {
    items: [{ line: 1, quantity: 217.95, rate: 5.93, location: { id: "1" } }]
  }
});
const palletEditPayload = buildPurchaseOrderHistoryRestPayload({
  lines: [{
    lineId: 4748749,
    restLineId: 1,
    itemId: 2055,
    palletQuantity: 6,
    quantity: 261.54,
    updatePalletColumn: true
  }]
});
assert.deepEqual(palletEditPayload.item.items, [{
  line: 1,
  quantity: 261.54,
  custcol_plt: 6
}]);
const updateTransportSource = netsuite.slice(
  netsuite.indexOf("export async function updatePurchaseOrderHistoryInNetSuite"),
  netsuite.indexOf("export async function resolvePalletItemFromNetSuite")
);
assert.match(updateTransportSource, /\/record\/v1\/purchaseOrder\/\$\{id\}/,
  "PO history edits must use the supported REST Record API.");
assert.doesNotMatch(updateTransportSource, /configuredRestletJson|action:\s*"updatePurchaseOrder"/,
  "PO history edits must not depend on optional picking-ticket RESTlet actions.");
assert.match(netsuite, /tl\.id AS rest_line_id/,
  "SuiteQL history snapshots must retain the REST sublist line key.");

assert.match(vendorCodes, /export async function resolveSmartScmVendorItemCodes/);
assert.match(netsuite, /FROM itemvendor iv/);
assert.match(netsuite, /i\.vendorname AS vendor_code/);
assert.match(worker, /lastModifiedDate/);
assert.match(worker, /vendorReference/);
assert.match(worker, /closed:/);
assert.match(directWebhook, /context\.UserEventType\.APPROVE/,
  "The one-script webhook must identify native manual approval events.");
assert.match(directWebhook, /MBBS webhook invoked/,
  "The one-script webhook must log entry before payload construction for deployment diagnostics.");
assert.match(directWebhook, /executionContext:\s*runtime\.executionContext/,
  "The one-script webhook must record which NetSuite execution context invoked it.");
assert.match(directWebhook, /const response = https\.post/,
  "The simple webhook option must post directly without a Scheduled Script worker.");
assert.match(directWebhook, /Webhook failures are logged but must not cancel the user's approval/,
  "A webhook failure must not roll back a successful manual approval.");

let directModule = null;
let postedRequest = null;
const directAuditTitles = [];
const recordValues = {
  tranid: "SO-DIRECT-APPROVE",
  orderstatus: "B",
  status: "B",
  entity: 55,
  custbody3: 2,
  location: 1
};
const loadedRecord = {
  id: 321,
  getValue: ({ fieldId }) => recordValues[fieldId] || "",
  getText: ({ fieldId }) => fieldId === "status"
    ? "Sales Order : Pending Fulfillment"
    : "",
  getLineCount: () => 0
};
const suiteScriptMocks = {
  "N/https": {
    post: (request) => {
      postedRequest = request;
      return { code: 200, body: "ok" };
    }
  },
  "N/log": {
    audit: (title) => directAuditTitles.push(title),
    error: () => {},
    debug: () => {}
  },
  "N/record": {
    Type: {
      SALES_ORDER: "salesorder",
      PURCHASE_ORDER: "purchaseorder",
      TRANSFER_ORDER: "transferorder"
    },
    load: () => loadedRecord
  },
  "N/runtime": {
    executionContext: "USERINTERFACE",
    getCurrentScript: () => ({
      id: "customscript_mbbs_direct",
      deploymentId: "customdeploy_mbbs_direct",
      getParameter: ({ name }) => name === "custscriptmbbs_webhook_url"
        ? "https://example.test/api/webhooks/netsuite/order"
        : name === "custscriptwh_webhook_secret_i"
          ? "harness-secret"
          : ""
    })
  },
  "N/search": { lookupFields: () => ({}) }
};
vm.runInNewContext(directWebhook, {
  define: (dependencies, factory) => {
    directModule = factory(...dependencies.map((dependency) => suiteScriptMocks[dependency]));
  }
});
directModule.afterSubmit({
  type: "approve",
  UserEventType: { APPROVE: "approve", DELETE: "delete" },
  newRecord: {
    id: 321,
    type: "salesorder",
    getValue: ({ fieldId }) => recordValues[fieldId] || "",
    getText: ({ fieldId }) => fieldId === "status"
      ? "Sales Order : Pending Fulfillment"
      : ""
  }
});
assert(postedRequest, "A native manual approval must make the direct webhook request.");
const postedPayload = JSON.parse(postedRequest.body);
assert.equal(postedPayload.eventType, "approve");
assert.equal(postedPayload.manualApproval, true);
assert.equal(postedPayload.executionContext, "USERINTERFACE");
assert.equal(postedPayload.statusText, "Sales Order : Pending Fulfillment");
assert.deepEqual(directAuditTitles, ["MBBS webhook invoked", "MBBS webhook sent"]);
assert.match(restlet, /render\.transaction/);
assert.match(restlet, /MBBS_PO_VERSION_CONFLICT/);
assert.match(restlet, /quantityreceived/);

assert.match(ui, /Archived application-created POs/);
assert.match(ui, /setInterval\(\(\) => \{[\s\S]*60000\)/);
assert.match(ui, /new EventSource\("\/api\/events\?client=scm-netsuite-po-history"\)/);
assert.match(ui, /Preview PDF/);
assert.match(ui, /Return to Vendor Replies/);
assert.match(ui, /expectedLastModifiedAt/);
assert.match(ui, /data-line-field="palletQuantity"/,
  "PO history must expose PLT as the editable quantity.");
assert.match(ui, /data-line-native-quantity/,
  "PO history must retain native SQFT or stock quantity as a read-only field.");
assert.match(ui, /syncNativeQuantityPreview/,
  "Editing PLT must immediately update the read-only native quantity preview.");
assert.match(ui, /record\.lifecycle !== "missing"/,
  "NetSuite action buttons must not render after the PO is confirmed missing.");
assert.match(service, /convertPurchaseOrderPalletQuantity/,
  "The server must own the PLT-to-native conversion used for NetSuite writes.");
assert.match(service, /PLT quantity and native quantity cannot both be provided/,
  "Ambiguous PLT/native write requests must be rejected instead of guessing which quantity wins.");
assert.match(ui, /id="poLifecycle"/,
  "PO history must expose a lifecycle filter.");
assert.match(ui, /option value="completed"/,
  "PO history must let users isolate completed purchase orders.");
assert.match(ui, /option value="pending_receive"/,
  "PO history must let users isolate purchase orders awaiting receipt.");
assert.match(ui, /lifecycle:\s*"pending_receive"/,
  "PO history must default to app-created purchase orders with open quantity.");
assert.match(ui, /option value="missing"/,
  "PO history must let users isolate purchase orders that no longer exist in NetSuite.");
assert.match(ui, /lifecycle: document\.getElementById\("poLifecycle"\)/,
  "The selected lifecycle must be included in PO history requests.");
assert.match(server, /lifecycle: req\.query\.lifecycle/,
  "The PO history endpoint must pass lifecycle filtering to the repository.");
assert.match(repository, /filters\.lifecycle/,
  "PO history lifecycle filtering must be enforced server-side before pagination.");

function renderPoHistoryCard(lifecycle) {
  const mount = {
    addEventListener() {},
    contains() { return false; },
    innerHTML: ""
  };
  const context = vm.createContext({
    console,
    confirm: () => true,
    document: {
      activeElement: null,
      visibilityState: "visible",
      addEventListener() {},
      getElementById: () => mount
    },
    requireDispatchLogin() {},
    setInterval() { return 1; },
    window: { addEventListener() {} }
  });
  vm.runInContext(ui, context);
  const record = {
    id: 10,
    lifecycle,
    purchaseOrderRef: "PO-RENDER-TEST",
    creationSnapshot: {},
    current: {
      active: lifecycle !== "missing",
      lines: [],
      status: lifecycle === "missing" ? "" : "B",
      statusText: lifecycle === "missing" ? "" : "Purchase Order : Pending Receipt",
      tranid: "PO-RENDER-TEST"
    }
  };
  context.__record = record;
  return vm.runInContext("poState.operator = { role: 'scm' }; card(__record)", context);
}

const missingCard = renderPoHistoryCard("missing");
assert.doesNotMatch(missingCard, /data-action="(?:pdf|refresh|save)"/,
  "A deleted PO card must render no button that calls NetSuite.");
assert.match(missingCard, /NetSuite actions unavailable/);
const activeCard = renderPoHistoryCard("active");
for (const action of ["pdf", "refresh", "save"]) {
  assert.match(activeCard, new RegExp(`data-action="${action}"`),
    `An editable active PO must retain its ${action} action.`);
}

const loadSource = ui.slice(
  ui.indexOf("async function load("),
  ui.indexOf("function changesForCard(")
);
const quietGuard = "quiet && !force && quietRefreshBlocked()";
const loadAwaitIndex = loadSource.indexOf("await api(");
const postAwaitQuietGuardIndex = loadSource.indexOf(quietGuard, loadAwaitIndex + 1);
const recordsCommitIndex = loadSource.indexOf("poState.records =", loadAwaitIndex + 1);
const postAwaitRenderIndex = loadSource.indexOf("render()", loadAwaitIndex + 1);
assert.ok(loadAwaitIndex >= 0, "PO history loading must await the server response.");
assert.ok(
  postAwaitQuietGuardIndex > loadAwaitIndex,
  "A quiet non-forced PO history refresh must recheck whether editing began while its request was in flight."
);
assert.ok(
  recordsCommitIndex > postAwaitQuietGuardIndex,
  "A newly blocked quiet refresh must be rejected before it replaces the current PO records."
);
assert.ok(
  postAwaitRenderIndex > postAwaitQuietGuardIndex,
  "A newly blocked quiet refresh must be rejected before any post-request redraw can interrupt the editor."
);
assert.match(
  loadSource,
  /let discardQuietResponse = false;[\s\S]*?quiet && !force && quietRefreshBlocked\(\)[\s\S]*?discardQuietResponse = true;[\s\S]*?finally\s*\{[\s\S]*?!discardQuietResponse[\s\S]*?render\(\)/,
  "Returning from the quiet-response guard must also suppress the finally-block redraw."
);

console.log("NetSuite PO history persistence, guarded editing, PDF, webhook, vendor-code, and live-refresh contracts passed.");
