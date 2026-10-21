import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import vm from "node:vm";
import fc from "fast-check";
import { closeDb } from "../../../src/db.js";
import { smartScmPackWholePalletLines } from "../../../src/smart-scm-planning-repository.js";

after(closeDb);
const epsilon = 0.000001;

function material(row, index) {
  const allocations = row.allocations ? [
    { yard: "3445", fulfillment: "vendor_direct", proposedPallets: Math.floor(row.pallets / 2) },
    { yard: "150", fulfillment: "transfer_later", proposedPallets: row.pallets - Math.floor(row.pallets / 2) }
  ].filter((entry) => entry.proposedPallets > 0) : null;
  return { itemId: index + 1, destinationLocationId: row.destination,
    destinationName: String(row.destination), proposedPallets: row.pallets,
    requiredPallets: row.pallets, residualPallets: row.pallets,
    salesQuantity: row.pallets * 7, palletWeight: row.weight,
    physicalPalletWeightLbs: row.physical, lineWeight: row.pallets * row.weight,
    urgencyLevel: row.ultimate ? "ultimate_urgent" : "normal",
    urgencyScore: row.ultimate ? 100 : 0, urgent: row.ultimate,
    reason: { physicalPalletWeightLbs: row.physical, ...(allocations ? { destinationAllocations: allocations } : {}) } };
}

function gross(entry) {
  return entry.proposedPallets * (entry.palletWeight + entry.physicalPalletWeightLbs);
}

function unitWeight(entry) {
  return entry.palletWeight + entry.physicalPalletWeightLbs;
}

function normalize(loads) {
  return loads.map((load) => ({ weight: load.totalWeight,
    stops: load.routeStops.map((stop) => stop.locationId),
    lines: load.lines.map((entry) => [entry.itemId, entry.destinationLocationId, entry.proposedPallets])
      .sort((left, right) => left[0] - right[0]) }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function verify(input, loads, capacity, maxDrops) {
  const flat = loads.flatMap((load) => load.lines);
  for (const expected of input) {
    const actual = flat.filter((entry) => entry.itemId === expected.itemId);
    for (const field of ["proposedPallets", "requiredPallets", "residualPallets", "salesQuantity", "lineWeight"]) {
      assert.ok(Math.abs(actual.reduce((sum, entry) => sum + entry[field], 0) - expected[field]) <= epsilon, field);
    }
    for (const allocation of expected.reason.destinationAllocations || []) {
      assert.equal(actual.flatMap((entry) => entry.reason.destinationAllocations || [])
        .filter((entry) => entry.yard === allocation.yard && entry.fulfillment === allocation.fulfillment)
        .reduce((sum, entry) => sum + entry.proposedPallets, 0), allocation.proposedPallets);
    }
  }
  assert.ok(Math.abs(loads.reduce((sum, load) => sum + load.totalWeight, 0)
    - input.reduce((sum, entry) => sum + gross(entry), 0)) <= epsilon);
  for (const load of loads) {
    assert.ok(load.totalWeight <= capacity + epsilon);
    assert.ok(load.routeStops.length <= maxDrops);
    const urgent = load.lines.filter((entry) => entry.urgencyLevel === "ultimate_urgent");
    if (urgent.length && capacity - urgent.reduce((sum, entry) => sum + gross(entry), 0) + epsilon
        < Math.min(...urgent.map(unitWeight))) {
      assert.equal(urgent.length, load.lines.length, "A full urgent quantity must resist lower-priority filler");
    }
  }
  for (const destination of new Set(input.map((entry) => entry.destinationLocationId))) {
    const urgent = input.filter((entry) => entry.destinationLocationId === destination && entry.urgencyLevel === "ultimate_urgent");
    if (urgent.length && urgent.reduce((sum, entry) => sum + gross(entry), 0) <= capacity + epsilon) {
      assert.equal(loads.filter((load) => load.lines.some((entry) => entry.destinationLocationId === destination
        && entry.urgencyLevel === "ultimate_urgent")).length, 1, "A fitting destination's urgent quantity stays together");
    }
  }
}

test("properties: quantities, physical weight, routes, full urgent isolation and fitting-quantity concentration", () => {
  fc.assert(fc.property(fc.array(fc.record({
    destination: fc.constantFrom(1, 28, 15, 26), pallets: fc.integer({ min: 1, max: 16 }),
    weight: fc.integer({ min: 1, max: 40 }), physical: fc.integer({ min: 0, max: 3 }), ultimate: fc.boolean(), allocations: fc.boolean()
  }), { minLength: 1, maxLength: 8 }), fc.constantFrom(1, 2), (rows, maxDrops) => {
    const input = rows.map(material);
    const options = { proposalType: "PO", sourceName: "Ayr", maxStops: maxDrops,
      routeRule: { enabled: true, maxDrops, stopOrder: [1, 28, 15, 26], partialRedirectEnabled: false } };
    const first = smartScmPackWholePalletLines(input, 100, options);
    verify(input, first, 100, maxDrops);
    assert.deepEqual(normalize(smartScmPackWholePalletLines(input, 100, options)), normalize(first));
    if (rows.some((row) => row.ultimate)) {
      const reverse = smartScmPackWholePalletLines([...input].reverse(), 100, options);
      verify(input, reverse, 100, maxDrops);
      assert.deepEqual(normalize(reverse), normalize(first));
    }
  }), { numRuns: 1000, seed: 4292026 });
});

test("properties: complete partial urgent destination groups share one compatible route", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 4 }), fc.integer({ min: 1, max: 4 }),
    (left, right) => {
      const input = [material({ pallets: left, weight: 10, physical: 0, destination: 1, ultimate: true }, 0),
        material({ pallets: right, weight: 10, physical: 0, destination: 28, ultimate: true }, 1)];
      const combined = smartScmPackWholePalletLines(input, 100, { proposalType: "PO", sourceName: "Ayr", maxStops: 2 });
      assert.equal(combined.length, 1);
      const separate = smartScmPackWholePalletLines(input, 100, { proposalType: "PO", sourceName: "Ayr", maxStops: 1 });
      assert.equal(separate.length, 2);
    }), { numRuns: 100, seed: 42928 });
});

