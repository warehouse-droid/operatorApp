import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { closeDb } from "../src/db.js";
import { consolidateCompatibleDrafts } from "../src/smart-scm-planning-repository.js";
import { smartScmBuiltInRouteRule, smartScmRouteRuleKey } from "../src/smart-scm-route-repository.js";

const directory = "test-artifacts/scm-ultimate-packing-20261005";
const fixture = JSON.parse(readFileSync(`${directory}/replay-input.json`, "utf8"));
const baseline = await import(pathToFileURL(path.resolve(directory, "baseline/src/smart-scm-planning-repository.js")));
const baselineDb = await import(pathToFileURL(path.resolve(directory, "baseline/src/db.js")));
const epsilon = 0.000001;
const number = (value) => Number(value || 0);
const rules = new Map(fixture.rules.map((row) => [row.source_key, {
  enabled: row.enabled, sourceName: row.source_name, maxDrops: number(row.max_drops),
  stopOrder: row.stop_order.map(Number), partialRedirectEnabled: false
}]));

function routing(source) {
  const configured = rules.get(smartScmRouteRuleKey(source));
  if (configured?.enabled === false) {
    return { ...smartScmBuiltInRouteRule(""), partialRedirectEnabled: false };
  }
  return { ...smartScmBuiltInRouteRule(source), ...configured, partialRedirectEnabled: false };
}

function identity(draft) {
  const phase = draft.proposalType === "PO" && ["direct_vendor", "vendor_hub"].includes(draft.phase)
    ? "vendor_purchase" : draft.phase;
  const clean = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const source = draft.sourceKind === "vendor"
    ? Number(draft.sourceVendorYardId) > 0 ? `vendor:${draft.sourceVendorYardId}` : `legacy:${clean(draft.vendor)}:${clean(draft.plant || draft.sourceName)}`
    : `yard:${draft.sourceLocationId || clean(draft.sourceName)}`;
  return JSON.stringify([draft.proposalType, phase, source,
    draft.proposalType === "PO" ? "multiple" : [draft.destinationLocationId, draft.destinationName]]);
}

function palletWeight(line) {
  return number(line.palletWeight) + number(line.physicalPalletWeightLbs ?? line.reason?.physicalPalletWeightLbs);
}

function gross(line) {
  return number(line.lineWeight) + number(line.proposedPallets)
    * number(line.physicalPalletWeightLbs ?? line.reason?.physicalPalletWeightLbs);
}

const fields = ["requiredPallets", "proposedPallets", "residualPallets", "salesQuantity", "lineWeight"];
function totals(lines) {
  const result = new Map();
  for (const line of lines) {
    const key = `${line.itemId}:${line.destinationLocationId}`;
    const aggregate = result.get(key) || { units: 0, gross: 0, allocations: new Map(),
      ...Object.fromEntries(fields.map((field) => [field, 0])) };
    for (const field of fields) aggregate[field] += number(line[field]);
    aggregate.gross += gross(line);
    aggregate.units += Math.ceil(number(line.proposedPallets));
    for (const allocation of line.reason?.destinationAllocations || []) {
      const allocationKey = `${allocation.yard}:${allocation.fulfillment || ""}`;
      aggregate.allocations.set(allocationKey, (aggregate.allocations.get(allocationKey) || 0) + number(allocation.proposedPallets));
    }
    result.set(key, aggregate);
  }
  return result;
}

function conserve(input, packed) {
  const expected = totals(input), actual = totals(packed);
  assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort());
  for (const [key, original] of expected) {
    const next = actual.get(key);
    // The existing pallet split rounds each proportional dimension to six
    // decimals. Bound accumulated roundoff by the number of pallet units.
    const tolerance = epsilon * Math.max(1, original.units);
    for (const field of [...fields, "gross"]) {
      const limit = field === "proposedPallets" ? epsilon : tolerance;
      assert.ok(Math.abs(original[field] - next[field]) <= limit, `${key} ${field}: ${original[field]} -> ${next[field]}`);
    }
    assert.deepEqual([...next.allocations.keys()].sort(), [...original.allocations.keys()].sort());
    for (const [allocation, quantity] of original.allocations) {
      assert.ok(Math.abs(quantity - next.allocations.get(allocation)) <= tolerance, `${key} ${allocation}`);
    }
  }
}

function validateGroup(group, result, capacity) {
  const inputs = group.flatMap((draft) => draft.lines);
  conserve(inputs, result.flatMap((draft) => draft.lines));
  const route = routing(group[0].sourceName);
  const maxStops = group[0].proposalType === "PO" ? route.maxDrops : 1;
  const priority = new Map(route.stopOrder.map((location, index) => [location, index]));
  for (const draft of result) {
    assert.ok(draft.totalWeight <= capacity + epsilon, `Overweight ${draft.proposalKey}`);
    assert.ok(draft.routeStops.length <= maxStops);
    const order = draft.routeStops.map((stop) => priority.get(stop.locationId));
    assert.deepEqual(order, [...order].sort((left, right) => left - right));
    const urgent = draft.lines.filter((line) => line.urgencyLevel === "ultimate_urgent");
    if (urgent.length && capacity - urgent.reduce((sum, line) => sum + gross(line), 0) + epsilon
        < Math.min(...urgent.map(palletWeight))) {
      assert.equal(urgent.length, draft.lines.length, "A full urgent quantity contains lower-priority filler");
    }
  }
  const destinationCounts = [];
  for (const destination of new Set(inputs.map((line) => Number(line.destinationLocationId)))) {
    const urgent = inputs.filter((line) => Number(line.destinationLocationId) === destination && line.urgencyLevel === "ultimate_urgent");
    if (!urgent.length) continue;
    const urgentWeight = urgent.reduce((sum, line) => sum + gross(line), 0);
    const loads = result.filter((draft) => draft.lines.some((line) => Number(line.destinationLocationId) === destination && line.urgencyLevel === "ultimate_urgent"));
    if (urgentWeight <= capacity + epsilon) assert.equal(loads.length, 1, `Urgent destination ${destination} fits one truck but is fragmented`);
    destinationCounts.push({ destination, urgentPallets: urgent.reduce((sum, line) => sum + number(line.proposedPallets), 0),
      urgentGrossWeight: urgentWeight, urgentLoads: loads.length });
  }
  const isFull = (draft) => draft.lines.length && draft.lines.every((line) => line.urgencyLevel === "ultimate_urgent")
    && capacity - draft.totalWeight + epsilon < Math.min(...draft.lines.map(palletWeight));
  const firstRemainder = result.findIndex((draft) => draft.lines.some((line) => line.urgencyLevel === "ultimate_urgent") && !isFull(draft));
  if (firstRemainder >= 0) assert.equal(result.slice(firstRemainder).some(isFull), false, "Full urgent loads must precede remainders");
  return destinationCounts;
}

