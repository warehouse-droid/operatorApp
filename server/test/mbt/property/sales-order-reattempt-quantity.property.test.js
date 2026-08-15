// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSalesOrderReattemptPreview,
  buildSalesOrderReattemptTargets
} from "../../../src/sales-order-reload.js";

test("Re-attempt and already-delivered quantities conserve every generated historical pallet load", () => {
  for (let historicalPallets = 1; historicalPallets <= 64; historicalPallets += 1) {
    const conversion = Number((1 + ((historicalPallets * 7919) % 10000) / 100).toFixed(2));
    const loadedSalesQty = Number((historicalPallets * conversion).toFixed(6));
    const preview = buildSalesOrderReattemptPreview({
      sourceLoadRecordId: 1000 + historicalPallets,
      historicalLines: [{
        lineId: String(5000 + historicalPallets),
        itemId: String(7000 + historicalPallets),
        itemName: `PROPERTY-SKU-${historicalPallets}`,
        loadedQty: loadedSalesQty,
        loadedUom: "SQFT"
      }],
      currentLines: [{
        id: 9000 + historicalPallets,
        line_id: 5000 + historicalPallets,
        item_id: 7000 + historicalPallets,
        item_name: `PROPERTY-SKU-${historicalPallets}`,
        sku: `PROPERTY-SKU-${historicalPallets}`,
        quantity: loadedSalesQty,
        unit: "SQFT",
        pallet_qty: historicalPallets,
        to_plt: conversion,
        item_weight: 10,
        netsuite_active: true
      }],
      itemCatalog: [{
        item_id: 7000 + historicalPallets,
        item_name: `PROPERTY-SKU-${historicalPallets}`,
        stock_unit: "SQFT",
        to_plt: conversion,
        item_weight: 10
      }]
    });
    for (let selectedPallets = 1; selectedPallets <= historicalPallets; selectedPallets += 1) {
      const [target] = buildSalesOrderReattemptTargets({
        preview,
        selections: [{
          lineKey: preview.lines[0].lineKey,
          palletQty: selectedPallets,
          reason: "Generated conservation case"
        }]
      });
      assert.equal(
        Number((target.targetPalletQty + target.alreadyDeliveredPalletQty).toFixed(6)),
        historicalPallets
      );
      assert.equal(
        Number((target.targetSalesQty + target.alreadyDeliveredSalesQty).toFixed(6)),
        loadedSalesQty
      );
      assert.ok(target.targetSalesQty <= target.historicalSalesQty + 0.000001);
    }
  }
});
