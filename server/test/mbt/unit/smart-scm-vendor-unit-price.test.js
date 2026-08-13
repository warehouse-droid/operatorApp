import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeSmartScmVendorUnitPrice,
  smartScmVendorUnitPriceEdit
} from "../../../src/smart-scm-vendor-unit-price.js";

test("material unit-price edit persists a normalized audited per-line override", () => {
  const edited = smartScmVendorUnitPriceEdit(
    { decision: "hold", decisionPallets: 2 },
    { unitPrice: "2.7500004" },
    { updatedAt: "2026-08-11T12:00:00.000Z", updatedBy: "price-editor" }
  );

  assert.equal(edited.provided, true);
  assert.equal(edited.unitPrice, 2.75);
  assert.deepEqual(edited.draft, {
    decision: "hold",
    decisionPallets: 2,
    unitPriceOverride: true,
    unitPrice: 2.75,
    unitPriceUpdatedAt: "2026-08-11T12:00:00.000Z",
    unitPriceUpdatedBy: "price-editor"
  });
});

test("an omitted unit-price field preserves the existing override without rewriting audit evidence", () => {
  const draft = {
    decision: "confirm",
    decisionPallets: 3,
    unitPriceOverride: true,
    unitPrice: 8.25,
    unitPriceUpdatedAt: "2026-08-10T00:00:00.000Z",
    unitPriceUpdatedBy: "first-editor"
  };
  const untouched = smartScmVendorUnitPriceEdit(draft, {}, {
    updatedAt: "2026-08-11T00:00:00.000Z",
    updatedBy: "second-editor"
  });

  assert.equal(untouched.provided, false);
  assert.equal(untouched.unitPrice, 8.25);
  assert.deepEqual(untouched.draft, draft);
});

test("blank unit price explicitly removes only price-override fields", () => {
  const reset = smartScmVendorUnitPriceEdit({
    decision: "hold",
    decisionPallets: 1,
    unitPriceOverride: true,
    unitPrice: 4.5,
    unitPriceUpdatedAt: "2026-08-10T00:00:00.000Z",
    unitPriceUpdatedBy: "price-editor",
    unrelatedEvidence: "keep"
  }, { unitPrice: "" });

  assert.equal(reset.provided, true);
  assert.equal(reset.unitPrice, null);
  assert.deepEqual(reset.draft, {
    decision: "hold",
    decisionPallets: 1,
    unrelatedEvidence: "keep"
  });
});

test("unit-price validation rejects unsafe money values with an HTTP 400 contract", () => {
  for (const value of [0, -0.01, "not-money", Number.POSITIVE_INFINITY, 1_000_000_000]) {
    assert.throws(
      () => normalizeSmartScmVendorUnitPrice(value),
      (error) => error?.status === 400 && /greater than zero|valid number|below/i.test(error.message),
      `expected ${String(value)} to be rejected`
    );
  }
  assert.equal(normalizeSmartScmVendorUnitPrice("0.000001"), 0.000001);
  assert.equal(normalizeSmartScmVendorUnitPrice(999_999_999), 999_999_999);
  assert.equal(normalizeSmartScmVendorUnitPrice(null), null);
});

test("sub-six-decimal prices and defensive malformed edit inputs stay explicit", () => {
  assert.throws(
    () => normalizeSmartScmVendorUnitPrice(0.0000001, "Material unit price"),
    (error) => error?.status === 400 && /after six-decimal normalization/.test(error.message)
  );
  assert.deepEqual(smartScmVendorUnitPriceEdit([], null), {
    provided: false,
    unitPrice: null,
    draft: {}
  });
  assert.deepEqual(smartScmVendorUnitPriceEdit(null, {}), {
    provided: false,
    unitPrice: null,
    draft: {}
  });
});
