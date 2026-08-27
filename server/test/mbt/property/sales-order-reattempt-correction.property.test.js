// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import {
  applyEffectiveReattemptIdentity,
  buildReattemptIdentityFingerprint
} from "../../../src/sales-order-reattempt-correction.js";

test("effective-item overlays conserve generated freight quantities and historical identity", () => {
  for (let seed = 1; seed <= 128; seed += 1) {
    const pallets = 1 + ((seed * 37) % 64);
    const salesQty = Number((pallets * (1 + ((seed * 7919) % 10000) / 100)).toFixed(6));
    const historicalItemId = 100_000 + seed;
    const currentItemId = 200_000 + seed;
    const line = Object.freeze({
      itemId: historicalItemId,
      sku: `HISTORICAL-${seed}`,
      itemName: `HISTORICAL-${seed}`,
      historicalItemId,
      historicalSku: `HISTORICAL-${seed}`,
      currentItemId,
      currentSku: `CURRENT-${seed}`,
      salesQty,
      pallets
    });
    const correction = {
      correctionId: seed,
      afterItemId: currentItemId,
      afterSku: `CURRENT-${seed}`,
      afterItemName: `CURRENT-${seed}`,
      targetSalesQty: salesQty,
      targetPalletQty: pallets
    };
    const projected = applyEffectiveReattemptIdentity(line, correction);

    assert.equal(projected.itemId, currentItemId);
    assert.equal(projected.sku, `CURRENT-${seed}`);
    assert.equal(projected.historicalItemId, historicalItemId);
    assert.equal(projected.historicalSku, `HISTORICAL-${seed}`);
    assert.equal(projected.salesQty, salesQty);
    assert.equal(projected.pallets, pallets);
    assert.equal(line.itemId, historicalItemId);
    assert.equal(line.sku, `HISTORICAL-${seed}`);
  }
});

test("fingerprints change for every generated parent quantity or lifecycle revision", () => {
  for (let seed = 1; seed <= 128; seed += 1) {
    const state = {
      childOrderId: 1000 + seed,
      cycleId: 2000 + seed,
      parentSalesOrderId: 3000 + seed,
      netsuiteLineId: 4000 + seed,
      beforeItemId: 5000 + seed,
      beforeSku: `OLD-${seed}`,
      afterItemId: 6000 + seed,
      afterSku: `NEW-${seed}`,
      currentSalesQty: 100 + seed,
      currentPalletQty: 10 + seed,
      targetSalesQty: 50 + seed,
      targetPalletQty: 5 + seed,
      childStatus: "completed",
      cycleStatus: "authorized"
    };
    const fingerprint = buildReattemptIdentityFingerprint(state);
    assert.notEqual(buildReattemptIdentityFingerprint({
      ...state,
      currentSalesQty: state.currentSalesQty + 0.01
    }), fingerprint);
    assert.notEqual(buildReattemptIdentityFingerprint({
      ...state,
      currentPalletQty: state.currentPalletQty + 1
    }), fingerprint);
    assert.notEqual(buildReattemptIdentityFingerprint({
      ...state,
      cycleStatus: "completed"
    }), fingerprint);
  }
});
