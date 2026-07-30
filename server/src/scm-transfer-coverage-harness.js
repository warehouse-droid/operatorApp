import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const { preferredFullCoverageSourceYards } = await import("./order-dependency-repository.js");
const {
  normalizeTransferDependencyReservationOverrides,
  transferDependencyPlanningAvailability,
  transferDependencyReservationContract,
  transferDependencyReservationOverrideKey,
  transferDependencyReservationOverrideSet,
  transferDependencyReservationOverridesFromSnapshot
} = await import("./transfer-dependency-reservation.js");

const source = fs.readFileSync(new URL("../public/scm-transfer-dependencies.js", import.meta.url), "utf8");
const dependencyHtml = fs.readFileSync(new URL("../public/scm-transfer-dependencies.html", import.meta.url), "utf8");
const dispatchCss = fs.readFileSync(new URL("../public/dispatch.css", import.meta.url), "utf8");
const repositorySource = fs.readFileSync(new URL("./order-dependency-repository.js", import.meta.url), "utf8");
const manualItemsSource = fs.readFileSync(new URL("./transfer-dependency-manual-items.js", import.meta.url), "utf8");
const serverSource = fs.readFileSync(new URL("./server.js", import.meta.url), "utf8");
const reservationHelperSource = source.match(/function depReservationOverrideKey[\s\S]*?(?=\nfunction depDate)/)?.[0] || "";
const helperSource = source.match(/function depInventoryCoverage[\s\S]*?(?=\nfunction renderInventoryMatrix)/)?.[0] || "";
const mergeHelperSource = source.match(/function dependencyMergeEntry[\s\S]*?(?=\nfunction selectedDependencyProposalCards)/)?.[0] || "";
assert(helperSource, "SCM item coverage helper must exist.");
assert(reservationHelperSource, "SCM reservation override helpers must exist.");
assert(mergeHelperSource, "SCM proposal merge compatibility helper must exist.");

