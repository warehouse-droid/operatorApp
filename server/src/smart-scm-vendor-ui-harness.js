import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const publicUrl = new URL("../public/", import.meta.url);
const readPublic = (name) => fs.readFileSync(new URL(name, publicUrl), "utf8");
const listeners = new Map();
const windowListeners = new Map();
const apiCalls = [];
const clipboardWrites = [];
const openedUrls = [];
const documentFetches = [];
const createdDocumentUrls = [];
const revokedDocumentUrls = [];
let documentFetchError = "";
let confirmResult = true;
const smartNumber = (value, places = 2) => {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "—";
  const formatted = amount.toFixed(places);
  return formatted.includes(".") ? formatted.replace(/0+$/, "").replace(/\.$/, "") : formatted;
};

const context = vm.createContext({
  smartState: { vendorReplyLoads: [], vendorSearch: "", busy: "", data: null, plan: null },
  smartCanWrite: () => true,
  smartNumber,
  smartEscape: (value) => String(value ?? ""),
  smartPill: (_status, label) => label || "",
  smartDate: () => "2026-07-23",
  smartProposalRoute: (proposal) => `${proposal.vendor} → ${proposal.destinationName}`,
  dispatchAuthHeaders: (headers = {}) => ({ ...headers, Authorization: "Bearer harness-app-token" }),
  smartScmApp: { addEventListener(type, handler) { listeners.set(type, handler); } },
  smartApi: async (url, options = {}) => {
    apiCalls.push({ url, options });
    if (String(url).startsWith("/api/scm/smart/vendor-reply-loads?")) return [];
    if (options.method === "DELETE") return { id: 7001, runId: 8001, removed: true };
    return {};
  },
  smartWork: async (_label, action) => action(),
  smartRender() {},
  document: {
    querySelector: () => ({ focus() {} }),
    getElementById: () => null,
    createElement: () => ({ style: {}, select() {}, remove() {} }),
    body: { appendChild() {} },
    execCommand() {}
  },
  navigator: { clipboard: { write: async (items) => clipboardWrites.push(items), writeText: async (value) => clipboardWrites.push(value) } },
  ClipboardItem: class ClipboardItem { constructor(items) { this.items = items; } },
  Blob,
  fetch: async (url, options = {}) => {
    documentFetches.push({ url: String(url), options });
    if (documentFetchError) {
      return {
        ok: false,
        status: 401,
        headers: { get: (name) => String(name).toLowerCase() === "content-type" ? "application/json" : "" },
        blob: async () => new Blob([]),
        json: async () => ({ error: documentFetchError }),
        text: async () => documentFetchError
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => String(name).toLowerCase() === "content-type" ? "application/pdf" : "" },
      blob: async () => new Blob(["%PDF-1.7 harness"], { type: "application/pdf" }),
      json: async () => ({}),
      text: async () => ""
    };
  },
  URL: {
    createObjectURL(blob) {
      assert(blob instanceof Blob);
      const value = `blob:harness-po-preview-${createdDocumentUrls.length + 1}`;
      createdDocumentUrls.push(value);
      return value;
    },
    revokeObjectURL(value) { revokedDocumentUrls.push(value); }
  },
  window: {
    addEventListener(type, handler) { windowListeners.set(type, handler); },
    open(url) { openedUrls.push(String(url)); }
  },
  confirm: () => confirmResult,
  setTimeout,
  clearTimeout,
  URLSearchParams,
  Map,
  Number,
  String
});

const source = readPublic("scm-smart-vendor.js");
vm.runInContext(source, context, { filename: "scm-smart-vendor.js" });

