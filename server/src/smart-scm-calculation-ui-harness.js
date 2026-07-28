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
  smartPercent: (value) => `${Math.round(Number(value || 0) * 100)}%`,
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
assert.match(bh80Html, /<strong>150 destination need<\/strong>/, "A vendor-hub line must name the actual planning yard.");
assert.match(bh80Html, /Projected position before recommendation: <strong>10 PLT<\/strong>/);
assert.match(bh80Html, /0 available \+ 10 on order − 0 backorder − 0 reserved = 10 PLT/);
assert.match(bh80Html, /Reorder trigger: <strong>11 PLT<\/strong>/);
assert.match(bh80Html, /Preferred target: <strong>16 PLT<\/strong>/);
assert.match(bh80Html, /10 &lt; ROP 11 → target gap 6 PLT → <strong>6 PLT destination policy need<\/strong>/);
assert.match(bh80Html, /After current 6-PLT proposal: <strong>16 PLT<\/strong>/);
assert.match(bh80Html, /Saved rule: min\(ceil\(max\(6 target gap, 3 minimum order\)\), floor\(16 capacity − 10 position\)\) = 6 PLT/);

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
assert.doesNotMatch(noTriggerHtml, /Saved rule:/, "A non-trigger state must not claim an order rule.");
const atTargetHtml = proposalContext.smartProposalInventory({ proposalType: "PO", destinationName: "150" }, {
  ...bh80Line,
  requiredPallets: 0,
  proposedPallets: 0,
  reason: { ...bh80Reason, positionPallets: 16 }
});
assert.match(atTargetHtml, /16 ≥ ROP 11 → <strong>no automatic replenishment trigger<\/strong>/);
assert.doesNotMatch(atTargetHtml, /Saved rule:/, "A no-trigger state at preferred stock must not claim an MOQ order.");
const moqBindingHtml = proposalContext.smartProposalInventory({ proposalType: "PO", destinationName: "150" }, {
  ...bh80Line,
  requiredPallets: 3,
  proposedPallets: 3,
  reason: {
    ...bh80Reason,
    positionPallets: 2.5,
    reorderPointPallets: 3,
    preferredPallets: 4,
    minimumOrderPallets: 3,
    capacityPallets: 10
  }
});
assert.match(moqBindingHtml, /2\.5 &lt; ROP 3 → target gap 1\.5 PLT → <strong>3 PLT destination policy need<\/strong>/);
assert.match(moqBindingHtml, /Saved rule: min\(ceil\(max\(1\.5 target gap, 3 minimum order\)\), floor\(10 capacity − 2\.5 position\)\) = 3 PLT/);
assert.doesNotMatch(moqBindingHtml, /order up to 4/, "An MOQ-bound recommendation must not claim it stops at the preferred level.");
const historicalMovedLine = {
  ...bh80Line,
  destinationName: "2967",
  reason: {
    ...bh80Reason,
    destinationManuallyAdjusted: true,
    manuallyAdjusted: true,
    quantityAvailable: 81.6,
    quantityOnOrder: 0,
    quantityBackordered: 0,
    quantityReservedOutbound: 0
  }
};
const historicalMovedHtml = proposalContext.smartProposalInventory({ proposalType: "PO", destinationName: "2967" }, historicalMovedLine);
assert.match(historicalMovedHtml, /Destination changed after planning; build a new plan to calculate this yard's policy need/);
assert.doesNotMatch(historicalMovedHtml, /Reorder trigger:/, "A historical destination edit must not display the old yard's ROP.");
const historicalMovedEvidence = proposalContext.smartProposalDecisionEvidence(historicalMovedLine);
assert.match(historicalMovedEvidence, /Destination changed · rebuild plan for yard policy evidence/);
assert.doesNotMatch(historicalMovedEvidence, /Safety stock:/, "A historical destination edit must hide the old yard's policy evidence.");
assert.doesNotMatch(proposalContext.smartProposalDecisionEvidence(bh80Line), /local_item_blend/, "Inactive coverage metadata must not appear as a cause.");
assert.match(proposalContext.smartProposalDecisionEvidence(bh80Line), /Safety stock: 3\.002 PLT/);
assert.match(proposalContext.smartProposalDecisionEvidence(bh80Line), /Vendor supply: available/);
assert.match(proposalContext.smartProposalDecisionEvidence(bh80Line), /Imported vendor available: 243 PLT/);
const lowerStockEvidence = proposalContext.smartProposalDecisionEvidence({
  ...bh80Line,
  reason: {
    ...bh80Reason,
    lowerStockPolicyEnabled: true,
    lowerStockPolicyApplied: true,
    configuredMinimumSafetyPallets: 3,
    effectiveMinimumSafetyPallets: 1,
    standardSafetyStockPallets: 3,
    safetyStockPallets: 1,
    standardReorderPointPallets: 11,
    reorderPointPallets: 9,
    standardPreferredPallets: 16,
    preferredPallets: 14
  }
});
assert.match(lowerStockEvidence, /Lower stock policy · 1-PLT floor/);
assert.match(lowerStockEvidence, /Safety 3 → 1/);
assert.match(lowerStockEvidence, /ROP 11 → 9/);
assert.match(lowerStockEvidence, /Preferred 16 → 14 PLT/);

const transferLine = {
  id: 71,
  itemId: 2298,
  itemName: "Transfer test",
  itemDescription: "Generated TO line",
  destinationLocationId: 26,
  destinationName: "150",
  toPlt: 6,
  requiredPallets: 3,
  proposedPallets: 1,
  salesQuantity: 6,
  lineWeightLbs: 1000,
  reason: {
    quantityAvailable: 7,
    quantityOnOrder: 0,
    quantityBackordered: 0,
    quantityReservedOutbound: 0,
    availablePallets: 1.166667,
    positionPallets: 1.166667,
    reorderPointPallets: 3,
    preferredPallets: 4,
    minimumOrderPallets: 1,
    capacityPallets: 6,
    sourceAvailablePallets: 2.5,
    sourceSafetyStockPallets: 1,
    sourceReorderPointPallets: 1,
    sourcePreferredPallets: 2,
    sourceLowerStockPolicyEnabled: true,
    sourceLowerStockPolicyApplied: true,
    sourceStandardSafetyStockPallets: 2,
    sourceStandardReorderPointPallets: 2,
    sourceStandardPreferredPallets: 3,
    sourceProtectedFloorPallets: 1,
    sourceMaximumTransferablePallets: 1
  }
};
const transferProposal = {
  id: 700,
  proposalType: "TO",
  phase: "internal_transfer",
  sourceName: "12441",
  destinationLocationId: 26,
  destinationName: "150",
  status: "draft",
  totalPallets: 1,
  totalWeightLbs: 1000,
  utilization: 0.1,
  routeStops: [{ locationId: 26, name: "150" }],
  lines: [transferLine]
};
const transferHtml = proposalContext.smartProposalInventory(transferProposal, transferLine);
assert.match(transferHtml, /12441 source protection/);
assert.match(transferHtml, /Lower stock policy · 1-PLT floor: Safety 2 → 1 PLT · ROP 2 → 1 PLT · Preferred 3 → 2 PLT/);
assert.match(transferHtml, /Protected floor = max\(1 safety stock, 1 ROP\) = 1 PLT/);
assert.match(transferHtml, /Maximum transferable = floor\(max\(0, 2\.5 available − 1 protected\)\) = 1 PLT/);
assert.match(transferHtml, /1 PLT transfer ≤ 1 PLT calculated limit → <strong>within source limit<\/strong>/);
assert.match(transferHtml, /Source after this TO line: <strong>1\.5 PLT<\/strong>/);
assert.match(transferHtml, /150 destination need/);
assert.match(transferHtml, /1\.17 &lt; ROP 3 → target gap 2\.83 PLT → <strong>3 PLT destination policy need<\/strong>/);
assert.match(transferHtml, /Saved rule: min\(ceil\(max\(2\.83 target gap, 1 minimum order\)\), floor\(6 capacity − 1\.17 position\)\) = 3 PLT/);
assert.match(transferHtml, /This TO line carries: <strong>1 of 3 PLT calculated policy need<\/strong>/);
assert.match(transferHtml, /After current 1-PLT TO line: <strong>2\.17 PLT<\/strong>/);
assert.match(proposalContext.smartProposalDecisionEvidence(transferLine), /Source protected floor: 1 PLT/);
assert.match(proposalContext.smartProposalDecisionEvidence(transferLine), /Source transfer limit: 1 PLT/);

const manualTransferHtml = proposalContext.smartProposalInventory(transferProposal, {
  ...transferLine,
  requiredPallets: 2,
  proposedPallets: 2,
  reason: {
    quantityAvailable: 12,
    quantityOnOrder: 0,
    quantityBackordered: 0,
    quantityReservedOutbound: 0,
    destinationAvailablePallets: 2,
    sourceAvailablePallets: 5,
    manuallyAdded: true
  }
});
assert.match(manualTransferHtml, /Source safety\/ROP calculation was not captured for this manual or legacy line/);
assert.match(manualTransferHtml, /Policy trigger and target were not captured for this manual or legacy line/);
assert.match(manualTransferHtml, /Source after this TO line: <strong>3 PLT<\/strong>/);

const groupedTransferHtml = proposalContext.smartProposalInventory({ ...transferProposal, manuallyGrouped: true }, {
  ...transferLine,
  requiredPallets: 6,
  proposedPallets: 2
});
assert.match(groupedTransferHtml, /Stored line requirement 6 PLT differs after editing\/grouping; calculated snapshot need is 3 PLT/);
assert.match(groupedTransferHtml, /This TO line carries: <strong>2 of 3 PLT calculated policy need<\/strong>/);
assert.doesNotMatch(groupedTransferHtml, /6 PLT saved need/);

const inconsistentSourceHtml = proposalContext.smartProposalInventory(transferProposal, {
  ...transferLine,
  reason: {
    ...transferLine.reason,
    sourceAvailablePallets: 5,
    sourceSafetyStockPallets: 1,
    sourceReorderPointPallets: 2,
    sourceProtectedFloorPallets: 1,
    sourceMaximumTransferablePallets: 10
  }
});
assert.match(inconsistentSourceHtml, /Protected floor = max\(1 safety stock, 2 ROP\) = 2 PLT/);
assert.match(inconsistentSourceHtml, /Maximum transferable = floor\(max\(0, 5 available − 2 protected\)\) = 3 PLT/);
assert.match(inconsistentSourceHtml, /Saved source-limit fields are inconsistent; refresh and replan before confirmation/);
assert.match(inconsistentSourceHtml, /1 PLT transfer ≤ 3 PLT calculated limit/);

assert.equal(proposalContext.smartState.planShowInventory, true, "Inventory should be visible by default.");
assert.equal(proposalContext.smartState.planShowDecisionEvidence, true, "Decision evidence should be visible by default.");
assert.match(proposalContext.smartProposalColumnControls(), /data-smart-plan-detail="inventory" type="checkbox" checked/);
assert.match(proposalContext.smartProposalColumnControls(), /data-smart-plan-detail="decision-evidence" type="checkbox" checked/);
proposalContext.smartState.planShowInventory = false;
proposalContext.smartState.planShowDecisionEvidence = false;
const compactTransferCard = proposalContext.smartProposalCard(transferProposal);
assert.match(compactTransferCard, /smart-proposal-lines smart-table-wrap smart-proposal-lines-compact/);
assert.match(compactTransferCard, /data-smart-plan-column="inventory" hidden/);
assert.match(compactTransferCard, /data-smart-plan-column="decision-evidence" hidden/);
proposalContext.smartState.planShowInventory = true;
const oneDetailHiddenCard = proposalContext.smartProposalCard(transferProposal);
assert.match(oneDetailHiddenCard, /smart-proposal-lines smart-table-wrap smart-proposal-lines-one-detail-hidden/);
assert.doesNotMatch(oneDetailHiddenCard, /data-smart-plan-column="inventory" hidden/);
assert.match(oneDetailHiddenCard, /data-smart-plan-column="decision-evidence" hidden/);
proposalContext.smartState.planShowDecisionEvidence = true;
proposalContext.localStorage = { setItem() { throw new Error("quota exceeded"); } };
assert.equal(proposalContext.smartSaveProposalColumnPreferences(), false, "Storage quota failures must not block column changes.");
proposalContext.localStorage = { getItem() { throw new Error("storage unavailable"); } };
const fallbackColumns = proposalContext.smartLoadProposalColumnPreferences();
assert.equal(fallbackColumns.inventory, true);
assert.equal(fallbackColumns.decisionEvidence, true);
delete proposalContext.localStorage;

const proposalCss = readPublic("scm-smart-proposals.css");
assert.match(proposalCss, /\.smart-proposal-lines-one-detail-hidden \.smart-table\s*\{\s*min-width: 1050px;/);
assert.match(proposalCss, /\.smart-proposal-lines-compact \.smart-table\s*\{\s*min-width: 900px;/);
assert.match(proposalCss, /\.smart-proposal-lines-compact \.smart-table td \{\s*padding-top: 5px;/);

const appListeners = new Map();
const appMount = {
  addEventListener(type, listener) {
    appListeners.set(type, listener);
  },
  innerHTML: ""
};
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
vm.runInContext("smartState.operator = { role: 'scm' };", forecastContext);
forecastContext.__capturedItemsUrl = null;
vm.runInContext(`
  smartState.itemLowerStockPolicy = "yard:150";
  smartApi = async (url) => {
    __capturedItemsUrl = url;
    return { items: [], total: 0, limit: 150, offset: 0, vendorYards: [] };
  };
  smartRender = () => {};
`, forecastContext);
await vm.runInContext("smartLoadItems({ reset: true, quiet: true })", forecastContext);
const filteredItemsUrl = new URL(forecastContext.__capturedItemsUrl, "https://example.test");
assert.equal(filteredItemsUrl.searchParams.get("lowerStockPolicy"), "yard:150");
const lowerStockFilterOptions = vm.runInContext("smartLowerStockPolicyFilterOptions()", forecastContext);
assert.match(lowerStockFilterOptions, /value="yard:150" selected>Lower stock enabled · 150<\/option>/);
assert.match(lowerStockFilterOptions, /value="any" >Lower stock enabled · any yard<\/option>/);

const itemYardHtml = vm.runInContext(`smartItemYardCell({
  itemName: "LOWER-STOCK-TEST",
  stockUnit: "EA",
  toPlt: 100,
  balances: [{ locationId: 28, quantityAvailable: 250 }],
  yardPolicies: [{
    locationId: 28,
    yardCode: "2967",
    eligible: false,
    capacityPallets: null,
    serviceQuantile: 0.9,
    minimumSafetyPallets: 3,
    lowerStockPolicyEnabled: true
  }]
}, { locationId: 28, code: "2967" })`, forecastContext);
const itemYardLowerPolicyInput = itemYardHtml.match(/<input data-item-yard-lower-stock="28"[^>]*>/)?.[0] || "";
assert.match(itemYardLowerPolicyInput, /type="checkbox"/);
assert.match(itemYardLowerPolicyInput, /\bchecked\b/, "The optional policy must render its saved per-yard state.");
assert.match(itemYardLowerPolicyInput, /aria-label="Lower stock policy for LOWER-STOCK-TEST, yard 2967"/);
assert.match(
  itemYardLowerPolicyInput,
  /\bdisabled\b/,
  "The lower-stock policy must remain visible but disabled while this yard is not planned."
);
const plannedItemYardHtml = vm.runInContext(`smartItemYardCell({
  itemName: "LOWER-STOCK-TEST",
  stockUnit: "EA",
  toPlt: 100,
  balances: [{ locationId: 28, quantityAvailable: 250 }],
  yardPolicies: [{
    locationId: 28,
    yardCode: "2967",
    eligible: true,
    capacityPallets: 12,
    serviceQuantile: 0.9,
    minimumSafetyPallets: 3,
    lowerStockPolicyEnabled: true
  }]
}, { locationId: 28, code: "2967" })`, forecastContext);
const plannedItemYardLowerPolicyInput = plannedItemYardHtml.match(/<input data-item-yard-lower-stock="28"[^>]*>/)?.[0] || "";
assert.match(plannedItemYardLowerPolicyInput, /\bchecked\b/);
assert.doesNotMatch(plannedItemYardLowerPolicyInput, /\bdisabled\b/, "A write user must be able to select the optional policy for a planned yard.");
const defaultOffItemYardHtml = vm.runInContext(`smartItemYardCell({
  itemName: "DEFAULT-OFF-TEST",
  stockUnit: "EA",
  toPlt: 100,
  balances: [{ locationId: 28, quantityAvailable: 250 }],
  yardPolicies: [{
    locationId: 28,
    yardCode: "2967",
    eligible: true,
    capacityPallets: 12,
    serviceQuantile: 0.9,
    minimumSafetyPallets: 3,
    lowerStockPolicyEnabled: false
  }]
}, { locationId: 28, code: "2967" })`, forecastContext);
assert.doesNotMatch(
  defaultOffItemYardHtml.match(/<input data-item-yard-lower-stock="28"[^>]*>/)?.[0] || "",
  /\bchecked\b/,
  "The optional policy must render unchecked when it has not been enabled."
);
assert.match(defaultOffItemYardHtml, /Lower stock policy \(1-PLT floor\)/, "Touch layouts need a visible policy explanation.");
vm.runInContext("smartState.operator = { role: 'yard_manager' };", forecastContext);
const readOnlyItemYardHtml = vm.runInContext(`smartItemYardCell({
  itemName: "LOWER-STOCK-TEST",
  stockUnit: "EA",
  toPlt: 100,
  balances: [{ locationId: 28, quantityAvailable: 250 }],
  yardPolicies: [{
    locationId: 28,
    yardCode: "2967",
    eligible: true,
    capacityPallets: 12,
    serviceQuantile: 0.9,
    minimumSafetyPallets: 3,
    lowerStockPolicyEnabled: true
  }]
}, { locationId: 28, code: "2967" })`, forecastContext);
assert.match(
  readOnlyItemYardHtml.match(/<input data-item-yard-lower-stock="28"[^>]*>/)?.[0] || "",
  /\bdisabled\b/,
  "Read-only roles must not be able to change the lower-stock policy."
);
vm.runInContext("smartState.operator = { role: 'scm' };", forecastContext);

forecastContext.__capturedItemSave = null;
vm.runInContext(`
  smartApi = async (url, options = {}) => {
    __capturedItemSave = { url, body: options.body };
    return { itemId: 501 };
  };
  smartRender = () => {};
  smartRestoreItemViewport = () => {};
`, forecastContext);
const itemSaveClick = appListeners.get("click");
assert.equal(typeof itemSaveClick, "function");
const capacityInput = {
  value: "12",
  dataset: {},
  setCustomValidity(message) { this.validationMessage = message; },
  focus() { this.focused = true; },
  reportValidity() { this.reported = true; }
};
const lowerStockPolicyInput = { checked: true, disabled: false };
const yardToggle = {
  checked: true,
  dataset: {
    itemYardEnabled: "28",
    yardCode: "2967",
    serviceQuantile: "0.9"
  },
  matches(selector) {
    return selector === "[data-item-yard-enabled]";
  },
  closest(selector) {
    return selector === "[data-item-row]" ? itemRow : null;
  }
};
const vendorYardSelect = { value: "", dataset: { sourceYard: "" } };
const itemRow = {
  dataset: { itemRow: "501" },
  closest(selector) {
    return selector === ".smart-item-grid-wrap"
      ? { scrollLeft: 0, scrollTop: 0 }
      : null;
  },
  getBoundingClientRect() {
    return { top: 100 };
  },
  querySelectorAll(selector) {
    return selector === "[data-item-yard-enabled]" ? [yardToggle] : [];
  },
  querySelector(selector) {
    const fields = {
      '[data-item-yard-capacity="28"]': capacityInput,
      '[data-item-yard-lower-stock="28"]': lowerStockPolicyInput,
      '[data-item-field="vendorYardId"]': vendorYardSelect,
      '[data-item-field="planningEnabled"]': { checked: true },
      '[data-item-field="leadTimeDays"]': { value: "14" }
    };
    return fields[selector] || null;
  }
};
const itemYardChange = appListeners.get("change");
assert.equal(typeof itemYardChange, "function");
yardToggle.checked = false;
await itemYardChange({ target: yardToggle });
assert.equal(lowerStockPolicyInput.checked, true, "Disabling yard planning must preserve the optional policy selection.");
assert.equal(lowerStockPolicyInput.disabled, true);
assert.equal(capacityInput.value, "");
yardToggle.checked = true;
await itemYardChange({ target: yardToggle });
assert.equal(lowerStockPolicyInput.checked, true, "Re-enabling yard planning must retain the policy selection.");
assert.equal(lowerStockPolicyInput.disabled, false);
assert.equal(capacityInput.value, "12", "Capacity's existing off/on restoration must remain intact.");

const saveButton = {
  dataset: { smartAction: "save-item", itemId: "501" },
  disabled: false,
  textContent: "Save",
  closest(selector) {
    if (selector === "[data-smart-action]") return this;
    if (selector === "[data-item-row]") return itemRow;
    return null;
  }
};
await itemSaveClick({
  target: {
    closest(selector) {
      if (selector === "[data-smart-tab]") return null;
      if (selector === "[data-smart-action]") return saveButton;
      return null;
    }
  }
});
assert.equal(forecastContext.__capturedItemSave.url, "/api/scm/smart/items/501");
assert.equal(forecastContext.__capturedItemSave.body.yardPolicies[0].lowerStockPolicyEnabled, true);
assert.equal(
  Object.hasOwn(forecastContext.__capturedItemSave.body.yardPolicies[0], "minimumSafetyPallets"),
  false,
  "The checkbox save must leave the legacy configured floor untouched."
);
assert.equal(forecastContext.__capturedItemSave.body.yardPolicies[0].locationId, 28);

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

const lowerStockPolicyHtml = vm.runInContext(`smartForecastStockPolicy({
  lowerStockPolicyEnabled: true,
  lowerStockPolicyApplied: true,
  standardSafetyStockPallets: 3,
  safetyStockPallets: 1,
  standardReorderPointPallets: 11,
  baseReorderPointPallets: 9,
  standardPreferredPallets: 16,
  basePreferredPallets: 14,
  reorderPointPallets: 9,
  preferredPallets: 14,
  weeklyDemandPallets: 4,
  weeklyDemandSdPallets: 0,
  leadWeeks: 2,
  safetyFactor: 1.3,
  stockPolicyModel: "formula",
  capacityPallets: 20,
  zeroDemandCoverageApplied: false
})`, forecastContext);
assert.match(lowerStockPolicyHtml, /Lower stock policy applied · 1-PLT minimum safety floor/);
assert.match(lowerStockPolicyHtml, /Safety 3 → 1 PLT/);
assert.match(lowerStockPolicyHtml, /ROP 11 → 9 PLT/);
assert.match(lowerStockPolicyHtml, /Preferred 16 → 14 PLT/);

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
