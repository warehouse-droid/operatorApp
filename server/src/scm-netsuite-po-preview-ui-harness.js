import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../public/scm-netsuite-po.js", import.meta.url), "utf8");
const listeners = new Map();
const fetches = [];
const revoked = [];
const poApp = {
  innerHTML: "",
  contains: () => false,
  addEventListener(type, handler) { listeners.set(type, handler); }
};

const context = vm.createContext({
  console,
  Blob,
  Map,
  Set,
  Number,
  String,
  URLSearchParams,
  Intl,
  confirm: () => true,
  setTimeout,
  clearTimeout,
  setInterval: () => 1,
  fetch: async (url, options = {}) => {
    fetches.push({ url: String(url), options });
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => String(name).toLowerCase() === "content-type" ? "application/pdf" : "" },
      blob: async () => new Blob(["%PDF-1.7 POB03688"], { type: "application/pdf" }),
      json: async () => ({}),
      text: async () => ""
    };
  },
  URL: {
    createObjectURL: () => "blob:po-history-preview-1",
    revokeObjectURL: (url) => revoked.push(url)
  },
  dispatchAuthHeaders: (headers = {}) => ({ ...headers, Authorization: "Bearer history-harness-token" }),
  dispatchLogout() {},
  requireDispatchLogin() {},
  document: {
    activeElement: null,
    visibilityState: "hidden",
    getElementById(id) { return id === "smartNetSuitePoApp" ? poApp : null; },
    addEventListener() {}
  },
  window: { addEventListener() {} }
});

vm.runInContext(source, context, { filename: "scm-netsuite-po.js" });
vm.runInContext(`
  poState.operator = { role: "admin", display_name: "Harness" };
  poState.records = [{
    id: 49,
    purchaseOrderId: 946001,
    purchaseOrderRef: "POB03688",
    lifecycle: "pending_receive",
    creationSnapshot: {},
    current: {
      tranid: "POB03688",
      vendor: "Harness vendor",
      status: "B",
      statusText: "Purchase Order : Pending Receipt",
      active: true,
      lines: []
    }
  }];
`, context);

const card = {
  dataset: { historyId: "49" },
  querySelector: () => null,
  querySelectorAll: () => []
};
const previewButton = {
  dataset: { action: "pdf" },
  closest(selector) {
    if (selector === "[data-history-id]") return card;
    return null;
  }
};

await context.act(previewButton);
assert.deepEqual(fetches.map((entry) => entry.url), ["/api/scm/netsuite-po-history/49/pdf"],
  "PO History preview must retrieve the PDF as an authenticated application request.");
assert.equal(fetches[0].options.headers.Authorization, "Bearer history-harness-token");
assert.equal(fetches[0].options.headers.Accept, "application/pdf");
assert.match(poApp.innerHTML, /iframe src="blob:po-history-preview-1"/,
  "Only a temporary local blob URL may be embedded in the PDF iframe.");
assert.doesNotMatch(poApp.innerHTML, /iframe src="\/api\/scm\/netsuite-po-history/,
  "A protected application API URL must never be used as an unauthenticated iframe navigation.");

await context.act({ dataset: { action: "close-pdf" } });
assert.deepEqual(revoked, ["blob:po-history-preview-1"],
  "Closing PO History preview must release the temporary document URL.");

assert.match(source, /fetchPurchaseOrderPdfFromNetSuite|NetSuite PDF preview|application\/pdf/,
  "The frontend must retain an explicit PDF-only preview contract.");

console.log(JSON.stringify({ ok: true, authenticatedAppHop: true, blobPreview: true, oauthBackendBoundary: true }));