const heldLine = {
  id: 11,
  itemId: 5011,
  itemName: "Held item",
  itemDescription: "Hold split test",
  unit: "EA",
  proposedPallets: 4,
  residualPallets: 4,
  confirmedPallets: 0,
  toPlt: 10,
  purchaseUnit: "EA",
  lastPurchasePrice: 1.64,
  destinationLocationId: 15,
  destinationName: "Harness yard",
  palletWeightLbs: 1080.25,
  lineWeightLbs: 4321,
  reason: { vendorReplyDraft: { decision: "hold", decisionPallets: 2.5 } },
  vendorResponses: [{ response_status: "awaiting" }]
};
const cancelledLine = {
  ...heldLine,
  id: 12,
  itemId: 5012,
  itemName: "Cancelled item",
  reason: { vendorReplyDraft: { decision: "cancel", decisionPallets: 0 } },
  vendorResponses: [{ response_status: "cancelled" }]
};
const proposal = {
  id: 7001,
  sourceProposalId: 7001,
  workflowId: 9001,
  workflowKind: "regular_po",
  workflowStatus: "vendor_replied",
  runId: 8001,
  proposalType: "PO",
  status: "vendor_replied",
  vendor: "Harness vendor",
  destinationName: "Harness yard",
  totalPallets: 8,
  totalWeightLbs: 12345,
  vendorResponseStatus: "partial",
  vendorEmailDraft: {
    to: "saved@vendor.example",
    subject: "Saved request",
    intro: "Saved introduction",
    closing: "Saved closing"
  },
  vendorEmailRows: [{
    itemId: 5011,
    itemName: "Held item",
    vendorCode: "V-5011",
    description: "Hold split test",
    requestedPallets: 4
  }],
  lines: [heldLine, cancelledLine],
  physicalPalletLines: [{
    id: "physical-pallet:7001:15",
    itemId: 1784,
    itemName: "PALLET",
    unit: "EACH",
    purchaseUnit: "EACH",
    lastPurchasePrice: 4.25,
    quantity: 6.5,
    automaticQuantity: 8,
    overrideQuantity: 6.5,
    overridden: true,
    itemWeightLbs: 40,
    lineWeightLbs: 260,
    destinationLocationId: 15,
    destinationName: "Harness yard",
    ancillaryPallet: true
  }]
};

assert.equal(context.smartVendorDecisionPallets(heldLine, "hold"), 2.5, "A saved Hold draft must reload its entered quantity.");
assert.equal(context.smartVendorDecisionPallets({ ...heldLine, reason: {}, residualPallets: 3 }, "hold"), 3, "Hold defaults to remaining quantity.");

const cardHtml = context.smartVendorLoadCard(proposal);
assert.equal(context.smartVendorUnitPriceSource({
  lastPurchasePrice: 12.6,
  unitPriceSource: "vendor_price",
  unitPriceOverridden: false
}), "NetSuite vendor price",
"An untouched vendor-specific price must be identified clearly instead of being labelled as LPP.");
assert.match(context.smartVendorPriceMarkup({
  itemName: "BWS-DC-CHAR",
  purchaseUnit: "PC",
  lastPurchasePrice: 12.6,
  unitPriceSource: "vendor_price",
  unitPriceOverridden: false
}, { editable: true, focusKey: "bws-price" }), /value="12\.6"[\s\S]*NetSuite vendor price/,
"The editable BWS-DC-CHAR price must render 12.60 from Item Vendor, not its lower LPP.");
assert.match(
  context.smartVendorLoadCard({ ...proposal, utilization: 1.08 }),
  /Over capacity · manual/,
  "Vendor Replies must retain the manual over-capacity warning from its proposal."
);
const heldRow = cardHtml.match(/<tr data-vendor-reply-line="11"[\s\S]*?<\/tr>/)?.[0] || "";
const heldInput = heldRow.match(/<input data-vendor-line-field="decisionPallets"[^>]+>/)?.[0] || "";
assert.match(heldInput, /data-vendor-decision-input/);
assert.match(heldInput, /min="0\.01"/);
assert.match(heldInput, /max="4"/);
assert.match(heldInput, /value="2\.5"/);
assert.doesNotMatch(heldInput, /\bdisabled\b/, "Hold quantity must remain editable.");

const cancelledRow = cardHtml.match(/<tr data-vendor-reply-line="12"[\s\S]*?<\/tr>/)?.[0] || "";
const cancelledInput = cancelledRow.match(/<input data-vendor-line-field="decisionPallets"[^>]+>/)?.[0] || "";
assert.match(cancelledInput, /value="0"/);
assert.match(cancelledInput, /\bdisabled\b/, "Cancel must stay zero and non-editable.");
assert.match(cardHtml, /Decision qty/);
assert.match(cardHtml, /Unit price/);
assert.match(cardHtml, /Decision amount/);
assert.match(cardHtml, /<th>Location<\/th>/);
assert.match(cardHtml, /Requested weight/);
assert.match(cardHtml, /12345 lb/);
assert.match(heldRow, /data-vendor-line-destination/);
assert.match(heldRow, /<option value="15" selected>12441<\/option>/,
  "An editable Vendor Replies line must retain its current destination while exposing every yard.");
