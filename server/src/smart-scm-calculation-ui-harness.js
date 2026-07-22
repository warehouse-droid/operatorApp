import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const publicUrl = new URL("../public/", import.meta.url);
const readPublic = (name) => fs.readFileSync(new URL(name, publicUrl), "utf8");
const smartNumber = (value, places = 1) => {
  const amount = Number(value);
  return Number.isFinite(amount)
    ? new Intl.NumberFormat("en-CA", { maximumFractionDigits: places }).format(amount)
    : "—";
};
const smartEscape = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

const proposalContext = vm.createContext({
  smartState: {
    planSearch: "", planType: "", planStatus: "", planSource: "", planDestination: "", planSort: "destination",
    selectedProposalIds: new Set(), plan: null, data: { planningRuns: [] }, busy: ""
  },
  smartCanWrite: () => true,
  smartNumber,
  smartEscape,
  smartPill: () => "",
  smartCoverageEvidence: () => "",
  smartScmApp: { addEventListener() {} },
  smartApi: async () => ({}),
  smartWork: async (_label, action) => action(),
  smartRender() {},
  document: { querySelector: () => null, getElementById: () => null },
  confirm: () => true,
  setTimeout,
  clearTimeout,
  URLSearchParams,
  Map,
  Set,
  Intl
});
vm.runInContext(readPublic("scm-smart-proposals.js"), proposalContext, { filename: "scm-smart-proposals.js" });

const bh80Reason = {
  preferredPallets: 16,
  capacityPallets: 16,
  quantityBackordered: 0,
  positionPallets: 10,
  actualDestinationYard: "150",
  reorderPointPallets: 11,
  quantityAvailable: 0,
  quantityReservedOutbound: 0,
  quantityOnOrder: 816,
  weeklyDemandPallets: 4,
  safetyStockPallets: 3.002221,
  minimumOrderPallets: 3,
  weeksOfCover: 2.5,
  forecastModel: "formula",
  vendorSupplyStatus: "available",
  vendorConfirmationRequired: true,
  importedVendorAvailablePallets: 243,
  coverageSource: "local_item_blend",
  zeroDemandCoverageApplied: false
};
const bh80Line = {
  toPlt: 81.6,
  destinationName: "12441",
  requiredPallets: 6,
  proposedPallets: 6,
  reason: bh80Reason
};
const bh80Html = proposalContext.smartProposalInventory({ proposalType: "PO", destinationName: "12441" }, bh80Line);
assert.match(bh80Html, /<strong>150<\/strong>/, "A vendor-hub line must name the actual planning yard.");
assert.match(bh80Html, /Projected position before recommendation: <strong>10 PLT<\/strong>/);
assert.match(bh80Html, /0 available \+ 10 on order − 0 backorder − 0 reserved = 10 PLT/);
assert.match(bh80Html, /Reorder trigger: <strong>11 PLT<\/strong>/);
assert.match(bh80Html, /Preferred target: <strong>16 PLT<\/strong>/);
assert.match(bh80Html, /10 &lt; ROP 11 → 16 − 10 = <strong>6 PLT recommended<\/strong>/);
assert.match(bh80Html, /After current 6-PLT proposal: <strong>16 PLT<\/strong>/);
assert.match(bh80Html, /Order rule: ceil\(max\(6 target gap, 3 minimum order\)\) within 16-PLT capacity = 6 PLT/);

