import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { closeDb, query, withTransaction } from "./db.js";
import { listSmartScmInputFiles } from "./smart-scm-import-repository.js";
import { runSmartScmForecast, listSmartScmForecasts, smartScmCoverageFloor } from "./smart-scm-forecast-repository.js";
import { consolidateCompatibleDrafts, getSmartScmPlanningRun, runSmartScmPlan, smartScmPackWholePalletLines, smartScmPhysicalPalletLines, smartScmProposalLineLoadWeightLbs, smartScmSourceTransferLimit, updateSmartScmProposal } from "./smart-scm-planning-repository.js";
import { addSmartScmVendorAlternativeLine, listSmartScmNetSuitePoReviewLoads, listSmartScmVendorReplyLoads, removeSmartScmVendorAlternativeLine, searchSmartScmVendorAlternatives, stageSmartScmVendorReplyLoad } from "./smart-scm-vendor-repository.js";
import { executeSmartScmPurchaseProposal } from "./smart-scm-purchase-service.js";
import { leaseYardPrintJob, queueYardPrinterTest, rotateYardPrinterToken, updateLeasedPrintJob, updateYardPrinter, yardPrintJobDocument } from "./smart-scm-print-repository.js";
import { createSmartScmManualLoad, groupSmartScmProposals, recalculateSmartScmPoProposal, removeSmartScmProposalLine, smartScmAllocateProRata, splitSmartScmProposalLine, updateSmartScmProposalLine } from "./smart-scm-proposal-editor.js";
import { buildSmartScmPurchaseOrderRestPayload } from "./smart-scm-purchase-netsuite.js";
import { listSmartScmRouteRules, upsertSmartScmRouteRule } from "./smart-scm-route-repository.js";

let temporaryPrintPath = null;
const pickupFloor = smartScmCoverageFloor({ representativeOrderPallets: 0.29, orderCount: 5, capacityPallets: 25 });
assert.equal(pickupFloor.rawFloorPallets, 1.45, "Five fractional pickup orders must stay fractional until the final rounding step.");
assert.equal(pickupFloor.coverageFloorPallets, 2, "Five 0.29-PLT pickup orders must create a 2-PLT floor, not a 5-PLT floor.");
const deliveryFloor = smartScmCoverageFloor({ representativeOrderPallets: 0.66, orderCount: 1, capacityPallets: 25 });
assert.equal(deliveryFloor.coverageFloorPallets, 1, "One 0.66-PLT delivery order must create a 1-PLT floor.");
const cappedFloor = smartScmCoverageFloor({ representativeOrderPallets: 4, orderCount: 5, capacityPallets: 12 });
const proportionalLoads = smartScmAllocateProRata([
  { itemId: 1, destinationLocationId: 26, proposedPallets: 8, requiredPallets: 8, palletWeight: 10, toPlt: 1, lineWeight: 80 },
  { itemId: 2, destinationLocationId: 15, proposedPallets: 4, requiredPallets: 4, palletWeight: 10, toPlt: 1, lineWeight: 40 }
], 100);
assert.equal(proportionalLoads.length, 1, "Manual grouping must create exactly one physical load.");
assert(proportionalLoads[0].reduce((sum, line) => sum + line.lineWeight, 0) <= 100.000001, "The grouped load must stay within truck capacity.");
assert(proportionalLoads[0].every((line) => Number.isInteger(line.proposedPallets)), "Every grouped quantity must be a whole pallet.");
const proportionalTotals = new Map();
assert.equal(smartScmProposalLineLoadWeightLbs({ proposedPallets: 1, palletWeight: 1000, lineWeight: 1000, physicalPalletWeightLbs: 40 }), 1040,
  "One material PLT must include exactly one 40-lb official PALLET in gross load weight.");
