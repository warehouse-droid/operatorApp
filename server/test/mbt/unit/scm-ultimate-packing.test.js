import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import vm from "node:vm";
import { closeDb } from "../../../src/db.js";
import { consolidateCompatibleDrafts, smartScmPackWholePalletLines } from "../../../src/smart-scm-planning-repository.js";

after(closeDb);

function line(itemId, pallets, weight, level = "ultimate_urgent", destinationLocationId = 1) {
  const yard = new Map([[1, "3445"], [28, "2967"], [15, "12441"], [26, "150"]]);
  return {
    itemId, itemName: `Item ${itemId}`, destinationLocationId,
    destinationName: yard.get(destinationLocationId),
    requiredPallets: pallets, proposedPallets: pallets, confirmedPallets: 0,
    residualPallets: pallets, salesQuantity: pallets * 10, palletWeight: weight,
    physicalPalletWeightLbs: 0, lineWeight: pallets * weight, toPlt: 10,
    urgencyLevel: level, urgencyScore: level === "ultimate_urgent" ? 100 : 0,
    urgent: level !== "normal", reason: {}
  };
}

function pack(lines, capacity, options = {}) {
  return smartScmPackWholePalletLines(lines, capacity, {
    sourceName: "Ayr", proposalType: "PO", maxStops: 2,
    routeRule: { enabled: true, maxDrops: 2, stopOrder: [1, 28, 15, 26], partialRedirectEnabled: false },
    ...options
  });
}

function ultimate(load) {
  return load.lines.filter((entry) => entry.urgencyLevel === "ultimate_urgent");
}

test("full Ultimate Urgent loads resist lower-priority filler; only the remainder mixes", () => {
  const loads = pack([line(1, 7, 9), line(2, 6, 3, "normal")], 30);
  assert.equal(loads.length, 3);
  assert.deepEqual(loads.slice(0, 2).map((load) => [load.totalWeight, load.lines.map((entry) => entry.itemId)]),
    [[27, [1]], [27, [1]]]);
  assert.equal(loads[2].lines.find((entry) => entry.itemId === 1).proposedPallets, 1);
  assert.equal(loads[2].lines.find((entry) => entry.itemId === 2).proposedPallets, 6);
  assert.equal(loads[2].totalWeight, 27);
});

test("truck-count preference cannot undo concentration of Ultimate Urgent pallets", () => {
  const loads = pack([line(1, 6, 1), line(2, 3, 8, "normal")], 10);
  const urgentLoads = loads.filter((load) => ultimate(load).length);
  assert.equal(urgentLoads.length, 1);
  assert.equal(ultimate(urgentLoads[0])[0].proposedPallets, 6);
  assert.equal(loads.length, 4);
  assert.ok(loads.every((load) => load.totalWeight <= 10));
});

test("whole urgent remainder destination groups combine without splitting; one-drop rules keep them apart", () => {
  const input = [line(1, 3, 10, "ultimate_urgent", 1), line(2, 2, 10, "ultimate_urgent", 28)];
  const combined = pack(input, 100);
  assert.equal(combined.length, 1);
  assert.deepEqual(combined[0].routeStops.map((stop) => stop.name), ["3445", "2967"]);
  const separate = pack(input, 100, {
    routeRule: { enabled: true, maxDrops: 1, stopOrder: [1, 28, 15, 26], partialRedirectEnabled: false }
  });
  assert.equal(separate.length, 2);
  assert.ok(separate.every((load) => load.routeStops.length === 1));
});

test("a destination's urgent remainder stays intact when it cannot share a whole route", () => {
  const loads = pack([line(1, 8, 10, "ultimate_urgent", 1), line(2, 6, 10, "ultimate_urgent", 28)], 100);
  assert.equal(loads.length, 2);
  assert.equal(loads.filter((load) => load.lines.some((entry) => entry.itemId === 2)).length, 1);
  assert.equal(loads.filter((load) => load.lines.some((entry) => entry.itemId === 1)).length, 1);
});

test("physical pallet weight is included and fractional purchase quantities are conserved", () => {
  const material = [line(1, 4, 8), line(2, 1.5, 2, "normal")]
    .map((entry) => ({ ...entry, physicalPalletWeightLbs: 2, reason: { physicalPalletWeightLbs: 2, stockingPurchase: true } }));
  const loads = pack(material, 30, { allowPartialPallets: true });
  assert.ok(loads.every((load) => load.totalWeight <= 30.000001));
  assert.equal(loads.reduce((sum, load) => sum + load.totalWeight, 0), 46);
  for (const expected of material) {
    assert.equal(loads.flatMap((load) => load.lines).filter((entry) => entry.itemId === expected.itemId)
      .reduce((sum, entry) => sum + entry.proposedPallets, 0), expected.proposedPallets);
  }
});

test("partial vendor hub routing survives urgent consolidation", () => {
  const loads = smartScmPackWholePalletLines([line(1, 4, 10), line(2, 2, 10, "normal", 28)], 100,
    { proposalType: "PO", sourceName: "Gormley", maxStops: 2 });
  assert.ok(loads.flatMap((load) => load.lines).every((entry) => entry.destinationLocationId === 15));
  assert.equal(loads.flatMap((load) => load.lines).filter((entry) => entry.itemId === 1)
    .reduce((sum, entry) => sum + entry.proposedPallets, 0), 4);
});

