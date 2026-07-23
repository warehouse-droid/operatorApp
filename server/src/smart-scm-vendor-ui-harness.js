import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const publicUrl = new URL("../public/", import.meta.url);
const readPublic = (name) => fs.readFileSync(new URL(name, publicUrl), "utf8");
const listeners = new Map();
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
  smartApi: async () => ({}),
  smartWork: async (_label, action) => action(),
  smartRender() {},
  document: { querySelector: () => null, getElementById: () => null },
  confirm: () => true,
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
  runId: 8001,
  proposalType: "PO",
  status: "vendor_replied",
  vendor: "Harness vendor",
  destinationName: "Harness yard",
  totalPallets: 8,
  vendorResponseStatus: "partial",
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
    ancillaryPallet: true
  }]
};

assert.equal(context.smartVendorDecisionPallets(heldLine, "hold"), 2.5, "A saved Hold draft must reload its entered quantity.");
assert.equal(context.smartVendorDecisionPallets({ ...heldLine, reason: {}, residualPallets: 3 }, "hold"), 3, "Hold defaults to remaining quantity.");

const cardHtml = context.smartVendorLoadCard(proposal);
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

const officialPalletRow = cardHtml.match(/<tr class="smart-physical-pallet-line"[\s\S]*?<\/tr>/)?.[0] || "";
assert.match(officialPalletRow, /Official PALLET/);
assert.match(officialPalletRow, /40 lb \/ EACH/);
assert.match(officialPalletRow, /Manual override/);
assert.match(officialPalletRow, /protected from automatic regeneration/);
assert.match(officialPalletRow, /data-vendor-pallet-quantity/);
assert.match(officialPalletRow, /min="0"/);
assert.match(officialPalletRow, /step="0\.01"/);
assert.match(officialPalletRow, /value="6\.5"/);
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
    { decision: "confirm", decisionPallets: 4, requestedPallets: 4 },
    { decision: "hold", decisionPallets: 2, requestedPallets: 4 },
    { decision: "cancel", decisionPallets: 0, requestedPallets: 4 }
  ]
}));
assert.throws(
  () => context.smartValidateVendorLoadPayload({ palletQuantityOverrides: { 15: -0.01 }, lines: [] }),
  /at or above zero/
);
assert.throws(
  () => context.smartValidateVendorLoadPayload({ lines: [{ decision: "hold", decisionPallets: 0, requestedPallets: 4 }] }),
  /Hold line needs a quantity above 0 PLT/
);
assert.throws(
  () => context.smartValidateVendorLoadPayload({ lines: [{ decision: "hold", decisionPallets: 5, requestedPallets: 4 }] }),
  /cannot exceed/
);

const sectionHtml = context.smartVendorReplies();
assert.match(sectionHtml, /smart-vendor-review-link/);
assert.match(sectionHtml, /smart-vendor-review-icon/);
assert.match(sectionHtml, /Review priced drafts/);
assert.match(sectionHtml, /splits every held line into its own vendor-reply load/);
assert.doesNotMatch(source, /Every line is Hold\. Use Save draft/);
assert.match(source, /decisionSelect\.value !== "cancel"/);

const css = readPublic("scm-smart-vendor.css");
assert.match(css, /\.smart-button\.smart-vendor-review-link\s*\{/);
assert.match(css, /linear-gradient/);
assert.match(css, /\.smart-button\.smart-vendor-review-link:focus-visible/);

console.log(JSON.stringify({
  ok: true,
  holdQuantityEditable: true,
  holdValidationCovered: true,
  reviewActionVisualCovered: true,
  officialPalletOverrideEditable: true,
  explicitZeroAccepted: true,
}));
