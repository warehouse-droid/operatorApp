import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const { preferredFullCoverageSourceYards } = await import("./order-dependency-repository.js");

const source = fs.readFileSync(new URL("../public/scm-transfer-dependencies.js", import.meta.url), "utf8");
const repositorySource = fs.readFileSync(new URL("./order-dependency-repository.js", import.meta.url), "utf8");
const serverSource = fs.readFileSync(new URL("./server.js", import.meta.url), "utf8");
const helperSource = source.match(/function depInventoryCoverage[\s\S]*?(?=\nfunction renderInventoryMatrix)/)?.[0] || "";
const mergeHelperSource = source.match(/function dependencyMergeEntry[\s\S]*?(?=\nfunction selectedDependencyProposalCards)/)?.[0] || "";
assert(helperSource, "SCM item coverage helper must exist.");
assert(mergeHelperSource, "SCM proposal merge compatibility helper must exist.");

const context = {
  depNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
};

const resultContext = {
  ...context,
  order: {
    outboundLocationId: 1,
    lines: [{ salesLineId: 32902, itemId: 5057, unit: "PC", unresolvedQuantity: 25 }]
  },
  matrix: {
    items: [{
      itemId: 5057,
      unit: "PC",
      balances: [
        { locationId: 1, quantityAvailable: 0, effectiveAvailable: 0 },
        { locationId: 26, quantityAvailable: 52, effectiveAvailable: 52 },
        { locationId: 28, quantityAvailable: 642, effectiveAvailable: 642 }
      ]
    }]
  },
  result: null
};
vm.runInNewContext(`${helperSource}; result = depInventoryCoverage(order, matrix);`, resultContext);
assert.equal(resultContext.result.length, 1);
assert.equal(resultContext.result[0].undercovered, 25, "Source-yard inventory must not reduce unlinked SO undercoverage.");
assert.equal(resultContext.result[0].sourceAvailable, 694, "Source availability remains a separate informational calculation.");
assert.equal(resultContext.result[0].sourceShortfall, 0, "Available source stock should still indicate that a proposal is possible.");
assert(source.includes("balance?.quantityAvailable"), "Yard columns must display the full available quantity.");
assert(source.includes("async function loadSelectedDependencyInventory"), "Selecting an undercovered order must use the automatic targeted inventory refresh helper.");
assert(source.includes('shouldRefresh ? "refresh-inventory" : "inventory"'), "Open undercovered items must refresh inventory automatically instead of requiring the manual button.");
function mergeCard(id, { mode = "yard_replenishment", fromLocationId = 1, toLocationId = 15 } = {}) {
  const values = { mode, fromLocationId, toLocationId };
  return {
    dataset: { proposalId: String(id) },
    querySelector(selector) {
      const field = selector.match(/data-proposal-field="([^"]+)"/)?.[1];
      return field ? { value: String(values[field]) } : null;
    }
  };
}

const mergeContext = {
  entries: [mergeCard(11), mergeCard(12)],
  result: null
};
vm.runInNewContext(`${mergeHelperSource}; result = dependencyProposalMergeCompatibility(entries);`, mergeContext);
assert.equal(mergeContext.result.eligible, true, "Two current draft cards with the same route and mode must be mergeable.");

mergeContext.entries = [mergeCard(11), mergeCard(12, { fromLocationId: 28 })];
vm.runInNewContext(`${mergeHelperSource}; result = dependencyProposalMergeCompatibility(entries);`, mergeContext);
assert.equal(mergeContext.result.eligible, false, "Current unsaved From selections must prevent a mismatched-route merge.");
assert.match(mergeContext.result.reason, /same From and Accounting To/, "Route mismatch must be explained before the merge request.");

mergeContext.entries = [mergeCard(11), mergeCard(12, { mode: "direct_to_customer" })];
vm.runInNewContext(`${mergeHelperSource}; result = dependencyProposalMergeCompatibility(entries);`, mergeContext);
assert.equal(mergeContext.result.eligible, false, "Mixed dispatch modes must not be collapsed into one semantic dependency.");

assert(source.includes('data-field="merge-proposal"'), "Draft proposal cards must expose merge selection checkboxes.");
assert(source.includes('/proposals/merge`'), "The merge control must call the dedicated atomic endpoint.");
assert(source.includes("dependencyState.batch = result.batch;"), "The merge response envelope must replace UI state with its batch payload.");
assert(serverSource.includes('source: "proposals-merged"'), "The merge endpoint must emit a scoped SCM update event.");


const preferred = preferredFullCoverageSourceYards(
  [
    { itemId: 2055, unresolvedQuantity: 6 },
    { itemId: 2055, unresolvedQuantity: 4 }
  ],
  [{
    itemId: 2055,
    balances: [
      { locationId: 1, effectiveAvailable: 4 },
      { locationId: 28, effectiveAvailable: 10 },
      { locationId: 26, effectiveAvailable: 20 }
    ]
  }],
  [
    { locationId: 1, routeScore: 10 },
    { locationId: 28, routeScore: 40 },
    { locationId: 26, routeScore: 80 }
  ]
);
assert.equal(preferred.get("2055"), 28, "The nearest yard that covers the complete aggregated item shortage must win before a nearer partial yard.");
assert(repositorySource.includes("const preferredSourceByItem = preferredFullCoverageSourceYards(order.lines, matrix.items, rankedYards);"), "Suggestion generation must calculate the full-cover yard map.");
assert(repositorySource.includes("rankedYards.filter((yard) => String(yard.locationId) === String(preferredSourceLocationId))"), "A full-cover item must stay in its selected source proposal instead of spilling into route-first partial yards.");

console.log("SCM transfer coverage frontend harness passed.");