const palletTareCapacityLoads = smartScmPackWholePalletLines([
  { itemId: 99, destinationLocationId: 26, destinationName: "150", proposedPallets: 26, requiredPallets: 26,
    palletWeight: 3000, physicalPalletWeightLbs: 40, lineWeight: 78000, toPlt: 1, reason: {} }
], 78000, { proposalType: "TO", sourceName: "2967", maxStops: 1 });
assert.equal(palletTareCapacityLoads.length, 2, "Gross material-plus-PALLET weight must split a load that material weight alone would fill exactly.");
assert(palletTareCapacityLoads.every((load) => load.totalWeight <= 78000), "Every tare-aware packed load must stay within truck capacity.");
assert.equal(palletTareCapacityLoads.reduce((sum, load) => sum + load.totalPallets, 0), 26, "Tare-aware packing must preserve pallet quantity.");
for (const load of proportionalLoads) {
  for (const line of load) proportionalTotals.set(line.itemId, (proportionalTotals.get(line.itemId) || 0) + line.proposedPallets);
}
assert.equal(proportionalTotals.get(1), 7, "Capacity-limited allocation must apportion the first item proportionally.");
assert.equal(proportionalTotals.get(2), 3, "Capacity-limited allocation must apportion the second item proportionally.");
assert.equal(proportionalLoads[0].reduce((sum, line) => sum + line.reason.groupingDeferredPallets, 0), 2, "Unallocated demand must be recorded as deferred pallets.");
const roundedCapacityLoad = smartScmAllocateProRata([
  { itemId: 3, destinationLocationId: 26, proposedPallets: 20.6, requiredPallets: 20.6, palletWeight: 3000, toPlt: 1, lineWeight: 61800 },
  { itemId: 4, destinationLocationId: 26, proposedPallets: 5.6, requiredPallets: 5.6, palletWeight: 3000, toPlt: 1, lineWeight: 16800 }
], 80000);
assert.equal(roundedCapacityLoad.length, 1);
assert.deepEqual(roundedCapacityLoad[0].map((line) => line.proposedPallets), [20, 6], "20.6 and 5.6 PLT must become a capacity-safe whole-pallet allocation.");
assert(roundedCapacityLoad[0].every((line) => Number.isInteger(line.proposedPallets)));
assert(roundedCapacityLoad[0].reduce((sum, line) => sum + line.lineWeight, 0) <= 80000, "Rounding may never push a grouped truck over capacity.");
const fourDestinationPo = smartScmPackWholePalletLines([
  { itemId: 11, destinationLocationId: 26, destinationName: "150", proposedPallets: 1, requiredPallets: 1, palletWeight: 10, lineWeight: 10, toPlt: 1, reason: {} },
  { itemId: 12, destinationLocationId: 15, destinationName: "12441", proposedPallets: 1, requiredPallets: 1, palletWeight: 10, lineWeight: 10, toPlt: 1, reason: {} },
  { itemId: 13, destinationLocationId: 1, destinationName: "3445", proposedPallets: 1, requiredPallets: 1, palletWeight: 10, lineWeight: 10, toPlt: 1, reason: {} },
  { itemId: 14, destinationLocationId: 28, destinationName: "2967", proposedPallets: 1, requiredPallets: 1, palletWeight: 10, lineWeight: 10, toPlt: 1, reason: {} }
], 100, { proposalType: "PO", sourceName: "Milton", maxStops: 2 });
assert.equal(fourDestinationPo.length, 2, "Four PO destinations must split across two routes.");
assert(fourDestinationPo.every((load) => load.routeStops.length <= 2), "A PO load may have at most two drops.");
assert.deepEqual(fourDestinationPo[0].routeStops.map((stop) => stop.name), ["150", "12441"], "Hub stops must use the preferred route order.");
const gormleyPartial = smartScmPackWholePalletLines([
  { itemId: 15, destinationLocationId: 1, destinationName: "3445", proposedPallets: 2, requiredPallets: 2, palletWeight: 30, lineWeight: 60, toPlt: 1, reason: {} }
], 100, { proposalType: "PO", sourceName: "Gormley", maxStops: 2 });
assert.deepEqual(gormleyPartial[0].routeStops.map((stop) => stop.name), ["12441"], "A partial Gormley direct-shop load must route through 12441.");
assert.equal(gormleyPartial[0].lines[0].reason.gormleyHubRedirected, true);
const gormleyFull = smartScmPackWholePalletLines([
  { itemId: 16, destinationLocationId: 1, destinationName: "3445", proposedPallets: 3, requiredPallets: 3, palletWeight: 30, lineWeight: 90, toPlt: 1, reason: {} }
], 100, { proposalType: "PO", sourceName: "Gormley", maxStops: 2 });
assert.deepEqual(gormleyFull[0].routeStops.map((stop) => stop.name), ["3445"], "An operationally full Gormley load may deliver directly to the shop.");
const gormleyMixedPartial = smartScmPackWholePalletLines([
  { itemId: 160, destinationLocationId: 1, destinationName: "3445", proposedPallets: 1, requiredPallets: 1, palletWeight: 30, lineWeight: 30, toPlt: 1, reason: {} },
  { itemId: 161, destinationLocationId: 26, destinationName: "150", proposedPallets: 7, requiredPallets: 7, palletWeight: 10, lineWeight: 70, toPlt: 1, reason: {} }
], 100, { proposalType: "PO", sourceName: "Gormley", maxStops: 2 });
assert(!gormleyMixedPartial.flatMap((load) => load.lines).some((line) => line.destinationLocationId === 1), "A partial Gormley shop quantity must not become direct just because 150 fills the truck.");
assert.deepEqual(gormleyMixedPartial[0].routeStops.map((stop) => stop.name), ["12441", "150"], "The redirected Gormley load must use 12441 before 150.");
const uxbridgeRoute = smartScmPackWholePalletLines([
  { itemId: 162, destinationLocationId: 26, destinationName: "150", proposedPallets: 1, requiredPallets: 1, palletWeight: 50, lineWeight: 50, toPlt: 1, reason: {} },
  { itemId: 163, destinationLocationId: 1, destinationName: "3445", proposedPallets: 1, requiredPallets: 1, palletWeight: 50, lineWeight: 50, toPlt: 1, reason: {} }
], 100, { proposalType: "PO", sourceName: "Uxbridge", maxStops: 2 });
assert.deepEqual(uxbridgeRoute[0].routeStops.map((stop) => stop.name), ["3445", "150"], "Uxbridge must not use 150 as the first stop when another yard is present.");
const woodbridgeRoute = smartScmPackWholePalletLines([
  { itemId: 164, destinationLocationId: 26, destinationName: "150", proposedPallets: 1, requiredPallets: 1, palletWeight: 50, lineWeight: 50, toPlt: 1, reason: {} },
  { itemId: 165, destinationLocationId: 15, destinationName: "12441", proposedPallets: 1, requiredPallets: 1, palletWeight: 50, lineWeight: 50, toPlt: 1, reason: {} }
], 100, { proposalType: "PO", sourceName: "Woodbridge", maxStops: 2 });
assert.deepEqual(woodbridgeRoute[0].routeStops.map((stop) => stop.name), ["12441", "150"], "Woodbridge must not use 150 as the first stop when another yard is present.");
const bwsWoodbridgeRoute = smartScmPackWholePalletLines([
  { itemId: 166, destinationLocationId: 26, destinationName: "150", proposedPallets: 1, requiredPallets: 1, palletWeight: 50, lineWeight: 50, toPlt: 1, reason: {} },
  { itemId: 167, destinationLocationId: 28, destinationName: "2967", proposedPallets: 1, requiredPallets: 1, palletWeight: 50, lineWeight: 50, toPlt: 1, reason: {} }
], 100, { proposalType: "PO", sourceName: "BWS Woodbridge", maxStops: 2 });
assert.deepEqual(bwsWoodbridgeRoute[0].routeStops.map((stop) => stop.name), ["2967", "150"], "Woodbridge-family pickup sources must not use 150 as the first stop.");
const twoFullDestinationLoads = smartScmPackWholePalletLines([
  { itemId: 17, destinationLocationId: 26, destinationName: "150", proposedPallets: 19, requiredPallets: 19, palletWeight: 4000, lineWeight: 76000, toPlt: 1, reason: {} },
  { itemId: 18, destinationLocationId: 15, destinationName: "12441", proposedPallets: 19, requiredPallets: 19, palletWeight: 4000, lineWeight: 76000, toPlt: 1, reason: {} }
], 78000, { proposalType: "PO", sourceName: "Ayr", maxStops: 2 });
assert.equal(twoFullDestinationLoads.length, 2, "Full quantities for 150 and 12441 must recalculate into two PO loads.");
assert(twoFullDestinationLoads.every((load) => load.totalWeight === 76000 && load.routeStops.length === 1));
assert.equal(twoFullDestinationLoads.flatMap((load) => load.lines).reduce((sum, line) => sum + line.proposedPallets, 0), 38);
const destinationFirstLoads = smartScmPackWholePalletLines([
  { itemId: 180, destinationLocationId: 26, destinationName: "150", proposedPallets: 11, requiredPallets: 11, palletWeight: 10, lineWeight: 110, toPlt: 1, reason: {} },
  { itemId: 181, destinationLocationId: 1, destinationName: "3445", proposedPallets: 15, requiredPallets: 15, palletWeight: 10, lineWeight: 150, toPlt: 1, reason: {} }
], 100, { proposalType: "PO", sourceName: "Ayr", maxStops: 2 });
assert.equal(destinationFirstLoads.length, 3, "Destination-first PO packing must preserve the minimum three-truck count.");
assert.equal(destinationFirstLoads.filter((load) => load.routeStops.length === 1 && load.totalWeight === 100).length, 2, "Full single-destination trucks must be locked before residual quantities are mixed.");
assert.equal(destinationFirstLoads.filter((load) => load.routeStops.length > 1).length, 1, "Only the residual Ayr quantities should form a two-stop route.");
assert(destinationFirstLoads.every((load) => load.totalWeight <= 100.000001), "Destination-first loads must stay within capacity.");
assert.equal(destinationFirstLoads.flatMap((load) => load.lines).reduce((sum, line) => sum + line.proposedPallets, 0), 26, "Destination-first packing must preserve every pallet.");
const urgencyFragmentationLoads = smartScmPackWholePalletLines([
  { itemId: 184, destinationLocationId: 1, destinationName: "3445", proposedPallets: 4, requiredPallets: 4, palletWeight: 4, lineWeight: 16, toPlt: 1, urgent: true, reason: {} },
  { itemId: 185, destinationLocationId: 1, destinationName: "3445", proposedPallets: 2, requiredPallets: 2, palletWeight: 6, lineWeight: 12, toPlt: 1, urgent: false, reason: {} }
], 10, { proposalType: "PO", sourceName: "Ayr", maxStops: 2 });
assert.equal(urgencyFragmentationLoads.length, 3, "Urgent small pallets must not fragment three destination-full trucks into four loads.");
assert(urgencyFragmentationLoads.every((load) => load.routeStops.length === 1 && load.totalWeight <= 10.000001), "Weight-first packing must preserve the single destination and capacity.");
const forcedSingleDestinationLoads = smartScmPackWholePalletLines([
  { itemId: 182, destinationLocationId: 26, destinationName: "150", proposedPallets: 11, requiredPallets: 11, palletWeight: 10, lineWeight: 110, toPlt: 1, reason: {} },
  { itemId: 183, destinationLocationId: 1, destinationName: "3445", proposedPallets: 15, requiredPallets: 15, palletWeight: 10, lineWeight: 150, toPlt: 1, reason: {} }
], 100, { proposalType: "PO", sourceName: "Ayr", maxStops: 1 });
assert.equal(forcedSingleDestinationLoads.length, 4, "A one-drop rule must keep every destination separate.");
assert(forcedSingleDestinationLoads.every((load) => load.routeStops.length === 1), "A one-drop rule may never create a mixed route.");
const mixedPriorityLoads = consolidateCompatibleDrafts([
  {
    proposalType: "TO", phase: "internal_transfer", sourceKind: "yard", sourceLocationId: 28, sourceName: "2967",
    destinationLocationId: 26, destinationName: "150", vendor: null, plant: null, status: "draft", urgent: true, provisional: true,
    lines: [{ itemId: 1, itemName: "Urgent item", destinationLocationId: 26, destinationName: "150", requiredPallets: 1, proposedPallets: 1, confirmedPallets: 0, residualPallets: 1, salesQuantity: 1, palletWeight: 30, lineWeight: 30, urgent: true, provisional: true, reason: {} }]
  },
  {
    proposalType: "TO", phase: "internal_transfer", sourceKind: "yard", sourceLocationId: 28, sourceName: "2967",
    destinationLocationId: 26, destinationName: "150", vendor: null, plant: null, status: "held", urgent: false, provisional: false,
    lines: [{ itemId: 2, itemName: "Normal item", destinationLocationId: 26, destinationName: "150", requiredPallets: 1, proposedPallets: 1, confirmedPallets: 0, residualPallets: 1, salesQuantity: 1, palletWeight: 20, lineWeight: 20, urgent: false, provisional: false, reason: {} }]
  }
], { truck_capacity_lbs: 100, hold_load_ratio: 0.5 }, "priority-test");
assert.equal(mixedPriorityLoads.length, 1, "Urgency and provisional state must not split an otherwise compatible route.");
assert.equal(mixedPriorityLoads[0].status, "draft", "Draft/Held must be assigned from final load utilization.");
assert.equal(mixedPriorityLoads[0].lines[0].urgent, true, "Urgent lines must be packed first.");
assert(mixedPriorityLoads[0].lines.some((line) => !line.urgent), "A final load may contain both urgent and non-urgent lines.");