test("captured plan 429 keeps BWS Woodbridge -> 2967 urgent quantity in one truck", () => {
  const fixture = JSON.parse(readFileSync("test-artifacts/scm-ultimate-packing-20261005/replay-input.json", "utf8"));
  const plan = fixture.plans.find((entry) => Number(entry.id) === 429);
  assert.ok(plan, "The reported plan must be present in the replay fixture");
  const drafts = plan.proposals.filter((proposal) => Number(proposal.sourceVendorYardId) === 73);
  const expected = drafts.flatMap((draft) => draft.lines).filter((entry) =>
    Number(entry.destinationLocationId) === 28 && entry.urgencyLevel === "ultimate_urgent");
  assert.equal(expected.reduce((sum, entry) => sum + Number(entry.proposedPallets), 0), 25);
  const packed = consolidateCompatibleDrafts(drafts, plan.settings_snapshot, "replay-429");
  const matching = packed.filter((proposal) => proposal.lines.some((entry) =>
    Number(entry.destinationLocationId) === 28 && entry.urgencyLevel === "ultimate_urgent"));
  assert.equal(matching.length, 1);
  assert.equal(matching[0].lines.filter((entry) => Number(entry.destinationLocationId) === 28 && entry.urgencyLevel === "ultimate_urgent")
    .reduce((sum, entry) => sum + Number(entry.proposedPallets), 0), 25);
});

function proposalContext(proposals, sort) {
  const context = vm.createContext({
    smartState: { planSearch: "", planType: "", planStatus: "", planSource: "", planVendor: "", planDestination: "",
      planSort: sort, plan: { proposals, settingsSnapshot: { truck_capacity_lbs: 30 } } },
    smartProposalManualPriority: (proposal) => proposal.manuallyGrouped ? 0 : 1,
    smartScmApp: { addEventListener() {} }, document: { querySelector() {}, getElementById() {} },
    setTimeout, clearTimeout, URLSearchParams
  });
  vm.runInContext(readFileSync("public/scm-smart-proposals.js", "utf8"), context,
    { filename: new URL("../../../public/scm-smart-proposals.js", import.meta.url).pathname });
  return context;
}

test("full urgent proposal cards precede mixed cards before destination and score tie-breakers", () => {
  const full = { id: 2, urgencyLevel: "ultimate_urgent", urgencyScore: 10, sourceName: "Ayr", lines: [line(1, 3, 9, "ultimate_urgent", 26)],
    totalWeightLbs: 27, utilization: 0.9, proposalType: "PO" };
  const mixed = { id: 1, urgencyLevel: "ultimate_urgent", urgencyScore: 100, sourceName: "Ayr",
    lines: [line(2, 1, 9), line(3, 4, 3, "normal")], totalWeightLbs: 21, utilization: 0.7, proposalType: "PO" };
  const manual = { ...mixed, id: 3, manuallyGrouped: true };
  const priority = { ...mixed, id: 4, regularReplenishmentId: 1 };
  for (const sort of ["source", "destination"]) {
    const context = proposalContext([mixed, full, manual, priority], sort);
    assert.deepEqual(Array.from(vm.runInContext("smartFilteredProposals().map(p => p.id)", context)), [4, 3, 2, 1]);
  }
});

test("full-load classification uses the saved capacity when utilization is missing and rejects incomplete or overweight cards", () => {
  const context = proposalContext([], "source");
  const full = { lines: [line(1, 3, 9)], totalWeightLbs: 27 };
  assert.equal(context.smartProposalUltimateLoadPriority(full), 0);
  assert.equal(context.smartProposalUltimateLoadPriority({ ...full, lines: [line(1, 2, 9)], totalWeightLbs: 18 }), 1);
  assert.equal(context.smartProposalUltimateLoadPriority({ ...full, totalWeightLbs: 36 }), 1);
  assert.equal(context.smartProposalUltimateLoadPriority({ ...full, lines: [] }), 1);
  assert.equal(context.smartProposalUltimateLoadPriority({ ...full, lines: [{ ...line(1, 3, 9), palletWeight: 0 }] }), 1);
});

test("invalid capacity, pallet weight and unsupported fractional quantities retain their errors", () => {
  assert.throws(() => pack([line(1, 1, 1)], 0), { message: "Truck capacity must be greater than zero." });
  assert.throws(() => pack([line(1, 1, 0)], 100), { message: "Every packed line needs a positive pallet quantity and pallet weight." });
  assert.throws(() => pack([line(1, 1.5, 10)], 100), { message: "PO recalculation requires whole-pallet quantities." });
});

test("frozen input and destination allocations survive urgent regrouping", () => {
  const allocations = Object.freeze([
    Object.freeze({ yard: "3445", fulfillment: "vendor_direct", proposedPallets: 3 }),
    Object.freeze({ yard: "150", fulfillment: "transfer_later", proposedPallets: 4 })
  ]);
  const input = Object.freeze([Object.freeze({ ...line(1, 7, 9),
    reason: Object.freeze({ destinationAllocations: allocations }) }), Object.freeze(line(2, 6, 3, "normal"))]);
  const before = JSON.stringify(input);
  const loads = pack(input, 30);
  assert.equal(JSON.stringify(input), before);
  const output = loads.flatMap((load) => load.lines).filter((entry) => entry.itemId === 1)
    .flatMap((entry) => entry.reason.destinationAllocations);
  assert.equal(output.filter((entry) => entry.yard === "3445").reduce((sum, entry) => sum + entry.proposedPallets, 0), 3);
  assert.equal(output.filter((entry) => entry.yard === "150").reduce((sum, entry) => sum + entry.proposedPallets, 0), 4);
});
