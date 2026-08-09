import assert from "node:assert/strict";
import fs from "node:fs/promises";
import * as planningRepository from "./smart-scm-planning-repository.js";

const effectiveInbound = planningRepository.smartScmEffectiveInboundSales;
const inventoryPosition = planningRepository.smartScmInventoryPositionSales;

assert.equal(
  typeof effectiveInbound,
  "function",
  "Smart SCM must expose one authoritative inbound calculation instead of adding local PO/TO rows."
);
assert.equal(
  typeof inventoryPosition,
  "function",
  "Smart SCM must calculate PO/TO need from authoritative available, on-order, and backorder totals."
);

assert.deepEqual(
  effectiveInbound({
    authoritativeOnOrderSales: 1_000,
    blanketExcludedSales: 600,
    excludedTransferOrderSales: 100,
    reservedBlanketSales: 50,
    pendingTransferReservationSales: 20,
    // This deliberately looks like the old local-line input. It must have no
    // effect because NetSuite's 1,000 already contains those order lines.
    localPurchaseAndTransferSales: 500
  }),
  {
    authoritativeOnOrderSales: 1_000,
    blanketExcludedSales: 600,
    excludedTransferOrderSales: 100,
    reservedBlanketSales: 50,
    pendingTransferReservationSales: 20,
    effectiveOnOrderSales: 370
  },
  "10 PLT authoritative on-order plus a locally mirrored 5 PLT TO must remain 10 PLT, not become 15 PLT."
);

assert.equal(
  effectiveInbound({
    authoritativeOnOrderSales: 360,
    blanketExcludedSales: 4_968,
    excludedTransferOrderSales: 360
  }).effectiveOnOrderSales,
  0,
  "Blanket and own-TO subtraction must clamp at zero when a local detail snapshot is newer than the aggregate."
);

assert.deepEqual(
  inventoryPosition({
    quantityAvailableSales: 400,
    authoritativeOnOrderSales: 1_000,
    blanketExcludedSales: 600,
    quantityBackorderedSales: 200,
    reservedOutboundSales: 50
  }),
  {
    quantityAvailableSales: 400,
    authoritativeOnOrderSales: 1_000,
    blanketExcludedSales: 600,
    excludedTransferOrderSales: 0,
    reservedBlanketSales: 0,
    pendingTransferReservationSales: 0,
    effectiveOnOrderSales: 400,
    quantityBackorderedSales: 200,
    reservedOutboundSales: 50,
    inventoryPositionSales: 550
  },
  "PO need must use available + effective NetSuite on-order - NetSuite backorder - pending outbound reservations."
);

const [netSuiteSource, inventorySource, migrationSource, vendorRepositorySource] = await Promise.all([
  fs.readFile(new URL("./netsuite.js", import.meta.url), "utf8"),
  fs.readFile(new URL("./inventory-repository.js", import.meta.url), "utf8"),
  fs.readFile(new URL("../migrations/138_smart_scm_authoritative_on_order.sql", import.meta.url), "utf8"),
  fs.readFile(new URL("./smart-scm-vendor-repository.js", import.meta.url), "utf8")
]);

assert.ok(
  (netSuiteSource.match(/ib\.quantityonorder\s+AS\s+quantity_on_order/gi) || []).length >= 3,
  "Every Smart SCM inventory fetch path must capture NetSuite AggregateItemLocation.quantityonorder."
);
assert.ok(
  (netSuiteSource.match(/ib\.quantitybackordered\s+AS\s+quantity_backordered/gi) || []).length >= 3,
  "Every Smart SCM inventory fetch path must capture NetSuite AggregateItemLocation.quantitybackordered."
);
assert.match(
  inventorySource,
  /inventory_balances[\s\S]*quantity_on_order[\s\S]*EXCLUDED\.quantity_on_order/i,
  "The canonical inventory upsert must persist the authoritative NetSuite on-order value."
);
assert.match(migrationSource, /ALTER TABLE\s+inventory_balances[\s\S]*quantity_on_order/i);
assert.match(migrationSource, /ALTER TABLE\s+inventory_balances[\s\S]*quantity_backordered/i);
assert.match(migrationSource, /ALTER TABLE\s+scm_smart_inventory_snapshots[\s\S]*quantity_on_order/i);
assert.match(migrationSource, /ALTER TABLE\s+scm_smart_inventory_snapshots[\s\S]*quantity_backordered/i);

const alternativeEvidenceStart = vendorRepositorySource.indexOf("async function smartScmAlternativeEvidence");
const alternativeEvidenceEnd = vendorRepositorySource.indexOf(
  "export function rankSmartScmVendorAlternatives",
  alternativeEvidenceStart
);
assert.ok(
  alternativeEvidenceStart >= 0 && alternativeEvidenceEnd > alternativeEvidenceStart,
  "The vendor-alternative inventory evidence implementation must be available for inspection."
);
const alternativeEvidenceSource = vendorRepositorySource.slice(alternativeEvidenceStart, alternativeEvidenceEnd);
assert.match(
  alternativeEvidenceSource,
  /smartScmInventoryPositionSales\s*\(/,
  "Vendor-alternative suggestions must use the same authoritative inventory-position formula as automatic planning."
);
assert.doesNotMatch(
  alternativeEvidenceSource,
  /\bopen_(?:po|to)\b|netsuite_backordered_qty/i,
  "Vendor-alternative suggestions must not reconstruct NetSuite aggregate on-order or backorder from incomplete local lines."
);
assert.match(
  vendorRepositorySource,
  /b\.quantity_on_order[\s\S]*b\.quantity_backordered/i,
  "Vendor-alternative candidates must load NetSuite aggregate on-order and backorder quantities."
);
for (const [name, source] of [
  ["automatic planning", await fs.readFile(new URL("./smart-scm-planning-repository.js", import.meta.url), "utf8")],
  ["manual proposal recalculation", await fs.readFile(new URL("./smart-scm-proposal-editor.js", import.meta.url), "utf8")],
  ["vendor alternatives", vendorRepositorySource]
]) {
  assert.match(
    source,
    /po\.status_text\s+ILIKE\s+'%Pending Receipt%'[\s\S]*po\.status_text\s+ILIKE\s+'%Partially Received%'/i,
    `${name} must subtract only open flagged blanket purchase orders.`
  );
}

console.log("Smart SCM authoritative inbound harness passed.");