assert.match(heldRow, /<option value="1" >3445<\/option>/);
assert.match(heldRow, /4321 lb/);
assert.match(heldRow, /data-vendor-unit-price-input/,
  "An editable material line must expose its unit price as an input.");
assert.match(heldRow, /data-vendor-unit-price-input[^>]+type="number"[^>]+value="1\.64"/);
assert.match(heldRow, /per EA · Last Purchase Price/,
  "Vendor Replies must label the source and unit of an editable price.");
assert.match(heldRow, /\$41\.00/,
  "Vendor Replies must multiply 25 EA of decision sales quantity by the 1.64 price.");
assert.equal(context.smartVendorLinePurchaseAmount(heldLine, 25), 41,
  "Material amount calculation must be executable and use sales quantity, not pallets.");
assert.match(cardHtml, /data-smart-action="remove-vendor-load"/);
assert.match(cardHtml, />Remove Load<\/button>/);
assert.doesNotMatch(
  context.smartVendorLoadCard({ ...proposal, status: "cancelled" }),
  /data-smart-action="remove-vendor-load"/,
  "A locked or cancelled vendor load must not expose Remove Load."
);

const officialPalletRow = cardHtml.match(/<tr class="smart-physical-pallet-line"[\s\S]*?<\/tr>/)?.[0] || "";
assert.match(officialPalletRow, /Official PALLET/);
assert.match(officialPalletRow, /40 lb \/ EACH/);
assert.match(officialPalletRow, /Manual override/);
assert.match(officialPalletRow, /protected from automatic regeneration/);
assert.match(officialPalletRow, /data-vendor-pallet-quantity/);
assert.match(officialPalletRow, /min="0"/);
assert.match(officialPalletRow, /step="0\.01"/);
assert.match(officialPalletRow, /value="6\.5"/);
assert.match(officialPalletRow, /Harness yard/);
assert.match(officialPalletRow, /260 lb/);
assert.match(officialPalletRow, /data-vendor-pallet-unit-price-input/,
  "An editable official PALLET row must expose the load-level PALLET price.");
assert.match(officialPalletRow, /data-vendor-pallet-unit-price-input[^>]+value="4\.25"/);
assert.match(officialPalletRow, /\$27\.63/,
  "The official PALLET row must show its rounded quantity amount.");
assert.match(officialPalletRow, /data-vendor-pallet-override-toggle[^>]+checked/);
assert.doesNotMatch(officialPalletRow, /data-vendor-reply-line=/, "PALLET must not become an independent decision or duplicate payload line.");
const automaticPalletRow = context.smartVendorPhysicalPalletRows({
  destinationName: "Harness yard",
  physicalPalletLines: [{
    id: "physical-pallet:7001:15",
    destinationLocationId: 15,
    destinationName: "Harness yard",
    itemName: "PALLET",
    unit: "EACH",
    quantity: 8,
    automaticQuantity: 8,
    overrideQuantity: null,
    overridden: false
  }]
}, true);
assert.match(automaticPalletRow, /Automatic/);
assert.match(automaticPalletRow, /data-vendor-pallet-quantity[^>]+disabled/);
assert.doesNotMatch(automaticPalletRow, /data-vendor-pallet-override-toggle[^>]+checked/);
assert.doesNotThrow(() => context.smartValidateVendorLoadPayload({
  palletQuantityOverrides: { 15: 0 },
  lines: [
    { destinationLocationId: 15, decision: "confirm", decisionPallets: 4, requestedPallets: 4 },
    { destinationLocationId: 15, decision: "hold", decisionPallets: 2, requestedPallets: 4 },
    { destinationLocationId: 15, decision: "cancel", decisionPallets: 0, requestedPallets: 4 }
  ]
}));
assert.throws(
  () => context.smartValidateVendorLoadPayload({ palletQuantityOverrides: { 15: -0.01 }, lines: [] }),
  /at or above zero/
);
assert.throws(
  () => context.smartValidateVendorLoadPayload({ lines: [{ destinationLocationId: 15, decision: "hold", decisionPallets: 0, requestedPallets: 4 }] }),
  /Hold line needs a quantity above 0 PLT/
);
assert.throws(
  () => context.smartValidateVendorLoadPayload({ lines: [{ destinationLocationId: 15, decision: "hold", decisionPallets: 5, requestedPallets: 4 }] }),
  /cannot exceed/
);
assert.throws(
  () => context.smartValidateVendorLoadPayload({ lines: [{ destinationLocationId: 0, decision: "cancel", decisionPallets: 0, requestedPallets: 4 }] }),
  /valid destination yard/
);
assert.throws(
  () => context.smartValidateVendorLoadPayload({ palletUnitPrice: 0, lines: [] }),
  /PALLET unit price must be greater than zero/
);
assert.throws(
  () => context.smartValidateVendorLoadPayload({ lines: [{ destinationLocationId: 15, decision: "cancel", decisionPallets: 0, unitPrice: -1 }] }),
  /Unit price must be greater than zero/
);
const lockedCardHtml = context.smartVendorLoadCard({ ...proposal, status: "cancelled" });
assert.doesNotMatch(lockedCardHtml, /data-vendor-line-destination/,
  "A locked Vendor Replies load must show its destination without an editable selector.");