try {
const safetyLimit = smartScmSourceTransferLimit({ availablePallets: 20, safetyStockPallets: 10, reorderPointPallets: 8 });
assert.equal(safetyLimit.maximumTransferablePallets, 10, "20 available with safety 10 can transfer at most 10.");
const reorderPointLimit = smartScmSourceTransferLimit({ availablePallets: 20, safetyStockPallets: 10, reorderPointPallets: 12 });
assert.equal(reorderPointLimit.maximumTransferablePallets, 8, "The higher reorder point must also remain protected.");
const unavailableLimit = smartScmSourceTransferLimit({ availablePallets: 1, safetyStockPallets: 4, reorderPointPallets: 6 });
assert.equal(unavailableLimit.maximumTransferablePallets, 0, "A yard below its protected floor cannot source a TO.");

const purchasePayload = buildSmartScmPurchaseOrderRestPayload({
  proposal: {
    id: 321,
    vendorId: 7101,
    destinationLocationId: 15,
    memo: "Harness PO",
    vendorReference: "VENDOR-REF",
    palletItem: {
      id: 699,
      itemName: "PALLET",
      unit: "Each",
      purchaseUnit: "Each",
      lastPurchasePrice: 4.25
    },
    lines: [
      { itemId: 601, itemName: "Harness A", unit: "Each", purchaseUnit: "Each", lastPurchasePrice: 11.5, destinationLocationId: 15, salesQuantity: 61.5, confirmedPallets: 1, palletQty: 1, layerQty: 0, sectionQty: 0, pieceQty: 0 },
      { itemId: 600, itemName: "Harness B", unit: "Each", purchaseUnit: "Each", lastPurchasePrice: 9.75, destinationLocationId: 26, salesQuantity: 50, confirmedPallets: 1, palletQty: 1, layerQty: 0, sectionQty: 0, pieceQty: 0 },
      { itemId: 699, itemName: "PALLET", unit: "Each", purchaseUnit: "Each", lastPurchasePrice: 4.25, destinationLocationId: 15, salesQuantity: 2, confirmedPallets: 2, palletQty: 0, layerQty: 0, sectionQty: 0, pieceQty: 2, ancillaryPallet: true }
    ]
  },
  locations: [
    { locationId: 15, netsuiteLocationId: 15, subsidiaryId: 2 },
    { locationId: 26, netsuiteLocationId: 26, subsidiaryId: 2 }
  ]
});
assert.equal(purchasePayload.entity.id, "7101");
assert.equal(purchasePayload.item.items[0].custcol_plt, 1);
assert.equal(purchasePayload.item.items[0].quantity, 61.5);
assert.equal(purchasePayload.item.items[0].rate, 11.5);
assert.equal(purchasePayload.location.id, "15");
assert(!Object.hasOwn(purchasePayload, "orderStatus"), "PO creation must not submit an order status override.");
assert.equal(purchasePayload.item.items[1].location.id, "26", "A multi-drop PO line must retain its own destination yard.");
assert.deepEqual(
  purchasePayload.item.items.filter((line) => line.item.id === "699").map((line) => [line.location.id, line.quantity, line.custcol_pcs, line.rate]),
  [["15", 1, 1, 4.25], ["26", 1, 1, 4.25]],
  "PO creation must add one priced PALLET line per destination."
);
assert.equal(purchasePayload.item.items.length, 4, "A visible PALLET row must not duplicate the derived NetSuite payload lines.");
const visiblePhysicalPallets = smartScmPhysicalPalletLines({
  id: 321,
  destinationLocationId: 15,
  destinationName: "12441",
  lines: [
    { itemId: 601, itemName: "Harness A", destinationLocationId: 15, destinationName: "12441", proposedPallets: 3 },
    { itemId: 600, itemName: "Harness B", destinationLocationId: 26, destinationName: "150", proposedPallets: 2 },
    { itemId: 699, itemName: "PALLET", destinationLocationId: 15, destinationName: "12441", proposedPallets: 5 }
  ]
}, { itemId: 699, itemName: "PALLET", unit: "EACH", itemWeightLbs: 40 });
assert.deepEqual(
  visiblePhysicalPallets.map((line) => [line.destinationLocationId, line.quantity, line.itemWeightLbs, line.lineWeightLbs, line.ancillaryPallet]),
  [[15, 3, 40, 120, true], [26, 2, 40, 80, true]],
  "Proposal display must expose one physical PALLET row per destination without counting an existing PALLET row again."
);
assert(visiblePhysicalPallets.every((line) => !line.includedInLoadPallets && line.includedInLoadWeight && line.weightSource === "netsuite_item_master"),
  "Physical PALLET rows must not double the pallet count, but their NetSuite item weight must count once in gross load weight.");
assert(visiblePhysicalPallets.every((line) => line.officialLineItem && line.submittedToNetSuite),
  "Every derived PALLET row must remain an official ancillary line through final NetSuite insertion.");

  const legacyPlan59 = await getSmartScmPlanningRun(59);
  if (legacyPlan59) {
    for (const proposal of legacyPlan59.proposals) {
      const materialWeight = proposal.lines.reduce((sum, line) => sum + Number(line.lineWeightLbs || 0), 0);
      const palletWeight = (proposal.physicalPalletLines || []).reduce((sum, line) => sum + Number(line.lineWeightLbs || 0), 0);
      assert(Math.abs(proposal.totalWeightLbs - materialWeight - palletWeight) < 0.000001,
        "Legacy plan #59 must expose gross material-plus-PALLET weight without mutating or double-counting stored totals.");
      assert((proposal.physicalPalletLines || []).every((line) => line.itemWeightLbs === 40 && line.includedInLoadWeight),
        "Legacy plan #59 must use the live mirrored NetSuite PALLET weight.");
    }
  }
  const inputs = await listSmartScmInputFiles();
  const activeSlots = new Set(inputs.filter((file) => file.active).map((file) => file.slot));
  for (const slot of ["item_master", "sales_data", "decision_workbook", "decision_tree", "decision_script"]) {
    assert(activeSlots.has(slot), `Expected active ${slot} input.`);
  }
  const routeRules = await listSmartScmRouteRules();
  const gormleyRule = routeRules.rules.find((rule) => rule.sourceKey === "gormley");
  assert.deepEqual(gormleyRule?.stopOrder, [15, 1, 28, 26], "Gormley must use 12441 before 150.");
  assert.equal(gormleyRule?.partialRedirectHubLocationId, 15, "Gormley partial direct loads must redirect to 12441.");
  const savedRouteRule = await upsertSmartScmRouteRule({
    sourceName: "BWS Woodbridge",
    enabled: true,
    maxDrops: 2,
    stopOrder: [15, 1, 28, 26],
    partialRedirectEnabled: false,
    partialRedirectDestinationIds: [1, 28],
    partialRedirectHubLocationId: null,
    notes: "Harness route rule"
  }, null);
  assert.deepEqual(savedRouteRule.stopOrder, [15, 1, 28, 26], "Route-rule stop priority must persist as JSON.");

  await withTransaction(async () => {
    await query(
      `UPDATE scm_smart_settings
          SET forecast_mode = 'formula',
              formula_average_weeks = 6,
              stockout_benchmark_weeks = 6,
              delivery_safety_factor = 1.645,
              execution_mode = 'mock',
              pickup_safety_factor = 1.3,
              zero_demand_coverage_enabled = true,
              zero_demand_pickup_order_count = 5,
              zero_demand_delivery_order_count = 1,
              coverage_order_percentile = 0.50,
              coverage_history_weeks = 104,
              coverage_prior_strength_orders = 8`
    );
    const forecastRun = await runSmartScmForecast({ triggerSource: "harness", operatorId: null });
    assert.equal(forecastRun.status, "completed");
    const forecasts = await listSmartScmForecasts({ runId: Number(forecastRun.id), limit: 5000 });
    assert(forecasts.length > 0, "Expected at least one item-yard forecast.");
    assert(forecasts.every((row) => Number.isFinite(row.p50Weekly) && Number.isFinite(row.leadTimeP90)));
    assert(forecasts.every((row) => Number.isFinite(row.safetyStockPallets)
      && Number.isFinite(row.reorderPointPallets) && Number.isFinite(row.preferredPallets)),
    "Every forecast must expose finite safety, ROP, and preferred policy levels.");
    const coverageEvidence = forecasts.filter((row) => row.representativeOrderPallets > 0 && row.coverageFloorPallets > 0);
    assert(coverageEvidence.length > 0, "Expected representative order evidence from the selected sales source.");
    const appliedCoverage = coverageEvidence.filter((row) => row.zeroDemandCoverageApplied);
    assert(appliedCoverage.length > 0, "Expected at least one zero-demand item-yard coverage floor.");
    for (const row of appliedCoverage) {
      assert(row.formulaWeeklyDemand <= 0.000001, "Coverage may apply only when corrected formula demand is zero.");
      assert.equal(row.coverageOrderCount, row.yardCode === "12441" ? 1 : 5, "Coverage count must follow the configured yard channel.");
      const requestedFloor = Math.ceil((row.representativeOrderPallets * row.coverageOrderCount) - 0.000001);
      assert(row.coverageFloorPallets <= requestedFloor, "Capacity may cap a coverage floor but may never increase it.");
      if (row.coverageFloorPallets < requestedFloor) assert.equal(row.coverageCapacityShortfall, true);
    }
    const alliance = forecasts.find((row) => row.itemId === 601 && row.yardCode === "12441");
    assert(alliance, "Expected Alliance G2 Supersand Grey at 12441.");
    assert.equal(alliance.formulaStockout, true);
    assert(Math.abs(alliance.formulaWeeklyDemand - 2.642857) < 0.00001, `Expected stockout peak 2.642857, received ${alliance.formulaWeeklyDemand}.`);
    assert(Math.abs(alliance.formulaWeeklySd - 1.003358) < 0.00001, `Expected six-week SD 1.003358, received ${alliance.formulaWeeklySd}.`);
    assert(Math.abs(alliance.safetyStockPallets - 2.334194) < 0.00001, `Expected forecast safety stock 2.334194, received ${alliance.safetyStockPallets}.`);
    assert.equal(alliance.reorderPointPallets, 8);
    assert.equal(alliance.preferredPallets, 14);

    const plan = await runSmartScmPlan({ triggerSource: "harness", operatorId: null, forecastRunId: Number(forecastRun.id) });
    assert.equal(plan.status, "ready");
    assert(Array.isArray(plan.proposals));
    assert(!plan.proposals.some((proposal) => proposal.phase === "hub_store"), "Future inbound stock must not pre-create a hub-store TO.");
    assert(plan.proposals.filter((proposal) => proposal.proposalType === "PO").every((proposal) => proposal.routeStops.length <= 2), "Every generated PO route must have at most two drops.");
    for (const proposal of plan.proposals) {
      const materialPallets = proposal.lines.reduce((sum, line) => sum + Number(line.proposedPallets || 0), 0);
      const physicalPallets = (proposal.physicalPalletLines || []).reduce((sum, line) => sum + Number(line.quantity || 0), 0);
      const materialWeight = proposal.lines.reduce((sum, line) => sum + Number(line.lineWeightLbs || 0), 0);
      const physicalWeight = (proposal.physicalPalletLines || []).reduce((sum, line) => sum + Number(line.lineWeightLbs || 0), 0);
      assert.equal(materialPallets, proposal.totalPallets, "Material lines must remain the only source of the load pallet total.");
      assert.equal(physicalPallets, proposal.totalPallets, "Existing PO and TO plans must expose matching physical PALLET item quantities.");
      assert((proposal.physicalPalletLines || []).every((line) => line.itemName === "PALLET" && line.ancillaryPallet),
        "Every derived physical packaging row must be identified as PALLET and ancillary.");
      assert(Math.abs(proposal.totalWeightLbs - materialWeight - physicalWeight) < 0.000001,
        "Public proposal gross weight must equal material line weight plus official PALLET line weight exactly once.");
      assert(proposal.totalWeightLbs <= 78000.000001, "New PO and TO packing must remain within capacity after PALLET tare.");
    }
    const manualSeed = plan.proposals.find((proposal) => proposal.proposalType === "PO" && proposal.lines.length)?.lines[0];
    assert(manualSeed, "Expected a planning-enabled PO item for manual-load coverage.");
    const beforeManualIds = new Set(plan.proposals.map((proposal) => proposal.id));
    const manualRun = await createSmartScmManualLoad(plan.id, {
      proposalType: "PO",
      itemId: manualSeed.itemId,
      destinationLocationId: manualSeed.destinationLocationId,
      proposedPallets: 1
    }, null);
    const manualProposal = manualRun.proposals.find((proposal) => !beforeManualIds.has(proposal.id));
    assert(manualProposal, "Adding a manual load must create a new proposal in the current planning run.");
    assert.equal(manualProposal.status, "held", "A manual PO load must start on Hold.");
    assert.equal(manualProposal.lines.length, 1);
    assert.equal(manualProposal.lines[0].proposedPallets, 1);
    assert.equal(manualProposal.lines[0].reason.manualLoad, true);
    const splitRun = await splitSmartScmProposalLine(manualProposal.id, manualProposal.lines[0].id, {}, null);
    const remainingManual = splitRun.proposals.find((proposal) => proposal.id === manualProposal.id);
    const splitProposal = splitRun.proposals.find((proposal) =>
      proposal.id !== manualProposal.id && proposal.memo === `split from load #${manualProposal.id} · ${manualSeed.itemName}`
    );
    assert.equal(remainingManual, undefined, "A one-line source load must be removed after its entire line is split out.");
    assert(splitProposal, "Splitting a 1-PLT line must create a separate held load.");
    assert.equal(splitProposal.status, "held");
    assert.equal(splitProposal.lines.length, 1);
    assert.equal(splitProposal.lines[0].proposedPallets, 1);
    assert.equal(splitProposal.lines[0].reason.splitWholeLine, true);
    assert.equal(splitProposal.totalPallets, 1, "The moved PALLET quantity must be conserved without an empty source load.");
    for (const proposal of plan.proposals.filter((row) => row.proposalType === "PO" && row.sourceName === "Gormley")) {
      const directLines = proposal.lines.filter((line) => [1, 28].includes(line.destinationLocationId));
      if (!directLines.length) continue;
      const smallestPallet = Math.min(...proposal.lines.map((line) => Number(line.palletWeightLbs)).filter((weight) => weight > 0));
      assert((78000 - proposal.totalWeightLbs) < smallestPallet + 0.000001, "A partial Gormley direct-shop PO must be redirected to 12441.");
    }
    for (const transfer of plan.proposals.filter((proposal) => proposal.proposalType === "TO" && proposal.phase === "internal_transfer")) {
      for (const line of transfer.lines) {
        const sourceAvailable = Number(line.reason.sourceAvailablePallets);
        const sourceSafety = Number(line.reason.sourceSafetyStockPallets);
        const sourceRop = Number(line.reason.sourceReorderPointPallets);
        const protectedFloor = Math.max(sourceSafety, sourceRop);
        const maximumTransferable = Math.floor(Math.max(0, sourceAvailable - protectedFloor) + 0.000001);
        assert(Math.abs(Number(line.reason.sourceProtectedFloorPallets) - protectedFloor) < 0.000001, "TO source protected floor must equal max(safety stock, ROP).");
        assert.equal(Number(line.reason.sourceMaximumTransferablePallets), maximumTransferable, "TO source transfer limit must equal floored available stock above the protected floor.");
        assert(line.proposedPallets <= maximumTransferable + 0.000001, "Suggested TO exceeds live source transfer limit.");
      }
    }
    const coverageReviewLines = plan.proposals.flatMap((proposal) => proposal.lines
      .filter((line) => line.reason?.coverageReviewRequired)
      .map((line) => ({ proposal, line })));
    for (const { proposal, line } of coverageReviewLines) {
      assert.equal(proposal.status, "held", `${line.itemName} must remain held while its order-size evidence is mostly borrowed.`);
    }
    const allianceLine = plan.proposals.flatMap((proposal) => proposal.lines.map((line) => ({ proposal, line })))
      .find(({ proposal, line }) => proposal.destinationLocationId === 15 && line.itemId === 601 && Number(line.reason.safetyFactor) === 1.645);
    assert(allianceLine, "Expected an Alliance G2 Supersand Grey replenishment line for 12441.");
    assert(Math.abs(Number(allianceLine.line.reason.safetyStockPallets) - 2.334194) < 0.00001, `Expected safety stock 2.334194, received ${allianceLine.line.reason.safetyStockPallets}.`);
    assert.equal(Number(allianceLine.line.reason.reorderPointPallets), 8);
    assert.equal(Number(allianceLine.line.reason.preferredPallets), 14);

    const destinationEditCandidate = await query(
      `SELECT line.proposal_id, line.id AS line_id, line.item_id, line.proposed_pallets,
              line.destination_location_id AS before_destination_location_id,
              sibling.destination_location_id AS destination_location_id
         FROM scm_smart_proposal_lines line
         JOIN scm_smart_proposals proposal ON proposal.id = line.proposal_id
         JOIN scm_smart_proposal_lines sibling
           ON sibling.proposal_id = line.proposal_id
          AND sibling.destination_location_id <> line.destination_location_id
         JOIN scm_smart_item_yard_policies yard
           ON yard.item_id = line.item_id
          AND yard.location_id = sibling.destination_location_id
          AND yard.eligible = true
        WHERE proposal.run_id = $1
          AND proposal.proposal_type = 'PO'
          AND proposal.status = 'held'
          AND NOT EXISTS (
            SELECT 1
              FROM scm_smart_proposal_lines duplicate
             WHERE duplicate.proposal_id = line.proposal_id
               AND duplicate.item_id = line.item_id
               AND duplicate.destination_location_id = sibling.destination_location_id
          )
        ORDER BY proposal.id, line.id
        LIMIT 1`,
      [plan.id]
    );
    assert(destinationEditCandidate.rowCount, "Expected an editable multi-drop PO line with an eligible alternate destination.");
    const move = destinationEditCandidate.rows[0];
    const destinationAdjusted = await updateSmartScmProposalLine(
      move.proposal_id,
      move.line_id,
      { proposedPallets: Number(move.proposed_pallets), destinationLocationId: Number(move.destination_location_id) },
      null
    );
    const movedLine = destinationAdjusted.lines.find((line) => line.id === Number(move.line_id));
    assert.equal(movedLine.destinationLocationId, Number(move.destination_location_id), "A PO proposal line destination must be editable.");
    assert.equal(movedLine.reason.destinationManuallyAdjusted, true, "A manual destination change must be recorded on the line.");
    assert.equal(movedLine.reason.positionPallets, undefined, "A destination change must invalidate the old yard's inventory position snapshot.");
    assert.equal(movedLine.reason.reorderPointPallets, undefined, "A destination change must invalidate the old yard's reorder point.");
    assert.equal(movedLine.reason.preferredPallets, undefined, "A destination change must invalidate the old yard's preferred target.");
    assert(Number.isFinite(Number(movedLine.reason.quantityAvailable)), "A destination change must capture the new yard's inventory components.");
    assert(destinationAdjusted.routeStops.length <= 2, "A destination edit must preserve the proposal route limit.");
    await query(
      "UPDATE scm_smart_item_yard_policies SET eligible = false WHERE item_id = $1 AND location_id = $2",
      [movedLine.itemId, movedLine.destinationLocationId]
    );
    await assert.rejects(
      () => updateSmartScmProposalLine(move.proposal_id, move.line_id, { proposedPallets: movedLine.proposedPallets }, null),
      /not enabled for Smart SCM planning/,
      "A same-yard quantity edit must reject an item or yard policy disabled after planning."
    );
    await query(
      "UPDATE scm_smart_item_yard_policies SET eligible = true WHERE item_id = $1 AND location_id = $2",
      [movedLine.itemId, movedLine.destinationLocationId]
    );

    const po = plan.proposals.find((proposal) => proposal.proposalType === "PO" && proposal.lines.length);
    assert(plan.proposals.filter((proposal) => proposal.proposalType === "PO").every((proposal) => proposal.status === "held"), "Every new PO load must start on Hold.");
    let vendorLoadChecked = false;
    let alternativeLineChecked = false;
    if (po) {
      const requested = await updateSmartScmProposal(po.id, { status: "order_requested" }, null);
      assert.equal(requested.status, "order_requested");
      assert(requested.orderRequestedAt, "Order Requested must record its load-level timestamp.");
      const queue = await listSmartScmVendorReplyLoads({ search: String(po.id), limit: 50 });
      assert(queue.some((load) => load.id === po.id), "Requested PO must appear in the cross-plan vendor queue.");
      const alternatives = await searchSmartScmVendorAlternatives(po.id, { lineId: po.lines[0].id, limit: 12 });
      assert(Array.isArray(alternatives), "Alternative item autocomplete must return a list.");
      if (alternatives[0]) {
        const withAlternative = await addSmartScmVendorAlternativeLine(po.id, { itemId: alternatives[0].itemId, proposedPallets: 1, confirmedPallets: 1, alternativeForLineId: po.lines[0].id, source: "system" }, null);
        const added = withAlternative.lines.find((line) => line.isAlternative && line.itemId === alternatives[0].itemId);
        assert(added, "Selected system alternative should be added to the load.");
        const withoutAlternative = await removeSmartScmVendorAlternativeLine(po.id, added.id, null);
        assert(!withoutAlternative.lines.some((line) => line.id === added.id), "Alternative line removal should restore the load.");
        alternativeLineChecked = true;
      }
      await query(
        `UPDATE inventory_items
            SET purchase_unit = COALESCE(NULLIF(stock_unit, ''), 'EACH'),
                last_purchase_price = CASE WHEN COALESCE(last_purchase_price, 0) > 0 THEN last_purchase_price ELSE 1 END
          WHERE item_id = ANY($1::bigint[])
             OR UPPER(COALESCE(item_name, '')) = 'PALLET'`,
        [po.lines.map((line) => line.itemId)]
      );
      const staged = await stageSmartScmVendorReplyLoad(po.id, {
        vendorReference: "HARNESS-VENDOR-REF",
        remarks: "Smart SCM rollback harness",
        lines: po.lines.map((line) => ({ proposalLineId: line.id, decision: "confirm", confirmedPallets: line.proposedPallets }))
      }, null);
      assert(staged.reviewProposalId, "Confirmed vendor lines must create a NetSuite PO review child.");
      assert.equal(staged.source.status, "superseded");
      assert.equal(staged.review.vendorReference, "HARNESS-VENDOR-REF");
      assert(staged.review.lines.every((line) => line.lastPurchasePrice > 0 && line.purchaseUnit === line.unit));
      assert(staged.review.palletItem.lastPurchasePrice > 0);
      assert.equal(staged.review.palletItem.itemWeightLbs, 40, "NetSuite PO review must expose the official PALLET item weight.");
      assert(staged.review.palletLines.every((line) => line.itemWeightLbs === 40 && line.lineWeightLbs === line.confirmedPallets * 40),
        "Every NetSuite PO review PALLET line must expose quantity × 40 lb.");
      assert.equal(staged.review.palletLines.reduce((sum, line) => sum + line.confirmedPallets, 0), staged.review.totalPallets);
      const pendingReviews = await listSmartScmNetSuitePoReviewLoads({ search: String(staged.reviewProposalId), view: "pending", limit: 50 });
      assert(pendingReviews.some((load) => load.id === staged.reviewProposalId), "Staged PO must appear in NetSuite PO review.");
      const execution = await executeSmartScmPurchaseProposal(staged.reviewProposalId, null);
      assert.equal(execution.purchaseOrderRef, "MOCK-PO-" + staged.reviewProposalId);
      const completed = (await listSmartScmNetSuitePoReviewLoads({ search: String(staged.reviewProposalId), view: "completed", limit: 50 }))
        .find((load) => load.id === staged.reviewProposalId);
      assert.equal(completed.status, "completed");
      assert.equal(completed.netsuitePurchaseOrderRef, "MOCK-PO-" + staged.reviewProposalId);
      vendorLoadChecked = true;
    }
    const groupCandidates = plan.proposals.filter((proposal) => proposal.id !== po?.id && ["draft", "held", "reviewed", "attention"].includes(proposal.status));
    const groupBuckets = new Map();
    for (const proposal of groupCandidates) {
      const key = proposal.proposalType === "PO"
        ? [proposal.proposalType, proposal.phase, proposal.sourceName, proposal.vendor].join("|")
        : [proposal.proposalType, proposal.phase, proposal.sourceLocationId, proposal.destinationLocationId].join("|");
      if (!groupBuckets.has(key)) groupBuckets.set(key, []);
      groupBuckets.get(key).push(proposal);
    }
    let compatibleGroup = null;
    for (const rows of groupBuckets.values()) {
      for (let left = 0; left < rows.length && !compatibleGroup; left += 1) {
        for (let right = left + 1; right < rows.length; right += 1) {
          const pair = [rows[left], rows[right]];
          const destinations = new Set(pair.flatMap((proposal) => proposal.lines.map((line) => line.destinationLocationId)));
          if (pair[0].proposalType !== "PO" || destinations.size <= 2) {
            compatibleGroup = pair;
            break;
          }
        }
      }
      if (compatibleGroup) break;
    }
    assert(compatibleGroup, "Expected at least two compatible proposal loads for manual grouping.");
    const groupedRun = await groupSmartScmProposals(compatibleGroup.map((proposal) => proposal.id), null);
    const groupedLoads = groupedRun.proposals.filter((proposal) => proposal.manuallyGrouped);
    assert(groupedLoads.length > 0, "Manual grouping must create route-aware replacement loads.");
    assert(groupedLoads.every((proposal) => proposal.utilization <= 1.000001), "Manual grouped loads must not exceed truck capacity.");
    assert(groupedLoads.every((proposal) => proposal.routeStops.length > 0), "Every grouped load must expose at least one route stop.");
    const editableGrouped = groupedLoads[0];
    const editLine = editableGrouped.lines[0];
    const edited = await updateSmartScmProposalLine(editableGrouped.id, editLine.id, { proposedPallets: editLine.proposedPallets }, null);
    assert.equal(edited.lines.find((line) => line.id === editLine.id).proposedPallets, editLine.proposedPallets, "Proposal pallet quantity must be editable.");
    if (edited.lines.length > 1) {
      const removedLineId = edited.lines[edited.lines.length - 1].id;
      const afterRemoval = await removeSmartScmProposalLine(edited.id, removedLineId, null);
      if (!afterRemoval.deleted) assert(!afterRemoval.lines.some((line) => line.id === removedLineId), "Proposal line removal must persist.");
    }
    const beforeRecalculate = await getSmartScmPlanningRun(plan.id);
    const recalculateCandidate = beforeRecalculate.proposals.find((proposal) => proposal.proposalType === "PO"
      && proposal.id !== po?.id && proposal.status === "held" && proposal.lines.length);
    assert(recalculateCandidate, "Expected an editable PO proposal for Re-Calculate coverage.");
    const expectedRecalculatedPallets = recalculateCandidate.lines.reduce((sum, line) => sum + Math.max(1, Math.round(line.proposedPallets)), 0);
    const recalculatedRun = await recalculateSmartScmPoProposal(recalculateCandidate.id, null);
    assert(!recalculatedRun.proposals.some((proposal) => proposal.id === recalculateCandidate.id), "Re-Calculate must replace the original PO proposal.");
    const recalculatedLoads = recalculatedRun.proposals.filter((proposal) => proposal.memo?.startsWith("PO recalculated load"));
    assert(recalculatedLoads.length > 0, "Re-Calculate must create replacement PO loads.");
    assert(recalculatedLoads.every((proposal) => proposal.utilization <= 1.000001 && proposal.routeStops.length <= 2), "Every recalculated PO must be capacity-safe with at most two drops.");
    assert(recalculatedLoads.flatMap((proposal) => proposal.lines).every((line) => Number.isInteger(line.proposedPallets)), "Recalculated PO quantities must remain whole pallets.");
    assert.equal(recalculatedLoads.flatMap((proposal) => proposal.lines).reduce((sum, line) => sum + line.proposedPallets, 0), expectedRecalculatedPallets, "Re-Calculate must preserve the edited purchase quantity.");

    const beforeWholeLineMove = await getSmartScmPlanningRun(plan.id);
    const multiLineSplitSource = beforeWholeLineMove.proposals.find((proposal) =>
      ["draft", "held", "reviewed", "attention"].includes(proposal.status)
      && proposal.lines.length > 1
      && proposal.lines.some((line) => line.proposedPallets > 1)
    );
    assert(multiLineSplitSource, "Expected an editable multi-line load for whole-line split coverage.");
    const wholeLineTarget = multiLineSplitSource.lines.find((line) => line.proposedPallets > 1);
    const proposalIdsBeforeWholeLineMove = new Set(beforeWholeLineMove.proposals.map((proposal) => proposal.id));
    const afterWholeLineMove = await splitSmartScmProposalLine(
      multiLineSplitSource.id,
      wholeLineTarget.id,
      { splitPallets: 1 },
      null
    );
    const retainedSource = afterWholeLineMove.proposals.find((proposal) => proposal.id === multiLineSplitSource.id);
    const wholeLineChild = afterWholeLineMove.proposals.find((proposal) => !proposalIdsBeforeWholeLineMove.has(proposal.id));
    assert(retainedSource, "Splitting one line from a multi-line load must retain the remaining source load.");
    assert(!retainedSource.lines.some((line) => line.id === wholeLineTarget.id), "The selected item line must be removed completely from its source load.");
    assert.equal(retainedSource.lines.length, multiLineSplitSource.lines.length - 1);
    assert.equal(retainedSource.status, "held", "The changed source load must return to Hold.");
    assert(wholeLineChild && wholeLineChild.lines.length === 1, "The moved item must be the only material line in its new load.");
    assert.equal(wholeLineChild.lines[0].proposedPallets, wholeLineTarget.proposedPallets,
      "A legacy partial split quantity must be ignored; Split always moves the entire selected line.");
    assert.equal(retainedSource.totalPallets + wholeLineChild.totalPallets, multiLineSplitSource.totalPallets,
      "Whole-line split must conserve the source load pallet quantity.");
    assert.equal(wholeLineChild.physicalPalletLines.reduce((sum, line) => sum + line.quantity, 0), wholeLineChild.totalPallets,
      "The separated load must immediately expose its matching physical PALLET line.");

    const printerCount = await query("SELECT COUNT(*)::integer AS count FROM scm_yard_printers");
    assert.equal(printerCount.rows[0].count, 4);
    const configuredPrinter = await updateYardPrinter(1, { printerName: "MBBS Harness Printer", enabled: true }, null);
    const credentials = await rotateYardPrinterToken(1, null);
    const queued = await queueYardPrinterTest(1, null);
    const storedJob = await query("SELECT document_path, document_sha256 FROM scm_print_jobs WHERE id = $1", [queued.id]);
    temporaryPrintPath = storedJob.rows[0].document_path;
    const leased = await leaseYardPrintJob(credentials.token, configuredPrinter.agentId);
    assert.equal(leased.job.id, queued.id);
    const document = await yardPrintJobDocument(queued.id, credentials.token, configuredPrinter.agentId, leased.job.leaseToken);
    assert.equal(document.path, temporaryPrintPath);
    const documentBytes = await fs.readFile(document.path);
    assert.equal(crypto.createHash("sha256").update(documentBytes).digest("hex"), storedJob.rows[0].document_sha256);
    await updateLeasedPrintJob(queued.id, credentials.token, configuredPrinter.agentId, leased.job.leaseToken, "started");
    const printed = await updateLeasedPrintJob(queued.id, credentials.token, configuredPrinter.agentId, leased.job.leaseToken, "completed");
    assert.equal(printed.status, "printed");
    console.log(JSON.stringify({
      activeInputs: activeSlots.size,
      forecasts: forecasts.length,
      proposals: plan.proposals.length,
      poProposals: plan.proposals.filter((proposal) => proposal.proposalType === "PO").length,
      toProposals: plan.proposals.filter((proposal) => proposal.proposalType === "TO").length,
      vendorLoadChecked,
      printerLeaseChecked: true,
      alternativeLineChecked,
      routeRulesChecked: true,
      proposalDestinationChecked: true,
      rolledBack: true
    }, null, 2));
  }, { rollback: true });
} finally {
  if (temporaryPrintPath) await fs.unlink(temporaryPrintPath).catch(() => null);
  await closeDb();
}