test("properties: partial Gormley quantities retain their hub routing after urgency grouping", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 4 }), fc.integer({ min: 1, max: 10 }),
    (pallets, weight) => {
      const input = [material({ pallets, weight, physical: 0, destination: 1, ultimate: true }, 0),
        material({ pallets, weight, physical: 0, destination: 28, ultimate: false }, 1)];
      const loads = smartScmPackWholePalletLines(input, 100, { proposalType: "PO", sourceName: "Gormley", maxStops: 2 });
      assert.ok(loads.flatMap((load) => load.lines).every((entry) => entry.destinationLocationId === 15));
      assert.equal(loads.reduce((sum, load) => sum + load.totalPallets, 0), pallets * 2);
    }), { numRuns: 200, seed: 42915 });
});

test("properties: nonpositive truck capacity fails before creating any loads", () => {
  fc.assert(fc.property(fc.integer({ min: -100000, max: 0 }), (capacity) => {
    const input = [material({ pallets: 1, weight: 1, physical: 0, destination: 1, ultimate: true }, 0)];
    assert.throws(() => smartScmPackWholePalletLines(input, capacity),
      { message: "Truck capacity must be greater than zero." });
  }), { numRuns: 100, seed: 4290 });
});

test("properties: lower-priority filler cannot turn protected full urgent loads into mixed loads", () => {
  fc.assert(fc.property(fc.integer({ min: 3, max: 12 }), fc.integer({ min: 2, max: 7 }),
    (weight, perTruck) => {
      const capacity = weight * perTruck + 1;
      const input = [material({ pallets: perTruck * 2 + 1, weight, physical: 0, destination: 1, ultimate: true }, 0),
        material({ pallets: 2, weight: 1, physical: 0, destination: 1, ultimate: false }, 1)];
      const loads = smartScmPackWholePalletLines(input, capacity, { proposalType: "PO", sourceName: "Ayr", maxStops: 1 });
      verify(input, loads, capacity, 1);
      assert.equal(loads.filter((load) => load.lines.length === 1 && load.lines[0].urgencyLevel === "ultimate_urgent"
        && load.lines[0].proposedPallets === perTruck).length, 2);
    }), { numRuns: 300, seed: 3623026 });
});

test("properties: full urgent cards stay ahead of mixed cards regardless of score and destination", () => {
  const script = readFileSync("public/scm-smart-proposals.js", "utf8");
  fc.assert(fc.property(fc.integer({ min: 1, max: 100 }), fc.integer({ min: 1, max: 100 }),
    (fullScore, mixedScore) => {
      const fullLine = { ...material({ pallets: 3, weight: 9, physical: 0, destination: 26, ultimate: true }, 0), destinationName: "150" };
      const mixedLines = [material({ pallets: 1, weight: 9, physical: 0, destination: 1, ultimate: true }, 1),
        material({ pallets: 1, weight: 3, physical: 0, destination: 1, ultimate: false }, 2)]
        .map((entry) => ({ ...entry, destinationName: "3445" }));
      const context = vm.createContext({
        smartState: { planSearch: "", planType: "", planStatus: "", planSource: "", planVendor: "", planDestination: "", planSort: "source",
          plan: { settingsSnapshot: { truck_capacity_lbs: 30 }, proposals: [
            { id: 1, urgencyLevel: "ultimate_urgent", urgencyScore: mixedScore, sourceName: "Ayr", lines: mixedLines, totalWeightLbs: 12, utilization: 0.4 },
            { id: 2, urgencyLevel: "ultimate_urgent", urgencyScore: fullScore, sourceName: "Ayr", lines: [fullLine], totalWeightLbs: 27, utilization: 0.9 }
          ] } },
        smartProposalManualPriority: () => 1, smartScmApp: { addEventListener() {} },
        document: { querySelector() {}, getElementById() {} }, setTimeout, clearTimeout, URLSearchParams
      });
      vm.runInContext(script, context,
        { filename: new URL("../../../public/scm-smart-proposals.js", import.meta.url).pathname });
      assert.deepEqual(Array.from(vm.runInContext("smartFilteredProposals().map(p => p.id)", context)), [2, 1]);
    }), { numRuns: 150, seed: 429150 });
});