assert.doesNotMatch(lockedCardHtml, /data-vendor-unit-price-input|data-vendor-pallet-unit-price-input/,
  "A locked Vendor Replies workflow must not expose editable money inputs.");
assert.match(source, /destinationLocationId:\s*Number\(row\.querySelector\("\[data-vendor-line-destination\]"\)/,
  "The saved Vendor Replies payload must include the currently selected destination yard.");
assert.ok(cardHtml.indexOf('data-smart-action="save-vendor-load"') < cardHtml.indexOf('data-smart-action="toggle-vendor-email"'),
  "The load Save draft control must appear immediately before Draft email in the header.");
assert.doesNotMatch(cardHtml, /data-vendor-email-editor/,
  "Opening an email must not expand the Vendor Replies card inline.");

const liveMaterialAmount = { textContent: "" };
const liveMaterialRow = {
  dataset: { toPlt: "10", salesUnit: "EA", lastPurchasePrice: "1.64", purchaseUnitMismatch: "false" },
  querySelector(selector) {
    if (selector === "[data-vendor-decision]") return { value: "confirm" };
    if (selector === "[data-vendor-decision-input]") return { value: "2.5" };
    if (selector === "[data-vendor-unit-price-input]") return { value: "2.75" };
    if (selector === "[data-vendor-sales-quantity]") return { textContent: "" };
    if (selector === "[data-vendor-sales-amount]") return liveMaterialAmount;
    return null;
  }
};
context.smartUpdateVendorReplyLine(liveMaterialRow);
assert.equal(liveMaterialAmount.textContent, "$68.75",
  "Editing unit price must recalculate decision sales quantity × price immediately.");

const materialPriceInput = { value: "2.75", dataset: { vendorUnitPriceDirty: "true" } };
const materialPayloadRow = {
  dataset: { vendorReplyLine: "11", requestedPallets: "4", destinationLocationId: "15" },
  querySelector(selector) {
    if (selector === "[data-vendor-line-destination]") return { value: "15" };
    if (selector === "[data-vendor-unit-price-input]") return materialPriceInput;
    return null;
  },
  querySelectorAll(selector) {
    return selector === "[data-vendor-line-field]"
      ? [{ dataset: { vendorLineField: "decision" }, value: "hold" }, { dataset: { vendorLineField: "decisionPallets" }, value: "2" }]
      : [];
  }
};
const palletPriceInput = { value: "5.5", dataset: { vendorUnitPriceDirty: "true" } };
const palletPayloadRow = {
  dataset: { vendorPalletDestination: "15" },
  querySelector(selector) {
    if (selector === "[data-vendor-pallet-override-toggle]") return { checked: false };
    if (selector === "[data-vendor-pallet-quantity]") return { value: "8" };
    if (selector === "[data-vendor-pallet-unit-price-input]") return palletPriceInput;
    return null;
  }
};
const pricePayloadCard = {
  dataset: { vendorKind: "regular_po" },
  querySelectorAll(selector) {
    if (selector === "[data-vendor-load-field]") return [];
    if (selector === "[data-vendor-reply-line]") return [materialPayloadRow];
    if (selector === "[data-vendor-pallet-destination]") return [palletPayloadRow];
    if (selector === "[data-vendor-pallet-unit-price-input]") return [palletPriceInput];
    return [];
  }
};
const pricePayload = context.smartVendorLoadPayload(pricePayloadCard);
assert.equal(pricePayload.lines[0].unitPrice, 2.75);
assert.equal(pricePayload.palletUnitPrice, 5.5);
const currentPoPriceMarkup = context.smartVendorPriceMarkup({
  ...heldLine,
  lastPurchasePrice: 12.6,
  purchaseAmount: 252,
  unitPriceSource: "netsuite_po_rate",
  priceChangedSinceVendorReply: true,
  vendorReplyConfirmedUnitPrice: 10.67
});
assert.match(currentPoPriceMarkup, /Current NetSuite PO rate/);
assert.match(currentPoPriceMarkup, /Vendor Reply confirmed at/);
assert.equal(context.smartVendorLinePurchaseAmount({
  lastPurchasePrice: 12.6,
  purchaseAmount: 252,
  unitPriceSource: "netsuite_po_rate"
}, 999), 252, "A linked PO must display NetSuite's canonical line amount rather than recomputing its audit snapshot.");

context.smartState.vendorReplyLoads = [proposal];
const draftEmailButton = {
  dataset: { smartAction: "toggle-vendor-email", workflowId: "9001" },
  closest(selector) { return selector === "[data-smart-action]" ? this : null; }
};
await listeners.get("click")({ target: draftEmailButton });
let emailModalHtml = context.smartVendorEmailModal();
assert.match(emailModalHtml, /smart-vendor-email-modal/);
assert.match(emailModalHtml, /role="dialog" aria-modal="true"/);
assert.match(emailModalHtml, /data-vendor-email-field="to"[^>]+saved@vendor\.example/);
assert.match(emailModalHtml, /data-vendor-email-code="5011"[^>]+V-5011/);

listeners.get("input")({ target: {
  dataset: { vendorEmailField: "subject" },
  value: "Live unsaved subject",
  matches(selector) { return selector === "[data-vendor-email-field]"; }
} });
emailModalHtml = context.smartVendorEmailModal();
assert.match(emailModalHtml, /data-vendor-email-field="subject"[^>]+Live unsaved subject/,
  "A rerender must retain real-time unsaved email edits while the modal is open.");

const emailFields = [
  { dataset: { vendorEmailField: "to" }, value: "live@vendor.example" },
  { dataset: { vendorEmailField: "subject" }, value: "Live purchase request" },
  { dataset: { vendorEmailField: "intro" }, value: "Hello from the live editor" },
  { dataset: { vendorEmailField: "closing" }, value: "Regards from SCM" }
];
const emailCode = { dataset: { vendorEmailCode: "5011" }, value: "LIVE-V-5011" };
const emailStatus = { textContent: "" };
const emailRow = {
  cells: [{ innerText: "Held item" }, {}, { innerText: "Hold split test" }, { innerText: "4 PLT" }],
  querySelector(selector) { return selector === "[data-vendor-email-code]" ? emailCode : null; }
};
const emailEditor = {
  querySelectorAll(selector) {
    if (selector === "[data-vendor-email-field]") return emailFields;
    if (selector === "[data-vendor-email-code]") return [emailCode];
    if (selector === "[data-vendor-email-item]") return [emailRow];
    return [];
  },
  querySelector(selector) { return selector === "[data-vendor-email-status]" ? emailStatus : null; }
};
const emailAction = (smartAction) => ({
  dataset: { smartAction, workflowId: "9001" },
  closest(selector) {
    if (selector === "[data-smart-action]") return this;
    if (selector === "[data-vendor-email-editor]") return emailEditor;
    return null;
  }
});

await listeners.get("click")({ target: emailAction("save-vendor-email") });
const savedEmailCall = apiCalls.find((call) => call.url === "/api/scm/smart/vendor-workflows/9001/email-draft");
assert(savedEmailCall, "Save email draft must call the workflow-scoped endpoint.");
assert.deepEqual(JSON.parse(JSON.stringify(savedEmailCall.options.body)), {
  to: "live@vendor.example",
  subject: "Live purchase request",
  intro: "Hello from the live editor",
  closing: "Regards from SCM",
  vendorCodes: { 5011: "LIVE-V-5011" }
});

await listeners.get("click")({ target: emailAction("copy-vendor-email-rich") });
const copiedHtml = await clipboardWrites.at(-1)?.[0]?.items?.["text/html"]?.text();
assert.match(copiedHtml || "", /LIVE-V-5011/);
assert.match(copiedHtml || "", /Hello from the live editor/);
assert.match(emailStatus.textContent, /Rich email copied/);

await listeners.get("click")({ target: emailAction("open-vendor-gmail") });
const gmailUrl = new URL(openedUrls.at(-1));
assert.equal(gmailUrl.origin, "https://mail.google.com");
assert.equal(gmailUrl.searchParams.get("to"), "live@vendor.example");
assert.equal(gmailUrl.searchParams.get("su"), "Live purchase request");
assert.match(gmailUrl.searchParams.get("body") || "", /LIVE-V-5011/,
  "Gmail must receive a send-ready live plain-text fallback body.");
assert.match(emailStatus.textContent, /Gmail opened with the live body/);

await listeners.get("click")({ target: {
  dataset: { smartAction: "close-vendor-email", workflowId: "9001" },
  closest(selector) { return selector === "[data-smart-action]" ? this : null; }
} });
assert.equal(context.smartVendorEmailModal(), "", "Close/backdrop action must dismiss the email modal.");
await listeners.get("click")({ target: draftEmailButton });
windowListeners.get("keydown")({ key: "Escape" });
assert.equal(context.smartVendorEmailModal(), "", "Escape must dismiss the email modal.");

const sectionHtml = context.smartVendorReplies();
assert.match(sectionHtml, /smart-vendor-review-link/);
assert.match(sectionHtml, /smart-vendor-review-icon/);
assert.match(sectionHtml, /NetSuite PO history/);
assert.match(sectionHtml, /create a regular NetSuite PO or finalize a Blanket split/);
assert.match(cardHtml, /smart-vendor-card-primary/);
assert.match(cardHtml, /smart-vendor-card-facts/);
assert.doesNotMatch(cardHtml, /smart-proposal-head/);
assert.doesNotMatch(source, /Every line is Hold\. Use Save draft/);
assert.match(source, /decisionSelect\.value !== "cancel"/);
assert.equal(context.smartVendorReplyDecision({
  ...heldLine,
  confirmedPallets: 2,
  residualPallets: 2,
  reason: { vendorReplyDraft: { decision: "confirm", decisionPallets: 2 } }
}, {
  workflowKind: "blanket_po",
  workflowStatus: "split_pending"
}), "hold", "A reopened partial Blanket remainder must not inherit its stale Confirm draft.");
const partialBlanketHtml = context.smartVendorLoadCard({
  ...proposal,
  workflowKind: "blanket_po",
  workflowStatus: "split_pending",
  sourcePurchaseOrderRef: "PO-BLANKET-1",
  totalPallets: 4,
  lines: [{
    ...heldLine,
    proposedPallets: 4,
    confirmedPallets: 2,
    residualPallets: 2,
    reason: { vendorReplyDraft: { decision: "confirm", decisionPallets: 2 } }
  }],
  physicalPalletLines: []
});
const partialBlanketRow = partialBlanketHtml.match(/<tr data-vendor-reply-line="11"[\s\S]*?<\/tr>/)?.[0] || "";
assert.match(partialBlanketHtml, /Held remainder<\/b> 2 PLT/);
assert.match(partialBlanketHtml, /only the held remainder/);
assert.match(partialBlanketRow, /data-requested-pallets="2"/);
assert.match(partialBlanketRow, /max="2"/);
assert.match(partialBlanketRow, /value="2"/);
assert.match(partialBlanketRow, /<option value="hold" selected>/);

const css = readPublic("scm-smart-vendor.css");
assert.match(css, /\.smart-button\.smart-vendor-review-link\s*\{/);
assert.match(css, /linear-gradient/);
assert.match(css, /\.smart-button\.smart-vendor-review-link:focus-visible/);
assert.match(css, /\.smart-vendor-remove-load\s*\{/);
assert.match(css, /\.smart-vendor-pdf-modal\s*\{/);
assert.match(css, /\.smart-vendor-email-modal\s*\{/);
assert.match(css, /\.smart-vendor-email-dialog\s*\{/);
assert.match(source, /smartVendorEmailModalDraft/,
  "Unsaved email edits need modal-local state so unrelated rerenders cannot erase them.");
assert.match(source, /data-smart-action="close-vendor-po-preview"/);
assert.match(source, /event\.key !== "Escape"/);

const previewCard = {
  querySelector: () => ({ textContent: "POB03688" })
};
const previewButton = {
  dataset: { smartAction: "preview-vendor-po", workflowId: "9001" },
  closest(selector) {
    if (selector === "[data-smart-action]") return this;
    if (selector === "[data-vendor-load]") return previewCard;
    return null;
  }
};
await listeners.get("click")({ target: previewButton });
assert.deepEqual(documentFetches.map((entry) => entry.url), [
  "/api/scm/smart/vendor-workflows/9001/purchase-order.pdf"
], "PO preview must fetch through the authenticated page request path instead of an unauthenticated iframe navigation.");
assert.equal(documentFetches[0].options.headers.Authorization, "Bearer harness-app-token",
  "The browser-to-application PDF request must explicitly carry the logged-in application bearer token.");
assert.equal(documentFetches[0].options.headers.Accept, "application/pdf");
const previewHtml = context.smartVendorPoPreviewModal();
assert.match(previewHtml, /blob:harness-po-preview-1/,
  "The fetched PDF blob must be embedded in the in-app preview.");
assert.doesNotMatch(previewHtml, /iframe src="\/api\/scm\/smart\/vendor-workflows/,
  "The iframe must never navigate directly to a bearer-protected API endpoint.");
await listeners.get("click")({ target: {
  dataset: { smartAction: "close-vendor-po-preview" },
  closest(selector) { return selector === "[data-smart-action]" ? this : null; }
} });
assert.deepEqual(revokedDocumentUrls, ["blob:harness-po-preview-1"],
  "Closing a preview must release its temporary PDF URL.");
documentFetchError = "Preview authorization expired.";
await listeners.get("click")({ target: previewButton });
const failedPreviewHtml = context.smartVendorPoPreviewModal();
assert.match(failedPreviewHtml, /Preview could not be loaded/);
assert.match(failedPreviewHtml, /Preview authorization expired\./,
  "A failed authenticated fetch must show the server error instead of a blank document frame.");
assert.match(failedPreviewHtml, /data-smart-action="retry-vendor-po-preview"/);
assert.equal(createdDocumentUrls.length, 1,
  "An error response must never be converted into a document URL.");
await listeners.get("click")({ target: {
  dataset: { smartAction: "close-vendor-po-preview" },
  closest(selector) { return selector === "[data-smart-action]" ? this : null; }
} });
documentFetchError = "";

const removeButton = {
  dataset: { smartAction: "remove-vendor-load", proposalId: "7001" },
  closest(selector) {
    return selector === "[data-smart-action]" ? this : null;
  }
};
confirmResult = false;
const callsBeforeCancelledPrompt = apiCalls.length;
await listeners.get("click")({ target: removeButton });
assert.equal(apiCalls.length, callsBeforeCancelledPrompt,
  "Dismissing the Remove Load confirmation must not call the API or refresh the queue.");
confirmResult = true;
await listeners.get("click")({ target: removeButton });
const removeRequest = apiCalls.find((call) =>
  call.url === "/api/scm/smart/vendor-reply-loads/7001"
  && call.options.method === "DELETE"
);
assert(removeRequest, "Remove Load must call the dedicated Vendor Replies removal endpoint.");
assert(apiCalls.some((call) => String(call.url).startsWith("/api/scm/smart/vendor-reply-loads?")),
  "Removing a vendor load must refresh the cross-plan queue.");

const html = readPublic("scm-smart.html");
assert.match(html, /scm-smart-vendor\.css\?v=20260812-vendor-price-source-v1/);
assert.match(html, /scm-smart\.js\?v=20260812-vendor-po-price-sync-v1/);
assert.match(html, /scm-smart-vendor\.js\?v=20260812-vendor-po-price-sync-v1/);

console.log(JSON.stringify({
  ok: true,
  holdQuantityEditable: true,
  holdValidationCovered: true,
  reviewActionVisualCovered: true,
  officialPalletOverrideEditable: true,
  explicitZeroAccepted: true,
  locationAndWeightVisible: true,
  emailModalAndGmailCovered: true,
  removeLoadCovered: true,
}));