const context = {
  dependencyState: { reservationOverrideKeys: new Set() },
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
vm.runInNewContext(`${reservationHelperSource}; ${helperSource}; result = depInventoryCoverage(order, matrix);`, resultContext);
assert.equal(resultContext.result.length, 1);
assert.equal(resultContext.result[0].undercovered, 25, "Source-yard inventory must not reduce unlinked SO undercoverage.");
assert.equal(resultContext.result[0].sourceAvailable, 694, "Source availability remains a separate informational calculation.");
assert.equal(resultContext.result[0].sourceShortfall, 0, "Available source stock should still indicate that a proposal is possible.");
const overrideCoverageContext = {
  ...context,
  dependencyState: { reservationOverrideKeys: new Set(["5057:28"]) },
  order: {
    outboundLocationId: 1,
    lines: [{ salesLineId: 32902, itemId: 5057, unit: "PC", unresolvedQuantity: 25 }]
  },
  matrix: {
    items: [{
      itemId: 5057,
      balances: [
        { locationId: 1, quantityAvailable: 0, effectiveAvailable: 0 },
        { locationId: 28, quantityAvailable: 100, reservedQuantity: 100, effectiveAvailable: 0 }
      ]
    }]
  },
  result: null
};
vm.runInNewContext(`${reservationHelperSource}; ${helperSource}; result = depInventoryCoverage(order, matrix);`, overrideCoverageContext);
assert.equal(overrideCoverageContext.result[0].sourceAvailable, 100,
  "A selected item-and-yard override must use full NetSuite Available in the coverage calculation.");
const allItemsContext = {
  ...context,
  order: {
    outboundLocationId: 1,
    lines: [{ salesLineId: 1, itemId: 100, quantity: 10, committedQuantity: 0, backorderedQuantity: 10, unresolvedQuantity: 10 }]
  },
  matrix: {
    orderLines: [
      { salesLineId: 1, itemId: 100, quantity: 10, committedQuantity: 0, backorderedQuantity: 10, unresolvedQuantity: 10 },
      { salesLineId: 2, itemId: 200, quantity: 5, committedQuantity: 5, backorderedQuantity: 0, unresolvedQuantity: 0 }
    ],
    items: [
      { itemId: 100, balances: [{ locationId: 28, effectiveAvailable: 10 }] },
      { itemId: 200, balances: [{ locationId: 1, effectiveAvailable: 5 }] }
    ]
  },
  result: null
};
vm.runInNewContext(`${reservationHelperSource}; ${helperSource}; result = depInventoryCoverage(order, matrix);`, allItemsContext);
const fullyCommittedCoverage = allItemsContext.result.find((entry) => String(entry.line.itemId) === "200");
assert.equal(allItemsContext.result.length, 2, "Shortage & Inventory must include every material Sales Order item.");
assert.equal(fullyCommittedCoverage?.ordered, 5, "A fully committed item must retain its ordered quantity.");
assert.equal(fullyCommittedCoverage?.committed, 5, "A fully committed item must retain its committed quantity.");
assert.equal(fullyCommittedCoverage?.backordered, 0, "A fully committed item must show zero backorder.");
assert.equal(fullyCommittedCoverage?.undercovered, 0, "A fully committed item must not increase undercoverage.");
assert(source.includes("balance?.quantityAvailable"), "Yard columns must display the full available quantity.");
assert(source.includes("Order item / quantity") && source.includes('"No backorder"'),
  "The matrix must label fully committed items without implying that a linked TO covered them.");
assert(source.includes("async function loadSelectedDependencyInventory"), "Selecting an undercovered order must use the automatic targeted inventory refresh helper.");
assert(source.includes('shouldRefresh ? "refresh-inventory" : "inventory"'), "Open undercovered items must refresh inventory automatically instead of requiring the manual button.");
assert(source.includes("Sales Order commitment and yard inventory refreshed from NetSuite."),
  "The refresh action must tell users that both SO commitment and yard inventory were refreshed.");
assert(source.includes('data-action="toggle-reservation-override"')
  && source.includes("reservationOverrides: depReservationOverridePayload()")
  && source.includes("This can allocate the same stock to more than one draft order"),
"The inventory matrix must expose an explicit warned reservation override and send only selected item-yard keys.");
assert(dispatchCss.includes(".scm-dependency-reservation-override")
  && dispatchCss.includes(".scm-dependency-reservation-warning"),
"The selected reservation override must have a visible warning state.");
assert(serverSource.includes("reservationOverrides: req.body?.reservationOverrides"),
  "The suggestion endpoint must pass selected reservation overrides to the repository.");
assert(repositorySource.includes("AS linked_transfer_quantity")
  && source.includes("linked TO already protected by NetSuite"),
  "Created linked TO quantities must remain visible as informational NetSuite-protected stock.");
assert(repositorySource.includes("- COALESCE(draft.reserved_quantity, 0)")
  && repositorySource.includes("- COALESCE(proposal.reserved_quantity, 0), 0")
  && !repositorySource.includes("- COALESCE(linked.linked_transfer_quantity, 0)"),
  "Only unsent local draft proposals may reduce NetSuite Available in matrix and creation validation.");
assert(manualItemsSource.includes("proposal_reserved.quantity AS reserved_quantity")
  && manualItemsSource.includes("linked_transfer.quantity AS linked_transfer_quantity")
  && !manualItemsSource.includes("- linked_transfer.quantity")
  && !manualItemsSource.includes("- COALESCE(linked_transfer.quantity, 0)"),
  "Manual proposal item lookup and validation must not subtract created linked TOs from NetSuite Available.");
assert(source.includes("unsent local draft proposal reservations")
  && !source.includes("other local linked-transfer reservations"),
  "The override warning must describe its narrow unsent-draft scope.");

const normalizedOverrides = normalizeTransferDependencyReservationOverrides([
  { itemId: 4991, locationId: 1 },
  { item_id: 4991, location_id: 1 }
], { strict: true });
assert.deepEqual(normalizedOverrides.map(({ itemId, locationId }) => ({ itemId, locationId })),
  [{ itemId: 4991, locationId: 1 }],
"Reservation overrides must be exact item-yard keys and deduplicate safely.");
const reservationKeys = transferDependencyReservationOverrideSet(normalizedOverrides);
assert.equal(transferDependencyReservationOverrideKey(4991, 1), "4991:1");
assert.deepEqual(
  transferDependencyReservationOverridesFromSnapshot({
    reservationOverridePolicy: "selected_full_netsuite_available",
    reservationOverrides: normalizedOverrides
  }),
  [],
  "Legacy linked-transfer overrides must not bypass a new unsent draft reservation."
);
assert.equal(
  transferDependencyReservationOverridesFromSnapshot({
    reservationOverridePolicy: transferDependencyReservationContract.policy,
    reservationOverrides: normalizedOverrides
  }).length,
  1,
  "Only overrides saved under the unsent-draft policy may be restored."
);
assert.deepEqual(
  transferDependencyPlanningAvailability({
    itemId: 4991,
    locationId: 1,
    quantityAvailable: 1457.26,
    effectiveAvailable: 0
  }, reservationKeys),
  {
    key: "4991:1",
    overridden: true,
    quantityAvailable: 1457.26,
    effectiveAvailable: 0,
    planningAvailable: 1457.26,
    localReservationIgnored: 1457.26
  },
  "The backend override must select full NetSuite Available without changing the stored balance."
);
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
assert(source.includes('order.workflowStage === "created" ? "Mark Reviewed"'),
  "Created orders must expose the same manual review completion action as Open orders.");
assert(source.includes('order.completionType === "transfer_manually_reviewed"'),
  "The UI must distinguish manual completion of a created TO from Reviewed - No Transfer.");
assert(source.includes('dependencyState.reviewStatus = "created";')
  && source.includes('dependencyState.mobilePanel = "proposals";')
  && source.includes("loadDependencyCandidates({ preserveSelection: true, refreshInventory: false })"),
"Successful TO creation must keep the same Sales Order selected and land phones on Verify, Approve & Print.");
assert(source.includes('data-field="manual-item-search"')
  && source.includes('data-action="select-manual-item"')
  && source.includes('data-action="add-manual-item"'),
"Draft proposals must expose free-type item autocomplete and an explicit add action.");
assert(source.includes("/proposals/${proposalId}/items?search=")
  && source.includes("/proposals/${proposalId}/lines"),
"Manual item autocomplete and add actions must call dependency-specific endpoints.");
assert(source.includes("}, 300);"), "Manual item autocomplete must be debounced.");
assert(source.includes('const DEPENDENCY_PROPOSAL_LINE_SELECTOR = ".scm-dependency-proposal-line[data-proposal-line-id]";')
  && source.includes("card.querySelectorAll(DEPENDENCY_PROPOSAL_LINE_SELECTOR)")
  && !source.includes('card.querySelectorAll("[data-proposal-line-id]")'),
"Saving a proposal must collect only proposal rows, never nested Remove line buttons with duplicate line IDs.");
assert(source.includes("target.closest(DEPENDENCY_PROPOSAL_LINE_SELECTOR)?.dataset.salesLineId"),
"Removing a manual line must inspect its containing proposal row instead of the Remove line button.");
assert(dependencyHtml.includes('class="scm-transfer-dependencies-page"'), "Auto Transfer must expose a page-specific responsive scope.");
assert(source.includes('data-action="set-mobile-panel"'), "Auto Transfer must expose phone workflow tabs.");
assert(source.includes('data-mobile-panel="${depEscape(dependencyState.mobilePanel)}"'), "The selected phone workflow panel must be reflected in rendered markup.");
assert(dispatchCss.includes("@media (max-width: 760px)"), "Auto Transfer must define a phone breakpoint.");
assert(dispatchCss.includes('.scm-dependency-grid[data-mobile-panel="inventory"]'), "Phone layout must show one workflow panel at a time.");
assert(dispatchCss.includes(".scm-transfer-dependencies-page .scm-dependency-shell"), "Phone layout must remove the desktop shell width constraint.");
assert(dispatchCss.includes(".scm-transfer-dependencies-page .scm-dependency-manual-item-grid")
  && dispatchCss.includes(".scm-dependency-manual-item-results"),
"Manual-item search, results, quantity, and Add controls must have responsive phone styling.");
assert(serverSource.includes("fetchDeliveryOrderDetailsBatchFromNetSuite")
  && serverSource.includes("refreshTransferDependencySalesOrderAllocations"),
"The Open dependency queue must refresh current committed/backordered quantities in one batched NetSuite query.");
assert(serverSource.includes("force: req.body?.force === true"),
  "The explicit refresh action must force a fresh SO allocation lookup.");
assert(serverSource.includes("(currentInventory.orderLines || [])"),
  "Refreshing Shortage & Inventory must refresh every displayed Sales Order item, not only shortage lines.");
assert(repositorySource.includes("pl.line_source = 'shortage'"),
  "Manual proposal items must not count as Sales Order shortage coverage.");
assert(repositorySource.includes('"manual_transfer" : "sales_allocation"'),
  "Created dependency records must distinguish manual material from SO allocations.");


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
assert(repositorySource.includes("const preferredSourceByItem = preferredFullCoverageSourceYards(order.lines, planningItems, rankedYards);"), "Suggestion generation must calculate the full-cover yard map from override-adjusted availability.");
assert(repositorySource.includes("rankedYards.filter((yard) => String(yard.locationId) === String(preferredSourceLocationId))"), "A full-cover item must stay in its selected source proposal instead of spilling into route-first partial yards.");

console.log("SCM transfer coverage frontend harness passed.");