const reorderedReason = Object.fromEntries(Object.entries(bh80Reason).reverse());
assert.equal(
  proposalContext.smartProposalInventory({ proposalType: "PO", destinationName: "12441" }, { ...bh80Line, reason: reorderedReason }),
  bh80Html,
  "Calculation output must not depend on JSON property order."
);
const noTriggerHtml = proposalContext.smartProposalInventory({ proposalType: "PO", destinationName: "150" }, {
  ...bh80Line,
  requiredPallets: 0,
  proposedPallets: 0,
  reason: { ...bh80Reason, positionPallets: 11 }
});
assert.match(noTriggerHtml, /11 ≥ ROP 11 → <strong>no automatic replenishment trigger<\/strong>/);
assert.doesNotMatch(noTriggerHtml, /Order rule: ceil\(max/, "A non-matching load allocation must not claim the full policy equation.");
const atTargetHtml = proposalContext.smartProposalInventory({ proposalType: "PO", destinationName: "150" }, {
  ...bh80Line,
  requiredPallets: 0,
  proposedPallets: 0,
  reason: { ...bh80Reason, positionPallets: 16 }
});
assert.match(atTargetHtml, /16 ≥ ROP 11 → <strong>no automatic replenishment trigger<\/strong>/);
assert.doesNotMatch(atTargetHtml, /Order rule: ceil\(max/, "A no-trigger state at preferred stock must not claim an MOQ order.");
assert.doesNotMatch(proposalContext.smartProposalDecisionEvidence(bh80Line), /local_item_blend/, "Inactive coverage metadata must not appear as a cause.");
assert.match(proposalContext.smartProposalDecisionEvidence(bh80Line), /Safety stock: 3\.002 PLT/);
assert.match(proposalContext.smartProposalDecisionEvidence(bh80Line), /Vendor supply: available/);
assert.match(proposalContext.smartProposalDecisionEvidence(bh80Line), /Imported vendor available: 243 PLT/);

const appMount = { addEventListener() {}, innerHTML: "" };
const forecastContext = vm.createContext({
  document: { getElementById: () => appMount, addEventListener() {}, createElement: () => ({ click() {}, remove() {} }), body: { appendChild() {} } },
  window: { addEventListener() {} },
  requireDispatchLogin() {},
  dispatchLogout() {},
  fetch: async () => { throw new Error("Unexpected fetch in UI harness."); },
  smartNumber,
  Intl,
  URL,
  URLSearchParams,
  Blob,
  ArrayBuffer,
  FormData,
  Map,
  Set,
  setTimeout,
  clearTimeout
});
vm.runInContext(readPublic("scm-smart.js"), forecastContext, { filename: "scm-smart.js" });
const forecastPolicyHtml = vm.runInContext(`smartForecastStockPolicy({
  safetyStockPallets: 3.002221,
  baseReorderPointPallets: 11,
  basePreferredPallets: 16,
  reorderPointPallets: 11,
  preferredPallets: 16,
  weeklyDemandPallets: 4,
  weeklyDemandSdPallets: 1.632993,
  leadWeeks: 2,
  safetyFactor: 1.3,
  stockPolicyModel: "formula",
  capacityPallets: 16,
  zeroDemandCoverageApplied: false
})`, forecastContext);
assert.match(forecastPolicyHtml, /Safety stock <strong>3\.002 PLT<\/strong>/);
assert.match(forecastPolicyHtml, /ROP <strong>11 PLT<\/strong>/);
assert.match(forecastPolicyHtml, /Preferred stock level <strong>16 PLT<\/strong>/);
assert.match(forecastPolicyHtml, /Capacity <strong>16 PLT<\/strong>/);
assert.match(forecastPolicyHtml, /4 PLT\/week · SD 1\.633 · 2 lead weeks · factor 1\.3 · current policy\/settings/);
assert.match(forecastPolicyHtml, /ROP = round\(3\.002 safety \+ 4 demand × 2 lead\) = 11 PLT/);
assert.match(forecastPolicyHtml, /Preferred = min\(16 capacity, ceil\(11 ROP \+ 4 demand × 2 lead\)\) = 16 PLT/);

const coveragePolicyHtml = vm.runInContext(`smartForecastStockPolicy({
  safetyStockPallets: 2,
  baseReorderPointPallets: 2,
  basePreferredPallets: 2,
  reorderPointPallets: 4,
  preferredPallets: 4,
  weeklyDemandPallets: 0,
  weeklyDemandSdPallets: 0,
  leadWeeks: 1,
  safetyFactor: 1.3,
  stockPolicyModel: "formula",
  capacityPallets: 6,
  zeroDemandCoverageApplied: true
})`, forecastContext);
assert.match(coveragePolicyHtml, /coverage floor raises final ROP to 4 PLT/);
assert.match(coveragePolicyHtml, /Preferred = min\(6 capacity, max\(2 base preferred, 4 ROP\)\) = 4 PLT/);

console.log("Smart SCM calculation UI harness passed.");
