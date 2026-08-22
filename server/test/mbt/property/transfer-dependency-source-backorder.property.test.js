// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import { transferDependencySourceBackorderDecision } from "../../../src/transfer-dependency-source-backorder.js";

function nextRandom(state) {
  const next = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return [next, next / 0x100000000];
}

test("source-backorder permission never consumes availability reserved for protected proposals", () => {
  let state = 0x118191;
  for (let index = 0; index < 2000; index += 1) {
    let sample;
    [state, sample] = nextRandom(state);
    const requested = Math.round(sample * 100000) / 100;
    [state, sample] = nextRandom(state);
    const eligible = Math.round(sample * requested * 1000) / 1000;
    [state, sample] = nextRandom(state);
    const available = Math.round(sample * 100000) / 100;
    const result = transferDependencySourceBackorderDecision({
      requestedQuantity: requested,
      backorderEligibleQuantity: eligible,
      availableQuantity: available
    });
    const protectedQuantity = Math.max(0, requested - Math.min(requested, eligible));
    assert.equal(result.allowed, protectedQuantity <= available + 0.000001);
    assert.equal(result.backorderQuantity, Number(Math.max(0, requested - available).toFixed(6)));
    assert.equal(result.protectedQuantity, Number(protectedQuantity.toFixed(6)));
    assert(result.backorderEligibleQuantity <= result.requestedQuantity);
  }
});

test("SOB118191 automatic PALLET behavior is exact at the policy boundary", () => {
  assert.deepEqual(transferDependencySourceBackorderDecision({
    requestedQuantity: 1,
    backorderEligibleQuantity: 0,
    availableQuantity: 0
  }), {
    allowed: false,
    requestedQuantity: 1,
    backorderEligibleQuantity: 0,
    protectedQuantity: 1,
    availableQuantity: 0,
    backorderQuantity: 1
  });
  assert.deepEqual(transferDependencySourceBackorderDecision({
    requestedQuantity: 1,
    backorderEligibleQuantity: 1,
    availableQuantity: 0
  }), {
    allowed: true,
    requestedQuantity: 1,
    backorderEligibleQuantity: 1,
    protectedQuantity: 0,
    availableQuantity: 0,
    backorderQuantity: 1
  });
});

test("source-backorder quantities fail safely for omitted, malformed, and oversized values", () => {
  assert.deepEqual(transferDependencySourceBackorderDecision(), {
    allowed: true,
    requestedQuantity: 0,
    backorderEligibleQuantity: 0,
    protectedQuantity: 0,
    availableQuantity: 0,
    backorderQuantity: 0
  });
  assert.deepEqual(transferDependencySourceBackorderDecision({
    requestedQuantity: "1,234.5678914",
    backorderEligibleQuantity: 2000,
    availableQuantity: -4
  }), {
    allowed: true,
    requestedQuantity: 1234.567891,
    backorderEligibleQuantity: 1234.567891,
    protectedQuantity: 0,
    availableQuantity: 0,
    backorderQuantity: 1234.567891
  });
  assert.deepEqual(transferDependencySourceBackorderDecision({
    requestedQuantity: "not-a-number",
    backorderEligibleQuantity: Number.POSITIVE_INFINITY,
    availableQuantity: null
  }), {
    allowed: true,
    requestedQuantity: 0,
    backorderEligibleQuantity: 0,
    protectedQuantity: 0,
    availableQuantity: 0,
    backorderQuantity: 0
  });
});
