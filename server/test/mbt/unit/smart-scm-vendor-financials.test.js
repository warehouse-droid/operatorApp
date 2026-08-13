import assert from "node:assert/strict";
import test from "node:test";
import { smartScmVendorFinancialLine } from "../../../src/smart-scm-vendor-financials.js";

test("Vendor Replies prefer the NetSuite vendor price over Last Purchase Price", () => {
  const line = smartScmVendorFinancialLine({
    line: { itemId: 1259, itemName: "BWS-DC-CHAR", unit: "PC", salesQuantity: 10 },
    metadata: {
      purchaseUnit: "PC",
      vendorPrice: 12.6,
      vendorPriceSyncedAt: "2026-08-12T00:00:00Z",
      lastPurchasePrice: 10.67,
      lastPurchasePriceSyncedAt: "2026-08-11T00:00:00Z"
    }
  });

  assert.equal(line.lastPurchasePrice, 12.6);
  assert.equal(line.unitPriceSource, "vendor_price");
  assert.equal(line.lastPurchasePriceSyncedAt, "2026-08-12T00:00:00Z");
  assert.equal(line.purchaseAmount, 126);
});

test("Vendor Replies fall back to positive LPP when vendor price is empty, zero, or invalid", () => {
  for (const vendorPrice of [null, undefined, "", 0, "0", -1, "invalid"]) {
    const line = smartScmVendorFinancialLine({
      line: { itemId: 1259, itemName: "BWS-DC-CHAR", unit: "PC", salesQuantity: 10 },
      metadata: {
        purchaseUnit: "PC",
        vendorPrice,
        lastPurchasePrice: 10.67,
        lastPurchasePriceSyncedAt: "2026-08-11T00:00:00Z"
      }
    });

    assert.equal(line.lastPurchasePrice, 10.67, `vendor price ${String(vendorPrice)} must fall back to LPP`);
    assert.equal(line.unitPriceSource, "last_purchase_price");
    assert.equal(line.purchaseAmount, 106.7);
  }
});

test("Vendor Replies financials multiply sales quantity by price and round accounting amount", () => {
  const line = smartScmVendorFinancialLine({
    line: { itemId: 5011, itemName: "Material", unit: "EA", salesQuantity: 25 },
    metadata: { purchaseUnit: "EA", lastPurchasePrice: 1.64, lastPurchasePriceSyncedAt: "2026-08-11T00:00:00Z" }
  });
  assert.equal(line.purchaseQuantity, 25);
  assert.equal(line.lastPurchasePrice, 1.64);
  assert.equal(line.purchaseAmount, 41);
  assert.equal(line.purchaseUnitMismatch, false);
});

test("Vendor Replies financials include official PALLET rows", () => {
  const line = smartScmVendorFinancialLine({
    line: { itemId: 1784, itemName: "PALLET", unit: "EACH", quantity: 6.5, ancillaryPallet: true },
    metadata: { purchaseUnit: "EACH", lastPurchasePrice: 4.25 }
  });
  assert.equal(line.purchaseQuantity, 6.5);
  assert.equal(line.purchaseAmount, 27.63);
  assert.equal(line.ancillaryPallet, true);
});

test("Vendor Replies financials never invent money or multiply mismatched units", () => {
  const missingPrice = smartScmVendorFinancialLine({
    line: { itemId: 1, itemName: "No price", unit: "EA", salesQuantity: 10 },
    metadata: { purchaseUnit: "EA", lastPurchasePrice: null }
  });
  assert.equal(missingPrice.lastPurchasePrice, null);
  assert.equal(missingPrice.purchaseAmount, null);

  const mismatched = smartScmVendorFinancialLine({
    line: { itemId: 2, itemName: "Case item", unit: "EA", salesQuantity: 10 },
    metadata: { purchaseUnit: "CASE", lastPurchasePrice: 12 }
  });
  assert.equal(mismatched.purchaseUnitMismatch, true);
  assert.equal(mismatched.purchaseAmount, null,
    "A price per CASE must not be multiplied by an EA sales quantity without a conversion.");
});

