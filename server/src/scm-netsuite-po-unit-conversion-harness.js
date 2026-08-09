import assert from "node:assert/strict";
import {
  convertPurchaseOrderPalletQuantity,
  describePurchaseOrderLinePallets
} from "./scm-netsuite-po-unit-conversion.js";

const sqftLine = {
  itemId: 2055,
  itemName: "MBBS-Special Order",
  quantity: 217.95,
  unit: "SQFT",
  palletQuantity: 5,
  toPlt: null
};

assert.deepEqual(describePurchaseOrderLinePallets(sqftLine), {
  ancillaryPallet: false,
  palletEditable: true,
  palletQuantity: 5,
  nativeQuantity: 217.95,
  nativeUnit: "SQFT",
  unitsPerPallet: 43.59,
  conversionSource: "line_ratio",
  updatePalletColumn: true
});

const configured = describePurchaseOrderLinePallets({
  ...sqftLine,
  quantity: 130.77,
  palletQuantity: 0,
  toPlt: 43.59
});
assert.equal(configured.palletQuantity, 3);
assert.equal(configured.unitsPerPallet, 43.59);
assert.equal(configured.conversionSource, "item_conversion");

assert.deepEqual(describePurchaseOrderLinePallets({
  itemId: 1784,
  itemName: "PALLET",
  quantity: 5,
  unit: "EACH",
  palletQuantity: 0,
  toPlt: null
}), {
  ancillaryPallet: true,
  palletEditable: true,
  palletQuantity: 5,
  nativeQuantity: 5,
  nativeUnit: "EACH",
  unitsPerPallet: 1,
  conversionSource: "pallet_item",
  updatePalletColumn: false
});

const unavailable = describePurchaseOrderLinePallets({
  itemName: "Unknown material",
  quantity: 12,
  unit: "SQFT",
  palletQuantity: 0,
  toPlt: 0
});
assert.equal(unavailable.palletEditable, false);
assert.equal(unavailable.palletQuantity, null);
assert.equal(unavailable.unitsPerPallet, null);

assert.deepEqual(convertPurchaseOrderPalletQuantity(sqftLine, 6), {
  palletQuantity: 6,
  nativeQuantity: 261.54,
  updatePalletColumn: true
});
assert.deepEqual(convertPurchaseOrderPalletQuantity({
  itemName: "PALLET",
  quantity: 5,
  unit: "EACH"
}, 6), {
  palletQuantity: 6,
  nativeQuantity: 6,
  updatePalletColumn: false
});
assert.throws(() => convertPurchaseOrderPalletQuantity(sqftLine, 0), /positive/i);
assert.throws(() => convertPurchaseOrderPalletQuantity(unavailable, 2), /conversion/i);
assert.throws(
  () => convertPurchaseOrderPalletQuantity({ ...sqftLine, toPlt: Number.MAX_VALUE }, Number.MAX_VALUE),
  /calculated native purchase quantity is invalid/i,
  "An overflowing PLT conversion must fail before any NetSuite write payload is built."
);

for (let units = 0.125; units <= 250; units += 7.125) {
  for (let pallets = 0.25; pallets <= 40; pallets += 3.25) {
    const line = { itemName: "Property material", quantity: units * 2, unit: "EA", toPlt: units };
    const converted = convertPurchaseOrderPalletQuantity(line, pallets);
    assert(Math.abs(converted.nativeQuantity - (units * pallets)) <= 0.000001,
      "PLT conversion must multiply by the authoritative units-per-pallet factor.");
    const roundTrip = describePurchaseOrderLinePallets({
      ...line,
      quantity: converted.nativeQuantity,
      palletQuantity: pallets
    });
    assert(Math.abs(roundTrip.palletQuantity - pallets) <= 0.000001,
      "PLT/native conversion must round-trip within NetSuite quantity precision.");
  }
}

console.log("NetSuite PO history PLT/native unit conversion harness passed.");
