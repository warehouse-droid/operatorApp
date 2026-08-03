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
assert.match(cardHtml, /<th>Location<\/th>/);
assert.match(cardHtml, /Requested weight/);
assert.match(cardHtml, /12345 lb/);
assert.match(heldRow, /data-vendor-line-destination/);
assert.match(heldRow, /<option value="15" selected>12441<\/option>/,
  "An editable Vendor Replies line must retain its current destination while exposing every yard.");
assert.match(heldRow, /<option value="1" >3445<\/option>/);
assert.match(heldRow, /4321 lb/);
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
const lockedCardHtml = context.smartVendorLoadCard({ ...proposal, status: "cancelled" });
assert.doesNotMatch(lockedCardHtml, /data-vendor-line-destination/,
  "A locked Vendor Replies load must show its destination without an editable selector.");
assert.match(source, /destinationLocationId:\s*Number\(row\.querySelector\("\[data-vendor-line-destination\]"\)/,
  "The saved Vendor Replies payload must include the currently selected destination yard.");
assert.ok(cardHtml.indexOf('data-smart-action="save-vendor-load"') < cardHtml.indexOf('data-smart-action="toggle-vendor-email"'),
  "The load Save draft control must appear immediately before Draft email in the header.");
assert.doesNotMatch(cardHtml, /data-vendor-email-editor/,
  "Opening an email must not expand the Vendor Replies card inline.");

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
assert.match(html, /scm-smart-vendor\.css\?v=20260801-vendor-email-location-v3/);
assert.match(html, /scm-smart-vendor\.js\?v=20260801-manual-over-capacity-v1/);

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