test("Persisted price snapshots win over newer metadata while absent fields use current metadata", () => {
  const snapshotted = smartScmVendorFinancialLine({
    line: {
      itemId: 3,
      itemName: "Snapshot",
      unit: "EA",
      salesQuantity: 3,
      purchaseUnit: "EA",
      lastPurchasePrice: 2.5,
      lastPurchasePriceSyncedAt: "2026-08-01T00:00:00Z"
    },
    metadata: {
      purchaseUnit: "EA",
      vendorPrice: 12.6,
      lastPurchasePrice: 9.99,
      lastPurchasePriceSyncedAt: "2026-08-11T00:00:00Z"
    }
  });
  assert.equal(snapshotted.lastPurchasePrice, 2.5);
  assert.equal(snapshotted.unitPriceSource, "saved_load");
  assert.equal(snapshotted.lastPurchasePriceSyncedAt, "2026-08-01T00:00:00Z");
  assert.equal(snapshotted.purchaseAmount, 7.5);
});

test("recorded snapshot sources survive reload and missing price timestamps stay blank", () => {
  const vendorSnapshot = smartScmVendorFinancialLine({
    line: {
      unit: "PC",
      salesQuantity: 2,
      lastPurchasePrice: 12.6,
      reason: { vendorReplyPriceSnapshot: { source: "vendor_price" } }
    },
    metadata: { purchaseUnit: "PC", vendorPrice: 99, lastPurchasePrice: 10.67 }
  });
  assert.equal(vendorSnapshot.unitPriceSource, "vendor_price");
  assert.equal(vendorSnapshot.lastPurchasePriceSyncedAt, null);

  const vendorWithoutTimestamp = smartScmVendorFinancialLine({
    line: { unit: "PC", salesQuantity: 2 },
    metadata: { purchaseUnit: "PC", vendorPrice: 12.6, lastPurchasePrice: 10.67 }
  });
  assert.equal(vendorWithoutTimestamp.unitPriceSource, "vendor_price");
  assert.equal(vendorWithoutTimestamp.lastPurchasePriceSyncedAt, null);

  const unknownSnapshotSource = smartScmVendorFinancialLine({
    line: {
      unit: "PC",
      salesQuantity: 2,
      lastPurchasePrice: 11,
      reason: { vendorReplyPriceSnapshot: { source: "legacy_unknown" } }
    },
    metadata: { purchaseUnit: "PC" }
  });
  assert.equal(unknownSnapshotSource.unitPriceSource, "saved_load");
});

test("invalid numeric snapshots stay blank and never become invented zero-dollar amounts", () => {
  const line = smartScmVendorFinancialLine({
    line: { unit: "EA", salesQuantity: "not-a-number", lastPurchasePrice: "unknown" },
    metadata: { purchaseUnit: "EA", lastPurchasePrice: "also-unknown" }
  });
  assert.equal(line.purchaseQuantity, 0);
  assert.equal(line.lastPurchasePrice, null);
  assert.equal(line.purchaseAmount, null);
});

test("legacy pallet quantities fall back to confirmed pallets multiplied by TO/PLT", () => {
  const line = smartScmVendorFinancialLine({
    line: { confirmedPallets: 2.5, toPlt: 12 },
    metadata: {
      stockUnit: "ea",
      purchaseUnit: " EA ",
      lastPurchasePrice: 0.5,
      lastPurchasePriceSyncedAt: "2026-08-10T00:00:00Z"
    }
  });
  assert.equal(line.unit, "ea");
  assert.equal(line.purchaseUnit, "EA");
  assert.equal(line.purchaseQuantity, 30);
  assert.equal(line.purchaseAmount, 15);
  assert.equal(line.lastPurchasePriceSyncedAt, "2026-08-10T00:00:00Z");
});

test("metadata unit fallback and negative quantities are handled without false money", () => {
  const line = smartScmVendorFinancialLine({
    line: { salesQuantity: -4 },
    metadata: { unit: "PCS", lastPurchasePrice: 2 }
  });
  assert.equal(line.unit, "PCS");
  assert.equal(line.purchaseUnit, "PCS");
  assert.equal(line.purchaseQuantity, 0);
  assert.equal(line.purchaseAmount, 0);
});

test("an empty financial input returns an explicit blank contract", () => {
  const line = smartScmVendorFinancialLine();
  assert.equal(line.unit, null);
  assert.equal(line.purchaseUnit, null);
  assert.equal(line.purchaseQuantity, 0);
  assert.equal(line.lastPurchasePrice, null);
  assert.equal(line.lastPurchasePriceSyncedAt, null);
  assert.equal(line.purchaseAmount, null);
});