const reports = [];
try {
  for (const plan of fixture.plans) {
    const settings = plan.settings_snapshot;
    const capacity = number(settings.truck_capacity_lbs) || 78000;
    const groups = new Map();
    let manualProposals = 0;
    let normalizedConfirmedLines = 0;
    for (const original of plan.proposals) {
      const draft = { ...original, lines: (original.lines || []).filter((line) => number(line.proposedPallets) > 0)
        .map((line) => {
          if (number(line.confirmedPallets) > 0 || number(line.residualPallets) !== number(line.proposedPallets)) {
            normalizedConfirmedLines += 1;
          }
          return { ...line, confirmedPallets: 0, residualPallets: line.proposedPallets };
        }) };
      if (!draft.lines.length) continue;
      if (draft.lines.some((line) => line.manualPlanningRequired || number(line.palletWeight) <= 0)) {
        manualProposals += 1;
        continue;
      }
      const key = identity(draft);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(draft);
    }
    const groupReports = [];
    for (const [key, group] of groups) {
      const replayRules = new Map(rules);
      replayRules.set(smartScmRouteRuleKey(group[0].sourceName), routing(group[0].sourceName));
      const previous = baseline.consolidateCompatibleDrafts(group, settings, `replay-${plan.id}`, replayRules);
      const next = consolidateCompatibleDrafts(group, settings, `replay-${plan.id}`, replayRules);
      const urgentDestinations = validateGroup(group, next, capacity);
      const repeated = consolidateCompatibleDrafts(group, settings, `replay-${plan.id}`, replayRules);
      assert.deepEqual(repeated, next, "Repeating a frozen plan changed the result");
      const noUltimate = !group.flatMap((draft) => draft.lines).some((line) => line.urgencyLevel === "ultimate_urgent");
      if (noUltimate) assert.deepEqual(next, previous, "A group without Ultimate Urgent items changed");
      groupReports.push({ key, source: group[0].sourceName, type: group[0].proposalType,
        storedLoads: group.length, oldReplayLoads: previous.length, newReplayLoads: next.length,
        delta: next.length - previous.length, unchangedWithoutUltimate: noUltimate,
        fullUltimateLoads: next.filter((draft) => draft.lines.every((line) => line.urgencyLevel === "ultimate_urgent")
          && capacity - draft.totalWeight + epsilon < Math.min(...draft.lines.map(palletWeight))).length,
        urgentDestinations,
        before: previous.map((draft) => ({ weight: draft.totalWeight, stops: draft.routeStops,
          lines: draft.lines.map((line) => ({ itemId: line.itemId, destination: line.destinationLocationId,
            pallets: line.proposedPallets, urgency: line.urgencyLevel })) })),
        after: next.map((draft) => ({ weight: draft.totalWeight, stops: draft.routeStops,
          lines: draft.lines.map((line) => ({ itemId: line.itemId, destination: line.destinationLocationId,
            pallets: line.proposedPallets, urgency: line.urgencyLevel })) })) });
    }
    const result = { planId: Number(plan.id), groups: groupReports.length, manualProposals, normalizedConfirmedLines,
      storedLoads: plan.proposals.length,
      oldReplayLoads: groupReports.reduce((sum, group) => sum + group.oldReplayLoads, 0),
      newReplayLoads: groupReports.reduce((sum, group) => sum + group.newReplayLoads, 0), groupReports };
    reports.push(result);
    console.log(JSON.stringify({ planId: result.planId, groups: result.groups,
      oldReplayLoads: result.oldReplayLoads, newReplayLoads: result.newReplayLoads, manualProposals }));
  }
  const summary = { passed: true, plans: reports.length, groups: reports.reduce((sum, plan) => sum + plan.groups, 0),
    storedProposals: fixture.plans.reduce((sum, plan) => sum + plan.proposals.length, 0),
    manualProposals: reports.reduce((sum, plan) => sum + plan.manualProposals, 0),
    oldReplayLoads: reports.reduce((sum, plan) => sum + plan.oldReplayLoads, 0),
    newReplayLoads: reports.reduce((sum, plan) => sum + plan.newReplayLoads, 0),
    unchangedGroupsWithoutUltimate: reports.flatMap((plan) => plan.groupReports).filter((group) => group.unchangedWithoutUltimate).length,
    groupsWithMoreTrucks: reports.flatMap((plan) => plan.groupReports).filter((group) => group.delta > 0).length,
    reports };
  writeFileSync(`${directory}/replay-report.json`, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ ...summary, reports: undefined }));
} finally {
  await closeDb();
  await baselineDb.closeDb();
}
