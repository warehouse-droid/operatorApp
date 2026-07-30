import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { consolidateCompatibleDrafts } from "./smart-scm-planning-repository.js";
import { smartScmBuiltInRouteRule } from "./smart-scm-route-repository.js";

const CANONICAL_AYR = "Ayr Yard - Unilock";
const LEGACY_AYR = "Ayr";
const SETTINGS = {
  truck_capacity_lbs: 78_000,
  hold_load_ratio: 0.5
};

function materialLine({
  itemId,
  destinationLocationId,
  destinationName,
  proposedPallets = 1
}) {
  return {
    itemId,
    itemName: `Vendor-yard identity fixture ${itemId}`,
    itemDescription: "Regression fixture",
    unit: "SQFT",
    destinationLocationId,
    destinationName,
    requiredPallets: proposedPallets,
    proposedPallets,
    confirmedPallets: 0,
    residualPallets: proposedPallets,
    salesQuantity: proposedPallets * 100,
    palletWeight: 1_000,
    lineWeight: proposedPallets * 1_000,
    toPlt: 100,
    toLyr: 10,
    toSec: 1,
    toPcs: 1,
    manualPlanningRequired: false,
    urgent: false,
    provisional: false,
    reason: {}
  };
}

function purchaseDraft({
  itemId,
  sourceVendorYardId,
  sourceName,
  plant = sourceName,
  destinationLocationId,
  destinationName
}) {
  const line = materialLine({
    itemId,
    destinationLocationId,
    destinationName
  });
  return {
    proposalKey: `vendor-yard-fixture:${itemId}`,
    proposalType: "PO",
    phase: "direct_vendor",
    sourceKind: "vendor",
    sourceLocationId: null,
    sourceVendorYardId,
    sourceName,
    destinationLocationId,
    destinationName,
    vendor: "UNILOCK",
    plant,
    status: "held",
    urgent: false,
    provisional: false,
    totalPallets: line.proposedPallets,
    totalWeight: line.lineWeight,
    utilization: line.lineWeight / SETTINGS.truck_capacity_lbs,
    routeStops: [{
      locationId: destinationLocationId,
      name: destinationName,
      sequence: 1
    }],
    lines: [line]
  };
}

const mixedLabelSameId = consolidateCompatibleDrafts([
  purchaseDraft({
    itemId: 910_001,
    sourceVendorYardId: 1,
    sourceName: CANONICAL_AYR,
    destinationLocationId: 15,
    destinationName: "12441"
  }),
  purchaseDraft({
    itemId: 910_002,
    sourceVendorYardId: 1,
    sourceName: LEGACY_AYR,
    plant: LEGACY_AYR,
    destinationLocationId: 1,
    destinationName: "3445"
  })
], SETTINGS, "vendor-yard-same-id");

assert.equal(
  mixedLabelSameId.length,
  1,
  "PO drafts with one vendor-yard ID must form one load even when legacy pickup labels differ."
);
assert.equal(
  mixedLabelSameId[0].sourceVendorYardId,
  1,
  "The consolidated PO must retain its vendor-yard identity."
);
assert.equal(
  mixedLabelSameId[0].sourceName,
  CANONICAL_AYR,
  "The consolidated PO must display the canonical vendor-yard pickup name."
);
assert.deepEqual(
  mixedLabelSameId[0].lines.map((line) => line.itemId).sort((left, right) => left - right),
  [910_001, 910_002],
  "Consolidation must preserve material from both legacy and canonical policy rows."
);
assert.deepEqual(
  mixedLabelSameId[0].routeStops.map((stop) => stop.locationId),
  [15, 1],
  "The consolidated Ayr load must retain both destination stops."
);

const sameLabelDifferentIds = consolidateCompatibleDrafts([
  purchaseDraft({
    itemId: 920_001,
    sourceVendorYardId: 1,
    sourceName: CANONICAL_AYR,
    destinationLocationId: 15,
    destinationName: "12441"
  }),
  purchaseDraft({
    itemId: 920_002,
    sourceVendorYardId: 2,
    sourceName: CANONICAL_AYR,
    destinationLocationId: 1,
    destinationName: "3445"
  })
], SETTINGS, "vendor-yard-distinct-ids");

assert.equal(
  sameLabelDifferentIds.length,
  2,
  "Different vendor-yard IDs must never merge merely because their display labels match."
);
assert.deepEqual(
  sameLabelDifferentIds.map((proposal) => proposal.sourceVendorYardId).sort((left, right) => left - right),
  [1, 2]
);

for (const canonicalGormleyName of ["UNILOCK Gormley", "Gormley Yard - Unilock"]) {
  const gormleyRule = smartScmBuiltInRouteRule(canonicalGormleyName);
  assert.equal(
    gormleyRule.partialRedirectEnabled,
    true,
    `${canonicalGormleyName} must retain the Gormley partial-load redirect.`
  );
  assert.equal(gormleyRule.partialRedirectHubLocationId, 15);
  assert.deepEqual(gormleyRule.stopOrder, [15, 1, 28, 26]);
}

const planningSource = await fs.readFile(
  new URL("./smart-scm-planning-repository.js", import.meta.url),
  "utf8"
);

assert.match(
  planningSource,
  /JOIN\s+dispatch_vendor_yards\s+(?:AS\s+)?vy\s+ON\s+vy\.id\s*=\s*p\.vendor_yard_id/i,
  "Planning policies must resolve vendor-yard IDs through dispatch_vendor_yards."
);
assert.match(
  planningSource,
  /COALESCE\s*\([^)]*vy\.yard[\s\S]*?\)\s+AS\s+plant/i,
  "Planning policies must prefer the canonical dispatch_vendor_yards.yard label."
);
assert.match(
  planningSource,
  /sourceVendorYardId:\s*state\.policy\.vendor_yard_id/,
  "PO draft creation must carry the vendor-yard ID into load consolidation."
);

const migrationSource = await fs.readFile(
  new URL("../migrations/085_smart_scm_vendor_yard_identity.sql", import.meta.url),
  "utf8"
);

assert.match(
  migrationSource,
  /ADD COLUMN IF NOT EXISTS source_vendor_yard_id bigint/i,
  "The stable PO pickup identity must be persisted separately from source_location_id."
);
assert.match(
  migrationSource,
  /UPDATE scm_smart_item_policies[\s\S]*?vendor_yard = BTRIM\(vendor_yard\.yard\)/i,
  "Mapped Item Master pickup labels must be normalized to their canonical vendor-yard names."
);

console.log("Smart SCM vendor-yard identity harness passed.");
